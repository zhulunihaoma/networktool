import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { HistorySources } from "../electron/core/history-sources";
import { HistoryService } from "../electron/core/history-service";
import type { SourceProject } from "../src/shared/handoff-api";
import type { HistoryScan } from "../src/shared/history";

async function fixture(fn: (home: string) => Promise<void>) {
  const home = await fs.mkdtemp(
    path.join(os.tmpdir(), "history-projects-test-"),
  );
  try {
    await fn(home);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function sqlite(
  file: string,
  fn: (db: import("node:sqlite").DatabaseSync) => void,
) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file);
  try {
    fn(db);
  } finally {
    db.close();
  }
}

async function writeJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value));
}

function ordered(scan: HistoryScan, names: string[]) {
  assert.deepEqual(
    scan.projects.map((p) => p.name),
    names,
  );
  // The rank belongs to the final, whole catalog, not a provider-local counter.
  assert.deepEqual(
    scan.projects.map((p) => (p as SourceProject & { order?: number }).order),
    names.map((_, index) => index),
  );
}

function preserved(scan: HistoryScan, nativeIds: string[]) {
  assert.deepEqual(
    scan.tasks.map((t) => t.nativeId).sort(),
    [...nativeIds].sort(),
  );
  assert.equal(scan.coverage.sourceRecords, nativeIds.length);
  assert.equal(scan.coverage.indexedRecords, nativeIds.length);
  assert.equal(
    scan.projects.reduce((sum, p) => sum + (p.count || 0), 0),
    nativeIds.length,
  );
  for (const task of scan.tasks) {
    assert(
      scan.projects.some((p) => p.id === task.projectId),
      `missing project for ${task.nativeId}`,
    );
  }
}

function named(scan: HistoryScan, name: string) {
  const p = scan.projects.find((p) => p.name === name);
  assert(p, `missing project ${name}`);
  return p;
}

function codexProjects() {
  return {
    alpha: { id: "alpha", name: "Alpha", rootPaths: ["/projects/alpha"] },
    beta: { id: "beta", name: "Beta", rootPaths: ["/projects/beta"] },
    empty: { id: "empty", name: "Empty", rootPaths: ["/projects/empty"] },
  };
}

async function codexThreads(home: string) {
  await sqlite(path.join(home, ".codex/state_9.sqlite"), (db) => {
    db.exec(`CREATE TABLE threads(id TEXT, title TEXT, cwd TEXT, project_id TEXT, archived INTEGER);
      INSERT INTO threads VALUES
      ('alpha-chat','Alpha chat','/projects/alpha','alpha',0),
      ('beta-archive','Beta archive','/projects/beta','beta',1),
      ('orphan','Orphan','/projects/unregistered',NULL,0)`);
  });
}

for (const nested of [false, true]) {
  test(`Codex ${nested ? "persisted" : "top-level"} project-order overrides object insertion without dropping history`, async () =>
    fixture(async (home) => {
      const state = {
        "local-projects": codexProjects(),
        "project-order": ["beta", "alpha", "empty"],
      };
      await writeJson(
        path.join(home, ".codex/.codex-global-state.json"),
        nested ? { "electron-persisted-atom-state": state } : state,
      );
      await codexThreads(home);
      const scan = await new HistorySources(home).scan("Codex");
      ordered(scan, ["Beta", "Alpha", "Empty", "unregistered"]);
      preserved(scan, ["alpha-chat", "beta-archive", "orphan"]);
      assert.equal(named(scan, "Empty").count, 0);
      assert.equal(
        scan.tasks.find((t) => t.nativeId === "beta-archive")?.kind,
        "archived",
      );
    }));
}

test("Codex reads unified-sidebar-project-order-v1 from nested persisted state", async () =>
  fixture(async (home) => {
    await writeJson(path.join(home, ".codex/.codex-global-state.json"), {
      "local-projects": codexProjects(),
      "electron-persisted-atom-state": {
        "unified-sidebar-project-order-v1": [
          "codex:project:empty",
          "codex:project:beta",
          "codex:project:alpha",
        ],
      },
    });
    const scan = await new HistorySources(home).scan("Codex");
    ordered(scan, ["Empty", "Beta", "Alpha"]);
    assert(scan.projects.every((p) => p.registered && p.count === 0));
  }));

