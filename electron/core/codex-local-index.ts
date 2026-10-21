/** Codex-owned metadata only. Never repairs or writes the source database. */
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { SourceProject, SourceTask } from "../../src/shared/handoff-api";
import { sanitizer } from "../../src/shared/handoff";

export const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export const stringValue = (value: unknown) => typeof value === "string" ? value : "";
export const directoryKey = (value: string) => value ? path.normalize(value).replace(/[\\/]+$/, "") || path.parse(value).root : "";
export const directoryProjectId = (value: string) => `dir:${createHash("sha256").update(directoryKey(value)).digest("hex").slice(0, 24)}`;
export function interactiveCodex(source: unknown, threadSource?: unknown): boolean {
  if (isObject(source)) return false;
  const kind = stringValue(source), detail = stringValue(threadSource);
  if (/subagent|guardian|review|compact/i.test(`${kind} ${detail}`)) return false;
  return !kind || kind === "cli" || kind === "vscode";
}
export interface IndexedCodexThread extends SourceTask { file: string; historyMode: string; sourceKind: string; threadSource: string }
export interface CodexProject extends SourceProject { aliases: string[] }
export interface CodexIndex { threads: IndexedCodexThread[]; projects: CodexProject[]; hasDatabase: boolean; warnings: string[]; titles?: Record<string, string> }

export async function readBoundedCodexFile(file: string, maximum: number): Promise<string> {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum) throw new Error("Codex 索引文件不是普通文件或超过读取上限。");
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maximum) throw new Error("Codex 索引超过读取上限。");
    return buffer.subarray(0, length).toString("utf8");
  } finally { await handle.close(); }
}
function registered(id: unknown, name: unknown, roots: unknown, aliases: string[] = []): CodexProject | undefined {
  if (typeof id !== "string" || !id || !Array.isArray(roots)) return;
  const directories = [...new Set(roots.filter((r): r is string => typeof r === "string" && path.isAbsolute(r)).map(directoryKey))];
  if (!directories.length) return;
  return { id, name: stringValue(name) || path.basename(directories[0]), directories, registered: true, aliases: [...new Set([id, ...aliases])] };
}
export function projectForThread(task: SourceTask, projects: CodexProject[]): CodexProject | undefined {
  const direct = task.projectId && projects.find(p => p.id === task.projectId || p.aliases.includes(task.projectId!));
  if (direct) return direct;
  const cwd = directoryKey(task.directory);
  const matches = projects.map(p => ({ project: p, length: Math.max(-1, ...p.directories.filter(root => cwd === root || cwd.startsWith(root + path.sep)).map(root => root.length)) })).filter(p => p.length >= 0).sort((a, b) => b.length - a.length);
  // Equal roots registered under different project names are ambiguous.
  return matches.length && (matches.length === 1 || matches[0].length > matches[1].length) ? matches[0].project : undefined;
}
export function catalogProjects(registeredProjects: CodexProject[], tasks: SourceTask[], countsKnown: boolean): CodexProject[] {
  const projects: CodexProject[] = registeredProjects.map(project => ({ ...project, directories: [...project.directories], aliases: [...project.aliases], count: countsKnown ? 0 : undefined }));
  for (const task of tasks) {
    let project = projectForThread(task, projects);
    if (!project) {
      const id = directoryProjectId(task.directory);
      project = projects.find(p => p.id === id);
      if (!project) { project = { id, name: path.basename(task.directory) || "未关联项目", directories: task.directory ? [directoryKey(task.directory)] : [], registered: false, aliases: [], count: 0 }; projects.push(project); }
    }
    if (project.count !== undefined) project.count++;
  }
  return projects;
}

