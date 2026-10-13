import assert from "node:assert/strict";
import test from "node:test";
import {
  ALL_SOURCE,
  EMPTY_SOURCE_STATE,
  loadSourceState,
  moveSource,
  orderSources,
  parseSourceState,
  saveSourceState,
  sourceProductId,
  type SourceState,
  type StorageLike,
} from "../src/shared/source-order";
import type { ToolUsage } from "../src/shared/tool-usage";

const discovered = ["WisCode", "Claude Code", "Windsurf", ALL_SOURCE];

function usage(tools: Record<string, { opens: number; lastOpenedAt?: number }>): ToolUsage {
  return { version: 1, tools };
}

test("全部 is pinned first and never reordered", () => {
  const state: SourceState = { order: ["Windsurf", "WisCode"] };
  assert.deepEqual(orderSources(discovered, state), [
    ALL_SOURCE,
    "Windsurf",
    "WisCode",
    "Claude Code",
  ]);
});

test("without a manual order, sources rank by real open count descending", () => {
  const state = EMPTY_SOURCE_STATE;
  const counts = usage({
    "claude-code": { opens: 1 },
    opencode: { opens: 9 },
    windsurf: { opens: 5 },
    wiscode: { opens: 2 },
  });
  assert.deepEqual(orderSources(["WisCode", "Claude Code", "Windsurf", ALL_SOURCE], state, counts), [
    ALL_SOURCE,
    "Windsurf",
    "WisCode",
    "Claude Code",
  ]);
});

test("opencode ranks first when it has the most opens", () => {
  const counts = usage({
    opencode: { opens: 12, lastOpenedAt: 5 },
    "claude-code": { opens: 3 },
    wiscode: { opens: 1 },
  });
  assert.deepEqual(
    orderSources(["WisCode", "Claude Code", "OpenCode", ALL_SOURCE], EMPTY_SOURCE_STATE, counts),
    [ALL_SOURCE, "OpenCode", "Claude Code", "WisCode"],
  );
});

test("open count ties break on most recent use", () => {
  const counts = usage({
    opencode: { opens: 4, lastOpenedAt: 100 },
    "claude-code": { opens: 4, lastOpenedAt: 200 },
  });
  assert.deepEqual(
    orderSources(["OpenCode", "Claude Code", ALL_SOURCE], EMPTY_SOURCE_STATE, counts),
    [ALL_SOURCE, "Claude Code", "OpenCode"],
  );
});

test("sources without a tracked product fall back to discovery order", () => {
  const counts = usage({ opencode: { opens: 3 } });
  assert.deepEqual(
    orderSources(["共享 Skills 目录", "OpenCode", "自定义目录", ALL_SOURCE], EMPTY_SOURCE_STATE, counts),
    [ALL_SOURCE, "OpenCode", "共享 Skills 目录", "自定义目录"],
  );
});

test("manual order wins over real usage, new sources are appended by usage", () => {
  const counts = usage({ opencode: { opens: 99 }, wiscode: { opens: 50 } });
  assert.deepEqual(
    orderSources(["WisCode", "Claude Code", "OpenCode", ALL_SOURCE], { order: ["WisCode", "Claude Code"] }, counts),
    [ALL_SOURCE, "WisCode", "Claude Code", "OpenCode"],
  );
});

test("order entries for sources that no longer exist are ignored", () => {
  assert.deepEqual(
    orderSources(discovered, { order: ["Ghost", "WisCode"] }),
    [ALL_SOURCE, "WisCode", "Claude Code", "Windsurf"],
  );
});

test("sourceProductId maps known labels and ignores unknown ones", () => {
  assert.equal(sourceProductId("OpenCode"), "opencode");
  assert.equal(sourceProductId("Claude Code"), "claude-code");
  assert.equal(sourceProductId("Gemini CLI"), "gemini-cli");
  assert.equal(sourceProductId("自定义目录"), undefined);
});

test("moveSource reorders within the list and keeps it stable", () => {
  assert.deepEqual(moveSource(["a", "b", "c"], "c", "a"), ["c", "a", "b"]);
  assert.deepEqual(moveSource(["a", "b", "c"], "a", "c"), ["b", "c", "a"]);
  assert.deepEqual(moveSource(["a", "b", "c"], "a", "a"), ["a", "b", "c"]);
  assert.deepEqual(moveSource(["a", "b"], "x", "b"), ["a", "b"]);
});

test("parseSourceState tolerates missing, malformed or legacy payloads", () => {
  assert.deepEqual(parseSourceState(null), EMPTY_SOURCE_STATE);
  assert.deepEqual(parseSourceState("{"), EMPTY_SOURCE_STATE);
  assert.deepEqual(parseSourceState('{"order":["a","a",1]}'), { order: ["a"] });
  assert.deepEqual(parseSourceState('{"order":["a"],"usage":{"a":2}}'), { order: ["a"] });
});

test("loadSourceState and saveSourceState round-trip through storage", () => {
  const memory = new Map<string, string>();
  const storage: StorageLike = {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => void memory.set(key, value),
  };
  assert.deepEqual(loadSourceState(storage), EMPTY_SOURCE_STATE);
  saveSourceState(storage, { order: ["WisCode"] });
  assert.deepEqual(loadSourceState(storage), { order: ["WisCode"] });
  assert.deepEqual(loadSourceState(undefined), EMPTY_SOURCE_STATE);
});
