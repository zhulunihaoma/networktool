import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { SkillItem, SkillUsage } from "../../src/shared/skills";

const MAX_DIR_ENTRIES = 12000;
const MAX_LOG_FILES = 400;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const DAY = 86400000;
function inside(root: string, location: string) {
  const relative = path.relative(root, location);
  return (
    relative === "" ||
    (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}
const unknown = (supported: boolean): SkillUsage => ({
  status: "unknown",
  coverage: supported ? "partial" : "unsupported",
  recommendation: "observe",
  evidence: supported
    ? "只统计本地日志中可对应到此安装位置的读取记录；未记录的加载无法确认"
    : "此工具尚未接入可靠的 Skill 加载记录，不能判断低频",
});

/** Exact file operands only; mentions, echo and substring path collisions never count. */
export function skillReadPaths(
  name: string,
  args: Record<string, unknown>,
): string[] {
  if (/^(?:\w+\.)*(?:read_file|read_text_file)$/.test(name)) {
    const file = args.path ?? args.file_path;
    return typeof file === "string" ? [file] : [];
  }
  if (!/(?:exec_command|shell|terminal)$/.test(name)) return [];
  const cmd = args.cmd ?? args.command;
  if (typeof cmd !== "string" || /[`$;\n]|<<|&&|\|\||\becho\b/.test(cmd)) return [];
  const result: string[] = [];
  for (const command of cmd.split(/[;\n]|&&|\|\|/)) {
    if (
      !/^\s*(?:cat|sed|head|less|Get-Content)\s/.test(command) ||
      /\|/.test(command)
    )
      continue;
    const tokens = [
      ...command.matchAll(/"([^"\n]*)"|'([^'\n]*)'|([^\s]+)/g),
    ].map((m) => m[1] ?? m[2] ?? m[3]);
    result.push(
      ...tokens
        .slice(1)
        .filter(
          (token) =>
            path.isAbsolute(token) && path.basename(token) === "SKILL.md",
        ),
    );
  }
  return result;
}
function succeeded(output: unknown, shell: boolean): boolean {
  if (typeof output !== "string") return false;
  try {
    const value = JSON.parse(output);
    if (value.isError || value.error || value.exit_code > 0) return false;
    if (shell) return value.exit_code === 0 || value.exitCode === 0;
    return !value.isError && !value.error;
  } catch {
    if (shell)
      return /(?:Process exited with code|exit_code["']?\s*[:=])\s*0\b/.test(
        output,
      );
    return (
      !!output &&
      !/^(?:error|failed|file not found|permission denied)\b/i.test(
        output.trim(),
      )
    );
  }
}

/** Available log coverage is explicit. Unconfirmed read requests never enter the ratio. */
export async function attachSkillUsage(
  home: string,
  items: SkillItem[],
  now = Date.now(),
): Promise<void> {
  const roots = [
    path.join(home, ".codex", "skills"),
    path.join(home, ".agents", "skills"),
  ];
  const targets = items.filter(
    (item) => (!item.kind || item.kind === 'skill') && roots.some((root) => inside(root, item.path)),
  );
  for (const item of items) item.usage = unknown(targets.includes(item));
  if (!targets.length) return;
  const logs: string[] = [];
  let visited = 0,
    partial = false,
    earliest = now,
    totalBytes = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 3) {
      partial = true;
      return;
    }
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++visited > MAX_DIR_ENTRIES) {
        partial = true;
        return;
      }
      const location = path.join(directory, entry.name);
      if (entry.isDirectory() && /^\d{2,4}$/.test(entry.name))
        await walk(location, depth + 1);
      else if (entry.isSymbolicLink()) partial = true;
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        logs.push(location);
      }
    }
  };
  try {
    await walk(path.join(home, ".codex", "sessions"), 0);
  } catch {
    return;
  }
  logs.sort().reverse();
  if (logs.length > MAX_LOG_FILES) partial = true;
  const documents = new Map(
    targets.map((item) => [path.join(item.path, "SKILL.md"), item]),
  );
  const seen = new Map<string, Set<string>>();
  const confirmed = new Map<string, number>();
  const requested = new Map<string, number>();
  const eligible = new Set<string>();
  for (const file of logs.slice(0, MAX_LOG_FILES)) {
    let raw: string;
    try {
      const h = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await h.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_LOG_BYTES) {
          partial = true;
          continue;
        }
        if ((totalBytes += stat.size) > MAX_TOTAL_BYTES) {
          partial = true;
          break;
        }
        raw = await h.readFile("utf8");
        if (Buffer.byteLength(raw) !== stat.size) partial = true;
      } finally {
        await h.close();
      }
    } catch {
      partial = true;
      continue;
    }
    const calls = new Map<
      string,
      { ids: string[]; at: number; shell: boolean }
    >();
    let session = file;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let row: any;
      try {
        row = JSON.parse(line);
      } catch {
        partial = true;
        continue;
      }
      const time = Date.parse(String(row.timestamp ?? ""));
      if (Number.isFinite(time) && time <= now)
        earliest = Math.min(earliest, time);
      if (row.type === "session_meta" && typeof row.payload?.id === "string")
        session = row.payload.id;
      if (row.type !== "response_item" || !row.payload) continue;
      const p = row.payload;
      if (p.type === "function_call_output" && typeof p.call_id === "string") {
        const call = calls.get(p.call_id);
        if (!call || !succeeded(p.output, call.shell)) continue;
        for (const id of call.ids) {
          confirmed.set(id, Math.max(confirmed.get(id) ?? 0, call.at));
          if (call.at >= now - 30 * DAY) {
            const sessions = seen.get(id) ?? new Set<string>();
            sessions.add(session);
            seen.set(id, sessions);
          }
        }
        continue;
      }
      if (!Number.isFinite(time) || time > now) continue;
      if (
        p.type === "custom_tool_call" ||
        (p.type === "function_call" && /(?:^|\.)exec$/.test(p.name ?? ""))
      ) {
        partial = true;
        continue;
      }
      if (p.type !== "function_call" || typeof p.name !== "string") continue;
      if (time >= now - 30 * DAY) eligible.add(session);
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(p.arguments);
      } catch {
        partial = true;
        continue;
      }
      const readPaths = skillReadPaths(p.name, args);
      const command = args.cmd ?? args.command;
      if (!readPaths.length && typeof command === 'string' && /SKILL\.md\b/.test(command) && !/^\s*echo\s/.test(command)) partial = true;
      const ids = readPaths.flatMap(
        (file) => documents.get(file)?.id ?? [],
      );
      if (!ids.length) continue;
      for (const id of ids)
        requested.set(id, Math.max(requested.get(id) ?? 0, time));
      if (typeof p.call_id === "string")
        calls.set(p.call_id, {
          ids,
          at: time,
          shell: /(?:exec_command|shell|terminal)$/.test(p.name),
        });
      else partial = true;
    }
  }
  for (const item of targets) {
    const at = confirmed.get(item.id),
      request = requested.get(item.id);
    item.usage = {
      ...unknown(true),
      status: at || request ? "observed-read" : "unknown",
      confirmed: !!at,
      lastObservedAt:
        at || request ? new Date(at ?? request!).toISOString() : undefined,
      coverage: partial ? "partial" : "recorded",
      sessions30: seen.get(item.id)?.size ?? 0,
      eligibleSessions30: eligible.size,
      observationDays: Math.floor((now - earliest) / DAY),
      evidence: partial
        ? "日志数量、大小、格式或工具调用解析不完整；已确认的读取可查看，不能据此推荐低频删除"
        : "统计可读取的 Codex 本地日志；只有读取成功的会话计数，不代表业务任务已运行，也不覆盖工具未写入日志的加载",
    };
  }
}