test("Codex legacy-to-app-server identity mapping keeps distinct projects sharing a root", async () =>
  fixture(async (home) => {
    const root = path.join(home, ".codex");
    await writeJson(path.join(root, ".codex-global-state.json"), {
      "local-projects": {
        "legacy-one": {
          id: "legacy-one",
          name: "First custom name",
          rootPaths: ["/shared"],
        },
        "legacy-two": {
          id: "legacy-two",
          name: "Second custom name",
          rootPaths: ["/shared"],
        },
      },
      "project-order": ["legacy-two", "legacy-one"],
      "app-server-project-id-by-legacy-project-id-by-host": {
        [`local:${root}`]: {
          "legacy-one": "server-one",
          "legacy-two": "server-two",
        },
      },
    });
    await sqlite(path.join(root, "state_9.sqlite"), (db) => {
      db.exec(`CREATE TABLE projects(id TEXT, name TEXT, position INTEGER);
        CREATE TABLE project_roots(project_id TEXT, path TEXT);
        CREATE TABLE threads(id TEXT,title TEXT,cwd TEXT,project_id TEXT);
        INSERT INTO projects VALUES('server-one','Stale first',0),('server-two','Stale second',1);
        INSERT INTO project_roots VALUES('server-one','/shared'),('server-two','/shared'),('server-one','/extra-root');
        INSERT INTO threads VALUES('first','First','/shared','server-one'),('second','Second','/shared','server-two')`);
    });
    const scan = await new HistorySources(home).scan("Codex");
    ordered(scan, ["Second custom name", "First custom name"]);
    preserved(scan, ["first", "second"]);
    const first = named(scan, "First custom name"),
      second = named(scan, "Second custom name");
    assert.notEqual(first.id, second.id);
    assert.deepEqual([...first.nativeIds!].sort(), [
      "legacy-one",
      "server-one",
    ]);
    assert.deepEqual([...second.nativeIds!].sort(), [
      "legacy-two",
      "server-two",
    ]);
    assert.deepEqual([...first.directories].sort(), ["/extra-root", "/shared"]);
    assert.deepEqual(second.directories, ["/shared"]);
    assert.equal(first.count, 1);
    assert.equal(second.count, 1);
    assert.equal(
      scan.tasks.find((t) => t.nativeId === "first")?.projectId,
      first.id,
    );
    assert.equal(
      scan.tasks.find((t) => t.nativeId === "second")?.projectId,
      second.id,
    );
  }));

for (const position of [true, false]) {
  test(`Codex database ${position ? "projects.position is the order fallback" : "without projects.position remains readable"}`, async () =>
    fixture(async (home) => {
      await sqlite(path.join(home, ".codex/state_9.sqlite"), (db) => {
        db.exec(`CREATE TABLE projects(id TEXT,name TEXT${position ? ",position INTEGER" : ""});
          CREATE TABLE project_roots(project_id TEXT,path TEXT);
          CREATE TABLE threads(id TEXT,title TEXT,cwd TEXT,project_id TEXT);
          INSERT INTO projects VALUES('a','Alpha'${position ? ",20" : ""}),('b','Beta'${position ? ",0" : ""});
          INSERT INTO project_roots VALUES('a','/a'),('b','/b');
          INSERT INTO threads VALUES('a-chat','Alpha','/a','a'),('b-chat','Beta','/b','b')`);
      });
      const scan = await new HistorySources(home).scan("Codex");
      if (position) ordered(scan, ["Beta", "Alpha"]);
      else {
        assert.deepEqual(scan.projects.map((p) => p.name).sort(), [
          "Alpha",
          "Beta",
        ]);
        ordered(
          scan,
          scan.projects.map((p) => p.name),
        );
      }
      preserved(scan, ["a-chat", "b-chat"]);
      assert.deepEqual(scan.coverage.gaps, []);
    }));
}

