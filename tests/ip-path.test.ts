import { test } from "node:test";
import assert from "node:assert/strict";
import tls from "node:tls";
import { EventEmitter, getEventListeners } from "node:events";
import {
  ipv6PathMismatch,
  ipv6RepairPlan,
  ipv6RepairText,
  ipPathSummary,
  ipRepairSnapshotCurrent,
  type IPPathReport,
} from "../src/shared/ip-path";
import {
  parseRouteInterface,
  parseIPv6Service,
  probeIPTLS,
} from "../electron/core/ip-path";

export function mismatchReport(): IPPathReport {
  const report: IPPathReport = {
    host: "codex-cloud-backend.chatgpt.com",
    checkedAt: Date.now(),
    networkKey: "hotspot-fixture",
    networkChanged: false,
    hasPublicIPv6: true,
    service: {
      id: "wifi-fixture",
      name: "Wi-Fi",
      device: "en0",
      method: "Automatic",
    },
    attempts: [
      {
        family: 4,
        interface: "utun6",
        tcp: true,
        tls: true,
        httpStatus: 403,
        duration: 450,
      },
      {
        family: 6,
        interface: "en0",
        tcp: true,
        tls: false,
        code: "ECONNRESET",
        duration: 120,
      },
      {
        family: 6,
        interface: "en0",
        tcp: true,
        tls: false,
        code: "ECONNRESET",
        duration: 130,
      },
    ],
  };
  report.repair = ipv6RepairPlan(report);
  return report;
}

