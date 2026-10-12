import { test } from "node:test";
import assert from "node:assert/strict";
import { TriageDoctor, type TriageDependencies } from "../electron/core/triage";
import { newTriage, triageText } from "../src/shared/triage";
import type { TriageRun } from "../src/shared/types";
const defaults = (): TriageDependencies => ({
  network: async () => ({ count: 1, signature: "hashed-private-addresses" }),
  proxy: async () => "DIRECT",
  proxyEndpoint: async () => [],
  dns: async () => ({ v4: 1, v6: 0 }),
  probe: async (target) => ({
    platformId: target.id,
    status: "reachable",
    summary: "入口响应",
    suggestion: "在原工具确认",
    evidence: [],
    runningApps: [],
    route: "系统网络",
    paths: [{ label: "系统路径", status: "accessible", httpStatus: 200 }],
  }),
  processes: async () => [],
  connections: async () => ({ flows: [] }),
});
async function scan(overrides: Partial<TriageDependencies> = {}) {
  let resolve!: (run: TriageRun) => void;
  const completed = new Promise<TriageRun>((r) => {
    resolve = r;
  });
  const doctor = new TriageDoctor({ ...defaults(), ...overrides }, (run) => {
    if (run.status === "completed") resolve(run);
  });
  doctor.start("codex");
  return { doctor, run: await completed };
}
test("按依赖顺序检查；DIRECT 不认定未安装VPN；入口通过不证明持续会话正常", async () => {
  const order: string[] = [];
  const base = defaults();
  const { run } = await scan({
    network: async () => {
      order.push("network");
      return base.network();
    },
    proxy: async () => {
      order.push("proxy");
      return "DIRECT";
    },
    dns: async (host, signal) => {
      order.push("dns");
      return base.dns(host, signal);
    },
    probe: async (target, signal) => {
      order.push("entry");
      return base.probe(target, signal);
    },
  });
  assert.deepEqual(order, ["network", "proxy", "dns", "entry"]);
  assert.equal(run.steps[1].status, "unverified");
  assert.equal(run.steps[3].status, "pass");
  assert.equal(run.steps[4].status, "unverified");
  assert.equal(run.verification, "unknown");
});
test("明确代理端点失败优先处理；系统解析失败但入口通过先观察而非误认DNS根因", async () => {
  const first = await scan({
    proxy: async () => "PROXY 127.0.0.1:9999",
    proxyEndpoint: async () => {
      throw new Error("refused");
    },
  });
  assert.equal(first.run.priorityIds[0], "proxy");
  assert.ok(first.run.steps[1].actions.includes("proxy_settings"));
  const second = await scan({
    dns: async () => {
      throw new Error("local DNS failure");
    },
  });
  assert.equal(second.run.priorityIds[0], "stability");
  assert.match(second.run.summary, /未证明应用故障原因/);
});
test("没有可用网络地址时阻止后续主动探测，并明确标记未执行", async () => {
  let probes = 0;
  const { run } = await scan({
    network: async () => ({ count: 0, signature: "empty" }),
    probe: async () => {
      probes++;
      throw new Error("must not run");
    },
  });
  assert.equal(probes, 0);
  assert.deepEqual(
    run.steps.slice(1, 4).map((s) => s.status),
    ["skipped", "skipped", "skipped"],
  );
  assert.equal(run.priorityIds[0], "network");
});
test("停止后忽略迟到结果；不能执行过期或不适用的修复操作", async () => {
  let release!: (value: { count: number; signature: string }) => void;
  const delayed = new Promise<{ count: number; signature: string }>((r) => {
    release = r;
  });
  const doctor = new TriageDoctor(
    { ...defaults(), network: async () => delayed },
    () => {},
  );
  const started = doctor.start("codex");
  doctor.stop();
  release({ count: 1, signature: "late" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(doctor.current().status, "cancelled");
  assert.ok(doctor.current().steps.every((s) => s.status === "skipped"));
  assert.throws(
    () => doctor.authorize(started.id, "network_settings"),
    /尚未完成/,
  );
  const { doctor: ready, run } = await scan();
  assert.throws(() => ready.authorize("expired", "copy_report"), /过期/);
  assert.throws(() => ready.authorize(run.id, "reset_probe"), /不适用/);
  assert.throws(() => ready.start("chatgpt"), /30 秒/);
});
test("观察需要独立复现；采集错误不当作无连接；双击不能创建两个观察循环", async () => {
  const { doctor, run } = await scan({
    connections: async () => ({ flows: [], error: "unreadable" }),
  });
  const first = doctor.observe(run.id);
  await assert.rejects(doctor.observe(run.id), /进行/);
  await first;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(doctor.current().observation.errors, 1);
  assert.equal(doctor.current().observation.samples, 1);
  doctor.mark(run.id);
  const stopped = doctor.stop();
  assert.equal(stopped.observation.status, "cancelled");
  assert.equal(stopped.observation.markers.length, 1);
  assert.ok(
    triageText(stopped).includes(
      new Date(stopped.observation.markers[0]).toISOString(),
    ),
  );
  assert.notEqual(stopped.steps[4].status, "pass");
  assert.equal(stopped.verification, "unknown");
});
test("给IT的排查结果没有内部网络签名或原始代理地址；恢复状态由用户单独确认", async () => {
  const { doctor, run } = await scan();
  const text = triageText(run);
  assert.ok(!text.includes("hashed-private-addresses"));
  assert.match(text, /未读取账号凭据/);
  assert.match(text, /用户尚未确认/);
  doctor.verify(run.id, "restored");
  assert.equal(doctor.current().verification, "restored");
  assert.match(triageText(doctor.current()), /用户确认已恢复/);
  assert.equal(newTriage("codex").observation.samples, 0);
});