async function wiscode(
  home: string,
  configure: (db: import("node:sqlite").DatabaseSync) => void,
) {
  await sqlite(path.join(home, ".wiscode/auth.db"), (db) => {
    // sessions intentionally includes every column selected by HistorySources.
    db.exec(`CREATE TABLE projects(
      project_id TEXT,project_path TEXT,custom_project_name TEXT,
      location_kind TEXT,remote_host_id TEXT,workspace_kind TEXT,
      isArchived INTEGER,isStarred INTEGER,created_at TEXT,updated_at TEXT);
      CREATE TABLE sessions(
      session_id TEXT,provider TEXT,provider_thread_id TEXT,custom_name TEXT,
      project_path TEXT,jsonl_path TEXT,isArchived INTEGER,updated_at TEXT,created_at TEXT);
      CREATE TABLE session_runtime_bindings(session_id TEXT,native_session_id TEXT,runtime_canonical_path TEXT);
      CREATE TABLE project_worktrees(source_project_path TEXT,worktree_path TEXT)`);
    configure(db);
  });
}

async function claudeLog(
  home: string,
  relative: string,
  sessionId: string,
  cwd: string,
  sidechain = false,
) {
  const file = path.join(home, ".wiscode/claude/projects", relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify({
      type: "user",
      sessionId,
      cwd,
      isSidechain: sidechain,
      message: { role: "user", content: "Complete historical prompt" },
    }) + "\n",
  );
  return file;
}

test("WisCode custom names and parent mapping attribute .claude/worktrees/agent children to the registered project", async () =>
  fixture(async (home) => {
    const parentFile = await claudeLog(
      home,
      "workspace/native-parent.jsonl",
      "native-parent",
      "/workspace/app",
    );
    const childCwd =
      "/workspace/app/.claude/worktrees/agent-build/packages/api";
    const childFile = await claudeLog(
      home,
      "workspace/native-parent/subagents/agent-child.jsonl",
      "native-parent",
      childCwd,
      true,
    );
    await wiscode(home, (db) => {
      db.exec(
        `INSERT INTO projects VALUES('app','/workspace/app','Customer-facing project name','local',NULL,'project',0,0,'2026-01-01 00:00:00','2026-02-01 00:00:00')`,
      );
      db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?)").run(
        "registered-parent",
        "claude",
        "native-parent",
        "Custom conversation name",
        "/workspace/app",
        parentFile,
        0,
        "2026-02-01 00:00:00",
        "2026-01-01 00:00:00",
      );
      db.prepare("INSERT INTO session_runtime_bindings VALUES(?,?,?)").run(
        "registered-parent",
        "native-parent",
        parentFile,
      );
    });
    const scan = await new HistorySources(home).scan("WisCode");
    ordered(scan, ["Customer-facing project name"]);
    preserved(scan, ["registered-parent", "agent-child"]);
    const p = named(scan, "Customer-facing project name");
    const parent = scan.tasks.find((t) => t.nativeId === "registered-parent")!;
    const child = scan.tasks.find((t) => t.nativeId === "agent-child")!;
    assert.equal(parent.title, "Custom conversation name");
    assert.equal(parent.projectId, p.id);
    assert.equal(child.projectId, p.id);
    assert.equal(child.parentId, parent.id);
    assert.equal(child.kind, "subagent");
    assert.equal(child.directory, childCwd);
    assert(child.locator.files?.some((f) => f.path === childFile));
    assert.equal(p.count, 2);
  }));

