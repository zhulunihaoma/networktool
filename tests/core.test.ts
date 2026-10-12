import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeTarget, normalizeProxy } from "../electron/core/validation";
import { parseLsof } from "../electron/core/collector";
import { evaluate } from "../electron/core/rules";
import { buildReport } from "../electron/core/report";
import { Store } from "../electron/core/store";
import { Manager } from "../electron/core/manager";
import { fixture, evidence } from "./fixtures";
test("输入规范化移除路径、query 和 fragment，保留 IPv6 与 IDNA", () => {
  assert.equal(
    normalizeTarget("https://example.com/a?secret=x#token").target,
    "https://example.com/",
  );
  assert.equal(normalizeTarget("[::1]:8443").host, "::1");
  assert.equal(normalizeTarget("中文.com").host, "xn--fiq228c.com");
  for (const target of [
    "file:///etc/passwd",
    "http://example.com",
    "https://user:pass@example.com",
    "example.com\r\nInjected: x",
    "example.com:65536",
    "https://example.com\\@evil.test",
  ])
    assert.throws(() => normalizeTarget(target));
});
test("代理规范化拒绝凭据、路径、非法端口和协议", () => {
  assert.equal(
    normalizeProxy("http://127.0.0.1:7897/"),
    "http://127.0.0.1:7897",
  );
  assert.equal(normalizeProxy("socks5://[::1]:1080"), "socks5://[::1]:1080");
  for (const p of [
    "file://host:1",
    "http://user:pass@host:1",
    "http://host:1/path",
    "http://host",
    "http://host:65536",
  ])
    assert.throws(() => normalizeProxy(p));
});
test("快照解析 IPv4 / IPv6、过滤监听端点并保留进程身份", () => {
  const ps = [
    {
      key: "boot:12:created",
      pid: 12,
      ppid: 1,
      name: "app",
      created: "created",
      relation: "root" as const,
    },
  ];
  const flows = parseLsof(
    "p12\ncapp\nf1\ntIPv4\nn127.0.0.1:1->203.0.113.1:443\nTST=ESTABLISHED\nf2\ntIPv6\nn[::1]:2->[2001:db8::1]:443\nTST=SYN_SENT\nf3\ntIPv4\nn*:3000\nTST=LISTEN\n",
    ps,
  );
  assert.equal(flows.length, 2);
  assert.equal(flows[1].family, "IPv6");
  assert.equal(flows[0].processKey, ps[0].key);
  assert.equal(flows[0].state, "ESTABLISHED");
});
const ruleFixtures = [
  ["R01", [evidence("dns", "failed", { code: "ENOTFOUND" })]],
  [
    "R02",
    [
      evidence("tcp", "failed", { code: "ETIMEDOUT" }),
      evidence("tls", "success", { route: "http://127.0.0.1:1" }),
    ],
  ],
  [
    "R03",
    [
      evidence("tcp", "failed", {
        route: "http://127.0.0.1:1",
        code: "ECONNREFUSED",
      }),
    ],
  ],
  ["R04", [evidence("tls", "failed", { code: "CERT_HAS_EXPIRED" })]],
  ["R05", [evidence("http", "success", { httpStatus: 403 })]],
  ["R06", [evidence("http", "success", { httpStatus: 429 })]],
  [
    "R07",
    [
      evidence("tcp", "success", { family: 4 }),
      evidence("tcp", "failed", { family: 6, code: "ENETUNREACH" }),
    ],
  ],
  ["R08", [evidence("tcp", "failed", { code: "ETIMEDOUT" })]],
] as const;
for (const [ruleId, es] of ruleFixtures)
  test(`${ruleId} 保留引用且不夸大到目标应用`, () => {
    const s = fixture({ evidence: [...es] });
    const found = evaluate(s).find((f) => f.ruleId === ruleId);
    assert.ok(found);
    assert.equal(found.support, "limited");
    assert.ok(found.evidenceIds.every((id) => es.some((e) => e.id === id)));
    assert.ok(found.missing.length);
  });
test("规则缺少前提或阶段跳过时不误报故障或安全", () => {
  assert.ok(
    !evaluate(
      fixture({ config: [], evidence: [evidence("dns", "failed")] }),
    ).some((f) => f.ruleId === "R01"),
  );
  assert.ok(
    !evaluate(
      fixture({
        evidence: [
          evidence("tcp", "failed", { code: "ECONNREFUSED" }),
          evidence("tls", "success", { route: "http://proxy:1" }),
        ],
      }),
    ).some((f) => f.ruleId === "R02"),
  );
  assert.equal(
    evaluate(fixture({ evidence: [evidence("tcp", "skipped")] }))[0].support,
    "insufficient",
  );
  assert.ok(
    !evaluate(
      fixture({ evidence: [evidence("http", "success", { httpStatus: 405 })] }),
    ).some((f) => f.ruleId === "R05"),
  );
});
test("默认报告白名单脱敏不包含内网目标、原始自由文本与配置凭据", () => {
  const s = fixture({
    name: "内部需求 secret",
    target: "https://internal.corp/",
    config: [
      {
        name: "proxy",
        value: "credential-secret",
        source: "fixture",
        state: "read",
      },
    ],
    evidence: [
      evidence("config", "info", { route: "local" }),
      evidence("tls", "failed", { route: "http://internal-proxy.corp:7897" }),
      evidence("tcp", "failed", {
        detail: "private 10.0.0.1 user-secret /Users/person/repo",
      }),
    ],
  });
  for (const format of ["md", "json"] as const) {
    const r = buildReport(s, format, true);
    for (const secret of [
      "internal.corp",
      "internal-proxy.corp",
      "credential-secret",
      "user-secret",
      "/Users/person/repo",
      "内部需求 secret",
    ])
      assert.ok(!r.content.includes(secret));
    if (format === "json") {
      const payload = JSON.parse(r.content);
      assert.equal(payload.evidence[0].route, "local");
      assert.match(payload.evidence[1].route, /^proxy_/);
    }
    assert.notEqual(
      r.digest,
      buildReport({ ...s, status: "cancelled" }, format, true).digest,
    );
  }
});
test("SQLite 重启读取、设置、删除与中断恢复", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "network-lens-store-"));
  const file = path.join(dir, "db.sqlite");
  const wasm = path.resolve("node_modules/sql.js/dist/sql-wasm.wasm");
  const store = new Store(file, wasm);
  await store.init();
  store.put(fixture({ status: "collecting" }));
  store.setSettings({ redact: true, retentionDays: 30 });
  const reopened = new Store(file, wasm);
  await reopened.init();
  const manager = new Manager(reopened, () => {});
  manager.init();
  assert.equal(manager.get(fixture().id).status, "interrupted");
  assert.equal(manager.overview().settings.retentionDays, 30);
  manager.remove(fixture().id);
  assert.equal(reopened.all().length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
