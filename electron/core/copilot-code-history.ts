import { bindAttachments, contentAttachments } from "./handoff-attachments";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { copilotRoots } from "./handoff-tools";
import { LocalHandoffHistory, nativeEntries, nativeFile, importedText, isObject, stringValue, type HistoryRow, type TextMessage } from "./local-handoff-history";

export function copilotMessages(value: unknown): TextMessage[] {
  if (!Array.isArray(value) || value.length > 20000 || !value.every(isObject)) throw new Error("极库 Copilot Code 会话结构不兼容或超过读取上限。");
  const out: TextMessage[] = [];
  let initial = true;
  for (const row of value) {
    const text = stringValue(row.text);
    if (row.partial || !text.trim() || row.type !== "say") continue;
    if (row.say === "text") { out.push({ role: initial ? "user" : "assistant", text }); initial = false; }
    else if (row.say === "user_feedback") { out.push({ role: "user", text }); initial = false; }
    else if (row.say === "completion_result") out.push({ role: "assistant", text });
    // ask/tool, reasoning, API headers, commands, checkpoints, and image data are omitted.
  }
  return out;
}
export class CopilotCodeHistory extends LocalHandoffHistory {
  constructor(private home = os.homedir()) { super("CopilotCode"); }
  async rows(): Promise<HistoryRow[]> {
    const rows: HistoryRow[] = [];
    for (const root of copilotRoots(this.home)) for (const entry of await nativeEntries(root)) {
      if (!entry.isDirectory() || !/^[\da-f-]{36}$/i.test(entry.name)) continue;
      const file = path.join(root, entry.name, "ui_messages.json");
      let data: unknown;
      try { data = JSON.parse((await nativeFile(file, root)).toString("utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      const messages = copilotMessages(data);
      if (!messages.length) continue;
      rows.push({ task: { id: entry.name, title: messages.find(m => m.role === "user")?.text.replace(/\s+/g, " ").slice(0, 300) || "无标题对话", directory: "", updated: (await fs.stat(file)).mtimeMs }, file, root });
      if (rows.length > 5000) throw new Error("极库 Copilot Code 会话数量超出扫描预算。");
    }
    return rows;
  }
  protected async read(row: HistoryRow) {
    const data: unknown = JSON.parse((await nativeFile(row.file!, row.root!)).toString("utf8"));
    const records = data as Record<string, unknown>[];
    let initial = true;
    const candidates = records.flatMap((r,index) => {
      if (r.partial || r.type !== "say") return [];
      const user = r.say === "user_feedback" || r.say === "text" && initial;
      if (r.say === "text" || r.say === "user_feedback") initial = false;
      return user && Array.isArray(r.images) ? contentAttachments(r.images.map(url => ({type:"image",url})),String(r.ts || index)) : [];
    });
    return bindAttachments(importedText(this.source, row.task, copilotMessages(data), ["极库 Copilot Code 使用本地 UI 消息记录；原生标题与工作区索引未提供，标题取首条用户请求。"]),candidates);
  }
}