test("WisCode Codex subagent forks are named by role and host wrappers leave the title", async () =>
  fixture(async (home) => {
    await wiscode(home, () => {});
    const polluted =
      "<wiscode_runtime_instructions>\nYou are WisCode.\n</wiscode_runtime_instructions>\n\n" +
      "<environment_context>\n<user>qihoo</user>\n</environment_context>\n\n" +
      "<user_request>\n这个工具架构是pi为基础的吗\n</user_request>";
    await sqlite(
      path.join(home, ".wiscode/codex-agents/state_5.sqlite"),
      (db) => {
        db.exec(`CREATE TABLE threads(
          id TEXT,name TEXT,title TEXT,preview TEXT,cwd TEXT,updated_at_ms INTEGER,
          updated_at INTEGER,source TEXT,thread_source TEXT,rollout_path TEXT,
          project_id TEXT,history_mode TEXT,archived INTEGER,agent_path TEXT,agent_nickname TEXT)`);
        const insert = db.prepare(
          "INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        );
        insert.run(
          "parent-thread", "", polluted, "", "/workspace/app",
          1770000000000, 0, "vscode", null, "", null, "paginated", 0, null, null,
        );
        // A fork stores neither name, title nor preview; its role lives only
        // in source.subagent.thread_spawn and it is absent from auth.db.
        insert.run(
          "spawn-thread", "", "", "", "/workspace/app",
          1770000100000, 0,
          JSON.stringify({
            subagent: {
              thread_spawn: {
                parent_thread_id: "parent-thread",
                depth: 1,
                agent_path: "/root/resource_gate",
                agent_nickname: "Maxwell",
              },
            },
          }),
          "subagent", "", null, null, 0, null, null,
        );
      },
    );
    const scan = await new HistorySources(home).scan("WisCode");
    const parent = scan.tasks.find((t) => t.nativeId === "parent-thread")!;
    const child = scan.tasks.find((t) => t.nativeId === "spawn-thread")!;
    assert(parent && child);
    assert.equal(parent.title, "这个工具架构是pi为基础的吗");
    assert.equal(child.title, "resource_gate（子代理 Maxwell）");
    assert.equal(child.kind, "subagent");
    assert.equal(child.parentId, parent.id);
    for (const task of scan.tasks)
      assert(
        !/wiscode_runtime_instructions|environment_context/.test(task.title),
        `host wrapper leaked into ${task.nativeId}: ${task.title}`,
      );
  }));

test("WisCode Codex threads fall back to first_user_message and placeholder session names yield engine titles", async () =>
  fixture(async (home) => {
    await wiscode(home, (db) => {
      // The host pre-fills unnamed sessions with a placeholder; it must not
      // mask the engine-derived title.
      db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?)").run(
        "registered-exec",
        "codex",
        "exec-thread",
        "Untitled Codex Session",
        "/workspace/app",
        "",
        0,
        "2026-02-01 00:00:00",
        "2026-01-01 00:00:00",
      );
      db.prepare("INSERT INTO session_runtime_bindings VALUES(?,?,?)").run(
        "registered-exec",
        "exec-thread",
        "",
      );
    });
    await sqlite(
      path.join(home, ".wiscode/codex-agents/state_5.sqlite"),
      (db) => {
        db.exec(`CREATE TABLE threads(
          id TEXT,name TEXT,title TEXT,preview TEXT,first_user_message TEXT,cwd TEXT,updated_at_ms INTEGER,
          updated_at INTEGER,source TEXT,thread_source TEXT,rollout_path TEXT,
          project_id TEXT,history_mode TEXT,archived INTEGER,agent_path TEXT,agent_nickname TEXT)`);
        const insert = db.prepare(
          "INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        );
        // WisCode's state index leaves name/title/preview empty; the first
        // prompt is the only stored prose.
        insert.run(
          "orphan-thread", "", "", "",
          "用 shell 执行 git push origin main，只回复命令输出",
          "/workspace/app", 1770000000000, 0, null, "user", "", null, null, 0, null, null,
        );
        insert.run(
          "exec-thread", "", "", "", "Actual first prompt",
          "/workspace/app", 1770000100000, 0, null, null, "", null, null, 0, null, null,
        );
      },
    );
    const scan = await new HistorySources(home).scan("WisCode");
    const orphan = scan.tasks.find((t) => t.nativeId === "orphan-thread")!;
    const named = scan.tasks.find((t) => t.nativeId === "registered-exec")!;
    assert(orphan && named);
    assert.equal(orphan.title, "用 shell 执行 git push origin main，只回复命令输出");
    assert.equal(named.title, "Actual first prompt");
  }));

