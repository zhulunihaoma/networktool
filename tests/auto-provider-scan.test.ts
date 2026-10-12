import { test } from "node:test";
import assert from "node:assert/strict";
import { autoProviderScan } from "../src/shared/auto-provider-scan";
import type { ProviderScan } from "../src/shared/types";

const scan = (status: ProviderScan["status"]): ProviderScan => ({
  id: "fixture", status, results: [],
});

test("首次自动检查全量端点，并合并并发初始化", async () => {
  let calls = 0;
  let state = scan("idle");
  const api = {
    providers: async () => state,
    scanProviders: async (id?: string) => {
      assert.equal(id, undefined);
      calls++;
      state = scan("running");
      return state;
    },
  };
  const first = autoProviderScan(api);
  assert.equal(autoProviderScan(api), first);
  assert.equal((await first).status, "running");
  await autoProviderScan(api);
  assert.equal(calls, 1);
});

test("已有运行、完成或停止结果时，不自动重新启动", async () => {
  for (const status of ["running", "completed", "cancelled"] as const) {
    const api = {
      providers: async () => scan(status),
      scanProviders: async () => { throw new Error("不应重新扫描"); },
    };
    assert.equal((await autoProviderScan(api)).status, status);
  }
});

test("自动启动失败后允许重试，不缓存拒绝的请求", async () => {
  let calls = 0;
  const api = {
    providers: async () => scan("idle"),
    scanProviders: async () => {
      if (++calls === 1) throw new Error("fixture-failed");
      return scan("running");
    },
  };
  await assert.rejects(autoProviderScan(api), /fixture-failed/);
  assert.equal((await autoProviderScan(api)).status, "running");
  assert.equal(calls, 2);
});
