/** Independent native ID/file inventory versus the production history adapter.
 * Never emits private message text or writes original stores. */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { HistorySources } from "../electron/core/history-sources";
import { HistoryService } from "../electron/core/history-service";
import { sourceDatabase, exists } from "../electron/core/history-io";
import { HANDOFF_SOURCES, type HandoffSource } from "../src/shared/handoff-api";
import type { HistoryScan } from "../src/shared/history";

async function files(root: string, extension: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(p: string) {
    let es;
    try {
      es = await fs.readdir(p, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    for (const e of es) {
      if (e.isSymbolicLink()) continue;
      const f = path.join(p, e.name);
      if (e.isDirectory()) await walk(f);
      else if (e.isFile() && f.endsWith(extension)) out.push(f);
    }
  }
  await walk(root);
  return out;
}
async function main() {
  const arguments_ = process.argv.slice(2),
    homeIndex = arguments_.indexOf("--home"),
    home =
      homeIndex >= 0 ? path.resolve(arguments_[homeIndex + 1]) : os.homedir();
  const context = arguments_.includes("--contexts"),
    filterIndex = arguments_.indexOf("--source"),
    filter = filterIndex >= 0 ? arguments_[filterIndex + 1] : undefined;
  const outputIndex = arguments_.indexOf("--output"),
    output =
      outputIndex >= 0
        ? path.resolve(arguments_[outputIndex + 1])
        : await fs.mkdtemp(path.join(os.tmpdir(), "history-coverage-"));
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const rows: any[] = [];
  for (const source of HANDOFF_SOURCES) {
    if (filter && filter !== source) continue;
    const expected = new Set<string>(),
      expectedProjects = new Set<string>(),
      expectedFiles = new Set<string>();
    let checked = false;
    const sql = async (
      relative: string,
      query: string,
      target: Set<string>,
    ) => {
      const file = path.join(home, relative);
      if (!(await exists(file))) return;
      checked = true;
      await sourceDatabase(file, (db) => {
        for (const r of db.prepare(query).iterate()) target.add(String(r.id));
      });
    };
    const logFiles = async (relative: string) => {
      for (const f of await files(path.join(home, relative), ".jsonl")) {
        expected.add(path.basename(f, ".jsonl"));
        expectedFiles.add(f);
      }
      checked = true;
    };
    let inventoryError: string | undefined;
    try {
      if (source === "OpenCode") {
        await sql(
          ".local/share/opencode/opencode.db",
          "SELECT id FROM session UNION SELECT id FROM session_v2",
          expected,
        );
        await sql(
          ".local/share/opencode/opencode.db",
          "SELECT id FROM project",
          expectedProjects,
        );
      } else if (source === "ZCode") {
        await sql(
          ".zcode/cli/db/db.sqlite",
          "SELECT id FROM session",
          expected,
        );
        await sql(
          ".zcode/v2/tasks-index.sqlite",
          "SELECT task_id AS id FROM tasks",
          expected,
        );
        await sql(
          ".zcode/v2/tasks-index.sqlite",
          "SELECT project_id AS id FROM projects",
          expectedProjects,
        );
      } else if (source === "Codex") {
        const dirs = await fs.readdir(path.join(home, ".codex"));
        const database = dirs
          .filter((n) => /^state_\d+\.sqlite$/.test(n))
          .sort(
            (a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]),
          )[0];
        if (database) {
          await sql(`.codex/${database}`, "SELECT id FROM threads", expected);
          await sql(
            `.codex/${database}`,
            "SELECT id FROM projects",
            expectedProjects,
          );
        }
        for (const name of ["sessions", "archived_sessions"]) {
          for (const suffix of [".jsonl", ".jsonl.zst", ".jsonl.zstd"]) {
            for (const file of await files(
              path.join(home, ".codex", name),
              suffix,
            )) {
              const id = path
                .basename(file)
                .match(
                  /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl/i,
                )?.[1];
              if (id) expected.add(id);
              expectedFiles.add(file);
              checked = true;
            }
          }
        }
      } else if (source === "ClaudeCode") await logFiles(".claude/projects");
      else if (source === "WorkBuddy") {
        await sql(
          ".workbuddy/workbuddy.db",
          "SELECT id FROM sessions",
          expected,
        );
        await logFiles(".workbuddy/projects");
      } else if (source === "WisCode") {
        await sql(
          ".wiscode/auth.db",
          "SELECT session_id AS id FROM sessions",
          expected,
        );
        await sql(
          ".wiscode/auth.db",
          "SELECT project_id AS id FROM projects",
          expectedProjects,
        );
        for (const root of [
          ".wiscode/claude/projects",
          ".wiscode/claude-agents/projects",
        ])
          for (const f of await files(path.join(home, root), ".jsonl"))
            expectedFiles.add(f);
      } else if (source === "CopilotCode") {
        for (const root of [
          ".roo-cline/globalStorage/ultra-ai.copilotcodepro/tasks",
          "Library/Application Support/Code/User/globalStorage/geelib-copilot-code.copilotcodepro/tasks",
        ])
          for (const f of await files(
            path.join(home, root),
            "ui_messages.json",
          )) {
            expected.add(path.basename(path.dirname(f)));
            expectedFiles.add(f);
            checked = true;
          }
        const database = path.join(
          home,
          "Library/Application Support/Code/User/globalStorage/state.vscdb",
        );
        if (await exists(database))
          await sourceDatabase(database, (db) => {
            for (const key of [
              "geelib-copilot-code.copilotcodepro",
              "Geelib-Copilot-Code.CopilotCodePro",
            ]) {
              const r = db
                .prepare("SELECT value FROM ItemTable WHERE key=?")
                .get(key);
              if (r)
                for (const t of JSON.parse(String(r.value)).taskHistory || [])
                  expected.add(String(t.id));
            }
          });
      } else if (source === "DeepSeekHarness") {
        for (const f of await files(
          path.join(home, ".dsh/sessions"),
          ".zstd",
        )) {
          expected.add(path.basename(path.dirname(f)));
          expectedFiles.add(f);
          checked = true;
        }
        for (const f of await files(
          path.join(home, ".dsh/storages/session_projcache/sessions"),
          ".json",
        ))
          expected.add(path.basename(f, ".json"));
        const file = path.join(home, ".dsh/storages/workspace.json");
        if (await exists(file)) {
          const d = JSON.parse(await fs.readFile(file, "utf8"));
          for (const id of Object.keys(d.tables?.workspaces || {}))
            expectedProjects.add(id);
        }
      } else if (source === "Cursor")
        await sql(
          "Library/Application Support/Cursor/User/globalStorage/state.vscdb",
          "SELECT substr(key,14) AS id FROM cursorDiskKV WHERE substr(key,1,13)='composerData:'",
          expected,
        );
      else if (source === "VSCode") {
        const root = path.join(
          home,
          "Library/Application Support/Code/User/workspaceStorage",
        );
        for (const f of await files(root, "workspace.json"))
          expectedProjects.add(path.basename(path.dirname(f)));
        for (const f of [
          ...(await files(root, ".json")),
          ...(await files(root, ".jsonl")),
        ])
          if (f.includes(`${path.sep}chatSessions${path.sep}`)) {
            expected.add(path.basename(f).replace(/\.jsonl?$/, ""));
            expectedFiles.add(f);
            checked = true;
          }
        for (const file of await files(root, "state.vscdb"))
          await sourceDatabase(file, (db) => {
            const row = db
              .prepare(
                "SELECT value FROM ItemTable WHERE key='chat.ChatSessionStore.index'",
              )
              .get();
            if (!row) return;
            const d = JSON.parse(String(row.value));
            for (const [id, t] of Object.entries(d.entries || {}))
              expected.add(String((t as any).sessionId || id));
          });
      }
    } catch (e) {
      inventoryError = e instanceof Error ? e.message : String(e);
    }
    const scan = await new HistorySources(home).scan(source),
      actual = new Set(scan.tasks.map((t) => t.nativeId)),
      nativeProjects = new Set(scan.projects.flatMap((p) => p.nativeIds || [])),
      actualFiles = new Set(
        scan.tasks.flatMap((t) => (t.locator.files || []).map((f) => f.path)),
      );
    const missing = [...expected].filter((id) => !actual.has(id)),
      missingProjects = [...expectedProjects].filter(
        (id) => !nativeProjects.has(id),
      ),
      missingFiles = [...expectedFiles].filter((f) => !actualFiles.has(f));
    const row: any = {
      source,
      nativeInventory: checked && !inventoryError ? "checked" : "unverified",
      nativeSessions: expected.size,
      indexedSessions: scan.tasks.length,
      indexedProjects: scan.projects.length,
      missingSessions: missing.length,
      missingNativeProjects: missingProjects.length,
      missingNativeFiles: missingFiles.length,
      passed:
        checked &&
        !inventoryError &&
        !missing.length &&
        !missingProjects.length &&
        !missingFiles.length,
      gaps: scan.coverage.gaps,
      ...(inventoryError ? { inventoryError } : {}),
    };
    // Details remain in the private local report, never conversation bodies or credentials.
    await fs.writeFile(
      path.join(output, `${source}-difference.json`),
      JSON.stringify(
        {
          missingSessionIds: missing,
          missingProjectIds: missingProjects,
          missingFilePaths: missingFiles,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    if (context && scan.tasks.length) {
      const service = new HistoryService(
        path.join(output, "owned-index"),
        home,
      );
      try {
        row.context = await service.verify(source);
      } catch (e) {
        row.context = {
          error: e instanceof Error ? e.message : String(e),
          complete: false,
        };
      } finally {
        service.close();
      }
    }
    rows.push(row);
    console.log(JSON.stringify(row));
    await fs.writeFile(
      path.join(output, "report.json"),
      JSON.stringify(
        {
          at: new Date().toISOString(),
          home,
          mode: context
            ? "metadata and all contexts"
            : "independent metadata inventory",
          results: rows,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }
  console.log(
    JSON.stringify({
      output,
      metadataPassed: rows
        .filter((r) => r.nativeInventory === "checked")
        .every((r) => r.passed),
      unverified: rows
        .filter((r) => r.nativeInventory !== "checked")
        .map((r) => r.source),
    }),
  );
  if (rows.some((r) => r.nativeInventory === "checked" && !r.passed))
    process.exitCode = 1;
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
