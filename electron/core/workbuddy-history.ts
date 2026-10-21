import { bindAttachments, contentAttachments } from "./handoff-attachments";
import os from "node:os";
import path from "node:path";
import { LocalHandoffHistory, nativeDatabase, columns, nativeEntries, nativeFile, parseLines, importedText, visibleText, isObject, stringValue, type HistoryRow, type TextMessage } from "./local-handoff-history";

export function workBuddyMessages(raw: string, id: string): TextMessage[] {
  const messages: TextMessage[] = [];
  for (const row of parseLines(raw)) {
    if (row.sessionId && row.sessionId !== id) throw new Error("WorkBuddy 会话身份已变更。");
    if (row.isSidechain || row.parentSessionId) continue;
    if (row.type === "message" && (row.role === "user" || row.role === "assistant")) messages.push({ role: row.role, text: visibleText(row.content), id: stringValue(row.id) || undefined });
    // Earlier versions use Claude-style envelopes; never interpret other record types.
    else if ((row.type === "user" || row.type === "assistant") && isObject(row.message)) messages.push({ role: row.type === "user" ? "user" : "assistant", text: visibleText(row.message.content), id: stringValue(row.uuid) || undefined });
  }
  return messages;
}
export class WorkBuddyHistory extends LocalHandoffHistory {
  constructor(private home = os.homedir()) { super("WorkBuddy"); }
  async rows(): Promise<HistoryRow[]> {
    const base = path.join(this.home, ".workbuddy"), root = path.join(base, "projects"), files = new Map<string, string>();
    for (const project of await nativeEntries(root)) {
      if (!project.isDirectory()) continue;
      for (const entry of await nativeEntries(path.join(root, project.name))) if (entry.isFile() && /^[\da-f-]{32,36}\.jsonl$/i.test(entry.name)) {
        const id = entry.name.slice(0, -6);
        if (files.has(id)) throw new Error("WorkBuddy 存在重复会话路径，请在来源中确认后重试。");
        files.set(id, path.join(root, project.name, entry.name));
      }
    }
    let records: Record<string, unknown>[];
    try { records = await nativeDatabase(path.join(base, "workbuddy.db"), db => {
      const c = columns(db, "sessions");
      for (const required of ["id", "cwd", "title", "updated_at", "deleted_at"]) if (!c.has(required)) throw new Error("WorkBuddy 会话索引版本不兼容。");
      const where = ["deleted_at IS NULL", ...(c.has("is_background_automation") ? ["COALESCE(is_background_automation,0)=0"] : []), ...(c.has("visibility") ? ["COALESCE(visibility,'') NOT IN ('hidden','internal')"] : []), ...(c.has("source_mode") ? ["COALESCE(source_mode,'') NOT IN ('subagent','automation')"] : [])];
      return db.prepare(`SELECT id,cwd,${c.has("custom_title") ? "COALESCE(NULLIF(custom_title,''),title)" : "title"} AS title,updated_at FROM sessions WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT 5001`).all();
    }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return records.filter(r => /^[\da-f-]{32,36}$/i.test(stringValue(r.id))).map(r => ({ task: { id: String(r.id), title: stringValue(r.title) || "无标题对话", directory: stringValue(r.cwd), updated: Number(r.updated_at) || 0 }, file: files.get(String(r.id)), root }));
  }
  protected async read(row: HistoryRow) {
    if (!row.file || !row.root) throw new Error("WorkBuddy 索引存在，但本地正文尚未下载或已移除；请先在 WorkBuddy 打开该会话。");
    const raw = (await nativeFile(row.file, row.root)).toString("utf8");
    return bindAttachments(importedText(this.source, row.task, workBuddyMessages(raw, row.task.id)), parseLines(raw).filter(r => !r.isSidechain && !r.parentSessionId && (r.type === "message" && r.role === "user" || r.type === "user")).flatMap(r => contentAttachments(isObject(r.message) ? r.message.content : r.content, stringValue(r.id) || stringValue(r.uuid) || "用户消息", {home:this.home,kind:"workbuddy"})));
  }
}
