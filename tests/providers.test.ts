import { test } from "node:test";
import assert from "node:assert/strict";
import { ALL_ENDPOINTS, MODEL_PROVIDERS } from "../src/shared/providers";
import { classifyProvider } from "../electron/core/provider-probe";
import type { Evidence, ModelProvider, ProviderEndpoint } from "../src/shared/types";

const sample = (overrides: Partial<Evidence> = {}): Evidence => ({
  id: "E-test",
  time: 0,
  stage: "http",
  route: "direct",
  status: "success",
  title: "test",
  detail: "test",
  executor: "diagnostic_probe",
  source: "Node · layered probe",
  ...overrides,
});

function find(id: string): { provider: ModelProvider; endpoint: ProviderEndpoint } {
  const found = ALL_ENDPOINTS.find((x) => x.endpoint.id === id)!;
  return found;
}

test("端点注册表：HTTPS 唯一 ID、来源文档、预期状态合法", () => {
  assert.ok(MODEL_PROVIDERS.length >= 5);
  const ids = new Set(ALL_ENDPOINTS.map((x) => x.endpoint.id));
  assert.equal(ids.size, ALL_ENDPOINTS.length);
  for (const { endpoint } of ALL_ENDPOINTS) {
    const url = new URL(endpoint.url);
    assert.equal(url.protocol, "https:");
    assert.ok(endpoint.source.startsWith("https://"));
    assert.ok(endpoint.expectAnon.length > 0);
    for (const n of endpoint.expectAnon) {
      assert.ok(n >= 200 && n <= 599);
    }
  }
});

test("401 / 405 在 expectAnon 内 → auth_required，表示网络与服务在线", () => {
  const { provider, endpoint } = find("openai-api");
  const result = classifyProvider(provider, endpoint, [sample({ httpStatus: 401 })], "直连");
  assert.equal(result.status, "auth_required");
  assert.match(result.summary, /网络与 TLS 正常/);
  assert.match(result.suggestion, /不证明你的密钥有效/);
});

test("200 在 expectAnon 内 → reachable，例如公开聚合服务", () => {
  const { provider, endpoint } = find("openrouter-api");
  const result = classifyProvider(provider, endpoint, [sample({ httpStatus: 200 })], "直连");
  assert.equal(result.status, "reachable");
  assert.equal(result.httpStatus, 200);
});

test("403 / 451 → restricted，不误报断网或登录", () => {
  const { provider, endpoint } = find("openai-api");
  for (const status of [403, 451]) {
    const result = classifyProvider(provider, endpoint, [sample({ httpStatus: status })], "直连");
    assert.equal(result.status, "restricted");
  }
});

test("429 / 503 → busy，不推断全球故障", () => {
  const { provider, endpoint } = find("openai-api");
  for (const status of [429, 503]) {
    const result = classifyProvider(provider, endpoint, [sample({ httpStatus: status })], "直连");
    assert.equal(result.status, "busy");
    assert.match(result.suggestion, /不能证明平台全球故障/);
  }
});

test("未在 expectAnon 内的其他状态 → reachable 但标注未登记", () => {
  const { provider, endpoint } = find("openai-api");
  const result = classifyProvider(provider, endpoint, [sample({ httpStatus: 418 })], "直连");
  assert.equal(result.status, "reachable");
  assert.match(result.summary, /未登记状态/);
});

test("DNS / 证书 / 代理 / 超时错误给出对应阶段建议", () => {
  const { provider, endpoint } = find("openai-api");
  for (const [code, text] of [
    ["ENOTFOUND", "解析"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "安全连接"],
    ["PROXY_CONNECT_FAILED", "代理"],
    ["ETIMEDOUT", "超时"],
  ]) {
    const result = classifyProvider(provider, endpoint, [sample({ status: "failed", code })], "直连");
    assert.equal(result.status, "network_error");
    assert.ok(result.summary.includes(text));
  }
});

test("TLS 成功但无 HTTP → network_error 且摘要说明 TLS 已建立", () => {
  const { provider, endpoint } = find("openai-api");
  const result = classifyProvider(
    provider,
    endpoint,
    [
      sample({ stage: "tls", status: "success", title: "TLS 完成" }),
      sample({ stage: "http", status: "failed", code: "ECONNRESET" }),
    ],
    "直连",
  );
  assert.equal(result.status, "network_error");
  assert.ok(result.summary.includes("安全连接已建立"));
});

test("代理路径可连接但直连失败：按代理路径判定并明示差异", () => {
  const { provider, endpoint } = find("openai-api");
  const result = classifyProvider(
    provider,
    endpoint,
    [
      sample({ stage: "http", route: "direct", status: "failed", code: "ERR_TIMED_OUT" }),
      sample({ stage: "http", route: "http://127.0.0.1:7897", status: "success", httpStatus: 401 }),
    ],
    "系统网络（检测到代理）",
  );
  assert.equal(result.status, "auth_required");
  assert.ok(result.summary.includes("代理路径可连接"));
});

test("缺失证据不冒充通过，返回 check_failed", () => {
  const { provider, endpoint } = find("openai-api");
  const result = classifyProvider(provider, endpoint, [], "直连");
  assert.equal(result.status, "check_failed");
});
