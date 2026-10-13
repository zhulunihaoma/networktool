import { TOOL_PRODUCTS } from "./assistant";

export interface ToolUsageEntry {
  opens: number;
  lastOpenedAt?: number;
}

export interface ToolUsage {
  version: 1;
  tools: Record<string, ToolUsageEntry>;
}

export const EMPTY_TOOL_USAGE: ToolUsage = { version: 1, tools: {} };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseToolUsage(value: unknown): ToolUsage {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return EMPTY_TOOL_USAGE;
    }
  }
  if (!isRecord(parsed) || !isRecord(parsed.tools)) return EMPTY_TOOL_USAGE;
  const tools: Record<string, ToolUsageEntry> = {};
  for (const [id, entry] of Object.entries(parsed.tools)) {
    if (!isRecord(entry)) continue;
    const opens = entry.opens;
    if (typeof opens !== "number" || !Number.isFinite(opens) || opens < 0) continue;
    const lastOpenedAt = entry.lastOpenedAt;
    tools[id] = {
      opens,
      ...(typeof lastOpenedAt === "number" && Number.isFinite(lastOpenedAt) ? { lastOpenedAt } : {}),
    };
  }
  return { version: 1, tools };
}

/**
 * Product ids with a process currently running, matched by process name against each
 * product's app and CLI names. This mirrors the "运行名称候选" rule in tool-registry.
 */
export function runningProducts(processes: readonly { name: string }[]): string[] {
  const names = processes.map((process) => process.name.toLowerCase());
  const running: string[] = [];
  for (const product of TOOL_PRODUCTS) {
    const candidates = [...product.apps, ...product.cli].map((name) => name.toLowerCase());
    if (!candidates.length) continue;
    if (names.some((name) => candidates.some((candidate) => name === candidate || name === `${candidate}.exe`)))
      running.push(product.id);
  }
  return running;
}

/**
 * Increment the open count for products that started running since the previous sample.
 * A `null` previous set marks the baseline sample (tools already running at startup are
 * not counted), which keeps restarts from inflating counts.
 */
export function applySample(
  usage: ToolUsage,
  previous: ReadonlySet<string> | null,
  current: readonly string[],
  now: number,
): ToolUsage {
  if (previous === null) return usage;
  const tools = { ...usage.tools };
  let changed = false;
  for (const id of current) {
    if (previous.has(id)) continue;
    const entry = tools[id];
    tools[id] = { opens: (entry?.opens ?? 0) + 1, lastOpenedAt: now };
    changed = true;
  }
  return changed ? { version: 1, tools } : usage;
}
