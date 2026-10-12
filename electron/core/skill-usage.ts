import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { SkillItem, SkillUsage } from "../../src/shared/skills";

const MAX_DIR_ENTRIES = 4000;
const MAX_LOG_FILES = 80;
const MAX_LOG_BYTES = 2 * 1024 * 1024;

function inside(root: string, location: string): boolean {
  const relative = path.relative(root, location);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

const unknown = (codex: boolean): SkillUsage => ({
  status: "unknown",
  evidence: codex
    ? "本次只检查有限的 Codex 本机会话工具调用；没有明确读取记录也不能证明从未使用"
    : "当前没有能准确对应此安装位置的调用记录，无法判断多久未使用",
});

/** Only an explicit tool read of this exact SKILL.md counts as an observed read. */
export async function attachSkillUsage(home: string, items: SkillItem[]): Promise<void> {
  const roots = [path.join(home, ".codex", "skills"), path.join(home, ".agents", "skills")];
  const targets = items.filter(item => item.kind !== "broken-link" && roots.some(root => inside(root, item.path)));
  for (const item of items) item.usage = unknown(targets.includes(item));
  if (!targets.length) return;
  const sessions = path.join(home, ".codex", "sessions");
  const logs: { file: string; modified: number }[] = [];
  let visited = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 3 || visited >= MAX_DIR_ENTRIES) return;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (++visited > MAX_DIR_ENTRIES) break;
      const location = path.join(directory, entry.name);
      if (entry.isDirectory() && /^\d{2,4}$/.test(entry.name)) await walk(location, depth + 1);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        const stat = await fs.lstat(location);
        if (stat.isFile() && stat.nlink === 1 && stat.size <= MAX_LOG_BYTES) logs.push({ file: location, modified: stat.mtimeMs });
      }
    }
  };
  try { await walk(sessions, 0); }
  catch { return; }
  logs.sort((a, b) => b.modified - a.modified);
  const documents = new Map(targets.map(item => [path.join(item.path, "SKILL.md"), item]));
  for (const log of logs.slice(0, MAX_LOG_FILES)) {
    let raw: string;
    try {
      const handle = await fs.open(log.file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_LOG_BYTES) continue;
        const buffer = Buffer.alloc(stat.size);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        raw = buffer.subarray(0, bytesRead).toString("utf8");
      } finally { await handle.close(); }
    }
    catch { continue; }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let record: unknown;
      try { record = JSON.parse(line); } catch { continue; }
      if (!record || typeof record !== "object") continue;
      const row = record as { type?: unknown; timestamp?: unknown; payload?: unknown };
      if (row.type !== "response_item" || !row.payload || typeof row.payload !== "object") continue;
      const payload = row.payload as { type?: unknown; name?: unknown; arguments?: unknown };
      if (payload.type !== "function_call" || typeof payload.name !== "string" || typeof payload.arguments !== "string") continue;
      let argumentsValue: unknown;
      try { argumentsValue = JSON.parse(payload.arguments); } catch { continue; }
      if (!argumentsValue || typeof argumentsValue !== "object") continue;
      const args = argumentsValue as { cmd?: unknown; command?: unknown; path?: unknown; file_path?: unknown };
      const command = typeof args.cmd === "string" ? args.cmd : typeof args.command === "string" ? args.command : "";
      const isRead = /read_file|read_mcp_resource/i.test(payload.name)
        || (/exec|shell|terminal/i.test(payload.name) && /(?:^|[;\n|&])\s*(?:cat|sed|head|less|Get-Content)\b/i.test(command));
      if (!isRead) continue;
      const time = Date.parse(String(row.timestamp ?? ""));
      if (!Number.isFinite(time)) continue;
      for (const [document, item] of documents) {
        if (!((typeof args.path === "string" && args.path === document) || (typeof args.file_path === "string" && args.file_path === document) || command.includes(document))) continue;
        const previous = item.usage?.lastObservedAt ? Date.parse(item.usage.lastObservedAt) : 0;
        if (time <= previous) continue;
        item.usage = {
          status: "observed-read", lastObservedAt: new Date(time).toISOString(),
          evidence: "Codex 本机会话的工具调用明确读取了这份 SKILL.md；这是读取记录，不证明业务任务已运行",
        };
      }
    }
  }
}
