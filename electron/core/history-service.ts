import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { HandoffImport } from "../../src/shared/handoff";
import { sanitizer } from "../../src/shared/handoff";
import type {
  HandoffSource,
  SourceTaskPage,
  SourceTaskQuery,
  SourceTask,
  SourceProject,
} from "../../src/shared/handoff-api";
import type {
  HistoryRecord,
  HistoryCoverage,
  HistoryVerification,
} from "../../src/shared/history";
import { HistorySources, type HistoryRoots } from "./history-sources";
import { ContextArchives } from "./history-context";
import { fileChunks, signature, hash } from "./history-io";
import { JsonStreamValidator } from "./history-json";

/** Owned persistent index. The source stores remain separate and read-only. */
export class HistoryService {
  readonly archives: ContextArchives;
  private db?: DatabaseSync;
  private cursors = new Map<
    string,
    { source: HandoffSource; scope: string; offset: number; revision: string }
  >();
  private loaded = new Map<string, HandoffSource>();
  private sources: HistorySources;
  private verification?: AbortController;
  private verificationProgress?: HistoryVerification;
  constructor(
    readonly root: string,
    home = os.homedir(),
    extra: HistoryRoots = {},
  ) {
    this.archives = new ContextArchives(path.join(root, "contexts"), home);
    this.sources = new HistorySources(home, extra);
  }
  private async database() {
    if (this.db) return this.db;
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      Object.assign(
        this.sources.extra,
        JSON.parse(
          await fs.readFile(path.join(this.root, "roots.json"), "utf8"),
        ),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const { DatabaseSync } = await import("node:sqlite");
    const db = (this.db = new DatabaseSync(
      path.join(this.root, "index.sqlite"),
    ));
    db.exec(
      "PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS history_sources(source TEXT PRIMARY KEY,revision TEXT NOT NULL,coverage TEXT NOT NULL);CREATE TABLE IF NOT EXISTS history_tasks(id TEXT PRIMARY KEY,source TEXT NOT NULL,project_id TEXT,kind TEXT,updated REAL,title TEXT,search_text TEXT,payload TEXT NOT NULL);CREATE INDEX IF NOT EXISTS history_tasks_source ON history_tasks(source,updated DESC,id);CREATE TABLE IF NOT EXISTS history_projects(id TEXT NOT NULL,source TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(source,id));",
    );
    return db;
  }
  async addRoot(source: HandoffSource, root: string) {
    await this.database();
    const canonical = await fs.realpath(root);
    if (!(await fs.stat(canonical)).isDirectory())
      throw new Error("请选择来源数据目录。");
    this.sources.extra[source] = [
      ...new Set([...(this.sources.extra[source] || []), canonical]),
    ];
    await fs.writeFile(
      path.join(this.root, "roots.json"),
      JSON.stringify(this.sources.extra, null, 2),
      { mode: 0o600 },
    );
    return this.browse(source);
  }
  private async refresh(source: HandoffSource) {
    const db = await this.database(),
      scan = await this.sources.scan(source),
      revision = hash(
        JSON.stringify({
          tasks: [...scan.tasks].sort((a, b) => a.id.localeCompare(b.id)),
          projects: [...scan.projects].sort((a, b) => a.id.localeCompare(b.id)),
          gaps: scan.coverage.gaps,
        }),
      );
    const stmt = db.prepare(
        "INSERT INTO history_tasks VALUES(?,?,?,?,?,?,?,?)",
      ),
      project = db.prepare("INSERT INTO history_projects VALUES(?,?,?)");
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM history_tasks WHERE source=?").run(source);
      db.prepare("DELETE FROM history_projects WHERE source=?").run(source);
      for (const r of scan.tasks)
        stmt.run(
          r.id,
          source,
          r.projectId || "",
          r.kind,
          r.updated,
          r.title,
          `${r.title} ${r.directory} ${r.nativeId} ${r.instance}`.toLocaleLowerCase(),
          JSON.stringify(r),
        );
      for (const p of scan.projects)
        project.run(p.id, source, JSON.stringify(p));
      db.prepare("INSERT OR REPLACE INTO history_sources VALUES(?,?,?)").run(
        source,
        revision,
        JSON.stringify(scan.coverage),
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return revision;
  }
  async browse(
    source: HandoffSource,
    query: SourceTaskQuery = {},
  ): Promise<SourceTaskPage> {
    const db = await this.database(),
      scope = JSON.stringify([
        query.projectId || "",
        query.search || "",
        query.kind || "",
      ]),
      cursor = query.cursor ? this.cursors.get(query.cursor) : undefined;
    if (
      query.cursor &&
      (!cursor || cursor.source !== source || cursor.scope !== scope)
    )
      throw new Error("会话分页已失效，请刷新。");
    const revision = cursor?.revision || (await this.refresh(source)),
      state = db
        .prepare("SELECT revision,coverage FROM history_sources WHERE source=?")
        .get(source);
    if (state?.revision !== revision)
      throw new Error("来源索引已刷新，请重新加载分页。");
    const filters = ["source=?"],
      params: string[] = [source];
    if (query.projectId) {
      filters.push("project_id=?");
      params.push(query.projectId);
    }
    if (query.kind) {
      filters.push("kind=?");
      params.push(query.kind);
    }
    if (query.search?.trim()) {
      filters.push("instr(search_text,?)>0");
      params.push(query.search.trim().toLocaleLowerCase());
    }
    const where = filters.join(" AND "),
      total =
        Number(
          db
            .prepare(`SELECT COUNT(*) AS n FROM history_tasks WHERE ${where}`)
            .get(...params)?.n,
        ) || 0;
    const offset = cursor?.offset || 0,
      rows = db
        .prepare(
          `SELECT payload FROM history_tasks WHERE ${where} ORDER BY updated DESC,id LIMIT 50 OFFSET ?`,
        )
        .all(...params, offset)
        .map((r) => JSON.parse(String(r.payload)) as HistoryRecord);
    for (const r of rows) this.loaded.set(r.id, source);
    let nextCursor: string | undefined;
    if (offset + rows.length < total) {
      nextCursor = randomUUID();
      this.cursors.set(nextCursor, {
        source,
        scope,
        offset: offset + rows.length,
        revision,
      });
    }
    const projects = db
        .prepare(
          "SELECT payload FROM history_projects WHERE source=? ORDER BY rowid",
        )
        .all(source)
        .map((r) => JSON.parse(String(r.payload)) as SourceProject),
      coverage = JSON.parse(String(state?.coverage)) as HistoryCoverage;
    return {
      tasks: rows.map(({ locator, ...r }) => r),
      projects,
      nextCursor,
      total,
      origin: "history-index",
      warnings: coverage.gaps,
      coverage,
    };
  }
  async list(source: HandoffSource): Promise<SourceTask[]> {
    const all: SourceTask[] = [];
    let page = await this.browse(source);
    for (;;) {
      all.push(...page.tasks);
      if (!page.nextCursor) break;
      page = await this.browse(source, { cursor: page.nextCursor });
    }
    return all;
  }
  private async selected(id: string, source: HandoffSource) {
    const db = await this.database();
    if (this.loaded.get(id) !== source)
      throw new Error("请从刚读取的会话列表选择对话。");
    const row = db
      .prepare("SELECT payload FROM history_tasks WHERE id=? AND source=?")
      .get(id, source);
    if (!row) throw new Error("来源记录已变更，请刷新。");
    return JSON.parse(String(row.payload)) as HistoryRecord;
  }
  async importSession(
    id: string,
    source: HandoffSource,
  ): Promise<HandoffImport> {
    await this.refresh(source);
    const task = await this.selected(id, source),
      context = await this.archives.archive(task),
      page = await this.archives.read(context.id),
      clean = sanitizer();
    return {
      source,
      id: task.nativeId,
      title: task.title,
      directory: task.directory,
      transcript: clean.clean(page.text).slice(0, 48 * 1024),
      messageCount: context.records,
      redactions: clean.count(),
      context,
      warnings: [
        ...context.warnings,
        "完整上下文已分块落盘；此处文本仅为首段预览，不能当作完整会话。",
        "原始事件保留工具过程与来源版本；完整导出未经脱敏，需人工检查。",
        `附件引用 ${context.attachmentCount || 0} 项，原件缺口 ${context.missingAttachments || 0} 项；逐项状态见 manifest。`,
        "历史命令、工具参数和任务状态都是引用数据，不得自动执行。",
      ],
    };
  }
  async importFile(file: string): Promise<HandoffImport> {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new Error("只能导入普通 JSON 文件。");
    const info: Record<string, string> = {},
      validator = new JsonStreamValidator({
        stringStart: (p) =>
          p.length === 2 &&
          p[0] === "info" &&
          ["id", "title", "directory"].includes(String(p[1])),
        stringChunk: (p, text) => {
          const k = String(p[1]);
          info[k] =
            (info[k] || "") +
            text.slice(0, Math.max(0, 4096 - (info[k]?.length || 0)));
        },
      });
    for await (const chunk of fileChunks(file, path.dirname(file)))
      validator.write(chunk);
    validator.end();
    if (!info.id) throw new Error("OpenCode JSON 会话身份无效，缺少 info.id。");
    const context = await this.archives.archive({
      id: `import_${hash(file)}`,
      nativeId: info.id,
      instance: "OpenCode:export",
      title: String(info.title || "导入会话"),
      directory: String(info.directory || ""),
      updated: stat.mtimeMs,
      kind: "conversation",
      available: true,
      locator: { files: [{ path: file, root: path.dirname(file) }] },
    });
    if (signature(stat) !== signature(await fs.lstat(file)))
      throw new Error("导出文件读取期间发生变化，请重试。");
    const page = await this.archives.read(context.id),
      clean = sanitizer();
    return {
      source: "OpenCode",
      id: info.id,
      title: clean.clean(String(info.title || "导入会话")),
      directory: clean.clean(String(info.directory || "")),
      transcript: clean.clean(page.text).slice(0, 48 * 1024),
      context,
      messageCount: context.records,
      redactions: clean.count(),
      warnings: [
        "原生 JSON 已全量归档；首段预览不是全部正文。",
        "完整原始记录未经脱敏；导出前需人工检查。",
      ],
    };
  }
  async verify(source: HandoffSource): Promise<HistoryVerification> {
    if (this.verification) throw new Error("已有上下文核验进行中。");
    const control = (this.verification = new AbortController()),
      result: HistoryVerification = {
        source,
        checked: 0,
        total: 0,
        bytes: 0,
        complete: false,
        failures: [],
      };
    this.verificationProgress = result;
    try {
      await this.refresh(source);
      const db = await this.database();
      const rows = db
        .prepare(
          "SELECT id,payload FROM history_tasks WHERE source=? ORDER BY id",
        )
        .all(source);
      result.total = rows.length;
      let bodyFailures = 0,
        attachmentFailures = 0;
      for (const r of rows) {
        control.signal.throwIfAborted();
        const task = JSON.parse(String(r.payload)) as HistoryRecord;
        if (task.kind === "deleted") {
          bodyFailures++;
          attachmentFailures++;
          result.failures.push({
            id: task.nativeId,
            reason: "来源已删除，不自动恢复正文。",
          });
          result.checked++;
          continue;
        }
        try {
          const archive = await this.archives.archive(task, control.signal);
          result.bytes += archive.bytes;
          if (!archive.complete) bodyFailures++;
          if (!archive.attachmentsComplete) attachmentFailures++;
          if (!archive.complete || !archive.attachmentsComplete)
            result.failures.push({
              id: task.nativeId,
              reason: [
                ...archive.warnings,
                ...(archive.missingAttachments
                  ? [
                      `有 ${archive.missingAttachments} 项历史附件原件不可取得。`,
                    ]
                  : []),
              ].join("；"),
            });
        } catch (e) {
          if (control.signal.aborted) throw e;
          bodyFailures++;
          attachmentFailures++;
          result.failures.push({
            id: task.nativeId,
            reason: e instanceof Error ? e.message : "读取失败",
          });
        }
        result.checked++;
      }
      const state = db
          .prepare("SELECT coverage FROM history_sources WHERE source=?")
          .get(source),
        coverage = JSON.parse(String(state?.coverage)) as HistoryCoverage;
      coverage.context = bodyFailures ? "partial" : "complete";
      coverage.attachments = attachmentFailures ? "partial" : "complete";
      result.coverage = coverage;
      result.complete =
        !result.failures.length &&
        coverage.projects === "complete" &&
        coverage.sessions === "complete" &&
        coverage.attachments === "complete";
      db.prepare("UPDATE history_sources SET coverage=? WHERE source=?").run(
        JSON.stringify(coverage),
        source,
      );
      await fs.writeFile(
        path.join(this.root, `verification-${source}.json`),
        JSON.stringify({ ...result, coverage }, null, 2),
        { mode: 0o600 },
      );
      return result;
    } finally {
      this.verification = undefined;
    }
  }
  getVerification() {
    return this.verification ? this.verificationProgress : undefined;
  }
  cancelVerification() {
    this.verification?.abort(
      new Error("上下文核验已取消，已完成的原始归档保留。"),
    );
  }
  close() {
    this.cancelVerification();
    this.db?.close();
    this.db = undefined;
  }
}