test("只有隧道 IPv4 TLS 成功、非隧道 IPv6 全部失败且自动配置已记录时才提供方案", () => {
  const report = mismatchReport();
  assert.equal(ipv6PathMismatch(report), true);
  assert.ok(report.repair);
  assert.match(report.repair.command, /-setv6linklocal 'Wi-Fi'/);
  assert.match(report.repair.restoreCommand, /-setv6automatic 'Wi-Fi'/);
  const text = ipv6RepairText(report.repair);
  const executable = text.split("\n").filter((line) => !line.startsWith("#"));
  assert.deepEqual(executable, [report.repair.command]);
  assert.match(text, /持续影响/);
  assert.match(text, /# sudo .*setv6automatic/);
});

test("双栈都失败、IPv6 可用、路径未知、隧道相同、没有公网 IPv6、切网均不推荐规避", () => {
  const cases = [
    (r: IPPathReport) => {
      r.attempts[0].tls = false;
    },
    (r: IPPathReport) => {
      r.attempts[1].tls = true;
    },
    (r: IPPathReport) => {
      r.attempts[1].interface = undefined;
    },
    (r: IPPathReport) => {
      r.attempts[1].interface = "utun6";
    },
    (r: IPPathReport) => {
      r.hasPublicIPv6 = false;
    },
    (r: IPPathReport) => {
      r.networkChanged = true;
    },
    (r: IPPathReport) => {
      r.unavailable = "无法获取路由";
    },
    (r: IPPathReport) => {
      r.dnsError = "DNS_LOOKUP_FAILED";
    },
    (r: IPPathReport) => {
      r.attempts = [];
    },
  ];
  for (const alter of cases) {
    const report = mismatchReport();
    alter(report);
    assert.equal(ipv6PathMismatch(report), false);
    assert.equal(ipv6RepairPlan(report), undefined);
  }
  const report = mismatchReport();
  report.attempts[0].tls = false;
  assert.match(ipPathSummary(report), /仅限制 IPv6 不能视为完整修复/);
});

test("未知、手动、已限制的配置不擅自生成自动恢复；网络服务名按 shell 参数转义", () => {
  for (const method of ["Manual", "unknown", "LinkLocal", "Off"] as const) {
    const report = mismatchReport();
    report.service!.method = method;
    assert.equal(ipv6RepairPlan(report), undefined);
  }
  const report = mismatchReport();
  report.service!.name = "Wi-Fi ' $(touch /tmp/never-run)";
  assert.ok(ipv6RepairPlan(report)?.command.includes("'\\''"));
  report.service!.name = "Wi-Fi\nmalicious";
  assert.equal(ipv6RepairPlan(report), undefined);
});

test("复制前拒绝过期、切网、服务变更与配置漂移；恢复命令只对应已记录的 LinkLocal 服务", () => {
  const report = mismatchReport(),
    service = report.service!;
  assert.equal(
    ipRepairSnapshotCurrent(report, report.networkKey, service),
    true,
  );
  assert.equal(
    ipRepairSnapshotCurrent(report, "another-network", service),
    false,
  );
  assert.equal(
    ipRepairSnapshotCurrent(
      report,
      report.networkKey,
      service,
      false,
      report.checkedAt + 600_001,
    ),
    false,
  );
  assert.equal(
    ipRepairSnapshotCurrent(report, report.networkKey, {
      ...service,
      id: "other",
    }),
    false,
  );
  assert.equal(
    ipRepairSnapshotCurrent(report, report.networkKey, {
      ...service,
      method: "LinkLocal",
    }),
    false,
  );
  assert.equal(
    ipRepairSnapshotCurrent(
      report,
      report.networkKey,
      { ...service, method: "LinkLocal" },
      true,
    ),
    true,
  );
  assert.equal(
    ipRepairSnapshotCurrent(
      report,
      report.networkKey,
      { ...service, method: "Manual" },
      true,
    ),
    false,
  );
});

test("只接受明确路由与唯一活动 Wi-Fi 服务，不从 networksetup 缺失输出推断原设置", () => {
  assert.equal(
    parseRouteInterface(" route to: x\n interface: utun6\n"),
    "utun6",
  );
  assert.equal(parseRouteInterface("route unavailable"), undefined);
  const service = {
    UserDefinedName: "Wi-Fi",
    Interface: { DeviceName: "en0", Type: "IEEE80211" },
    IPv6: { ConfigMethod: "LinkLocal" },
  };
  assert.equal(
    parseIPv6Service(JSON.stringify({ a: service }), "en0")?.method,
    "LinkLocal",
  );
  assert.equal(
    parseIPv6Service(
      JSON.stringify({
        a: {
          ...service,
          Interface: {
            DeviceName: "en0",
            Type: "Ethernet",
            Hardware: "AirPort",
          },
        },
      }),
      "en0",
    )?.method,
    "LinkLocal",
  );
  assert.equal(
    parseIPv6Service(JSON.stringify({ a: service, b: service }), "en0"),
    undefined,
  );
  assert.equal(
    parseIPv6Service(
      JSON.stringify({
        a: { ...service, Interface: { DeviceName: "en0", Type: "Ethernet" } },
      }),
      "en0",
    ),
    undefined,
  );
  assert.equal(
    parseIPv6Service(JSON.stringify({ a: { ...service, IPv6: {} } }), "en0")
      ?.method,
    "unknown",
  );
});

test("预先取消的探测不创建连接，不会误报 TLS 成功", async () => {
  const abort = new AbortController();
  abort.abort();
  const result = await probeIPTLS("example.com", "127.0.0.1", 4, abort.signal);
  assert.equal(result.code, "ABORTED");
  assert.equal(result.tls, false);
  assert.equal(result.tcp, false);
});

test("TLS 探测保留 SNI 和证书校验，收到 403 只记录响应；完成后释放连接", async (t) => {
  let request = "";
  const socket = Object.assign(new EventEmitter(), {
    destroyed: false,
    write(text: string) {
      request = text;
      queueMicrotask(() =>
        socket.emit("data", Buffer.from("HTTP/1.1 403 Forbidden\r\n\r\n")),
      );
    },
    destroy() {
      socket.destroyed = true;
      queueMicrotask(() => socket.emit("close"));
    },
  });
  t.mock.method(tls, "connect", ((options: tls.ConnectionOptions) => {
    assert.equal(options.host, "192.0.2.1");
    assert.equal(options.servername, "example.com");
    assert.equal(options.rejectUnauthorized, true);
    queueMicrotask(() => {
      socket.emit("connect");
      socket.emit("secureConnect");
    });
    return socket;
  }) as unknown as typeof tls.connect);
  const abort = new AbortController();
  const result = await probeIPTLS("example.com", "192.0.2.1", 4, abort.signal);
  assert.equal(result.tcp, true);
  assert.equal(result.tls, true);
  assert.equal(result.httpStatus, 403);
  assert.match(request, /^HEAD \/ HTTP\/1\.1\r\nHost: example.com/);
  assert.doesNotMatch(request, /Authorization|Cookie/i);
  assert.equal(socket.destroyed, true);
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
});

test("握手期间取消或超时会销毁连接，TCP 已通不能误报 TLS 成功", async (t) => {
  const sockets: { destroyed: boolean }[] = [];
  t.mock.method(tls, "connect", (() => {
    const socket = Object.assign(new EventEmitter(), {
      destroyed: false,
      destroy() {
        socket.destroyed = true;
      },
    });
    sockets.push(socket);
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  }) as unknown as typeof tls.connect);
  const abort = new AbortController();
  const pending = probeIPTLS("example.com", "192.0.2.1", 4, abort.signal);
  await new Promise((r) => setImmediate(r));
  abort.abort();
  const cancelled = await pending;
  assert.equal(cancelled.code, "ABORTED");
  assert.equal(cancelled.tcp, true);
  assert.equal(cancelled.tls, false);
  const timedOut = await probeIPTLS(
    "example.com",
    "192.0.2.1",
    4,
    new AbortController().signal,
    10,
  );
  assert.equal(timedOut.code, "TIMEOUT");
  assert.equal(timedOut.tls, false);
  assert.ok(sockets.every((s) => s.destroyed));
});