test("WisCode sessions without any stored name fall back to the first user message in the transcript", async () =>
  fixture(async (home) => {
    // A registered session with no custom_name whose canonical jsonl is not
    // covered by any engine catalog: the transcript head is the only title source.
    const file = path.join(home, ".wiscode/claude/projects/loose/talk.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      [
        JSON.stringify({ type: "user", sessionId: "loose-talk", cwd: "/loose", message: { role: "user", content: "帮我把登录页改成深色模式" } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: "好的" } }),
      ].join("\n") + "\n",
    );
    await wiscode(home, (db) => {
      db.exec(
        `INSERT INTO projects VALUES('loose','/loose','Loose','local',NULL,'project',0,0,'2026-01-01 00:00:00','2026-02-01 00:00:00')`,
      );
      db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?)").run(
        "loose-talk",
        "claude",
        "loose-thread",
        "",
        "/loose",
        file,
        0,
        "2026-02-01 00:00:00",
        "2026-01-01 00:00:00",
      );
      db.prepare("INSERT INTO session_runtime_bindings VALUES(?,?,?)").run(
        "loose-talk",
        "loose-thread",
        file,
      );
    });
    const scan = await new HistorySources(home).scan("WisCode");
    const task = scan.tasks.find((t) => t.nativeId === "loose-talk")!;
    assert(task, "登记会话应保留");
    assert.equal(task.title, "帮我把登录页改成深色模式");
    assert.equal(task.projectId, named(scan, "Loose").id);
  }));

test("WisCode project_worktrees attributes nested cwd without absorbing unrelated prefix paths", async () =>
  fixture(async (home) => {
    await claudeLog(
      home,
      "worktree/worktree-root.jsonl",
      "worktree-root",
      "/worktrees/app-feature",
    );
    await claudeLog(
      home,
      "worktree/worktree-nested.jsonl",
      "worktree-nested",
      "/worktrees/app-feature/packages/ui",
    );
    await claudeLog(
      home,
      "worktree/unrelated.jsonl",
      "unrelated",
      "/worktrees/app-feature-other",
    );
    await wiscode(home, (db) => {
      db.exec(`INSERT INTO projects VALUES('app','/workspace/app','Mapped app','local',NULL,'project',0,0,'2026-01-01 00:00:00','2026-02-01 00:00:00');
        INSERT INTO project_worktrees VALUES('/workspace/app','/worktrees/app-feature')`);
    });
    const scan = await new HistorySources(home).scan("WisCode");
    preserved(scan, ["worktree-root", "worktree-nested", "unrelated"]);
    const p = named(scan, "Mapped app");
    assert.equal(
      scan.tasks.find((t) => t.nativeId === "worktree-root")?.projectId,
      p.id,
    );
    assert.equal(
      scan.tasks.find((t) => t.nativeId === "worktree-nested")?.projectId,
      p.id,
    );
    assert.notEqual(
      scan.tasks.find((t) => t.nativeId === "unrelated")?.projectId,
      p.id,
    );
    assert.equal(p.count, 2);
    assert.equal(scan.projects.length, 2);
    ordered(scan, ["Mapped app", "app-feature-other"]);
  }));

const wiscodeOrders = {
  manual: ["Gamma", "Alpha", "Beta"],
  priority: ["Beta", "Gamma", "Alpha"],
  createdAt: ["Alpha", "Beta", "Gamma"],
  updatedAt: ["Gamma", "Alpha", "Beta"],
} as const;

