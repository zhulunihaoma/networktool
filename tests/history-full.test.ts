import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import * as zlib from "node:zlib";
import { HistoryService } from "../electron/core/history-service";
import { HistorySources } from "../electron/core/history-sources";
import { ContextArchives, FramedZstd } from "../electron/core/history-context";
import { JsonStreamValidator } from "../electron/core/history-json";
import type { HistoryRecord } from "../src/shared/history";

const sqlite = async (
  file: string,
  fn: (db: import("node:sqlite").DatabaseSync) => void,
) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file);
  try {
    fn(db);
  } finally {
    db.close();
  }
};
async function fixture(fn: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "full-history-test-"));
  try {
    await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
const task = (file: string, root: string): HistoryRecord => ({
  id: "test",
  nativeId: "native",
  instance: "fixture",
  title: "fixture",
  directory: "/fixture",
  updated: 1,
  kind: "conversation",
  available: true,
  locator: { files: [{ path: file, root }] },
});

test("ZCode enumerates both ID formats, empty registered projects, drafts and subagents", async () =>
  fixture(async (home) => {
    await sqlite(path.join(home, ".zcode/cli/db/db.sqlite"), (db) => {
      db.exec(
        "CREATE TABLE session(id TEXT,title TEXT,directory TEXT,time_updated INTEGER,parent_id TEXT);INSERT INTO session VALUES('session_new','new','/one',3,NULL),('sess_old','old','/two',2,NULL),('child','child','/one',1,'session_new')",
      );
    });
    await sqlite(path.join(home, ".zcode/v2/tasks-index.sqlite"), (db) => {
      db.exec(
        "CREATE TABLE projects(project_id TEXT,host_id TEXT,name TEXT);CREATE TABLE project_roots(project_id TEXT,root_path TEXT);CREATE TABLE tasks(task_id TEXT,title TEXT,workspace_path TEXT,project_id TEXT,host_id TEXT);INSERT INTO projects VALUES('one','local','custom'),('empty','local','empty');INSERT INTO project_roots VALUES('one','/one'),('empty','/empty');INSERT INTO tasks VALUES('session_new','renamed','/one','one','local'),('draft','draft','/one','one','local')",
      );
    });
    const scan = await new HistorySources(home).scan("ZCode");
    assert.deepEqual(scan.tasks.map((t) => t.nativeId).sort(), [
      "child",
      "draft",
      "sess_old",
      "session_new",
    ]);
    assert.equal(
      scan.tasks.find((t) => t.nativeId === "session_new")?.title,
      "renamed",
    );
    assert(scan.projects.some((p) => p.name === "empty" && p.count === 0));
    assert.equal(scan.tasks.find((t) => t.nativeId === "draft")?.kind, "draft");
    assert.equal(
      scan.tasks.find((t) => t.nativeId === "child")?.kind,
      "subagent",
    );
  }));

test("OpenCode unions native old/new sessions independent of cwd and exports v2 events", async () =>
  fixture(async (home) => {
    const file = path.join(home, ".local/share/opencode/opencode.db");
    await sqlite(file, (db) => {
      db.exec(
        "CREATE TABLE project(id TEXT,name TEXT,worktree TEXT);CREATE TABLE session(id TEXT,title TEXT,directory TEXT,project_id TEXT,time_updated INTEGER,parent_id TEXT);CREATE TABLE session_v2 AS SELECT * FROM session;CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,data TEXT);INSERT INTO project VALUES('p','custom','/p'),('empty','empty','/empty');INSERT INTO session VALUES('old','old','/p','p',1,NULL);INSERT INTO session_v2 VALUES('old','new title','/p','p',2,NULL),('v2_only','v2','/p','p',3,NULL);INSERT INTO session_message VALUES('u','v2_only','user',1,'{\"text\":\"V2_ONLY_FULL_CONTEXT\"}'),('a','v2_only','assistant',2,'{\"content\":\"RESULT\"}')",
      );
    });
    const service = new HistoryService(path.join(home, "owned"), home);
    try {
      const page = await service.browse("OpenCode");
      assert.equal(page.total, 2);
      assert.equal(
        page.tasks.find((t) => t.nativeId === "old")?.title,
        "new title",
      );
      assert(page.projects.some((p) => p.name === "empty" && p.count === 0));
      const imported = await service.importSession(
        page.tasks.find((t) => t.nativeId === "v2_only")!.id,
        "OpenCode",
      );
      assert(imported.context?.complete);
      const first = await service.archives.read(imported.context!.id);
      assert.match(first.text, /V2_ONLY_FULL_CONTEXT/);
      assert.match(first.text, /RESULT/);
    } finally {
      service.close();
    }
  }));

test("all-history search and project catalog survive more than 5000 sessions", async () =>
  fixture(async (home) => {
    await sqlite(path.join(home, ".zcode/cli/db/db.sqlite"), (db) => {
      db.exec(
        "CREATE TABLE session(id TEXT PRIMARY KEY,title TEXT,directory TEXT,time_updated INTEGER,parent_id TEXT);BEGIN",
      );
      const ins = db.prepare("INSERT INTO session VALUES(?,?,?,?,NULL)");
      for (let n = 0; n < 5002; n++)
        ins.run(`session_${n}`, `chat ${n}`, n === 0 ? "/old" : "/new", n);
      db.exec("COMMIT");
    });
    const s = new HistoryService(path.join(home, "owned"), home);
    try {
      const first = await s.browse("ZCode");
      assert.equal(first.total, 5002);
      assert.equal(first.tasks.length, 50);
      assert(first.nextCursor);
      assert(first.projects.some((p) => p.directories.includes("/old")));
      const searched = await s.browse("ZCode", { search: "session_0" });
      assert.equal(searched.tasks[0].nativeId, "session_0");
      assert.equal(
        (await s.browse("ZCode", { cursor: first.nextCursor })).tasks.length,
        50,
      );
      await assert.rejects(
        s.browse("ZCode", { cursor: first.nextCursor, search: "different" }),
        /刷新|分页/,
      );
    } finally {
      s.close();
    }
  }));

test("large single JSONL records stream to disk without an 8 MB archive/export limit", async () =>
  fixture(async (root) => {
    const file = path.join(root, "large.jsonl"),
      handle = await fs.open(file, "w"),
      expected = createHash("sha256");
    const part = Buffer.from("中".repeat(349525));
    const put = async (b: Buffer) => {
      await handle.write(b);
      expected.update(b);
    };
    await put(Buffer.from('{"type":"user","text":"'));
    for (let n = 0; n < 64; n++) await put(part);
    await put(Buffer.from('"}\n'));
    await handle.close();
    const archives = new ContextArchives(path.join(root, "owned")),
      archive = await archives.archive(task(file, root));
    assert(archive.complete);
    assert(archive.bytes > 64 * 1024 * 1024 - 1024);
    const manifest = await archives.manifest(archive.id);
    assert.equal(manifest.inputs[0].sha256, expected.digest("hex"));
    assert.equal(manifest.inputs[0].bytes, (await fs.stat(file)).size);
    let offset = 0,
      parts = 0;
    for (;;) {
      const page = await archives.read(archive.id, offset);
      assert(!page.text.includes("\ufffd"));
      parts++;
      if (page.nextOffset === undefined) break;
      assert(page.nextOffset > offset);
      offset = page.nextOffset;
    }
    assert(parts > 100);
    const exported = await archives.export(archive.id, root);
    assert.equal(
      (await fs.stat(path.join(exported.path, "context.txt"))).size,
      archive.bytes,
    );
  }));

test("SQLite payload larger than 8 MB is copied in chunks with no truncated event", async () =>
  fixture(async (root) => {
    const file = path.join(root, "source.sqlite");
    await sqlite(file, (db) => {
      db.exec(
        "CREATE TABLE session(id TEXT PRIMARY KEY,title TEXT);CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,sequence INTEGER,data TEXT);INSERT INTO session VALUES('native','large');INSERT INTO message VALUES('m','native',1,json_object('text',hex(zeroblob(5*1024*1024))))",
      );
    });
    const t: HistoryRecord = {
      ...task(file, root),
      locator: {
        database: file,
        table: "session",
        idColumn: "id",
        related: ["message"],
      },
    };
    const a = new ContextArchives(path.join(root, "owned")),
      archive = await a.archive(t);
    assert(archive.complete);
    assert(archive.bytes > 10 * 1024 * 1024);
    assert.equal(archive.records, 3);
    const raw = await fs.readFile(
      path.join(root, "owned", archive.id, "context.jsonl"),
      "utf8",
    );
    const event = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((r) => r.source === "message");
    assert.equal(event.record.text.length, 10 * 1024 * 1024);
  }));

test("concatenated Zstandard frames include every frame under backpressure", async () => {
  const z = zlib as unknown as { zstdCompressSync: (b: Buffer) => Buffer };
  const input = Buffer.concat([
    z.zstdCompressSync(Buffer.from("first\n")),
    z.zstdCompressSync(Buffer.from("x".repeat(12 * 1024 * 1024) + "\n")),
    z.zstdCompressSync(Buffer.from("last\n")),
  ]);
  let text = "",
    bytes = 0;
  for await (const b of Readable.from([input]).pipe(new FramedZstd())) {
    bytes += b.length;
    if (text.length < 10) text += b.toString();
  }
  assert.equal(bytes, 6 + 12 * 1024 * 1024 + 1 + 5);
  assert(text.startsWith("first\n"));
});

test("incremental validation detects truncated JSON and accepts split UTF-8, escape and number tokens", () => {
  const raw = Buffer.from(
    '{"中":"value\\u4e2d","n":-1.23e+4}\n[true,false,null]\n',
  );
  const v = new JsonStreamValidator();
  for (const byte of raw) v.write(Buffer.from([byte]));
  v.end();
  assert.equal(v.values, 2);
  for (const raw of ['{"x":"unfinished', "[1,]", '{"x":01}', '{"x":"\\q"}']) {
    const p = new JsonStreamValidator();
    assert.throws(() => {
      p.write(Buffer.from(raw));
      p.end();
    });
  }
});

test("corrupt history does not produce a complete archive or erase other indexed sessions", async () =>
  fixture(async (root) => {
    const file = path.join(root, "broken.jsonl");
    await fs.writeFile(file, '{"x":1}\n{"unfinished":');
    const a = new ContextArchives(path.join(root, "owned"));
    await assert.rejects(a.archive(task(file, root)), /JSON/);
    const dirs = (await fs.readdir(path.join(root, "owned"))).filter(
      (n) => n !== "jobs",
    );
    assert.equal(dirs.length, 1);
    assert.equal(
      JSON.parse(
        await fs.readFile(
          path.join(root, "owned", dirs[0], "incomplete.json"),
          "utf8",
        ),
      ).complete,
      false,
    );
  }));

test("inline attachments larger than 8 MB decode incrementally and are included in export", async () =>
  fixture(async (root) => {
    const file = path.join(root, "image.jsonl"),
      out = await fs.open(file, "w");
    await out.write(
      '{"type":"image","source":{"type":"base64","media_type":"application/octet-stream","data":"',
    );
    const block = Buffer.alloc(3 * 64 * 1024, 0x5a),
      encoded = block.toString("base64"),
      expected = createHash("sha256");
    for (let i = 0; i < 64; i++) {
      await out.write(encoded);
      expected.update(block);
    }
    await out.write('"}}\n');
    await out.close();
    const a = new ContextArchives(path.join(root, "owned"), root),
      archive = await a.archive(task(file, root)),
      manifest = await a.manifest(archive.id);
    assert.equal(archive.attachmentsComplete, true);
    assert.equal(manifest.attachments.length, 1);
    assert.equal(manifest.attachments[0].bytes, block.length * 64);
    assert.equal(manifest.attachments[0].sha256, expected.digest("hex"));
    const exported = await a.export(archive.id, root);
    assert.equal(
      (await fs.stat(path.join(exported.path, manifest.attachments[0].path!)))
        .size,
      block.length * 64,
    );
  }));

test("missing historical originals are explicit gaps and prose paths are never read", async () =>
  fixture(async (root) => {
    const file = path.join(root, "refs.jsonl");
    await fs.writeFile(
      file,
      JSON.stringify({ type: "text", text: "/etc/passwd" }) +
        "\n" +
        JSON.stringify({
          type: "file",
          url: "https://example.invalid/private",
        }) +
        "\n",
    );
    const a = new ContextArchives(path.join(root, "owned")),
      archive = await a.archive(task(file, root));
    assert(archive.complete);
    assert.equal(archive.attachmentCount, 1);
    assert.equal(archive.missingAttachments, 1);
    assert.equal(archive.attachmentsComplete, false);
  }));

test("unchanged source archives survive service restart without duplicating raw context", async () =>
  fixture(async (root) => {
    const file = path.join(root, "source.jsonl");
    await fs.writeFile(file, '{"text":"cache test"}\n');
    const one = new ContextArchives(path.join(root, "owned"));
    const first = await one.archive(task(file, root));
    const two = new ContextArchives(path.join(root, "owned"));
    const second = await two.archive(task(file, root));
    assert.equal(first.id, second.id);
    assert.equal(first.sha256, second.sha256);
    assert.match((await two.read(second.id)).text, /cache test/);
  }));

test("8 MB boundaries and a 256 MB context remain lossless with bounded streaming memory", async () =>
  fixture(async (root) => {
    const MB = 1024 * 1024,
      block = Buffer.alloc(MB, 0x78),
      prefix = Buffer.from('{"type":"user","text":"'),
      suffix = Buffer.from('"}\n');
    let peak = process.memoryUsage().rss;
    const monitor = setInterval(() => {
        peak = Math.max(peak, process.memoryUsage().rss);
      }, 5),
      baseline = peak;
    try {
      for (const size of [8 * MB - 1, 8 * MB, 8 * MB + 1, 256 * MB]) {
        const file = path.join(root, `context-${size}.jsonl`),
          handle = await fs.open(file, "w"),
          sha = createHash("sha256");
        const put = async (b: Buffer) => {
          await handle.write(b);
          sha.update(b);
        };
        await put(prefix);
        let remaining = size - prefix.length - suffix.length;
        while (remaining > 0) {
          const part = block.subarray(0, Math.min(block.length, remaining));
          await put(part);
          remaining -= part.length;
        }
        await put(suffix);
        await handle.close();
        const expected = sha.digest("hex");
        const archives = new ContextArchives(path.join(root, `owned-${size}`)),
          archive = await archives.archive(task(file, root));
        assert(archive.complete);
        const manifest = await archives.manifest(archive.id);
        assert.equal(manifest.inputs[0].bytes, size);
        assert.equal(manifest.inputs[0].sha256, expected);
        if (size === 256 * MB) {
          const exported = await archives.export(archive.id, root);
          assert.equal(
            (await fs.stat(path.join(exported.path, "context.txt"))).size,
            archive.bytes,
          );
        }
      }
      assert(
        peak - baseline < 180 * MB,
        `streaming memory grew by ${Math.round((peak - baseline) / MB)} MB`,
      );
    } finally {
      clearInterval(monitor);
    }
  }));

test("Cursor unique-key KV data exports message bubbles and empty registered projects", async () =>
  fixture(async (home) => {
    const user = path.join(home, "Library/Application Support/Cursor/User"),
      dbfile = path.join(user, "globalStorage/state.vscdb");
    await sqlite(dbfile, (db) => {
      db.exec(
        'CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE cursorDiskKV(key TEXT UNIQUE,value TEXT);INSERT INTO cursorDiskKV VALUES(\'composerData:chat\',\'{"composerId":"chat","createdAt":1}\'),(\'bubbleId:chat:bubble\',\'{"type":1,"text":"CURSOR_COMPLETE_BUBBLE"}\')',
      );
    });
    await sqlite(dbfile, (db) => {
      db.prepare("INSERT INTO cursorDiskKV VALUES(?,NULL)").run(
        "messageRequestContext:chat:WARM_SUBMIT",
      );
    });
    const ws = path.join(user, "workspaceStorage/empty");
    await fs.mkdir(ws, { recursive: true });
    await fs.writeFile(
      path.join(ws, "workspace.json"),
      JSON.stringify({ folder: "file:///empty-project" }),
    );
    const service = new HistoryService(path.join(home, "owned"), home);
    try {
      const page = await service.browse("Cursor");
      assert.equal(page.total, 1);
      assert(
        page.projects.some((p) => p.directories.includes("/empty-project")),
      );
      const imported = await service.importSession(page.tasks[0].id, "Cursor");
      assert(imported.context?.complete);
      assert.match(
        (await service.archives.read(imported.context!.id)).text,
        /CURSOR_COMPLETE_BUBBLE/,
      );
    } finally {
      service.close();
    }
  }));

test("cancelled archive resumes committed inputs and completes without duplicating records", async () =>
  fixture(async (root) => {
    const one = path.join(root, "one.jsonl"),
      two = path.join(root, "two.jsonl");
    await fs.writeFile(one, '{"text":"first committed input"}\n');
    const f = await fs.open(two, "w");
    await f.write('{"text":"');
    const block = Buffer.alloc(1024 * 1024, 0x78);
    for (let n = 0; n < 64; n++) await f.write(block);
    await f.write('"}\n');
    await f.close();
    const t = task(one, root);
    t.locator.files!.push({ path: two, root });
    const archives = new ContextArchives(path.join(root, "owned")),
      control = new AbortController(),
      timer = setTimeout(
        () => control.abort(new Error("fixture cancellation")),
        30,
      );
    try {
      await assert.rejects(
        archives.archive(t, control.signal),
        /fixture cancellation/,
      );
    } finally {
      clearTimeout(timer);
    }
    const partials = (await fs.readdir(path.join(root, "owned"))).filter(
      (n) => n !== "jobs",
    );
    assert.equal(partials.length, 1);
    const resumed = await new ContextArchives(path.join(root, "owned")).archive(
      t,
    );
    assert.equal(resumed.id, partials[0]);
    assert(resumed.complete);
    const saved = JSON.parse(
      await fs.readFile(
        path.join(root, "owned", resumed.id, "manifest.json"),
        "utf8",
      ),
    );
    assert.equal(saved.inputs.length, 2);
    assert.equal(saved.records, 3);
  }));

test("Codex resolves compressed native log paths and discovers compressed orphan histories", async () =>
  fixture(async (home) => {
    const root = path.join(home, ".codex"),
      logs = path.join(root, "sessions");
    await fs.mkdir(logs, { recursive: true });
    const id = "11111111-1111-4111-8111-111111111111";
    const original = path.join(logs, `rollout-${id}.jsonl`);
    const z = zlib as unknown as { zstdCompressSync: (b: Buffer) => Buffer };
    const line = (id: string) =>
      JSON.stringify({
        type: "session_meta",
        payload: { id, cwd: "/project" },
      }) + "\n";
    const body =
      JSON.stringify({
        type: "event_msg",
        payload: { type: "user_message", message: "COMPRESSED_CONTEXT_END" },
      }) + "\n";
    await fs.writeFile(
      original + ".zst",
      Buffer.concat([
        z.zstdCompressSync(Buffer.from(line(id))),
        z.zstdCompressSync(Buffer.from(body)),
      ]),
    );
    await fs.writeFile(
      path.join(logs, "orphan.jsonl.zst"),
      z.zstdCompressSync(Buffer.from(line("compressed-orphan") + body)),
    );
    await sqlite(path.join(root, "state_9.sqlite"), (db) => {
      db.exec(
        "CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT)",
      );
      db.prepare("INSERT INTO threads VALUES(?,?,?)").run(
        id,
        original,
        "/project",
      );
    });
    const forkId = "22222222-2222-4222-8222-222222222222";
    await fs.writeFile(
      path.join(logs, `rollout-${id}_${forkId}.jsonl.zst`),
      z.zstdCompressSync(Buffer.from(line(id) + body)),
    );
    const scan = await new HistorySources(home).scan("Codex");
    assert.equal(scan.tasks.length, 3);
    const fork = scan.tasks.find((t) => t.nativeId === forkId)!;
    assert.equal(fork.locator.metadata?.originalSessionId, id);
    assert(fork.parentId);
    const native = scan.tasks.find((t) => t.nativeId === id)!;
    assert.equal(native.locator.files![0].path, original + ".zst");
    assert.equal(native.locator.files![0].format, "zstd");
    const archives = new ContextArchives(path.join(home, "owned"), home);
    const reading = archives.archive(native);
    await assert.rejects(archives.archive(native), /正在读取/);
    const archive = await reading;
    assert(archive.complete);
    assert(
      (await archives.read(archive.id)).text.includes("COMPRESSED_CONTEXT_END"),
    );
  }));

test("native tool-result file URI attachments are decoded and exported", async () =>
  fixture(async (root) => {
    const file = path.join(root, "result.jsonl");
    await fs.writeFile(
      file,
      JSON.stringify({
        type: "message",
        content: [
          {
            type: "tool",
            state: {
              content: [
                {
                  type: "file",
                  uri: "data:image/png;base64,aGlzdG9yaWNhbC1pbWFnZQ==",
                  mime: "image/png",
                },
              ],
            },
          },
        ],
      }) + "\n",
    );
    const archives = new ContextArchives(path.join(root, "owned"));
    const archive = await archives.archive(task(file, root));
    assert(archive.attachmentsComplete);
    const manifest = await archives.manifest(archive.id);
    assert.equal(manifest.attachments.length, 1);
    assert.equal(
      manifest.attachments[0].sha256,
      createHash("sha256").update("historical-image").digest("hex"),
    );
  }));

test("MCP image content preserves direct Base64 data and mimeType", async () =>
  fixture(async (root) => {
    const file = path.join(root, "mcp.jsonl");
    await fs.writeFile(
      file,
      JSON.stringify({
        type: "message",
        content: [
          { type: "image", data: "bWNwLWltYWdl", mimeType: "image/jpeg" },
        ],
      }) + "\n",
    );
    const archives = new ContextArchives(path.join(root, "owned"));
    const archive = await archives.archive(task(file, root));
    assert(archive.attachmentsComplete);
    const manifest = await archives.manifest(archive.id);
    assert.equal(manifest.attachments.length, 1);
    assert.equal(manifest.attachments[0].mime, "image/jpeg");
    assert.equal(
      manifest.attachments[0].sha256,
      createHash("sha256").update("mcp-image").digest("hex"),
    );
  }));
