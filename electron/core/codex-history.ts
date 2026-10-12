/** Bounded, read-only discovery of local Codex rollout files. Never executes Codex. */
import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HANDOFF_LIMITS, sanitizer, type HandoffImport } from "../../src/shared/handoff";
import type { SourceTask } from "../../src/shared/handoff-api";

type Row = { task: SourceTask; file: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// WisCode sets CODEX_HOME for its own agent; it is not the user's native Codex history.
const root = () => path.join(os.homedir(), ".codex", "sessions");
const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const text = (x: unknown): string => {
  if (typeof x === "string") return x;
  if (Array.isArray(x)) return x.map(part => obj(part) && part.type === "input_text" && typeof part.text === "string" ? part.text : "").filter(Boolean).join("\n");
  return "";
};
const userText = (record: Record<string, unknown>) => {
  if (record.type === "message" && record.role === "user") return text(record.content);
  const payload = record.payload;
  if (!obj(payload)) return "";
  if (record.type === "event_msg" && payload.type === "user_message") return text(payload.message);
  if (record.type === "response_item" && payload.type === "message" && payload.role === "user") return text(payload.content);
  return "";
};
const ordinary = (s: string) => !!s.trim() && !/^\s*<(?:environment_context|user_instructions|system_instructions|developer_instructions|assistant_instructions|agent_instructions|wiscode_runtime_instructions)\b/i.test(s);
function parseLines(raw: string, file: string): Row | undefined {
  let id = "", directory = "", title = "", timestamp = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let record: unknown;
    try { record = JSON.parse(line); } catch { continue; }
    if (!obj(record)) continue;
    if (record.type === "session_meta" && obj(record.payload)) {
      const meta = record.payload;
      if (typeof meta.id === "string") id = meta.id;
      if (typeof meta.cwd === "string") directory = meta.cwd;
      const time = Date.parse(String(meta.timestamp || record.timestamp || ""));
      if (Number.isFinite(time)) timestamp = time;
    }
    if (record.type === "turn_context" && obj(record.payload) && typeof record.payload.cwd === "string") directory ||= record.payload.cwd;
    const ask = userText(record);
    if (!title && ordinary(ask)) title = ask.replace(/\s+/g, " ").trim().slice(0, 300);
  }
  if (!uuid.test(id)) return;
  const clean = sanitizer();
  return { task: { id, title: clean.clean(title || "无标题对话"), directory: clean.clean(directory.slice(0, 2000)), updated: timestamp }, file };
}

export class CodexHistory {
  private files = new Map<string, string>();
  constructor(private sessionsRoot = root()) {}
  async list(): Promise<SourceTask[]> {
    this.files.clear();
    let count = 0;
    const rows: Row[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 3 || count >= 5000) return;
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (++count > 5000) throw new Error("Codex 会话目录超过扫描预算；未列出不完整结果。");
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && /^\d{4}$|^\d{2}$/.test(entry.name)) await walk(full, depth + 1);
        else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
          const stat = await fs.lstat(full);
          if (stat.size > HANDOFF_LIMITS.bytes || stat.nlink !== 1) continue;
          // List reads bounded metadata, not entire history. A selected session is read separately.
          const handle = await fs.open(full, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
          try {
            const buffer = Buffer.alloc(Math.min(stat.size, 128 * 1024));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            const raw = buffer.subarray(0, bytesRead).toString("utf8");
            const row = parseLines(raw.slice(0, raw.lastIndexOf("\n") + 1), full);
            if (row) { row.task.updated = Math.max(row.task.updated, stat.mtimeMs); rows.push(row); }
          } finally { await handle.close(); }
        }
      }
    };
    try { await walk(this.sessionsRoot, 0); }
    catch (error) { if (obj(error) && error.code === "ENOENT") return []; throw error; }
    rows.sort((a, b) => b.task.updated - a.task.updated);
    for (const row of rows.slice(0, 30)) this.files.set(row.task.id, row.file);
    return rows.slice(0, 30).map(row => row.task);
  }
  async importSession(id: string): Promise<HandoffImport> {
    const file = this.files.get(id);
    if (!file || !uuid.test(id)) throw new Error("请从刚读取的 Codex 会话列表选择对话。");
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    let raw: string;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > HANDOFF_LIMITS.bytes) throw new Error("Codex 会话文件不可读取或超过 8 MB。");
      const buffer = Buffer.alloc(HANDOFF_LIMITS.bytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > HANDOFF_LIMITS.bytes) throw new Error("Codex 会话超过 8 MB，未截断导入。");
      raw = buffer.subarray(0, length).toString("utf8");
    } finally { await handle.close(); }
    const row = parseLines(raw, file);
    if (!row || row.task.id !== id) throw new Error("Codex 会话身份已变更，请刷新列表。");
    const clean = sanitizer();
    const entries: string[] = [];
    let count = 0;
    let previousUser: { text: string; type: unknown } | undefined;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let record: unknown;
      try { record = JSON.parse(line); } catch { throw new Error("Codex 会话记录损坏，未导入。"); }
      if (!obj(record)) continue;
      const ask = userText(record);
      if (ordinary(ask)) {
        // Codex can write the same user turn as both event_msg and response_item.
        if (previousUser?.text === ask && previousUser.type !== record.type) previousUser = undefined;
        else { entries.push(`[用户历史]\n${clean.clean(ask)}`); count++; previousUser = { text: ask, type: record.type }; }
      }
      else if (record.type === "event_msg" && obj(record.payload) && record.payload.type === "agent_message" && typeof record.payload.message === "string") {
        entries.push(`[Codex 回复历史]\n${clean.clean(record.payload.message)}`); count++;
        previousUser = undefined;
      }
      if (count > HANDOFF_LIMITS.messages) throw new Error("Codex 会话消息超过 5000 条，未截断导入。");
    }
    const transcript = entries.join("\n\n");
    if (transcript.length > HANDOFF_LIMITS.text) throw new Error("Codex 交接文本超过 120000 字符，未截断导入。");
    return { ...row.task, source: "Codex", transcript, messageCount: count, redactions: clean.count(), warnings: [
      "Codex 会话列表是历史摘要，不代表任务状态或完成情况。",
      "只迁移用户请求和可见回复；工具调用、附件、内部推理、子会话及运行状态未迁移。",
      "离线记录不能证明原任务已停止；接续前核对项目文件和未知结果的副作用。",
    ] };
  }
}
