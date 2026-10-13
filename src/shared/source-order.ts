import { SKILL_TARGETS } from "./skill-targets";
import type { ToolUsage } from "./tool-usage";

export const ALL_SOURCE = "全部";
export const SOURCE_STATE_KEY = "networkLens.skillCenter.sources.v1";

export interface SourceState {
  order: string[];
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const EMPTY_SOURCE_STATE: SourceState = { order: [] };

/** Skill source ids map to the product ids used by real process-based usage tracking. */
const TARGET_PRODUCT: Record<string, string> = {
  wiscode: "wiscode",
  codex: "codex",
  claude: "claude-code",
  cursor: "cursor",
  windsurf: "windsurf",
  gemini: "gemini-cli",
  opencode: "opencode",
  trae: "trae",
  "trae-cn": "trae",
  workbuddy: "workbuddy",
};

/** Skill source label (as it appears in scans) to product id, derived from the target table. */
export const SOURCE_PRODUCT: Record<string, string> = Object.fromEntries(
  SKILL_TARGETS.filter((target) => TARGET_PRODUCT[target.id]).map((target) => [
    target.label,
    TARGET_PRODUCT[target.id],
  ]),
);

export function sourceProductId(source: string): string | undefined {
  return SOURCE_PRODUCT[source];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSourceState(raw: string | null): SourceState {
  if (!raw) return EMPTY_SOURCE_STATE;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return EMPTY_SOURCE_STATE;
  }
  if (!isRecord(value)) return EMPTY_SOURCE_STATE;
  const order = Array.isArray(value.order)
    ? Array.from(
        new Set(
          value.order.filter(
            (entry): entry is string => typeof entry === "string" && entry !== "" && entry !== ALL_SOURCE,
          ),
        ),
      )
    : [];
  return { order };
}

function opensFor(source: string, usage: ToolUsage | undefined): number {
  const id = sourceProductId(source);
  return id ? usage?.tools[id]?.opens ?? 0 : 0;
}

function lastOpenedFor(source: string, usage: ToolUsage | undefined): number {
  const id = sourceProductId(source);
  return id ? usage?.tools[id]?.lastOpenedAt ?? 0 : 0;
}

export function orderSources(
  discovered: string[],
  state: SourceState,
  usage?: ToolUsage,
): string[] {
  const unique = Array.from(
    new Set(discovered.filter((source) => source !== "" && source !== ALL_SOURCE)),
  );
  const pinnedIndex = new Map(state.order.map((source, index) => [source, index]));
  const discoveredIndex = new Map(unique.map((source, index) => [source, index]));
  const ranked = unique.slice().sort((a, b) => {
    const pinnedA = pinnedIndex.has(a) ? pinnedIndex.get(a)! : Number.POSITIVE_INFINITY;
    const pinnedB = pinnedIndex.has(b) ? pinnedIndex.get(b)! : Number.POSITIVE_INFINITY;
    if (pinnedA !== pinnedB) return pinnedA - pinnedB;
    if (pinnedA === Number.POSITIVE_INFINITY) {
      const opensDelta = opensFor(b, usage) - opensFor(a, usage);
      if (opensDelta !== 0) return opensDelta;
      const lastDelta = lastOpenedFor(b, usage) - lastOpenedFor(a, usage);
      if (lastDelta !== 0) return lastDelta;
    }
    return discoveredIndex.get(a)! - discoveredIndex.get(b)!;
  });
  return [ALL_SOURCE, ...ranked];
}

export function moveSource(order: string[], from: string, to: string): string[] {
  const current = order.slice();
  const fromIndex = current.indexOf(from);
  const toIndex = current.indexOf(to);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return current;
  current.splice(fromIndex, 1);
  current.splice(toIndex, 0, from);
  return current;
}

export function loadSourceState(storage: StorageLike | undefined): SourceState {
  if (!storage) return EMPTY_SOURCE_STATE;
  try {
    return parseSourceState(storage.getItem(SOURCE_STATE_KEY));
  } catch {
    return EMPTY_SOURCE_STATE;
  }
}

export function saveSourceState(storage: StorageLike | undefined, state: SourceState): void {
  if (!storage) return;
  try {
    storage.setItem(SOURCE_STATE_KEY, JSON.stringify(state));
  } catch {
    /* storage can be unavailable or full; ordering is a non-critical preference */
  }
}
