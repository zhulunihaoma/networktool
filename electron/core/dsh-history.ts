import { bindAttachments, contentAttachments } from "./handoff-attachments";
import os from "node:os";
import path from "node:path";
import * as zlib from "node:zlib";
import { LocalHandoffHistory, nativeFile, nativeEntries, parseLines, importedText, visibleText, isObject, stringValue, type HistoryRow, type TextMessage } from "./local-handoff-history";
import { HANDOFF_LIMITS } from "../../src/shared/handoff";

export function decompressDsh(compressed: Buffer): string {
  type Result = { buffer: Buffer; engine: { bytesWritten: number } };
  const decompress = (zlib as unknown as { zstdDecompressSync?: (data: Buffer, options: { maxOutputLength: number; info: true }) => Result }).zstdDecompressSync;
  if (!decompress) throw new Error("当前运行时不支持 Zstandard 会话解压，请使用新版桌面应用。");
  const chunks: Buffer[] = [];
  let offset = 0, size = 0, frames = 0;
  // DSH appends independent frames. Node stops at the first frame; use the
  // decoder's consumed-byte count, never search for magic bytes inside payloads.
  while (offset < compressed.length) {
    if (++frames > 50000 || size >= HANDOFF_LIMITS.bytes) throw new Error("DeepSeek Harness 日志超过解压预算，未截断导入。");
    let result: Result;
    try { result = decompress(compressed.subarray(offset), { maxOutputLength: HANDOFF_LIMITS.bytes - size, info: true }); }
    catch { throw new Error("DeepSeek Harness 正文损坏或解压后超过 8 MB，未截断导入。"); }
    const consumed = result.engine.bytesWritten;
    if (!Number.isSafeInteger(consumed) || consumed <= 0 || consumed > compressed.length - offset) throw new Error("DeepSeek Harness 压缩日志不完整，未导入部分正文。");
    offset += consumed; size += result.buffer.length; chunks.push(result.buffer);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}
export function dshMessages(raw: string, id: string): TextMessage[] {
  const records = parseLines(raw), header = records[0];
  if (!header || header.type !== "session" || ![id, `session-${id}`].includes(stringValue(header.id)) || Number(header.delegationDepth || 0) > 0) throw new Error("DeepSeek Harness 会话身份不符或是子代理记录。");
  if (![0, 4].includes(Number(header.version))) throw new Error("DeepSeek Harness 日志版本尚未适配。");
  const entries: TextMessage[] = [];
  for (const row of records) {
    if (!isObject(row.data)) continue;
    if (row.type === "user/message") {
      const source = isObject(row.data.source) ? row.data.source : {};
      if (source.kind && !["human", "user", "rpc", "cli", "interactive"].includes(String(source.kind))) continue;
      entries.push({ role: "user", text: visibleText(row.data.content), id: stringValue(row.data.id) || undefined });
    } else if (row.type === "assistant/message" && isObject(row.data.message)) entries.push({ role: "assistant", text: visibleText(row.data.message.content), id: stringValue(row.data.message.id) || undefined });
    // Streaming chunks and compressed text/reasoning chunks mirror committed messages.
  }
  return entries;
}
export class DshHistory extends LocalHandoffHistory {
  constructor(private home = os.homedir()) { super("DeepSeekHarness"); }
  async rows(): Promise<HistoryRow[]> {
    const base = path.join(this.home, ".dsh"), root = path.join(base, "sessions"), rows: HistoryRow[] = [];
    for (const workspace of await nativeEntries(root)) {
      if (!workspace.isDirectory()) continue;
      for (const session of await nativeEntries(path.join(root, workspace.name))) {
        if (!session.isDirectory() || !/^session-[\da-f-]{36}$/i.test(session.name)) continue;
        const folder = path.join(root, workspace.name, session.name), entries = await nativeEntries(folder);
        const native = entries.find(e => e.isFile() && e.name === "session.v4.jsonl.zstd") || entries.find(e => e.isFile() && e.name === "session.jsonl.zstd");
        if (!native) continue;
        let cache: unknown;
        try { cache = JSON.parse((await nativeFile(path.join(base, "storages/session_projcache/sessions", `${session.name}.json`), base, 1024 * 1024)).toString("utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        if (!isObject(cache) || !isObject(cache.record) || !isObject(cache.record.identity) || !isObject(cache.record.rows)) throw new Error("DeepSeek Harness 会话索引版本不兼容。");
        const data = cache.record.rows;
        const metadata = isObject(data.sessionListMetadata) && isObject(data.sessionListMetadata.val) ? data.sessionListMetadata.val : {};
        if (metadata.blank === true) continue;
        const subagent = isObject(data.subagent) && isObject(data.subagent.val) ? data.subagent.val : {};
        if (Object.keys(subagent).length) continue;
        const title = isObject(data.title) ? stringValue(data.title.val) : "";
        rows.push({ task: { id: session.name.slice(8), title: title || "无标题对话", directory: stringValue(cache.record.identity.cwd), updated: Number(metadata.lastPromptAt || cache.record.identity.createdAt) || 0 }, file: path.join(folder, native.name), root });
        if (rows.length > 5000) throw new Error("DeepSeek Harness 会话数量超出扫描预算。");
      }
    }
    return rows;
  }
  protected async read(row: HistoryRow) {
    const compressed = await nativeFile(row.file!, row.root!);
    const raw = decompressDsh(compressed);
    const candidates = parseLines(raw).filter(r => r.type === "user/message" && isObject(r.data)).flatMap(r => {
      const d = r.data as Record<string,unknown>, source = isObject(d.source) ? d.source : {};
      if (source.kind && !["human","user","rpc","cli","interactive"].includes(String(source.kind))) return [];
      return contentAttachments(d.content,stringValue(d.id) || String(r.seq || "用户消息"),{home:this.home,kind:"dsh"});
    });
    return bindAttachments(importedText(this.source, row.task, dshMessages(raw, row.task.id), ["正文来自原生压缩日志；列表缓存中的截短摘要没有作为会话正文导入。"]), candidates);
  }
}