for (const sortOrder of [
  "manual",
  "priority",
  "createdAt",
  "updatedAt",
] as const) {
  test(`WisCode settings sharedSidebarPreferences.uiOrder ${sortOrder} sorts active projects before retained archived/auto_session history`, async () =>
    fixture(async (home) => {
      await writeJson(path.join(home, ".wiscode/settings.json"), {
        sharedSidebarPreferences: {
          uiOrder: {
            organizeMode: "byProject",
            sortOrder,
            projectManualOrder: ["auto", "archived", "gamma", "alpha", "beta"],
          },
        },
      });
      await wiscode(home, (db) => {
        // Insertion order and high archived/auto timestamps must not dominate the active sidebar.
        // Activity is max(project created/updated, sessions): Gamma's April session
        // wins, then Alpha's March creation, then Beta's February project update.
        db.exec(`INSERT INTO projects VALUES
          ('auto','/auto','Auto history','local',NULL,'auto_session',0,1,'2030-01-01 00:00:00','2030-01-01 00:00:00'),
          ('archived','/archived','Archived history','local',NULL,'project',1,1,'2029-01-01 00:00:00','2029-01-01 00:00:00'),
          ('gamma','/gamma','Gamma','local',NULL,'project',0,0,'2026-01-01 00:00:00','2026-03-01 00:00:00'),
          ('alpha','/alpha','Alpha','local',NULL,'project',0,0,'2026-03-01 00:00:00','2026-01-01 00:00:00'),
          ('beta','/beta','Beta','local',NULL,'project',0,1,'2026-02-01 00:00:00','2026-02-01 00:00:00');
          INSERT INTO sessions VALUES
          ('auto-chat','claude',NULL,'Auto chat','/auto','',0,'2030-01-01 00:00:00','2030-01-01 00:00:00'),
          ('archived-chat','claude',NULL,'Archived chat','/archived','',1,'2029-01-01 00:00:00','2029-01-01 00:00:00'),
          ('alpha-chat','claude',NULL,'Alpha chat','/alpha','',0,'2026-01-01 00:00:00','2026-01-01 00:00:00'),
          ('beta-chat','claude',NULL,'Beta chat','/beta','',0,'2026-02-01 00:00:00','2026-01-01 00:00:00'),
          ('gamma-chat','claude',NULL,'Gamma chat','/gamma','',0,'2026-04-01 00:00:00','2026-01-01 00:00:00')`);
      });
      const scan = await new HistorySources(home).scan("WisCode");
      assert.deepEqual(
        scan.projects.slice(0, 3).map((p) => p.name),
        [...wiscodeOrders[sortOrder]],
      );
      assert.deepEqual(
        scan.projects
          .slice(3)
          .map((p) => p.name)
          .sort(),
        ["Archived history", "Auto history"],
      );
      ordered(
        scan,
        scan.projects.map((p) => p.name),
      );
      preserved(scan, [
        "auto-chat",
        "archived-chat",
        "alpha-chat",
        "beta-chat",
        "gamma-chat",
      ]);
      assert.equal(
        scan.tasks.find((t) => t.nativeId === "archived-chat")?.kind,
        "archived",
      );
      assert.equal(named(scan, "Archived history").count, 1);
      assert.equal(named(scan, "Auto history").count, 1);
      assert(scan.projects.every((p) => p.registered));
    }));
}

test("WisCode SQLite timestamps are UTC even when the process timezone is not UTC", async () =>
  fixture(async (home) => {
    await wiscode(home, (db) => {
      db.exec(`INSERT INTO projects VALUES('p','/p','UTC project','local',NULL,'project',0,0,'2026-01-01 00:00:00','2026-01-01 00:00:00');
        INSERT INTO sessions VALUES
        ('seconds','claude',NULL,'Seconds','/p','',0,'2026-01-02 03:04:05','2026-01-01 00:00:00'),
        ('millis','claude',NULL,'Millis','/p','',0,'2026-01-02 03:04:05.678','2026-01-01 00:00:00'),
        ('created-fallback','claude',NULL,'Created fallback','/p','',0,NULL,'2026-01-02 03:04:06'),
        ('explicit-offset','claude',NULL,'Explicit offset','/p','',0,'2026-01-02T03:04:05+02:00','2026-01-01 00:00:00')`);
    });
    const previousTZ = process.env.TZ;
    try {
      process.env.TZ = "America/Los_Angeles";
      const scan = await new HistorySources(home).scan("WisCode");
      preserved(scan, [
        "seconds",
        "millis",
        "created-fallback",
        "explicit-offset",
      ]);
      const expected = {
        seconds: Date.parse("2026-01-02T03:04:05Z"),
        millis: Date.parse("2026-01-02T03:04:05.678Z"),
        "created-fallback": Date.parse("2026-01-02T03:04:06Z"),
        "explicit-offset": Date.parse("2026-01-02T03:04:05+02:00"),
      };
      for (const [id, updated] of Object.entries(expected)) {
        assert.equal(
          scan.tasks.find((t) => t.nativeId === id)?.updated,
          updated,
          id,
        );
      }
    } finally {
      if (previousTZ === undefined) delete process.env.TZ;
      else process.env.TZ = previousTZ;
    }
  }));

