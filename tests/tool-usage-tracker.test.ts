import assert from "node:assert/strict";
import test from "node:test";
import { ToolUsageTracker } from "../electron/core/tool-usage";
import type { Store } from "../electron/core/store";
import type { ProcessInfo } from "../src/shared/types";

function fakeStore(initial: Map<string, unknown> = new Map()) {
  const memory = initial;
  const store = {
    assistant: <T>(name: string, fallback: T): T =>
      memory.has(name) ? (memory.get(name) as T) : fallback,
    putAssistant: (name: string, value: unknown) => void memory.set(name, value),
  } as unknown as Store;
  return { store, memory };
}

function processList(names: string[]): ProcessInfo[] {
  return names.map((name, index) => ({
    key: `k${index}`,
    pid: index + 1,
    ppid: 0,
    name,
    created: new Date().toISOString(),
    relation: "candidate" as const,
  }));
}

test("the first poll is a baseline and does not count already-running tools", async () => {
  const { store, memory } = fakeStore();
  let names = ["opencode"];
  const tracker = new ToolUsageTracker(store, async () => processList(names), 1_000_000);
  await tracker.poll();
  assert.deepEqual(tracker.current().tools, {});
  await tracker.poll();
  assert.deepEqual(tracker.current().tools, {});
  assert.equal(memory.has("toolUsage"), false, "no writes when nothing starts running");
});

test("a tool is counted once per open episode and persisted", async () => {
  const { store, memory } = fakeStore();
  let names: string[] = [];
  const tracker = new ToolUsageTracker(store, async () => processList(names), 1_000_000);
  await tracker.poll(); // baseline, nothing running
  names = ["opencode"];
  await tracker.poll(); // opencode starts
  assert.equal(tracker.current().tools.opencode.opens, 1);
  names = ["opencode", "codex"];
  await tracker.poll(); // codex starts, opencode still running
  assert.equal(tracker.current().tools.opencode.opens, 1);
  assert.equal(tracker.current().tools.codex.opens, 1);
  names = [];
  await tracker.poll(); // both stop
  names = ["opencode"];
  await tracker.poll(); // opencode reopens
  assert.equal(tracker.current().tools.opencode.opens, 2);
  assert.deepEqual(memory.get("toolUsage"), tracker.current());
});

test("the tracker resumes counts loaded from the store", async () => {
  const memory = new Map<string, unknown>([
    ["toolUsage", { version: 1, tools: { opencode: { opens: 4, lastOpenedAt: 7 } } }],
  ]);
  const { store } = fakeStore(memory);
  let names: string[] = [];
  const tracker = new ToolUsageTracker(store, async () => processList(names), 1_000_000);
  await tracker.poll();
  names = ["opencode"];
  await tracker.poll();
  assert.equal(tracker.current().tools.opencode.opens, 5);
});

test("process listing failures never throw", async () => {
  const { store } = fakeStore();
  const tracker = new ToolUsageTracker(
    store,
    async () => {
      throw new Error("ps failed");
    },
    1_000_000,
  );
  await tracker.poll();
  assert.deepEqual(tracker.current().tools, {});
});
