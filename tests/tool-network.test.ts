import { test } from "node:test";
import assert from "node:assert/strict";
import {
  suggestedEndpoints,
  suggestedPlatformId,
  suggestedTriageTarget,
  toolNetworkProfile,
} from "../src/shared/tool-network";
import { TOOL_PRODUCTS } from "../src/shared/assistant";

test("顺序排查选择对应公开入口，未知工具不默认冒充 Codex", () => {
  assert.equal(suggestedTriageTarget("codex"), "codex");
  assert.equal(suggestedTriageTarget("claude-code"), "claude");
  assert.equal(suggestedTriageTarget("claude-desktop"), "claude");
  assert.equal(suggestedTriageTarget("cursor"), "cursor");
  assert.equal(suggestedTriageTarget("deepseek-harness"), "deepseek");
  assert.equal(suggestedTriageTarget("dsh-desktop"), "deepseek");
  assert.equal(suggestedTriageTarget("gemini-cli"), "gemini");
  assert.equal(suggestedTriageTarget("qwen-code"), "qianwen");
  // 无公开入口参考的产品不猜测：zcode / wiscode / opencode / vscode / 未知。
  assert.equal(suggestedTriageTarget("zcode"), undefined);
  assert.equal(suggestedTriageTarget("wiscode"), undefined);
  assert.equal(suggestedTriageTarget("opencode"), undefined);
  assert.equal(suggestedTriageTarget("vscode"), undefined);
  assert.equal(suggestedTriageTarget("unknown"), undefined);
});

test("卡片入口检查使用平台扫描 id；Codex 产品由 ChatGPT 公开入口覆盖", () => {
  assert.equal(suggestedPlatformId("codex"), "chatgpt");
  assert.equal(suggestedPlatformId("claude-code"), "claude");
  assert.equal(suggestedPlatformId("cursor"), "cursor");
  assert.equal(suggestedPlatformId("zcode"), undefined);
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
  assert.deepEqual(
    suggestedEndpoints("gemini-cli").map((x) => x.endpoint.id),
    ["gemini-api"],
  );
  assert.deepEqual(
    suggestedEndpoints("qwen-code").map((x) => x.endpoint.id),
    ["dashscope-api"],
  );
});

test("多供应商工具和未知工具不推断服务", () => {
  for (const id of [
    undefined,
    "cursor",
    "vscode",
    "opencode",
    "zcode",
    "wiscode",
    "unknown",
  ]) {
    assert.deepEqual(suggestedEndpoints(id), []);
  }
});

test("每个已收录产品都有组件类型档案；CLI 类智能体归入 cli-agent", () => {
  for (const product of TOOL_PRODUCTS) {
    assert.ok(toolNetworkProfile(product.id), `${product.id} 缺少网络档案`);
  }
  for (const id of ["claude-code", "opencode", "zcode", "kiro", "gemini-cli", "qwen-code", "openclaw", "codebuddy-cli"]) {
    assert.ok(
      toolNetworkProfile(id)!.kinds.includes("cli-agent"),
      `${id} 应归入 cli-agent`,
    );
  }
  assert.deepEqual(toolNetworkProfile("wiscode")!.kinds, ["desktop-host"]);
  assert.deepEqual(toolNetworkProfile("chatgpt")!.kinds, ["desktop-host"]);
  assert.deepEqual(toolNetworkProfile("codex")!.kinds, [
    "desktop-host",
    "cli-agent",
  ]);
});
