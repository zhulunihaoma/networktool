import fs from "node:fs";
import { createHash } from "node:crypto";
import type {
  EvidenceSource,
  SecurityEvent,
  SecurityStats,
  TimelineFilter,
  TimelinePage,
} from "../../src/shared/security";
import { eventsFile } from "./guard-protocol";
export type StoredEvent = SecurityEvent & { prev: string; hash: string };
const SOURCES: EvidenceSource[] = [
  "real_block",
  "real_allow",
  "self_check",
  "scan",
  "network",
  "session",
  "action",
  "error",
];
export function readStored(
  dataDir: string,
  max = 20000,
): { rows: StoredEvent[]; corrupt: number; truncated: boolean } {
  let text = "";
  try {
    try {
      text = fs.readFileSync(eventsFile(dataDir) + ".1", "utf8");
    } catch {}
    text += fs.readFileSync(eventsFile(dataDir), "utf8");
  } catch {
    return { rows: [], corrupt: 0, truncated: false };
  }
  const lines = text.split("\n").filter(Boolean);
  const rows: StoredEvent[] = [];
  let corrupt = 0;
  for (const line of lines.slice(-max)) {
    try {
      const value = JSON.parse(line);
      if (
        value &&
        typeof value.hash === "string" &&
        typeof value.at === "number"
      )
        rows.push(value);
      else corrupt++;
    } catch {
      corrupt++;
    }
  }
  return { rows, corrupt, truncated: lines.length > max };
}
/** Each line stores sha256(body) and the previous line's hash; any edit, deletion or reorder is detected. */
export function verifyChain(
  rows: StoredEvent[],
  corrupt = 0,
): TimelinePage["chain"] {
  if (!rows.length) return { status: corrupt ? "broken" : "empty", checked: 0 };
  for (let i = 0; i < rows.length; i++) {
    const { hash, ...body } = rows[i];
    const expected = createHash("sha256")
      .update(JSON.stringify(body))
      .digest("hex");
    if (hash !== expected || (i > 0 && rows[i].prev !== rows[i - 1].hash))
      return { status: "broken", checked: rows.length, brokenAt: i };
  }
  return corrupt
    ? { status: "broken", checked: rows.length }
    : { status: "ok", checked: rows.length };
}
const dayKey = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
/** Days between two times, counting a new day as soon as local midnight passes. */
export const protectionDays = (from: number, to: number) => {
  const a = new Date(from).setHours(0, 0, 0, 0);
  const b = new Date(to).setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((b - a) / 86400000) + 1);
};
/** Cumulative stats for the overview dashboard, from the same chained log. */
export function stats(dataDir: string, now = Date.now()): SecurityStats {
  const { rows } = readStored(dataDir);
  const byDay = new Map<string, SecurityStats["byDay"][number]>();
  const byTool: Record<string, number> = {};
  const byRule: Record<string, number> = {};
  const actions: SecurityStats["actions"] = [];
  const tools = new Set<string>();
  let firstEventAt: number | undefined;
  let totalChecked = 0;
  let totalBlocked = 0;
  // Initialize the chart range so quiet days still show a bar.
  for (let i = 29; i >= 0; i--) {
    const day = dayKey(now - i * 86400000);
    byDay.set(day, { day, checked: 0, blocked: 0 });
  }
  for (const row of rows) {
    const real = row.source === "real_block" || row.source === "real_allow";
    if (real) {
      if (firstEventAt === undefined || row.at < firstEventAt)
        firstEventAt = row.at;
      tools.add(row.tool);
      totalChecked++;
      if (row.source === "real_block") {
        totalBlocked++;
        if (row.tool in byTool) byTool[row.tool]++;
        else byTool[row.tool] = 1;
        if (row.ruleId) {
          if (row.ruleId in byRule) byRule[row.ruleId]++;
          else byRule[row.ruleId] = 1;
        }
      }
      const key = dayKey(row.at);
      const day = byDay.get(key);
      if (day) {
        day.checked++;
        if (row.source === "real_block") day.blocked++;
      }
    } else if (row.source === "action") {
      actions.push({
        at: row.at,
        operation: row.operation,
        reason: row.reason,
        tool: row.tool,
      });
    }
  }
  return {
    firstEventAt,
    totalChecked,
    totalBlocked,
    toolsWithEvents: tools.size,
    byDay: [...byDay.values()],
    byTool,
    byRule,
    // Newest first; actions render like an activity feed.
    actions: actions.reverse().slice(0, 50),
  };
}
export function timeline(
  dataDir: string,
  filter: TimelineFilter = {},
): TimelinePage {
  const { rows, corrupt } = readStored(dataDir);
  const counts = Object.fromEntries(SOURCES.map((s) => [s, 0])) as Record<
    EvidenceSource,
    number
  >;
  const byRule: Record<string, number> = {};
  for (const row of rows) {
    if (row.source in counts) counts[row.source]++;
    if (row.source === "real_block" && row.ruleId)
      byRule[row.ruleId] = (byRule[row.ruleId] ?? 0) + 1;
  }
  const query = filter.query?.trim().toLowerCase();
  const sources = filter.sources?.length ? new Set(filter.sources) : undefined;
  const matched = rows
    .filter((r) =>
      sources
        ? sources.has(r.source)
        : !filter.source || filter.source === "all" || r.source === filter.source,
    )
    .filter((r) => !filter.tool || r.tool === filter.tool)
    .filter((r) => !filter.ruleId || r.ruleId === filter.ruleId)
    .filter((r) => filter.from === undefined || r.at >= filter.from)
    .filter((r) => filter.to === undefined || r.at <= filter.to)
    .filter(
      (r) =>
        !query ||
        [r.operation, r.reason, r.project, r.ruleId].some((v) =>
          v?.toLowerCase().includes(query),
        ),
    )
    .reverse();
  const offset = Math.max(0, filter.offset ?? 0);
  const limit = Math.min(filter.limit ?? 200, 1000);
  const events = matched
    .slice(offset, offset + limit)
    .map(({ prev, hash, ...event }) => event as SecurityEvent);
  return {
    events,
    total: matched.length,
    counts,
    byRule,
    hasMore: offset + limit < matched.length,
    chain: verifyChain(rows, corrupt),
  };
}
