/** Bounded, read-only discovery of local Claude Code transcripts. Never executes Claude. */
import { bindAttachments, claudeAttachmentCandidates } from "./handoff-attachments";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HANDOFF_LIMITS, sanitizer, type HandoffImport } from "../../src/shared/handoff";
import type { SourceTask } from "../../src/shared/handoff-api";

type Row = { task: SourceTask; file: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const root = () => path.join(os.homedir(), ".claude", "projects");
const HEAD = 128 * 1024;
const TAIL = 64 * 1024;
const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const contentText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(part => obj(part) && part.type === "text" && typeof part.text === "string").map(part => part.text as string).join("\n");
};
const userText = (record: Record<string, unknown>) => (record.type === "user" && obj(record.message) ? contentText(record.message.content) : "");
const assistantText = (record: Record<string, unknown>) => (record.type === "assistant" && obj(record.message) ? contentText(record.message.content) : "");
// Context wrappers such as ide_selection or local-command-stdout are not real user requests.
const ordinary = (s: string) => !!s.trim() && !/^\s*<(?:ide_opened_file|ide_selection|local-command-caveat|local-command-stdout|command-name|command-message|system-reminder)\b/i.test(s);
const recordsOf = (raw: string): Record<string, unknown>[] => {
  const out: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) { if (!line.trim()) continue; let parsed: unknown; try { parsed = JSON.parse(line); } catch { continue; } if (obj(parsed)) out.push(parsed); }
  return out;
};
function headMeta(raw: string): { directory: string; updated: number; title: string } {
  let directory = "", updated = 0, title = "";
  for (const record of recordsOf(raw)) {
    if (!directory && typeof record.cwd === "string") directory = record.cwd;
    if (typeof record.timestamp === "string") { const time = Date.parse(record.timestamp); if (Number.isFinite(time)) updated = Math.max(updated, time); }
    if (!title) { const ask = userText(record); if (ordinary(ask)) title = ask.replace(/\s+/g, " ").trim().slice(0, 300); }
  }
  return { directory, updated, title };
}
function aiTitle(raw: string): string {
  let title = "";
  for (const record of recordsOf(raw)) if (record.type === "ai-title" && typeof record.aiTitle === "string" && record.aiTitle.trim()) title = record.aiTitle.trim().slice(0, 300);
  return title;
}

export class ClaudeHistory {
  private files = new Map<string, string>();
  constructor(private sessionsRoot = root(), private listLimit = 30) {}
  async list(): Promise<SourceTask[]> {
    this.files.clear();
    let count = 0;
    const rows: Row[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 2 || count >= 5000) return;
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (++count > 5000) throw new Error("Claude Code 会话目录超过扫描预算；未列出不完整结果。");
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { await walk(full, depth + 1); continue; }
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const id = entry.name.slice(0, -".jsonl".length);
        if (!uuid.test(id)) continue;
        const stat = await fs.lstat(full);
        if (stat.size > HANDOFF_LIMITS.bytes || stat.nlink !== 1) continue;
        // List reads bounded metadata only. A selected session is read separately.
        const handle = await fs.open(full, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        try {
          const headSize = Math.min(stat.size, HEAD);
          const head = await readAt(handle, 0, headSize);
          const meta = headMeta(head.toString("utf8"));
          let title = meta.title;
          if (stat.size > headSize) {
            const offset = Math.max(headSize, stat.size - TAIL);
            const tail = await readAt(handle, offset, stat.size - offset);
            title = aiTitle(tail.toString("utf8")) || title;
          } else {
            title = aiTitle(head.toString("utf8")) || title;
          }
          const clean = sanitizer();
          rows.push({ file: full, task: { id, title: clean.clean(title || "无标题对话"), directory: clean.clean(meta.directory.slice(0, 2000)), updated: Math.max(meta.updated, stat.mtimeMs) } });
        } finally { await handle.close(); }
      }
    };
    try { await walk(this.sessionsRoot, 0); }
    catch (error) { if (obj(error) && error.code === "ENOENT") return []; throw error; }
    rows.sort((a, b) => b.task.updated - a.task.updated);
    for (const row of rows.slice(0, this.listLimit)) this.files.set(row.task.id, row.file);
    return rows.slice(0, this.listLimit).map(row => row.task);
  }
  async importSession(id: string): Promise<HandoffImport> {
    const file = this.files.get(id);
    if (!file || !uuid.test(id)) throw new Error("请从刚读取的 Claude Code 会话列表选择对话。");
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    let raw: string;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > HANDOFF_LIMITS.bytes) throw new Error("Claude Code 会话文件不可读取或超过 8 MB。");
      raw = (await readAt(handle, 0, stat.size)).toString("utf8");
    } finally { await handle.close(); }
    const clean = sanitizer();
    const entries: string[] = [];
    let count = 0;
    let identity = "";
    let directory = "";
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let record: unknown;
      try { record = JSON.parse(line); } catch { throw new Error("Claude Code 会话记录损坏，未导入。"); }
      if (!obj(record)) continue;
      if (!identity && typeof record.sessionId === "string") identity = record.sessionId;
      if (!directory && typeof record.cwd === "string") directory = record.cwd;
      if (record.isSidechain) continue;
      if (record.type === "user") {
        const ask = userText(record);
        if (ordinary(ask)) { entries.push(`[用户历史]\n${clean.clean(ask)}`); count++; }
      } else if (record.type === "assistant") {
        const reply = assistantText(record);
        if (reply.trim()) { entries.push(`[Claude Code 回复历史]\n${clean.clean(reply)}`); count++; }
      }
      if (count > HANDOFF_LIMITS.messages) throw new Error("Claude Code 会话消息超过 5000 条，未截断导入。");
    }
    if (identity && identity !== id) throw new Error("Claude Code 会话身份已变更，请刷新列表。");
    const transcript = entries.join("\n\n");
    if (transcript.length > HANDOFF_LIMITS.text) throw new Error("Claude Code 交接文本超过 120000 字符，未截断导入。");
    return bindAttachments({
      id, title: clean.clean(aiTitle(raw) || headMeta(raw).title || "无标题对话"), directory: clean.clean(directory.slice(0, 2000)),
      source: "ClaudeCode", transcript, messageCount: count, redactions: clean.count(), warnings: [
        "Claude Code 会话列表是历史摘要，不代表任务状态或完成情况。",
        "只迁移用户请求和可见回复；工具调用、内部推理、子代理会话及运行状态未迁移；附件需单独确认打包。",
        "离线记录不能证明原任务已停止；接续前核对项目文件和未知结果的副作用。",
      ],
    }, claudeAttachmentCandidates(recordsOf(raw)));
  }
}
async function readAt(handle: fs.FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) { const { bytesRead } = await handle.read(buffer, read, length - read, position + read); if (!bytesRead) break; read += bytesRead; }
  return buffer.subarray(0, read);
}
