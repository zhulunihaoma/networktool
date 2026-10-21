import { bindAttachments, contentAttachments, type AttachmentCandidate } from "./handoff-attachments";
import os from "node:os";
import path from "node:path";
import { LocalHandoffHistory, nativeDatabase, columns, importedText, isObject, stringValue, type HistoryRow, type TextMessage } from "./local-handoff-history";
import { HANDOFF_LIMITS } from "../../src/shared/handoff";

export function zcodeVisible(message: Record<string, unknown>) {
  if (message.synthetic || message.visibility === "hidden") return false;
  const semantics = isObject(message.semantics) ? message.semantics : {};
  if (semantics.uiVisibility === "hidden" || semantics.transcriptVisibility === "hidden") return false;
  const metadata = isObject(message.metadata) ? message.metadata : {};
  if (metadata.visibility === "hidden") return false;
  return message.role === "user" || message.role === "assistant";
}
export class ZCodeHistory extends LocalHandoffHistory {
  private file: string;
  constructor(private home = os.homedir()) { super("ZCode"); this.file = path.join(home, ".zcode/cli/db/db.sqlite"); }
  async rows(): Promise<HistoryRow[]> {
    let tasks: Record<string, unknown>[] = [];
    try { tasks = await nativeDatabase(this.file, db => {
      const c = columns(db, "session");
      for (const required of ["id", "title", "directory", "time_updated", "parent_id"]) if (!c.has(required)) throw new Error("ZCode 会话索引版本不兼容。");
      const where = ["parent_id IS NULL", ...(c.has("time_archived") ? ["time_archived IS NULL"] : []), ...(c.has("time_deleted") ? ["time_deleted IS NULL"] : []), ...(c.has("task_type") ? ["task_type='interactive'"] : [])];
      return db.prepare(`SELECT id,title,directory,time_updated FROM session WHERE ${where.join(" AND ")} ORDER BY time_updated DESC LIMIT 5001`).all();
    }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    // Client overrides / deletions take precedence; drafts without CLI history are omitted.
    let titles = new Map<string, Record<string, unknown>>();
    try { titles = await nativeDatabase(path.join(this.home, ".zcode/v2/tasks-index.sqlite"), db => new Map(db.prepare("SELECT task_id,title,workspace_path,deleted,archived,host_id FROM tasks LIMIT 5001").all().map(r => [String(r.task_id), r]))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return tasks.filter(r => {
      const client = titles.get(String(r.id));
      return /^sess_[a-zA-Z0-9_-]{1,100}$/.test(stringValue(r.id)) && (!client || !client.deleted && !client.archived && (!client.host_id || client.host_id === "local"));
    }).map(r => { const client = titles.get(String(r.id)); return { task: { id: String(r.id), title: stringValue(client?.title) || stringValue(r.title) || "无标题对话", directory: stringValue(client?.workspace_path) || stringValue(r.directory), updated: Number(r.time_updated) || 0 } }; });
  }
  protected async read(row: HistoryRow) {
    const candidates: AttachmentCandidate[] = [];
    const messages = await nativeDatabase(this.file, db => {
      const c = columns(db, "message"), p = columns(db, "part");
      if (!c.has("data") || !p.has("data")) throw new Error("ZCode 正文结构不兼容。");
      const size = db.prepare("SELECT SUM(length(CAST(data AS BLOB))) AS size,COUNT(*) AS count FROM message WHERE session_id=?").get(row.task.id);
      const partsSize = db.prepare("SELECT SUM(length(CAST(data AS BLOB))) AS size,COUNT(*) AS count FROM part WHERE session_id=?").get(row.task.id);
      if (Number(size?.size || 0) + Number(partsSize?.size || 0) > HANDOFF_LIMITS.bytes || Number(size?.count) > 5000 || Number(partsSize?.count) > 20000) throw new Error("ZCode 历史超过读取上限，未导入部分正文。");
      const records = db.prepare(`SELECT id,data FROM message WHERE session_id=? ORDER BY ${c.has("sequence") ? "COALESCE(sequence,time_created)," : ""}time_created,id`).all(row.task.id);
      const parts = db.prepare(`SELECT message_id,data FROM part WHERE session_id=? ORDER BY ${p.has("sequence") ? "COALESCE(sequence,time_created)," : ""}time_created,id`).all(row.task.id);
      const userIds = new Set(records.filter(r => { const d = JSON.parse(String(r.data)); return isObject(d) && d.role === "user" && zcodeVisible(d); }).map(r => String(r.id)));
      for (const p of parts) if (userIds.has(String(p.message_id))) candidates.push(...contentAttachments([JSON.parse(String(p.data))],String(p.message_id),{home:this.home,kind:"zcode"}));
      const texts = new Map<string, string[]>();
      for (const part of parts) {
        const data: unknown = JSON.parse(String(part.data));
        if (!isObject(data) || data.type !== "text" || data.ignored || data.synthetic || typeof data.text !== "string") continue;
        const id = String(part.message_id), values = texts.get(id) || []; values.push(data.text); texts.set(id, values);
      }
      return records.flatMap(r => {
        const data: unknown = JSON.parse(String(r.data));
        if (!isObject(data) || !zcodeVisible(data)) return [];
        return [{ role: data.role as "user" | "assistant", text: (texts.get(String(r.id)) || []).join("\n"), id: String(r.id) }];
      }) satisfies TextMessage[];
    });
    return bindAttachments(importedText(this.source, row.task, messages, ["ZCode 仅读取交互式主会话；草稿、后台工作流和子任务未计入。"]),candidates);
  }
}
