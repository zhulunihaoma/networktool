import { test } from "node:test";
import assert from "node:assert/strict";
import {
  providerConnectionView,
  providerPathText,
} from "../src/shared/providers";
import type { ProviderResult } from "../src/shared/types";

const result = (override: Partial<ProviderResult>): ProviderResult => ({
  providerId: "openai",
  endpointId: "openai-api",
  status: "auth_required",
  effectiveUrl: "https://api.openai.com",
  urlSource: "default",
  summary: "",
  suggestion: "",
  route: "系统网络",
  evidence: [],
  httpStatus: 401,
  ...override,
});

test("IPv4 和代理收到401，IPv6重置：主结论明确已连通，路径异常只作补充", () => {
  const value = result({
    paths: [
      { label: "直连（IPv4）", status: "accessible", httpStatus: 401 },
      { label: "直连（IPv6）", status: "unreachable", code: "ECONNRESET" },
      { label: "代理路径", status: "accessible", httpStatus: 401 },
    ],
  });
  const view = providerConnectionView(value);
  assert.equal(view.label, "网络已连通");
  assert.equal(view.tone, "green");
  assert.match(view.summary, /直连和代理/);
  assert.match(view.summary, /检查未携带密钥，服务要求认证/);
  assert.doesNotMatch(view.summary, /ECONNRESET|IPv6|登录/);
  assert.match(view.pathNote!, /仍有可连通路径/);
  assert.match(
    providerPathText(value.paths![1]),
    /连接被提前关闭或重置.*ECONNRESET/,
  );
});

test("只有代理收到响应：不冒充直连可用，提醒原工具采用代理", () => {
  const view = providerConnectionView(
    result({
      paths: [
        { label: "直连（IPv4）", status: "unreachable", code: "ETIMEDOUT" },
        { label: "代理路径", status: "accessible", httpStatus: 401 },
      ],
    }),
  );
  assert.equal(view.label, "代理可连通");
  assert.match(view.summary, /原工具也需使用该代理/);
});

test("403和429是连通后的服务限制，区别于所有连接路径失败", () => {
  const restricted = providerConnectionView(
    result({ status: "restricted", httpStatus: 403 }),
  );
  const limited = providerConnectionView(
    result({ status: "busy", httpStatus: 429 }),
  );
  const failed = providerConnectionView(
    result({
      status: "network_error",
      httpStatus: undefined,
      paths: [
        { label: "直连（IPv4）", status: "unreachable", code: "ETIMEDOUT" },
        { label: "直连（IPv6）", status: "unreachable", code: "ENETUNREACH" },
      ],
    }),
  );
  assert.match(restricted.label, /已连通/);
  assert.match(limited.label, /已连通/);
  assert.match(limited.summary, /限制请求频率/);
  assert.equal(failed.label, "本次未连通");
  assert.equal(failed.tone, "red");
});

test("TLS已建立但没有API响应、执行失败和未检测不误报网络正常或断网", () => {
  const partial = providerConnectionView(
    result({
      status: "network_error",
      httpStatus: undefined,
      paths: [
        {
          label: "直连（IPv4）",
          status: "network_reachable",
          code: "ECONNRESET",
        },
      ],
    }),
  );
  assert.equal(partial.tone, "amber");
  assert.equal(partial.label, "已建连 · 响应未确认");
  assert.equal(
    providerConnectionView(result({ status: "check_failed" })).label,
    "暂无法判断",
  );
  assert.equal(providerConnectionView().label, "尚未检测");
  assert.equal(
    providerConnectionView(result({ status: "cancelled" })).label,
    "检测已停止",
  );
});
