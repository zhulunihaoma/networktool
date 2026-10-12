import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestedEndpoints, suggestedTriageTarget } from "../src/shared/tool-network";

test("顺序排查选择对应公开入口，未知工具不默认冒充 Codex", () => {
  assert.equal(suggestedTriageTarget("codex"), "codex");
  assert.equal(suggestedTriageTarget("claude-code"), "claude");
  assert.equal(suggestedTriageTarget("claude-desktop"), "claude");
  assert.equal(suggestedTriageTarget("deepseek-harness"), "deepseek");
  assert.equal(suggestedTriageTarget("unknown"), undefined);
  assert.equal(suggestedTriageTarget("vscode"), undefined);
});

test("已知工具只建议官方服务，不将建议冒充已读取配置", () => {
  assert.deepEqual(
    suggestedEndpoints("codex").map((x) => x.endpoint.id),
    ["openai-api"],
  );
  assert.deepEqual(
    suggestedEndpoints("claude-code").map((x) => x.endpoint.id),
    ["anthropic-api"],
  );
  assert.deepEqual(
    suggestedEndpoints("deepseek-harness").map((x) => x.endpoint.id),
    ["deepseek-api"],
  );
});

test("多供应商工具和未知工具不推断服务", () => {
  for (const id of [undefined, "cursor", "vscode", "opencode", "unknown"]) {
    assert.deepEqual(suggestedEndpoints(id), []);
  }
});
