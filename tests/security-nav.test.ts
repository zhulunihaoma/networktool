import test from "node:test";
import assert from "node:assert/strict";
import { SOURCE_LABELS, type EvidenceSource } from "../src/shared/security";
import {
  EVENT_VIEWS,
  GROUPS,
  eventViewCount,
  groupOf,
  type EventView,
} from "../src/shared/security-nav";

const ALL_SOURCES = Object.keys(SOURCE_LABELS) as EvidenceSource[];

test("安全中心收敛为 5 个一级入口", () => {
  assert.deepEqual(
    GROUPS.map((g) => g.name),
    ["总览", "事件分析", "防护与规则", "配置检查", "数据边界"],
  );
});

test("每个子页面只属于一个一级入口，且没有重复 id", () => {
  const ids = GROUPS.flatMap((g) => g.views.map((v) => v.id));
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids)
    assert.equal(
      GROUPS.filter((g) => g.views.some((v) => v.id === id)).length,
      1,
      `${id} 只能出现在一个分组里`,
    );
  for (const id of ids) assert.ok(groupOf(id).views.some((v) => v.id === id));
});

test("事件分析默认打开追踪链，且事件列表和回溯扫描在同一组", () => {
  const analysis = GROUPS.find((g) => g.name === "事件分析")!;
  assert.equal(analysis.views[0].id, "chain");
  assert.deepEqual(
    analysis.views.map((v) => v.id).sort(),
    ["chain", "events", "retro"],
  );
});

test("每种记录来源都至少出现在一个事件视图里", () => {
  const covered = new Set(
    (Object.keys(EVENT_VIEWS) as EventView[]).flatMap(
      (v) => EVENT_VIEWS[v].sources,
    ),
  );
  for (const s of ALL_SOURCES) assert.ok(covered.has(s), `${s} 无处可看`);
});

test("回溯线索算 AI 的历史操作，不和安全中心自己的记录混在一起", () => {
  assert.ok(!EVENT_VIEWS.app.sources.includes("session"));
  assert.deepEqual(EVENT_VIEWS.history.sources, ["session"]);
  // 安全中心自己产生的记录不会出现在任何 AI 操作视图里
  for (const own of ["self_check", "scan", "network", "action"] as const)
    for (const v of ["attention", "ai", "history"] as const)
      assert.ok(!EVENT_VIEWS[v].sources.includes(own), `${own} 混进了 ${v}`);
});

test("视图计数按来源求和，与视图定义保持一致", () => {
  const counts = Object.fromEntries(
    ALL_SOURCES.map((s, i) => [s, i + 1]),
  ) as Record<EvidenceSource, number>;
  for (const v of Object.keys(EVENT_VIEWS) as EventView[])
    assert.equal(
      eventViewCount(v, counts),
      EVENT_VIEWS[v].sources.reduce((n, s) => n + counts[s], 0),
    );
  assert.equal(eventViewCount("history", counts), counts.session);
});