test("ZCode pinned projects precede unpinned projects with position order within each group", async () =>
  fixture(async (home) => {
    await sqlite(path.join(home, ".zcode/v2/tasks-index.sqlite"), (db) => {
      db.exec(`CREATE TABLE projects(project_id TEXT,host_id TEXT,name TEXT,position INTEGER,pinned INTEGER);
        CREATE TABLE project_roots(project_id TEXT,root_path TEXT);
        CREATE TABLE tasks(task_id TEXT,title TEXT,workspace_path TEXT,project_id TEXT,host_id TEXT);
        INSERT INTO projects VALUES('a','local','Unpinned first',0,0),('b','local','Pinned later',20,1),('c','local','Pinned first',10,1),('d','local','Unpinned last',30,0);
        INSERT INTO project_roots VALUES('a','/a'),('b','/b'),('c','/c'),('d','/d');
        INSERT INTO tasks VALUES('draft','Draft','/a','a','local')`);
    });
    const scan = await new HistorySources(home).scan("ZCode");
    ordered(scan, [
      "Pinned first",
      "Pinned later",
      "Unpinned first",
      "Unpinned last",
    ]);
    preserved(scan, ["draft"]);
    assert.equal(scan.tasks[0].kind, "draft");
  }));

test("OpenCode projects use time_active descending instead of insertion or session activity", async () =>
  fixture(async (home) => {
    await sqlite(path.join(home, ".local/share/opencode/opencode.db"), (db) => {
      db.exec(`CREATE TABLE project(id TEXT,name TEXT,worktree TEXT,time_active INTEGER);
        CREATE TABLE session(id TEXT,title TEXT,directory TEXT,project_id TEXT,time_updated INTEGER,parent_id TEXT);
        INSERT INTO project VALUES('a','Old active','/a',10),('b','Most active empty','/b',30),('c','Middle active','/c',20);
        INSERT INTO session VALUES('a-chat','Newest chat','/a','a',9999,NULL),('c-chat','Old chat','/c','c',1,NULL)`);
    });
    const scan = await new HistorySources(home).scan("OpenCode");
    ordered(scan, ["Most active empty", "Middle active", "Old active"]);
    preserved(scan, ["a-chat", "c-chat"]);
    assert.equal(named(scan, "Most active empty").count, 0);
  }));

test("DeepSeek Harness global.workspaceIds supplies native order and retains archived session history", async () =>
  fixture(async (home) => {
    await writeJson(path.join(home, ".dsh/storages/workspace.json"), {
      tables: {
        workspaces: {
          a: { title: "Alpha", path: "/a", sessionIds: ["alpha-chat"] },
          b: { title: "Beta empty", path: "/b", sessionIds: [] },
          c: { title: "Gamma", path: "/c", sessionIds: ["gamma-chat"] },
        },
      },
      global: {
        workspaceIds: ["c", "b", "a"],
        archivedSessionIds: ["alpha-chat"],
      },
    });
    for (const [id, cwd] of [
      ["alpha-chat", "/a"],
      ["gamma-chat", "/c"],
    ]) {
      await writeJson(
        path.join(
          home,
          ".dsh/storages/session_projcache/sessions",
          `${id}.json`,
        ),
        {
          record: {
            identity: { cwd, createdAt: 1 },
            rows: {
              title: { val: id },
              sessionListMetadata: { val: { lastPromptAt: 2 } },
            },
          },
        },
      );
    }
    const scan = await new HistorySources(home).scan("DeepSeekHarness");
    ordered(scan, ["Gamma", "Beta empty", "Alpha"]);
    preserved(scan, ["alpha-chat", "gamma-chat"]);
    assert.equal(named(scan, "Beta empty").count, 0);
    assert.equal(
      scan.tasks.find((t) => t.nativeId === "alpha-chat")?.kind,
      "archived",
    );
  }));

