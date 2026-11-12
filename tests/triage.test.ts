import { test } from "node:test";
import assert from "node:assert/strict";
import { TriageDoctor, type TriageDependencies } from "../electron/core/triage";
import { newTriage, triageText } from "../src/shared/triage";
import type { TriageRun } from "../src/shared/types";
import { ipv6RepairPlan, type IPPathReport } from "../src/shared/ip-path";
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
async function scan(overrides: Partial<TriageDependencies> = {}, target = "codex") {
  let resolve!: (run: TriageRun) => void;
  const completed = new Promise<TriageRun>((r) => {
    resolve = r;
  });
  const doctor = new TriageDoctor({ ...defaults(), ...overrides }, (run) => {
    if (run.status === "completed") resolve(run);
  });
  doctor.start(target);
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

const paths = (): IPPathReport => {
  const report: IPPathReport = {
    host: "chatgpt.com", checkedAt: Date.now(), networkKey: "private-key", accessNetworkKey: "hotspot",
    hasPublicIPv6: true, networkChanged: false,
    service: { id: "wifi", name: "Wi-Fi", device: "en0", method: "Automatic" },
    attempts: [
      { family: 4, interface: "utun6", tcp: true, tls: true, httpStatus: 403, duration: 500 },
      { family: 6, interface: "en0", tcp: true, tls: false, code: "ECONNRESET", duration: 100 },
    ],
  };
  report.repair = ipv6RepairPlan(report);
  return report;
};

test("Codex 补充检查使用公开入口参考主机，路径不一致提升为待处理，报告包含可恢复方案但不泄露网络签名", async () => {
  const { doctor, run } = await scan({ ipPath: async (host) => {
    assert.equal(host, "chatgpt.com"); return paths();
  } });
  assert.equal(run.steps[3].status, "attention");
  assert.equal(run.priorityIds[0], "entry");
  assert.ok(run.steps[3].actions.includes("copy_ipv6_plan"));
  doctor.authorize(run.id, "copy_ipv6_plan");
  assert.match(triageText(run), /setv6automatic/);
  assert.ok(!triageText(run).includes("private-key"));
  assert.equal(run.verification, "unknown");
});

test("明确系统代理时不把补充直连失败转成系统 IPv6 修复；双栈都失败也不推荐该命令", async () => {
  const proxy = await scan({ proxy: async () => "PROXY 127.0.0.1:7890", ipPath: async () => paths() });
  assert.equal(proxy.run.ipPath?.repair, undefined);
  assert.throws(() => proxy.doctor.authorize(proxy.run.id, "copy_ipv6_plan"), /不适用/);
  const failed = await scan({ ipPath: async () => {
    const report = paths(); report.attempts[0].tls = false; report.repair = ipv6RepairPlan(report); return report;
  } });
  assert.equal(failed.run.steps[3].status, "attention");
  assert.match(failed.run.steps[3].summary, /仅限制 IPv6 不能视为完整修复/);
  assert.equal(failed.run.ipPath?.repair, undefined);
});

test("修复后同一热点保留原恢复方案；切回其他网络则拒绝作修复成功归因", async (t) => {
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  let report = paths();
  const { doctor } = await scan({ ipPath: async () => structuredClone(report) });
  report = { ...paths(), networkKey: "after-ipv6-change", hasPublicIPv6: false, repair: undefined,
    service: { ...paths().service!, method: "LinkLocal" }, attempts: [paths().attempts[0]] };
  const rerun = async () => {
    now += 31_000;
    doctor.start("codex");
    for (let i = 0; i < 20 && doctor.current().status === "running"; i++) await new Promise((r) => setImmediate(r));
    return doctor.current();
  };
  const same = await rerun();
  assert.ok(same.ipv6Recovery);
  assert.ok(same.steps[3].actions.includes("copy_ipv6_restore"));
  assert.match(same.comparison!, /先前异常现已通过/);
  assert.equal(same.verification, "unknown");
  report.accessNetworkKey = "other-wifi";
  const other = await rerun();
  assert.match(other.comparison!, /不能把恢复归因于修复操作/);
});

test("DNS 返回回环或全零地址识别为劫持特征，不当作网络不通", async () => {
  const { run } = await scan({
    dns: async () => ({ v4: 1, v6: 0, sinkholed: true }),
  });
  assert.equal(run.steps[2].status, "attention");
  assert.match(run.steps[2].summary, /回环或全零地址/);
  assert.match(run.steps[2].evidence.join(""), /劫持/);
  assert.ok(run.steps[2].actions.includes("network_settings"));
});

test("NXDOMAIN 与解析器超时给出不同结论，均不归因平台故障", async () => {
  const notFound = new Error("getaddrinfo ENOTFOUND") as Error & {
    code: string;
  };
  notFound.code = "ENOTFOUND";
  const first = await scan({
    dns: async () => {
      throw notFound;
    },
  });
  assert.match(first.run.steps[2].summary, /NXDOMAIN/);
  const again = new Error("getaddrinfo EAI_AGAIN") as Error & {
    code: string;
  };
  again.code = "EAI_AGAIN";
  const second = await scan({
    dns: async () => {
      throw again;
    },
  });
  assert.match(second.run.steps[2].summary, /暂时没有应答/);
});

test("系统路径成功而补充路径证书失败时，显式产出证书信任分歧结论", async () => {
  const { run } = await scan({
    probe: async (target) => ({
      platformId: target.id,
      status: "reachable",
      summary: "入口响应",
      suggestion: "在原工具确认",
      evidence: [
        {
          id: "E-sys",
          time: Date.now(),
          stage: "http",
          route: "system",
          status: "success",
          httpStatus: 200,
          title: "系统路径已响应",
          detail: "",
          duration: 10,
          executor: "diagnostic_probe",
          source: "Chromium · system network",
        },
        {
          id: "E-node",
          time: Date.now(),
          stage: "tls",
          route: "direct",
          status: "failed",
          code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
          title: "补充路径证书失败",
          detail: "",
          duration: 10,
          executor: "diagnostic_probe",
          source: "node",
        },
      ],
      runningApps: [],
      route: "系统网络",
      paths: [{ label: "系统路径", status: "accessible", httpStatus: 200 }],
    }),
  });
  assert.equal(run.steps[3].status, "pass");
  assert.match(run.steps[3].evidence.join(""), /证书信任分歧/);
  assert.match(run.steps[3].suggestion, /企业根证书/);
});

test("系统 SOCKS5 且产品官方说明不支持 SOCKS 时降级为需确认并说明作用域", async () => {
  const { run } = await scan(
    {
      proxy: async () => "SOCKS5 127.0.0.1:1080",
    },
    "claude",
  );
  assert.equal(run.steps[1].status, "unverified");
  assert.match(run.steps[1].evidence.join(""), /不支持 SOCKS/);
  assert.equal(run.guidance?.productId, "claude-code");
});

test("排查结果携带已核对的官方网络说明草案并进入 IT 报告", async () => {
  const { run } = await scan();
  assert.equal(run.guidance?.productId, "codex");
  assert.match(triageText(run), /官方说明/);
});

test("服务状态入口只对已核实官方状态页的目标出现", async () => {
  const busyProbe = async (target: Parameters<TriageDependencies["probe"]>[0]) => ({
    platformId: target.id,
    status: "busy" as const,
    summary: "服务忙",
    suggestion: "稍后再试",
    evidence: [],
    runningApps: [],
    route: "系统网络",
    paths: [{ label: "系统路径", status: "restricted" as const, httpStatus: 429 }],
  });
  const kimi = await scan({ probe: busyProbe }, "kimi");
  assert.ok(!kimi.run.steps[3].actions.includes("service_status"));
  const codex = await scan({ probe: busyProbe });
  assert.ok(codex.run.steps[3].actions.includes("service_status"));
});