export async function readCodexIndex(nativeHome: string): Promise<CodexIndex> {
  const result: CodexIndex = { threads: [], projects: [], hasDatabase: false, warnings: [] };
  try {
    const raw = await readBoundedCodexFile(path.join(nativeHome, "session_index.jsonl"), 4 * 1024 * 1024);
    result.titles = {};
    const clean = sanitizer();
    for (const line of raw.slice(0, raw.lastIndexOf("\n") + 1).split("\n")) {
      if (!line.trim()) continue;
      let row: unknown;
      try { row = JSON.parse(line); } catch { continue; }
      if (isObject(row) && typeof row.id === "string" && /^[0-9a-f-]{36}$/i.test(row.id) && typeof row.thread_name === "string") result.titles[row.id] = clean.clean(row.thread_name);
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.warnings.push("旧版聊天名称索引未能读取，部分降级记录可能没有标题。"); }
  let state: unknown;
  try { state = JSON.parse(await readBoundedCodexFile(path.join(nativeHome, ".codex-global-state.json"), 4 * 1024 * 1024)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.warnings.push("客户端项目登记未能完整读取；项目归属可能不完整。"); }
  if (isObject(state)) {
    const persisted = isObject(state["electron-persisted-atom-state"]) ? state["electron-persisted-atom-state"] : {};
    const entries = state["local-projects"] ?? persisted["local-projects"];
    if (isObject(entries)) for (const [key, value] of Object.entries(entries)) {
      if (!isObject(value)) continue;
      const project = registered(value.id || key, value.name, value.rootPaths);
      if (project) result.projects.push(project);
    }
    // Older clients kept only workspace roots. Keep those registered roots too.
    const roots = state["electron-saved-workspace-roots"] ?? persisted["electron-saved-workspace-roots"];
    if (Array.isArray(roots)) for (const root of roots) {
      if (typeof root !== "string" || !path.isAbsolute(root) || result.projects.some(p => p.directories.includes(directoryKey(root)))) continue;
      const project = registered(directoryProjectId(root), path.basename(root), [root]);
      if (project) result.projects.push(project);
    }
  }
  let databaseFile: string | undefined;
  try {
    const candidates = (await fs.readdir(nativeHome)).filter(name => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
    databaseFile = candidates[0] && path.join(nativeHome, candidates[0]);
    result.hasDatabase = !!databaseFile;
    if (databaseFile) {
      const stat = await fs.lstat(databaseFile);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("不是普通索引文件");
      // Native SQLite sees committed WAL records; reading the main file with
      // sql.js would silently miss recent Desktop updates.
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(databaseFile, { readOnly: true });
      try {
        db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000");
        const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)));
        if (tables.has("projects") && tables.has("project_roots")) {
          const rows = db.prepare("SELECT p.id,p.name,r.path FROM projects p JOIN project_roots r ON r.project_id=p.id LIMIT 2001").all();
          if (rows.length > 2000) throw new Error("项目登记超过 2000 项");
          for (const row of rows) {
            const project = registered(row.id, row.name, [row.path]);
            if (!project) continue;
            const rootsMatch = result.projects.filter(p => p.registered && p.directories.some(dir => project.directories.includes(dir)));
            const same = result.projects.find(p => p.id === project.id || p.aliases.includes(project.id)) || (rootsMatch.length === 1 ? rootsMatch[0] : rootsMatch.find(p => p.name === project.name));
            if (same) { same.aliases = [...new Set([...same.aliases, project.id])]; same.directories = [...new Set([...same.directories, ...project.directories])]; }
            else result.projects.push(project);
          }
        }
        if (tables.has("threads")) {
          const columns = new Set(db.prepare("PRAGMA table_info(threads)").all().map(row => String(row.name)));
          const fields = ["id", "name", "title", "preview", "cwd", "updated_at_ms", "updated_at", "source", "thread_source", "rollout_path", "project_id", "history_mode"];
          const select = fields.map(key => columns.has(key) ? key : `NULL AS ${key}`).join(",");
          const filters = [columns.has("archived") ? "archived=0" : "1", columns.has("source") ? "(source IN ('cli','vscode') OR source IS NULL OR source='')" : "1"];
          const rows = db.prepare(`SELECT ${select} FROM threads WHERE ${filters.join(" AND ")} LIMIT 5001`).all();
          if (rows.length > 5000) throw new Error("会话索引超过 5000 项");
          const clean = sanitizer();
          result.threads = rows.filter(row => interactiveCodex(row.source, row.thread_source)).map(row => ({
            id: stringValue(row.id), title: clean.clean(stringValue(row.name) || stringValue(row.title) || stringValue(row.preview) || "无标题对话"),
            directory: stringValue(row.cwd), updated: Number(row.updated_at_ms) || Number(row.updated_at) * 1000 || 0,
            projectId: stringValue(row.project_id) || undefined, file: stringValue(row.rollout_path), historyMode: stringValue(row.history_mode), sourceKind: stringValue(row.source), threadSource: stringValue(row.thread_source),
          }));
        }
      } finally { db.close(); }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.warnings.push("本地 Codex 状态索引暂不可读取；仅使用可核实的项目与会话来源。");
  }
  result.projects = catalogProjects(result.projects, result.threads, !!databaseFile && !result.warnings.some(w => w.startsWith("本地 Codex")));
  if (isObject(state)) {
    const persisted = isObject(state["electron-persisted-atom-state"]) ? state["electron-persisted-atom-state"] : {};
    const order = state["project-order"] ?? persisted["project-order"];
    if (Array.isArray(order)) {
      const rank = (project: CodexProject) => { const indices = [project.id, ...project.aliases].map(id => order.indexOf(id)).filter(index => index >= 0); return indices.length ? Math.min(...indices) : Number.MAX_SAFE_INTEGER; };
      result.projects.sort((a, b) => rank(a) - rank(b));
    }
  }
  return result;
}