test("HistoryService refresh picks up a native order change that leaves tasks untouched", async () =>
  fixture(async (home) => {
    const state = path.join(home, ".codex/.codex-global-state.json");
    await writeJson(state, {
      "local-projects": codexProjects(),
      "project-order": ["beta", "alpha", "empty"],
    });
    await codexThreads(home);
    const service = new HistoryService(path.join(home, "index"), home);
    try {
      const first = await service.browse("Codex", { refresh: true });
      assert.deepEqual(
        first.projects.map((p) => p.name),
        ["Beta", "Alpha", "Empty", "unregistered"],
      );
      const revision = first.revision;

      // Only the sidebar order moved: no task, project or file changed.
      await writeJson(state, {
        "local-projects": codexProjects(),
        "project-order": ["empty", "alpha", "beta"],
      });
      const second = await service.browse("Codex", { refresh: true });
      assert.deepEqual(
        second.projects.map((p) => p.name),
        ["Empty", "Alpha", "Beta", "unregistered"],
      );
      assert.notEqual(second.revision, revision);
      assert.deepEqual(second.tasks.map((t) => t.nativeId).sort(), [
        "alpha-chat",
        "beta-archive",
        "orphan",
      ]);

      // A stale page from the previous revision must be rejected, not silently
      // re-ordered under the caller.
      await assert.rejects(
        () => service.browse("Codex", { cursor: "stale" }),
        /分页已失效|请刷新/,
      );
    } finally {
      service.close();
    }
  }));

test("WorkBuddy workspaces.last_opened_at orders projects and unopened sessions still keep history", async () =>
  fixture(async (home) => {
    const root = path.join(home, ".workbuddy");
    await sqlite(path.join(root, "workbuddy.db"), (db) => {
      db.exec(`CREATE TABLE workspaces(path TEXT PRIMARY KEY,last_opened_at TEXT);
        CREATE TABLE sessions(id TEXT,title TEXT,cwd TEXT,updated_at TEXT,deleted_at TEXT,parent_id TEXT);
        INSERT INTO workspaces VALUES
          ('/project/recent','2026-06-02T10:00:00Z'),
          ('/project/stale','2026-06-01T10:00:00Z'),
          ('/project/never','2026-05-01T10:00:00Z');
        INSERT INTO sessions VALUES
          ('recent-chat','Recent chat','/project/recent','2026-06-02T10:00:00Z',NULL,NULL),
          ('stale-chat','Stale chat','/project/stale','2026-06-02T11:00:00Z',NULL,NULL),
          ('deleted-chat','Deleted chat','/project/stale','2026-06-03T11:00:00Z','2026-06-04T00:00:00Z',NULL)`);
    });
    for (const id of ["recent-chat", "stale-chat", "deleted-chat"]) {
      await fs.mkdir(path.join(root, "projects"), { recursive: true });
      await fs.writeFile(
        path.join(root, "projects", `${id}.jsonl`),
        JSON.stringify({ type: "message", role: "user", sessionId: id }) + "\n",
      );
    }
    const scan = await new HistorySources(home).scan("WorkBuddy");
    // Native workspace list wins over newest session timestamps.
    ordered(scan, ["recent", "stale", "never"]);
    preserved(scan, ["recent-chat", "stale-chat", "deleted-chat"]);
    assert.equal(named(scan, "never").count, 0);
    assert.equal(
      scan.tasks.find((t) => t.nativeId === "deleted-chat")?.kind,
      "deleted",
    );
  }));
