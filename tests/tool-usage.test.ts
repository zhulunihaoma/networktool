import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_TOOL_USAGE,
  applySample,
  parseToolUsage,
  runningProducts,
  type ToolUsage,
} from "../src/shared/tool-usage";

test("runningProducts matches product app and cli names case-insensitively", () => {
  const running = runningProducts([
    { name: "opencode" },
    { name: "Codex" },
    { name: "gemini" },
    { name: "unrelated-process" },
  ]);
  assert.deepEqual(running.sort(), ["codex", "gemini-cli", "opencode"]);
});

test("runningProducts recognises .exe names on Windows", () => {
  assert.deepEqual(runningProducts([{ name: "opencode.exe" }]), ["opencode"]);
});

test("runningProducts ignores blank and unknown names", () => {
  assert.deepEqual(runningProducts([{ name: "" }, { name: "curl" }]), []);
});

test("applySample treats the first sample as a baseline and counts nothing", () => {
  const baseline = applySample(EMPTY_TOOL_USAGE, null, ["opencode", "codex"], 1000);
  assert.deepEqual(baseline, EMPTY_TOOL_USAGE);
});

test("applySample counts a product only when it starts running", () => {
  const first = applySample(EMPTY_TOOL_USAGE, new Set(), ["opencode", "codex"], 1000);
  assert.deepEqual(first, {
    version: 1,
    tools: {
      opencode: { opens: 1, lastOpenedAt: 1000 },
      codex: { opens: 1, lastOpenedAt: 1000 },
    },
  });
  const stillRunning = applySample(first, new Set(["opencode", "codex"]), ["opencode", "codex"], 2000);
  assert.equal(stillRunning, first, "no transition means no new count and no new object");
  const reopened = applySample(stillRunning, new Set(["codex"]), ["opencode", "codex"], 3000);
  assert.equal(reopened.tools.opencode.opens, 2);
  assert.equal(reopened.tools.opencode.lastOpenedAt, 3000);
  assert.equal(reopened.tools.codex.opens, 1);
});

test("applySample returns the same object when nothing changed", () => {
  const usage: ToolUsage = { version: 1, tools: { opencode: { opens: 3, lastOpenedAt: 5 } } };
  assert.equal(applySample(usage, new Set(), [], 10), usage);
});

test("parseToolUsage tolerates malformed payloads and drops invalid entries", () => {
  assert.deepEqual(parseToolUsage(null), EMPTY_TOOL_USAGE);
  assert.deepEqual(parseToolUsage("{"), EMPTY_TOOL_USAGE);
  assert.deepEqual(
    parseToolUsage('{"version":1,"tools":{"opencode":{"opens":2,"lastOpenedAt":9},"bad":{"opens":"x"},"neg":{"opens":-1}}}'),
    { version: 1, tools: { opencode: { opens: 2, lastOpenedAt: 9 } } },
  );
});
