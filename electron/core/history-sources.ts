/** Source-owned project/session metadata. No original CLI, model call or source mutation. */
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { Readable } from "node:stream";
import { FramedZstd } from "./history-context";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import type {
  HandoffSource,
  SourceProject,
} from "../../src/shared/handoff-api";
import type {
  HistoryRecord,
  HistoryScan,
  HistoryKind,
  HistoryLocator,
} from "../../src/shared/history";
import { sanitizer } from "../../src/shared/handoff";
import {
  entries,
  walk,
  exists,
  json,
  head,
  headRecords,
  sourceDatabase,
  tables,
  columns,
  identifier,
  object,
  str,
  missing,
  hash,
  fileChunks,
} from "./history-io";

const opaque = (v: unknown) =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= 4096 &&
  !/[\x00-\x1f\x7f]/.test(v);
const directoryId = (instance: string, dir: string) =>
  `project_${hash(`${instance}\0${path.normalize(dir)}`).slice(0, 40)}`;
const taskId = (instance: string, id: string) =>
  `history_${hash(`${instance}\0${id}`).slice(0, 48)}`;
const time = (v: unknown) =>
  typeof v === "number" ? v : Number(v) || Date.parse(str(v)) || 0;
function field(
  db: DatabaseSync,
  table: string,
  name: string,
  fallback = "NULL",
) {
  return columns(db, table).has(name)
    ? identifier(name)
    : `${fallback} AS ${identifier(name)}`;
}
export interface HistoryRoots {
  [source: string]: string[];
}
export class HistorySources {
  constructor(
    readonly home = os.homedir(),
    readonly extra: HistoryRoots = {},
  ) {}
  async scan(source: HandoffSource): Promise<HistoryScan> {
    const tasks = new Map<string, HistoryRecord>(),
      projects = new Map<string, SourceProject>(),
      projectInstances = new Map<string, string>(),
      gaps: string[] = [];
    let nativeProjects = false,
      stores = 0;
    const clean = sanitizer();
    const instance = (root: string, engine = "") =>
      `${source}:${hash(root).slice(0, 20)}:${engine}`;
    const project = (
      inst: string,
      id: string,
      name: string,
      dirs: string[],
      registered = true,
      reuseRoots = false,
    ) => {
      const matches = reuseRoots
        ? [...projects.values()].filter(
            (p) =>
              projectInstances.get(p.id) === inst &&
              p.registered &&
              p.directories.some((d) => dirs.includes(d)),
          )
        : [];
      const alias =
        matches.length === 1
          ? matches[0]
          : matches.find((p) => p.name === name);
      const key =
        alias?.id ||
        (registered
          ? `project_${hash(`${inst}\0${id}`).slice(0, 40)}`
          : directoryId(inst, dirs[0] || ""));
      const previous = projects.get(key);
      projects.set(key, {
        id: key,
        name:
          alias?.name ||
          clean.clean(name || path.basename(dirs[0] || "") || "未关联项目"),
        directories: [
          ...new Set([
            ...(previous?.directories || []),
            ...dirs.filter(Boolean),
          ]),
        ],
        registered,
        count: 0,
        nativeIds: [
          ...new Set([
            ...(previous?.nativeIds || []),
            ...(registered ? [id] : []),
          ]),
        ],
        instance: inst,
      });
      projectInstances.set(key, inst);
      return key;
    };
    const add = (
      inst: string,
      nativeId: string,
      title: string,
      dir: string,
      updated: number,
      locator: HistoryLocator,
      options: Partial<HistoryRecord> = {},
    ) => {
      if (!opaque(nativeId)) {
        gaps.push("存在无法识别身份的来源记录，未计入完整覆盖。");
        return;
      }
      let projectId = options.projectId;
      if (!projectId) {
        const matches = [...projects.values()].filter(
          (p) =>
            projectInstances.get(p.id) === inst && p.directories.includes(dir),
        );
        if (matches.length === 1) projectId = matches[0].id;
        else
          projectId = project(
            inst,
            "",
            path.basename(dir) || "未关联项目",
            dir ? [dir] : [],
            false,
          );
      }
      const id = taskId(inst, nativeId);
      const value: HistoryRecord = {
        id,
        nativeId,
        instance: inst,
        title: clean.clean(title || "无标题对话"),
        directory: clean.clean(dir),
        updated,
        kind: "conversation",
        available: true,
        locator,
        ...options,
        projectId,
      };
      if (options.parentId) value.parentId = taskId(inst, options.parentId);
      tasks.set(id, value);
    };
    const attempt = async (label: string, run: () => Promise<void>) => {
      try {
        await run();
      } catch (e) {
        if (!missing(e))
          gaps.push(
            `${label}：${e instanceof Error ? e.message : "来源读取失败"}`,
          );
      }
    };
    const bases = (name: string, defaults: string[]) => [
      ...new Set([...defaults, ...(this.extra[name] || [])]),
    ];
    const kind = (r: Record<string, any>): HistoryKind =>
      r.deleted || r.time_deleted || r.cli_deleted
        ? "deleted"
        : r.archived || r.time_archived
          ? "archived"
          : r.parent_id || r.isSidechain
            ? "subagent"
            : r.is_background_automation ||
                (r.task_type && r.task_type !== "interactive")
              ? "automation"
              : "conversation";
    const fileRef = (file: string, root: string, format?: "zstd" | "raw") => ({
      path: file,
      root,
      format:
        format ||
        ((/\.zst(?:d)?$/.test(file) ? "zstd" : "raw") as "zstd" | "raw"),
    });
    const logHead = async (file: string, root: string) => {
      if (!/\.zst(?:d)?$/.test(file)) return head(file);
      const input = Readable.from(fileChunks(file, root)),
        decoded = input.pipe(new FramedZstd());
      const parts: Buffer[] = [];
      let size = 0;
      try {
        for await (const chunk of decoded) {
          const part = Buffer.from(chunk).subarray(0, 128 * 1024 - size);
          parts.push(part);
          size += part.length;
          if (size >= 128 * 1024) break;
        }
        return Buffer.concat(parts).toString("utf8");
      } finally {
        input.destroy();
        decoded.destroy();
      }
    };

    const scanClaude = async (root: string) => {
      const inst = instance(root, "claude"),
        list = await entries(root);
      if (!list.length) return;
      stores++;
      const configFiles = [
        path.join(path.dirname(root), ".claude.json"),
        ...(source === "ClaudeCode"
          ? [path.join(this.home, ".claude.json")]
          : []),
      ];
      for (const f of configFiles)
        if (await exists(f)) {
          const config = await json(f);
          if (object(config.projects)) {
            nativeProjects = true;
            for (const dir of Object.keys(config.projects))
              if (path.isAbsolute(dir))
                project(inst, dir, path.basename(dir), [dir]);
          }
        }
      for await (const f of walk(root)) {
        if (!f.endsWith(".jsonl")) continue;
        await attempt(`Claude ${path.basename(f)}`, async () => {
          const records = headRecords(await head(f)),
            identity = records.find((r) => opaque(r.sessionId)),
            user = records.find((r) => r.type === "user" && object(r.message));
          const native = path.basename(f, ".jsonl");
          const dir =
            str(identity?.cwd) || str(records.find((r) => r.cwd)?.cwd);
          const content = user?.message?.content,
            text =
              typeof content === "string"
                ? content
                : Array.isArray(content)
                  ? content
                      .filter(object)
                      .filter((p) => p.type === "text")
                      .map((p) => str(p.text))
                      .join(" ")
                  : "";
          const sub =
            records.some((r) => r.isSidechain) || native.startsWith("agent-");
          add(
            inst,
            native,
            str(records.filter((r) => r.type === "ai-title").at(-1)?.aiTitle) ||
              text.replace(/\s+/g, " ").slice(0, 500),
            dir,
            (await fs.stat(f)).mtimeMs,
            { files: [fileRef(f, root)], engine: "claude" },
            {
              kind: sub ? "subagent" : "conversation",
              parentId: sub ? str(identity?.sessionId) || undefined : undefined,
            },
          );
        });
      }
    };
    const scanCodex = async (root: string) => {
      const inst = instance(root, "codex"),
        files = await entries(root),
        candidates = files
          .filter((e) => e.isFile() && /^state_\d+\.sqlite$/.test(e.name))
          .sort(
            (a, b) =>
              Number(b.name.match(/\d+/)![0]) - Number(a.name.match(/\d+/)![0]),
          );
      const dbfile = candidates[0] && path.join(root, candidates[0].name),
        historyFile = path.join(root, "thread_history_1.sqlite");
      // Desktop projects may contain empty projects and custom labels.
      await attempt("Codex 项目登记", async () => {
        const file = path.join(root, ".codex-global-state.json");
        if (!(await exists(file))) return;
        const state = await json(file),
          persisted = state["electron-persisted-atom-state"] || {},
          values = state["local-projects"] || persisted["local-projects"] || {};
        for (const [id, v] of Object.entries(values))
          if (object(v) && Array.isArray(v.rootPaths)) {
            project(
              inst,
              str(v.id) || id,
              str(v.name),
              v.rootPaths.filter((v: unknown) => typeof v === "string"),
            );
            nativeProjects = true;
          }
        for (const dir of state["electron-saved-workspace-roots"] ||
          persisted["electron-saved-workspace-roots"] ||
          [])
          if (typeof dir === "string")
            project(inst, dir, path.basename(dir), [dir], true, true);
      });
      if (dbfile)
        await attempt("Codex 状态索引", async () => {
          stores++;
          await sourceDatabase(dbfile, (db) => {
            const ts = tables(db),
              native = new Map<string, string>();
            if (ts.has("projects") && ts.has("project_roots")) {
              nativeProjects = true;
              for (const r of db
                .prepare(
                  "SELECT p.id,p.name,r.path FROM projects p LEFT JOIN project_roots r ON r.project_id=p.id",
                )
                .iterate())
                native.set(
                  String(r.id),
                  project(
                    inst,
                    String(r.id),
                    str(r.name),
                    [str(r.path)],
                    true,
                    true,
                  ),
                );
            }
            if (!ts.has("threads")) {
              gaps.push("Codex 数据库缺少 threads，需适配当前版本。");
              return;
            }
            const cs = columns(db, "threads");
            if (!cs.has("id")) {
              gaps.push("Codex 会话索引缺少 ID。");
              return;
            }
            for (const r of db.prepare("SELECT * FROM threads").iterate()) {
              const k: HistoryKind = r.archived
                ? "archived"
                : /guardian|subagent|review|compact/i.test(
                      `${r.source} ${r.thread_source}`,
                    )
                  ? "subagent"
                  : r.thread_source === "automation"
                    ? "automation"
                    : "conversation";
              add(
                inst,
                String(r.id),
                str(r.name) || str(r.title) || str(r.preview),
                str(r.cwd),
                Number(r.updated_at_ms) || Number(r.updated_at) * 1000 || 0,
                {
                  database: dbfile,
                  table: "threads",
                  idColumn: "id",
                  historyDatabase: historyFile,
                  engine: "codex",
                  paginated: r.history_mode === "paginated",
                  files: str(r.rollout_path)
                    ? [fileRef(str(r.rollout_path), root)]
                    : [],
                },
                { kind: k, projectId: native.get(str(r.project_id)) },
              );
            }
          });
        });
      // Include logs missing from a state index, plus archived logs; never require a state DB.
      for (const name of ["sessions", "archived_sessions"]) {
        const logs = path.join(root, name);
        for await (const f of walk(logs)) {
          if (!/\.jsonl(?:\.zst(?:d)?)?$/.test(f)) continue;
          const filenameId = path
            .basename(f)
            .match(
              /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl/i,
            )?.[1];
          const indexed = filenameId
            ? tasks.get(taskId(inst, filenameId))
            : undefined;
          if (indexed) {
            const refs = (indexed.locator.files ||= []);
            if (!refs.some((ref) => ref.path === f))
              refs.push(fileRef(f, root));
            continue;
          }
          await attempt("Codex 日志", async () => {
            const records = headRecords(await logHead(f, root)),
              meta = records.find((r) => r.type === "session_meta")?.payload;
            if (!object(meta) || !opaque(meta.id)) {
              gaps.push(`Codex 日志缺少可读取的身份：${path.basename(f)}`);
              return;
            }
            // Fork logs can begin with copied parent metadata. Their final
            // filename UUID identifies the fork; preserve both identities.
            const logId = filenameId || meta.id;
            const existing = tasks.get(taskId(inst, logId));
            if (existing) {
              const refs = (existing.locator.files ||= []);
              if (!refs.some((ref) => ref.path === f))
                refs.push(fileRef(f, root));
              return;
            }
            const ask = records.find(
              (r) =>
                r.type === "event_msg" && r.payload?.type === "user_message",
            )?.payload?.message;
            add(
              inst,
              logId,
              str(ask).replace(/\s+/g, " ").slice(0, 500),
              str(meta.cwd),
              (await fs.stat(f)).mtimeMs,
              {
                files: [fileRef(f, root)],
                engine: "codex",
                ...(logId !== meta.id
                  ? {
                      metadata: {
                        originalSessionId: meta.id,
                        forkSessionId: logId,
                      },
                    }
                  : {}),
              },
              {
                parentId: logId !== meta.id ? taskId(inst, meta.id) : undefined,
                kind:
                  name === "archived_sessions"
                    ? "archived"
                    : /subagent|guardian|review/i.test(
                          JSON.stringify(meta.source),
                        )
                      ? "subagent"
                      : "orphan",
              },
            );
          });
        }
      }
    };

    if (source === "ZCode")
      for (const root of bases(source, [path.join(this.home, ".zcode")]))
        await attempt("ZCode", async () => {
          const cli = path.join(root, "cli/db/db.sqlite"),
            client = path.join(root, "v2/tasks-index.sqlite"),
            local = instance(root, "local"),
            metadata = new Map<string, Record<string, any>>(),
            projectIds = new Map<string, string>();
          if (await exists(client))
            await sourceDatabase(client, (db) => {
              stores++;
              const ts = tables(db);
              if (ts.has("projects") && ts.has("project_roots")) {
                nativeProjects = true;
                const roots = new Map<string, string[]>();
                for (const r of db
                  .prepare("SELECT project_id,root_path FROM project_roots")
                  .iterate()) {
                  const id = String(r.project_id);
                  roots.set(id, [...(roots.get(id) || []), str(r.root_path)]);
                }
                for (const r of db.prepare("SELECT * FROM projects").iterate())
                  projectIds.set(
                    `${r.host_id || "local"}:${r.project_id}`,
                    project(
                      instance(root, String(r.host_id || "local")),
                      String(r.project_id),
                      str(r.name),
                      roots.get(String(r.project_id)) || [],
                    ),
                  );
              }
              if (ts.has("tasks"))
                for (const r of db.prepare("SELECT * FROM tasks").iterate())
                  metadata.set(`${r.host_id || "local"}:${r.task_id}`, r);
            });
          if (await exists(cli))
            await sourceDatabase(cli, (db) => {
              stores++;
              if (!tables(db).has("session"))
                throw new Error("ZCode 会话表尚未适配。");
              for (const r of db.prepare("SELECT * FROM session").iterate()) {
                const c = metadata.get(`local:${r.id}`) || {},
                  deleted = kind({ ...r, ...c });
                add(
                  local,
                  String(r.id),
                  str(c.title) || str(r.title),
                  str(c.workspace_path) || str(r.directory),
                  Number(r.time_updated) || time(c.updated_at),
                  {
                    database: cli,
                    table: "session",
                    idColumn: "id",
                    related: [
                      "message",
                      "part",
                      "todo",
                      "session_entry",
                      "session_task_link",
                    ],
                    engine: "zcode",
                  },
                  {
                    kind: deleted,
                    parentId: str(r.parent_id) || undefined,
                    projectId: projectIds.get(
                      `local:${c.project_id || r.project_id}`,
                    ),
                    available: deleted !== "deleted",
                  },
                );
              }
            });
          for (const c of metadata.values()) {
            const host = String(c.host_id || "local"),
              inst = instance(root, host);
            if (tasks.has(taskId(inst, String(c.task_id)))) continue;
            const remote = host !== "local";
            add(
              inst,
              String(c.task_id),
              str(c.title),
              str(c.workspace_path),
              time(c.updated_at),
              {
                database: client,
                table: "tasks",
                idColumn: "task_id",
                engine: "zcode-draft",
              },
              {
                kind:
                  kind(c) === "deleted"
                    ? "deleted"
                    : c.archived
                      ? "archived"
                      : "draft",
                projectId: projectIds.get(`${host}:${c.project_id}`),
                available: !remote,
              },
            );
            if (remote)
              gaps.push(`ZCode 主机 ${host} 未连接，正文无法在本机核验。`);
          }
        });
    else if (source === "OpenCode")
      for (const root of bases(source, [
        path.join(this.home, ".local/share/opencode"),
        ...(process.env.XDG_DATA_HOME
          ? [path.join(process.env.XDG_DATA_HOME, "opencode")]
          : []),
      ]))
        await attempt("OpenCode", async () => {
          const file = path.join(root, "opencode.db"),
            inst = instance(root);
          if (!(await exists(file))) return;
          stores++;
          await sourceDatabase(file, (db) => {
            const ts = tables(db),
              ps = new Map<string, string>();
            if (ts.has("project")) {
              nativeProjects = true;
              const dirs = new Map<string, string[]>();
              if (ts.has("project_directory"))
                for (const r of db
                  .prepare("SELECT project_id,directory FROM project_directory")
                  .iterate())
                  dirs.set(String(r.project_id), [
                    ...(dirs.get(String(r.project_id)) || []),
                    str(r.directory),
                  ]);
              for (const r of db.prepare("SELECT * FROM project").iterate())
                ps.set(
                  String(r.id),
                  project(
                    inst,
                    String(r.id),
                    str(r.name) || path.basename(str(r.worktree)),
                    [str(r.worktree), ...(dirs.get(String(r.id)) || [])],
                  ),
                );
            }
            for (const table of ["session", "session_v2"]) {
              if (!ts.has(table)) continue;
              for (const r of db
                .prepare(`SELECT * FROM ${identifier(table)}`)
                .iterate())
                add(
                  inst,
                  String(r.id),
                  str(r.title),
                  str(r.directory),
                  Number(r.time_updated) || 0,
                  {
                    database: file,
                    table,
                    idColumn: "id",
                    related: [
                      "session_message",
                      "message",
                      "part",
                      "todo",
                      "session_inbox",
                      "session_pending",
                    ],
                    engine: "opencode",
                  },
                  {
                    kind: kind(r),
                    parentId:
                      str(r.parent_id) || str(r.fork_session_id) || undefined,
                    projectId: ps.get(str(r.project_id)),
                  },
                );
            }
          });
        });
    else if (source === "ClaudeCode") {
      for (const root of bases(source, [path.join(this.home, ".claude")]))
        await attempt("Claude Code", () =>
          scanClaude(path.join(root, "projects")),
        );
      if (!nativeProjects)
        gaps.push(
          "Claude Code 尚无已验证的独立项目登记；当前保留完整历史目录。",
        );
    } else if (source === "Codex")
      for (const root of bases(source, [path.join(this.home, ".codex")]))
        await attempt("Codex", () => scanCodex(root));
    else if (source === "WisCode") {
      for (const root of bases(source, [path.join(this.home, ".wiscode")])) {
        for (const name of ["claude", "claude-agents"])
          await attempt(`WisCode ${name}`, () =>
            scanClaude(path.join(root, name, "projects")),
          );
        await attempt("WisCode Codex", () =>
          scanCodex(path.join(root, "codex-agents")),
        );
        const native = path.join(root, "auth.db"),
          inst = instance(root, "native"),
          projectIds = new Map<string, string>(),
          remapped = new Map<string, string>();
        if (await exists(native))
          await attempt("WisCode 原生项目和会话登记", async () =>
            sourceDatabase(native, (db) => {
              const ts = tables(db);
              if (ts.has("projects")) {
                nativeProjects = true;
                for (const r of db
                  .prepare(
                    "SELECT project_id,project_path,custom_project_name,location_kind,remote_host_id FROM projects",
                  )
                  .iterate()) {
                  const dir = str(r.project_path),
                    pid = project(
                      inst,
                      String(r.project_id),
                      str(r.custom_project_name) || path.basename(dir),
                      dir ? [dir] : [],
                    );
                  projectIds.set(dir, pid);
                  if (r.remote_host_id)
                    gaps.push(
                      "WisCode 存在远端项目，其正文需连接对应主机后核验。",
                    );
                }
              }
              const bindings = new Map<string, Record<string, any>>();
              if (ts.has("session_runtime_bindings"))
                for (const r of db
                  .prepare(
                    "SELECT session_id,native_session_id,runtime_canonical_path FROM session_runtime_bindings",
                  )
                  .iterate())
                  bindings.set(String(r.session_id), r);
              if (ts.has("sessions"))
                for (const r of db
                  .prepare(
                    "SELECT session_id,provider,provider_thread_id,custom_name,project_path,jsonl_path,isArchived,updated_at,created_at FROM sessions",
                  )
                  .iterate()) {
                  const b = bindings.get(String(r.session_id)) || {},
                    nativeId =
                      str(b.native_session_id) ||
                      str(r.provider_thread_id) ||
                      String(r.session_id),
                    canonical =
                      str(b.runtime_canonical_path) || str(r.jsonl_path);
                  const matches = [...tasks.values()].filter(
                    (t) =>
                      !t.instance.endsWith(":native") &&
                      t.locator.engine === r.provider &&
                      (t.nativeId === nativeId ||
                        t.nativeId === r.session_id ||
                        (canonical &&
                          t.locator.files?.some(
                            (f) => f.path === canonical,
                          ))) &&
                      t.instance.startsWith("WisCode:"),
                  );
                  const primary =
                    matches.find(
                      (t) =>
                        canonical &&
                        t.locator.files?.some((f) => f.path === canonical),
                    ) || matches[0];
                  // WisCode may bind an existing conversation in the native
                  // Claude/Codex store. Keep the scope within verified agent roots.
                  const knownRoot =
                    [
                      path.join(this.home, ".claude/projects"),
                      path.join(this.home, ".codex/sessions"),
                      path.join(this.home, ".codex/archived_sessions"),
                    ].find((base) => canonical.startsWith(base + path.sep)) ||
                    root;
                  const locator: HistoryLocator = primary
                    ? { ...primary.locator }
                    : {
                        files: canonical ? [fileRef(canonical, knownRoot)] : [],
                        engine: str(r.provider),
                      };
                  locator.metadataDatabase = native;
                  locator.metadataId = String(r.session_id);
                  locator.metadataTables = [
                    "sessions",
                    "session_runtime_bindings",
                    "message_metadata",
                    "artifact_messages",
                    "artifact_annotations",
                    "goal_completion_messages",
                    "design_deployment_messages",
                    "session_turn_checkpoints",
                    "session_imports",
                    "agent_v2_session_migrations",
                  ];
                  if (matches.length > 1)
                    locator.files = [
                      ...new Map(
                        matches
                          .flatMap((t) => t.locator.files || [])
                          .map((f) => [f.path, f]),
                      ).values(),
                    ];
                  const id = taskId(inst, String(r.session_id));
                  for (const t of matches) {
                    tasks.delete(t.id);
                    remapped.set(t.id, id);
                  }
                  add(
                    inst,
                    String(r.session_id),
                    str(r.custom_name) || primary?.title || "无标题对话",
                    str(r.project_path) || primary?.directory || "",
                    time(r.updated_at) ||
                      primary?.updated ||
                      time(r.created_at),
                    locator,
                    {
                      kind: r.isArchived
                        ? "archived"
                        : primary?.kind || "conversation",
                      available: !!primary || !!canonical,
                      projectId: projectIds.get(str(r.project_path)),
                    },
                  );
                }
              for (const t of tasks.values())
                if (t.instance.startsWith("WisCode:")) {
                  if (
                    !t.instance.endsWith(":native") &&
                    t.kind === "conversation"
                  )
                    t.kind = "orphan";
                  if (projectIds.has(t.directory))
                    t.projectId = projectIds.get(t.directory);
                  if (t.parentId && remapped.has(t.parentId))
                    t.parentId = remapped.get(t.parentId);
                }
            }),
          );
      }
      if (!nativeProjects)
        gaps.push(
          "WisCode 独立项目登记尚不可取得；按各引擎来源实例保留完整历史目录。",
        );
    } else if (source === "WorkBuddy")
      for (const root of bases(source, [path.join(this.home, ".workbuddy")]))
        await attempt("WorkBuddy", async () => {
          const inst = instance(root),
            files = new Map<string, string[]>();
          for await (const f of walk(path.join(root, "projects")))
            if (f.endsWith(".jsonl"))
              files.set(path.basename(f, ".jsonl"), [
                ...(files.get(path.basename(f, ".jsonl")) || []),
                f,
              ]);
          const file = path.join(root, "workbuddy.db");
          if (await exists(file))
            await sourceDatabase(file, (db) => {
              stores++;
              const ts = tables(db);
              if (ts.has("workspaces")) {
                nativeProjects = true;
                for (const r of db
                  .prepare("SELECT * FROM workspaces")
                  .iterate())
                  project(inst, str(r.path), path.basename(str(r.path)), [
                    str(r.path),
                  ]);
              }
              if (!ts.has("sessions"))
                throw new Error("WorkBuddy 会话表尚未适配。");
              for (const r of db.prepare("SELECT * FROM sessions").iterate()) {
                const refs = files.get(String(r.id)) || [];
                add(
                  inst,
                  String(r.id),
                  str(r.custom_title) || str(r.title),
                  str(r.cwd),
                  time(r.updated_at),
                  {
                    database: file,
                    table: "sessions",
                    idColumn: "id",
                    files: refs.map((f) => fileRef(f, root)),
                    engine: "workbuddy",
                  },
                  {
                    kind: r.deleted_at ? "deleted" : kind(r),
                    available: refs.length > 0 && !r.deleted_at,
                  },
                );
                if (refs.length > 1)
                  gaps.push(
                    `WorkBuddy ${r.id} 存在多个正文路径，保留所有来源副本。`,
                  );
              }
            });
          for (const [id, refs] of files)
            if (!tasks.has(taskId(inst, id)))
              await attempt("WorkBuddy 独立日志", async () => {
                const records = headRecords(await head(refs[0])),
                  meta = records.find((r) => r.cwd),
                  msg = records.find((r) => r.role === "user");
                add(
                  inst,
                  id,
                  typeof msg?.content === "string" ? msg.content : "独立日志",
                  str(meta?.cwd),
                  (await fs.stat(refs[0])).mtimeMs,
                  {
                    files: refs.map((f) => fileRef(f, root)),
                    engine: "workbuddy",
                  },
                  { kind: id.startsWith("agent-") ? "subagent" : "orphan" },
                );
              });
          for (const r of tasks.values())
            if (r.instance === inst) {
              const todo = path.join(root, "tasks", r.nativeId);
              for await (const f of walk(todo))
                if (f.endsWith(".json"))
                  r.locator.files!.push(fileRef(f, root));
            }
        });
    else if (source === "CopilotCode") {
      const app =
        process.platform === "darwin"
          ? path.join(this.home, "Library/Application Support/Code/User")
          : process.platform === "win32"
            ? path.join(process.env.APPDATA || this.home, "Code/User")
            : path.join(this.home, ".config/Code/User");
      const locations = [
        {
          root: path.join(
            this.home,
            ".roo-cline/globalStorage/ultra-ai.copilotcodepro",
          ),
          state: "",
        },
        {
          root: path.join(
            app,
            "globalStorage/geelib-copilot-code.copilotcodepro",
          ),
          state: path.join(app, "globalStorage/state.vscdb"),
        },
        ...(this.extra[source] || []).map((root) => ({ root, state: "" })),
      ];
      for (const { root, state } of locations)
        await attempt("极库 Copilot Code", async () => {
          const inst = instance(root),
            index = new Map<string, Record<string, any>>();
          let hasIndex = false;
          if (state && (await exists(state)))
            await sourceDatabase(state, (db) => {
              if (!tables(db).has("ItemTable")) return;
              for (const key of [
                "geelib-copilot-code.copilotcodepro",
                "Geelib-Copilot-Code.CopilotCodePro",
              ]) {
                const row = db
                  .prepare("SELECT value FROM ItemTable WHERE key=?")
                  .get(key);
                if (!row) continue;
                const data = JSON.parse(String(row.value));
                if (!Array.isArray(data.taskHistory)) continue;
                hasIndex = true;
                nativeProjects = true;
                for (const r of data.taskHistory)
                  if (object(r) && opaque(r.id)) index.set(r.id, r);
              }
            });
          const dirs = await entries(path.join(root, "tasks"));
          if (dirs.length) stores++;
          for (const e of dirs) {
            if (!e.isDirectory()) continue;
            const folder = path.join(root, "tasks", e.name),
              r = index.get(e.name) || {},
              refs = [];
            for (const name of [
              "ui_messages.json",
              "api_conversation_history.json",
              "task_metadata.json",
            ]) {
              const file = path.join(folder, name);
              if (await exists(file)) refs.push(fileRef(file, root));
            }
            if (!refs.length) continue;
            const dir =
              str(r.workspace) || str(r.cwdOnTaskInitialization) || str(r.cwd);
            const pid = dir
              ? project(inst, dir, path.basename(dir), [dir])
              : undefined;
            add(
              inst,
              e.name,
              str(r.task),
              dir,
              time(r.ts) || (await fs.stat(refs[0].path)).mtimeMs,
              { files: refs, engine: "copilot" },
              {
                kind:
                  hasIndex && !index.has(e.name) ? "orphan" : "conversation",
                projectId: pid,
              },
            );
          }
          for (const [id, r] of index)
            if (!tasks.has(taskId(inst, id))) {
              const dir = str(r.workspace) || str(r.cwdOnTaskInitialization);
              add(
                inst,
                id,
                str(r.task),
                dir,
                time(r.ts),
                { engine: "copilot" },
                { available: false },
              );
              gaps.push(`极库 Copilot Code ${id} 原生索引存在但本地正文缺失。`);
            }
          if (!hasIndex && dirs.length)
            gaps.push(
              "极库 Copilot Code 独立宿主未提供已验证任务索引；项目归属及原生活动状态待核验。",
            );
        });
    } else if (source === "DeepSeekHarness")
      for (const root of bases(source, [path.join(this.home, ".dsh")]))
        await attempt("DeepSeek Harness", async () => {
          const inst = instance(root),
            nativeIds = new Map<string, string>(),
            archived = new Set<string>();
          const folders = new Map<string, string>();
          const registry = path.join(root, "storages/workspace.json");
          if (await exists(registry)) {
            const d = await json(registry);
            if (object(d.tables?.workspaces)) {
              nativeProjects = true;
              for (const [id, r] of Object.entries(d.tables.workspaces))
                if (object(r)) {
                  const pid = project(inst, id, str(r.title), [str(r.path)]);
                  for (const s of r.sessionIds || [])
                    if (typeof s === "string") nativeIds.set(s, pid);
                }
              for (const id of d.global?.archivedSessionIds || [])
                archived.add(String(id));
            }
          }
          for await (const f of walk(path.join(root, "sessions")))
            if (/session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(path.basename(f)))
              folders.set(path.basename(path.dirname(f)), f);
          const caches = new Map<string, string>();
          for (const e of await entries(
            path.join(root, "storages/session_projcache/sessions"),
          ))
            if (e.isFile() && e.name.endsWith(".json"))
              caches.set(
                e.name.slice(0, -5),
                path.join(root, "storages/session_projcache/sessions", e.name),
              );
          for (const id of new Set([...folders.keys(), ...caches.keys()]))
            await attempt("DeepSeek 会话", async () => {
              const cache = caches.has(id)
                  ? await json(caches.get(id)!)
                  : undefined,
                r = cache?.record,
                rows = r?.rows || {},
                meta = rows.sessionListMetadata?.val || {},
                body = folders.get(id);
              const refs = body
                ? [fileRef(body, root, body.endsWith(".zstd") ? "zstd" : "raw")]
                : [];
              if (caches.has(id)) refs.push(fileRef(caches.get(id)!, root));
              add(
                inst,
                id,
                str(rows.title?.val),
                str(r?.identity?.cwd),
                time(meta.lastPromptAt || r?.identity?.createdAt),
                { files: refs, engine: "dsh" },
                {
                  kind:
                    archived.has(id) ||
                    archived.has(id.replace(/^session-/, ""))
                      ? "archived"
                      : meta.blank
                        ? "draft"
                        : object(rows.subagent?.val) &&
                            Object.keys(rows.subagent.val).length
                          ? "subagent"
                          : "conversation",
                  available: !!body,
                  projectId:
                    nativeIds.get(id) ||
                    nativeIds.get(id.replace(/^session-/, "")),
                },
              );
              if (!cache)
                gaps.push(
                  `DeepSeek ${id} 缺少元数据缓存，需从日志恢复项目归属。`,
                );
            });
          if (folders.size || caches.size) stores++;
          if (!nativeProjects)
            gaps.push(
              "DeepSeek Harness 原生项目登记尚不可取得；当前保留完整会话历史目录。",
            );
        });
    else if (source === "VSCode") {
      const user =
        process.platform === "darwin"
          ? path.join(this.home, "Library/Application Support/Code/User")
          : process.platform === "win32"
            ? path.join(process.env.APPDATA || this.home, "Code/User")
            : path.join(this.home, ".config/Code/User");
      const externalLogs = new Map<string, string[]>();
      for (const profile of bases("ClaudeCode", [
        path.join(this.home, ".claude"),
      ]))
        for await (const f of walk(path.join(profile, "projects")))
          if (f.endsWith(".jsonl")) {
            const id = path.basename(f, ".jsonl");
            externalLogs.set(id, [...(externalLogs.get(id) || []), f]);
          }
      for (const userRoot of bases(source, [user]))
        for (const ws of await entries(
          path.join(userRoot, "workspaceStorage"),
        )) {
          if (!ws.isDirectory()) continue;
          await attempt("VS Code 工作区", async () => {
            const root = path.join(userRoot, "workspaceStorage", ws.name),
              inst = instance(root),
              meta = (await exists(path.join(root, "workspace.json")))
                ? await json(path.join(root, "workspace.json"))
                : {},
              uri = str(meta.folder) || str(meta.workspace);
            let dir = "";
            try {
              dir = uri.startsWith("file:") ? fileURLToPath(uri) : uri;
            } catch {
              gaps.push("VS Code 工作区 URI 无法解析。");
            }
            project(
              inst,
              ws.name,
              path.basename(dir) || ws.name,
              dir ? [dir] : [],
            );
            nativeProjects = true;
            const idx = new Map<string, Record<string, any>>(),
              dbfile = path.join(root, "state.vscdb");
            if (await exists(dbfile))
              await sourceDatabase(dbfile, (db) => {
                if (!tables(db).has("ItemTable")) return;
                const row = db
                  .prepare(
                    "SELECT value FROM ItemTable WHERE key='chat.ChatSessionStore.index'",
                  )
                  .get();
                if (!row) return;
                const v = JSON.parse(String(row.value));
                for (const [id, r] of Object.entries(v.entries || {}))
                  if (object(r)) idx.set(str(r.sessionId) || id, r);
              });
            const refs = new Map<string, string>();
            for await (const f of walk(path.join(root, "chatSessions")))
              if (/\.jsonl?$/.test(f))
                refs.set(path.basename(f).replace(/\.jsonl?$/, ""), f);
            for (const id of new Set([...idx.keys(), ...refs.keys()])) {
              const r = idx.get(id) || {},
                f = refs.get(id);
              const nativeExternal = id.startsWith("claude-code:/")
                  ? id.slice("claude-code:/".length)
                  : "",
                external = nativeExternal
                  ? externalLogs.get(nativeExternal) || []
                  : [];
              const externalFile =
                external.length === 1 ? external[0] : undefined;
              add(
                inst,
                id,
                str(r.title),
                dir,
                time(r.lastMessageDate),
                {
                  files: f
                    ? [fileRef(f, root)]
                    : externalFile
                      ? [
                          fileRef(
                            externalFile,
                            path.dirname(path.dirname(externalFile)),
                          ),
                        ]
                      : [],
                  engine: "vscode",
                  metadata: r,
                },
                {
                  kind: r.isEmpty
                    ? "draft"
                    : idx.has(id)
                      ? "conversation"
                      : "orphan",
                  available: !!f || !!externalFile || !!r.isEmpty,
                },
              );
            }
            if (idx.size || refs.size) stores++;
          });
        }
    } else if (source === "Cursor")
      for (const user of bases(source, [
        path.join(this.home, "Library/Application Support/Cursor/User"),
      ]))
        await attempt("Cursor", async () => {
          const dbfile = path.join(user, "globalStorage/state.vscdb"),
            inst = instance(user),
            headers = new Map<string, Record<string, any>>(),
            associations = new Map<
              string,
              { dir: string; projectId: string }
            >();
          if (!(await exists(dbfile))) return;
          stores++;
          for (const ws of await entries(path.join(user, "workspaceStorage"))) {
            if (!ws.isDirectory()) continue;
            await attempt("Cursor 工作区", async () => {
              const folder = path.join(user, "workspaceStorage", ws.name),
                meta = (await exists(path.join(folder, "workspace.json")))
                  ? await json(path.join(folder, "workspace.json"))
                  : {},
                uri = str(meta.folder) || str(meta.workspace);
              let dir = "";
              try {
                dir = uri.startsWith("file:") ? fileURLToPath(uri) : uri;
              } catch {
                gaps.push("Cursor 工作区 URI 不兼容。");
              }
              const projectId = project(
                inst,
                ws.name,
                path.basename(dir) || ws.name,
                dir ? [dir] : [],
              );
              nativeProjects = true;
              const state = path.join(folder, "state.vscdb");
              if (!(await exists(state))) return;
              await sourceDatabase(state, (db) => {
                if (!tables(db).has("ItemTable")) return;
                for (const key of [
                  "composer.composerData",
                  "composer.composerHeaders",
                ]) {
                  const row = db
                    .prepare("SELECT value FROM ItemTable WHERE key=?")
                    .get(key);
                  if (!row) continue;
                  const data = JSON.parse(String(row.value));
                  for (const r of data.allComposers || [])
                    if (object(r) && opaque(r.composerId)) {
                      headers.set(r.composerId, r);
                      associations.set(r.composerId, { dir, projectId });
                    }
                }
              });
            });
          }
          await sourceDatabase(dbfile, (db) => {
            const ts = tables(db);
            if (!ts.has("cursorDiskKV"))
              throw new Error("Cursor 缺少已验证的 cursorDiskKV 会话存储。");
            if (ts.has("ItemTable")) {
              const row = db
                .prepare(
                  "SELECT value FROM ItemTable WHERE key='composer.composerHeaders'",
                )
                .get();
              if (row) {
                const data = JSON.parse(String(row.value));
                for (const r of data.allComposers || [])
                  if (
                    object(r) &&
                    opaque(r.composerId) &&
                    !headers.has(r.composerId)
                  )
                    headers.set(r.composerId, r);
              }
            }
            for (const r of db
              .prepare(
                "SELECT key,json_extract(value,'$.composerId') AS composerId,json_extract(value,'$.name') AS name,json_extract(value,'$.createdAt') AS createdAt,json_extract(value,'$.lastUpdatedAt') AS lastUpdatedAt,json_extract(value,'$.isArchived') AS archived,json_extract(value,'$.isDraft') AS draft FROM cursorDiskKV WHERE substr(key,1,13)='composerData:'",
              )
              .iterate()) {
              const id = str(r.composerId) || String(r.key).slice(13),
                h = headers.get(id) || {},
                a = associations.get(id);
              add(
                inst,
                id,
                str(h.name) || str(r.name),
                a?.dir || "",
                time(h.lastUpdatedAt || r.lastUpdatedAt || r.createdAt),
                {
                  database: dbfile,
                  table: "cursorDiskKV",
                  idColumn: "key",
                  recordKey: String(r.key),
                  engine: "cursor",
                },
                {
                  kind: r.archived
                    ? "archived"
                    : r.draft
                      ? "draft"
                      : h.isBestOfNSubcomposer
                        ? "subagent"
                        : "conversation",
                  projectId: a?.projectId,
                },
              );
            }
            for (const [id, h] of headers)
              if (!tasks.has(taskId(inst, id))) {
                const a = associations.get(id);
                add(
                  inst,
                  id,
                  str(h.name),
                  a?.dir || "",
                  time(h.lastUpdatedAt || h.createdAt),
                  { engine: "cursor" },
                  { available: false, projectId: a?.projectId },
                );
                gaps.push(`Cursor ${id} 原生索引存在但正文未同步。`);
              }
          });
        });
    else if (source === "GeminiCLI")
      for (const root of bases(source, [path.join(this.home, ".gemini")]))
        await attempt("Gemini CLI", async () => {
          const inst = instance(root);
          for (const folder of ["sessions", "tmp"]) {
            for await (const f of walk(path.join(root, folder))) {
              if (
                !f.endsWith(".json") ||
                (folder === "tmp" && !f.includes(`${path.sep}chats${path.sep}`))
              )
                continue;
              const d = await json(f);
              if (!object(d)) continue;
              const id =
                  str(d.sessionId) || str(d.id) || path.basename(f, ".json"),
                dir = str(d.cwd) || str(d.projectPath);
              add(
                inst,
                id,
                str(d.title) || str(d.summary),
                dir,
                time(d.lastUpdated || d.updatedAt),
                { files: [fileRef(f, root)], engine: "gemini" },
              );
              stores++;
            }
          }
          gaps.push(
            "Gemini CLI 项目登记及当前版本记录结构尚未完成真实样本对账。",
          );
        });
    else {
      // Never advertise a discovered installation as a verified history adapter.
      const name = source === "Windsurf" ? "Windsurf" : "Trae";
      const user = path.join(
        this.home,
        "Library/Application Support",
        name,
        "User",
      );
      if ((await entries(user)).length)
        gaps.push(
          `${source} 已发现用户数据；原生项目、会话和上下文格式尚未验证，未将未知数据当作空历史。`,
        );
      else
        gaps.push(`${source} 尚无已验证的本地历史来源；可添加数据目录后适配。`);
    }
    // Native indexes can retain the original name after log compression.
    for (const task of tasks.values()) {
      for (const ref of task.locator.files || []) {
        if (await exists(ref.path)) continue;
        for (const suffix of [".zst", ".zstd"]) {
          if (await exists(ref.path + suffix)) {
            ref.path += suffix;
            ref.format = "zstd";
            break;
          }
        }
      }
      if (task.locator.files)
        task.locator.files = [
          ...new Map(task.locator.files.map((ref) => [ref.path, ref])).values(),
        ];
    }
    // Native project IDs take precedence; histories without registrations remain explicitly directory-derived.
    for (const p of projects.values()) p.count = 0;
    for (const r of tasks.values()) {
      const p = projects.get(r.projectId || "");
      if (p) p.count = (p.count || 0) + 1;
    }
    for (const [id, p] of projects)
      if (!p.registered && !p.count) projects.delete(id);
    const uniqueGaps = [...new Set(gaps)];
    return {
      tasks: [...tasks.values()],
      projects: [...projects.values()],
      coverage: {
        indexedAt: Date.now(),
        projects: nativeProjects && !uniqueGaps.length ? "complete" : "partial",
        sessions: uniqueGaps.length ? "partial" : "complete",
        context: "not-checked",
        attachments: "not-checked",
        sourceRecords: tasks.size,
        indexedRecords: tasks.size,
        gaps: uniqueGaps.length
          ? uniqueGaps
          : stores
            ? []
            : ["尚未发现此来源的本地记录。"],
      },
    };
  }
}
