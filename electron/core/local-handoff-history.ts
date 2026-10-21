/** Native histories are inert data. Fixed roots, bounded reads, no original-agent execution. */
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { HANDOFF_LIMITS, sanitizer, type HandoffImport } from "../../src/shared/handoff";
import type { HandoffSource, SourceTask, SourceTaskPage, SourceTaskQuery, SourceProject } from "../../src/shared/handoff-api";
import { handoffToolLabel } from "../../src/shared/handoff-api";
import { directoryProjectId, isObject, stringValue } from "./codex-local-index";

export { isObject, stringValue };
export interface HistoryRow { task: SourceTask; file?: string; root?: string; engine?: string }
export interface TextMessage { role: "user" | "assistant"; text: string; id?: string }
export async function nativeFile(file: string, root: string, maximum: number = HANDOFF_LIMITS.bytes): Promise<Buffer> {
  const base = await fs.realpath(root), resolved = await fs.realpath(file), relative = path.relative(base, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("会话路径超出来源目录。");
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum) throw new Error("会话文件不是普通文件或超过读取上限，未截断导入。");
    const buffer = Buffer.alloc(Math.min(maximum + 1, stat.size + 1));
    let offset = 0;
    while (offset < buffer.length) { const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null); if (!bytesRead) break; offset += bytesRead; }
    if (offset > maximum || offset > stat.size) throw new Error("会话文件在读取时增长，请刷新后重试。");
    return buffer.subarray(0, offset);
  } finally { await handle.close(); }
}
export async function nativeEntries(root: string): Promise<import("node:fs").Dirent[]> {
  try {
    const stat = await fs.lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("会话目录不是普通目录。");
    const entries = await fs.readdir(root, { withFileTypes: true });
    if (entries.length > 5000) throw new Error("会话目录超过 5000 项扫描预算，未返回部分结果。");
    return entries.filter(e => !e.isSymbolicLink());
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
export async function nativeDatabase<T>(file: string, run: (db: import("node:sqlite").DatabaseSync) => T): Promise<T> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("会话索引不是普通数据库文件。");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try { db.exec("PRAGMA query_only=ON; BEGIN"); return run(db); }
  finally { db.close(); }
}
export function columns(db: import("node:sqlite").DatabaseSync, table: string): Set<string> {
  if (!/^[a-z_]+$/.test(table)) throw new Error("无效会话表。");
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name)));
}
export const parseLines = (raw: string): Record<string, unknown>[] => raw.split("\n").filter(line => line.trim()).map(line => {
  const value: unknown = JSON.parse(line); if (!isObject(value)) throw new Error("会话记录结构不兼容，未导入部分正文。"); return value;
});
export function visibleText(value: unknown): string {
  if (typeof value === "string") return value;
  return Array.isArray(value) ? value.filter(isObject).filter(p => ["text", "input_text", "output_text"].includes(String(p.type))).map(p => stringValue(p.text)).join("\n") : "";
}
export const ordinaryText = (text: string) => !!text.trim() && !/^\s*<(?:system-reminder|environment_context|ide_opened_file|ide_selection|local-command|command-name|wiscode_runtime_instructions)\b/i.test(text);
export function importedText(source: HandoffSource, task: SourceTask, messages: TextMessage[], warnings: string[] = []): HandoffImport {
  const clean = sanitizer(), entries: string[] = [], seen = new Set<string>();
  let length = 0;
  for (const message of messages) {
    if (message.id && seen.has(message.id)) continue;
    if (message.id) seen.add(message.id);
    if (!message.text.trim() || message.role === "user" && !ordinaryText(message.text)) continue;
    const value = `[${message.role === "user" ? "用户历史" : `${handoffToolLabel(source)} 回复历史`}]\n${clean.clean(message.text)}`;
    length += value.length + 2;
    if (entries.length >= HANDOFF_LIMITS.messages || length > HANDOFF_LIMITS.text) throw new Error("会话正文超过 5000 条消息或 120000 字符，未截断导入。");
    entries.push(value);
  }
  if (!entries.length) throw new Error("所选会话没有可读取的用户请求或可见回复。");
  return { source, id: task.id, title: clean.clean(task.title), directory: clean.clean(task.directory), transcript: entries.join("\n\n"), messageCount: entries.length, redactions: clean.count(), warnings: [
    "只迁移本地用户请求和可见回复；工具调用、内部推理与子代理运行状态未迁移；附件需单独确认打包。",
    "历史记录不代表当前完成情况；接续前确认来源已停止，并核对目标工作区。",
    ...(!task.directory ? ["来源未提供项目目录，请在目标工具中手动确认工作区。"] : []), ...warnings,
  ] };
}
export abstract class LocalHandoffHistory {
  private loaded = new Set<string>();
  private snapshot: HistoryRow[] = [];
  private cursors = new Map<string, { scope: string; offset: number }>();
  constructor(readonly source: HandoffSource) {}
  abstract rows(): Promise<HistoryRow[]>;
  protected abstract read(row: HistoryRow): Promise<HandoffImport>;
  async list() { return (await this.browse()).tasks; }
  async browse(query: SourceTaskQuery = {}): Promise<SourceTaskPage> {
    const scope = JSON.stringify([query.projectId || "", query.search || ""]), cursor = query.cursor ? this.cursors.get(query.cursor) : undefined;
    if (query.cursor && (!cursor || cursor.scope !== scope)) throw new Error("会话分页已失效，请刷新。");
    if (!query.cursor) {
      this.loaded.clear(); this.cursors.clear();
      const rows = await this.rows();
      if (rows.length > 5000) throw new Error("会话数量超过 5000 条，请缩小来源记录后重试。");
      // Newest canonical record wins; backup files never count as extra chats.
      this.snapshot = [...new Map(rows.sort((a, b) => a.task.updated - b.task.updated).map(row => [row.task.id, row])).values()].sort((a, b) => b.task.updated - a.task.updated);
    }
    const clean = sanitizer(), projects = new Map<string, SourceProject>();
    for (const row of this.snapshot) {
      const id = directoryProjectId(row.task.directory); row.task.projectId = id;
      const p = projects.get(id) || { id, name: clean.clean(path.basename(row.task.directory) || "未关联项目"), directories: row.task.directory ? [clean.clean(row.task.directory)] : [], registered: false, count: 0 };
      p.count!++; projects.set(id, p);
    }
    if (query.projectId && !projects.has(query.projectId)) throw new Error("项目记录已变更，请刷新。");
    const search = query.search?.trim().toLocaleLowerCase();
    const filtered = this.snapshot.filter(row => (!query.projectId || row.task.projectId === query.projectId) && (!search || clean.clean(`${row.task.title} ${row.task.directory} ${row.task.id}`).toLocaleLowerCase().includes(search)));
    const offset = cursor?.offset || 0, rows = filtered.slice(offset, offset + 50);
    for (const row of rows) this.loaded.add(row.task.id);
    let nextCursor: string | undefined;
    if (offset + 50 < filtered.length) { nextCursor = randomUUID(); this.cursors.set(nextCursor, { scope, offset: offset + 50 }); }
    return { tasks: rows.map(({ task }) => ({ ...task, title: clean.clean(task.title).slice(0, 500), directory: clean.clean(task.directory) })), projects: [...projects.values()], total: filtered.length, nextCursor, origin: "native", warnings: [] };
  }
  async importSession(id: string) {
    if (!this.loaded.has(id)) throw new Error("请从刚读取的会话列表选择对话。");
    // Recheck deletion / archive and current canonical path before reading正文.
    const row = (await this.rows()).find(row => row.task.id === id);
    if (!row) throw new Error("所选会话已移除或不再可见，请刷新。");
    return this.read(row);
  }
}
