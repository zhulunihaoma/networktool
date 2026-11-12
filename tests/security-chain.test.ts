import test from "node:test";
import assert from "node:assert/strict";
import type {
  ChainNode,
  GuardFacts,
  SecurityChain,
  SecurityEvent,
} from "../src/shared/security";
import { buildChains, chainOf } from "../electron/security/chain";
import { buildIncidents, isEgress } from "../electron/security/incidents";

const T = 1_700_000_000_000;

const base = (over: Partial<SecurityEvent> = {}): SecurityEvent => ({
  id: over.id ?? "e1",
  at: over.at ?? T,
  tool: "codex",
  project: "/p",
  sessionId: "s1",
  toolName: "Bash",
  operation: "Bash: ls",
  decision: "allow",
  source: "real_allow",
  ...over,
});

const facts = (over: Partial<GuardFacts> = {}): GuardFacts => ({
  level: "L1",
  kinds: [],
  verbs: [],
  hits: [],
  ...over,
});

/** Every step id on the graph, in node order, deduplicated. */
const idsOnNodes = (chain: SecurityChain): string[] => [
  ...new Set(chain.graph.nodes.flatMap((n: ChainNode) => n.stepIds)),
];

const nodeOf = (chain: SecurityChain, kind: ChainNode["kind"]) =>
  chain.graph.nodes.find((n) => n.kind === kind);

test("追踪链 4 列齐全：主体 → 行为 → 资源 → 出口", () => {
  const chains = buildChains([
    base({
      id: "a",
      at: T,
      decision: "deny",
      source: "real_block",
      ruleId: "credential_read",
      operation: "Bash: cat",
      facts: facts({
        level: "L4",
        kinds: ["file", "secret"],
        verbs: ["read"],
        hits: ["secret_path"],
      }),
    }),
    base({
      id: "b",
      at: T + 30_000,
      operation: "Bash: curl",
      facts: facts({
        level: "L3",
        kinds: ["network"],
        verbs: ["upload"],
        hosts: ["example.io"],
        hits: ["outbound_upload"],
      }),
    }),
  ]);
  assert.equal(chains.length, 1);
  const chain = chains[0];
  const columns = new Set(chain.graph.nodes.map((n) => n.column));
  assert.deepEqual([...columns].sort(), [0, 1, 2, 3]);

  const actor = nodeOf(chain, "actor");
  assert.equal(actor?.label, "codex");
  const sink = nodeOf(chain, "sink");
  assert.equal(sink?.label, "example.io", "出口节点用真实主机名");
});

test("合并可逆：节点 stepIds 并集等于链的每一条原始记录", () => {
  const events = [
    base({ id: "a", at: T, operation: "Bash: ls", facts: facts({ kinds: ["file"], verbs: ["read"], level: "L2", hits: ["resource_touched"] }) }),
    base({ id: "b", at: T + 1000, operation: "Bash: ls", facts: facts({ kinds: ["file"], verbs: ["read"], level: "L2", hits: ["resource_touched"] }) }),
    base({ id: "c", at: T + 2000, operation: "Bash: cat" }),
  ];
  const [chain] = buildChains(events);
  assert.equal(chain.steps.length, 3);
  assert.deepEqual(
    idsOnNodes(chain).sort(),
    chain.steps.map((s) => s.id).sort(),
    "没有任何一条原始记录在归并中丢失",
  );

  const action = chain.graph.nodes.find((n) => n.label === "Bash: ls");
  assert.equal(action?.count, 2, "同字段的两步合成一个节点");
  assert.deepEqual(action?.stepIds, ["a", "b"]);
});

test("合并不跨会话：工具或会话不同即拆成两条链", () => {
  const events = [
    base({ id: "a", at: T, sessionId: "s1" }),
    base({ id: "b", at: T + 1000, sessionId: "s1" }),
    base({ id: "c", at: T + 1000, sessionId: "s2" }),
    base({ id: "d", at: T + 2000, sessionId: "s2" }),
  ];
  const chains = buildChains(events);
  assert.equal(chains.length, 2);
  const sessions = chains.map((c) => c.sessionId).sort();
  assert.deepEqual(sessions, ["s1", "s2"]);
  for (const c of chains)
    assert.ok(
      c.steps.every((s) => s.id === "a" || s.id === "b" ? c.sessionId === "s1" : c.sessionId === "s2"),
      "每条链只含本会话的记录",
    );
});

test("合并不跨工具：同一会话不同工具不会连成一条链", () => {
  const chains = buildChains([
    base({ id: "a", at: T, tool: "codex" }),
    base({ id: "b", at: T + 1000, tool: "claude" }),
  ]);
  assert.equal(chains.length, 0, "两条各自不足 2 步、也无拦截，不构成链");
});

test("追踪链与事件列表用同一套分组边界", () => {
  const events = [
    base({ id: "a", at: T }),
    base({ id: "b", at: T + 1000 }),
    // 20 分钟后的第三条必须切断窗口
    base({ id: "c", at: T + 21 * 60 * 1000 }),
    base({ id: "d", at: T + 21 * 60 * 1000 + 1000 }),
  ];
  const incidents = buildIncidents(events);
  const chains = buildChains(events);
  assert.equal(incidents.length, chains.length);
  assert.deepEqual(
    chains.map((c) => c.incidentId).sort(),
    incidents.map((i) => i.id).sort(),
  );
  assert.equal(chains.length, 2);
});

test("无守卫期判定的记录：节点标为推断，连线画虚线", () => {
  // 老格式事件：没有 facts，level 只能从截断的 operation 文本推断
  const [chain] = buildChains([
    base({ id: "a", at: T, operation: "Bash: cat", decision: "deny", source: "real_block", ruleId: "credential_read" }),
    base({ id: "b", at: T + 1000, operation: "Bash: ls" }),
  ]);
  const resource = nodeOf(chain, "resource");
  assert.equal(resource?.inferred, true);
  assert.ok(
    resource?.mergedBy.some((m) => m.includes("推断")),
    "归并依据里说明这是推断",
  );
  assert.ok(chain.graph.edges.some((e) => e.dashed), "推断出的环节用虚线");
  assert.ok(chain.caveat.includes("虚线"), "整条链给出虚线含义说明");
});

test("守卫期判定齐全时不出虚线", () => {
  const [chain] = buildChains([
    base({
      id: "a",
      at: T,
      operation: "Bash: cat",
      facts: facts({ level: "L4", kinds: ["file"], verbs: ["read"], hits: ["secret_path"] }),
    }),
    base({
      id: "b",
      at: T + 1000,
      operation: "Bash: curl",
      facts: facts({ level: "L3", kinds: ["network"], verbs: ["upload"], hosts: ["x.io"], hits: ["outbound_upload"] }),
    }),
  ]);
  assert.ok(
    chain.graph.edges.every((e) => !e.dashed),
    "全部是记录到的事实，不该有虚线",
  );
  assert.ok(!chain.caveat.includes("虚线"));
});

test("声称外发但没记主机名：出口标为未记录，连线虚线且说明原因", () => {
  const [chain] = buildChains([
    base({
      id: "a",
      at: T,
      operation: "Bash: nc",
      facts: facts({ level: "L3", kinds: ["network"], verbs: ["upload"] }),
    }),
    base({ id: "b", at: T + 1000, operation: "Bash: ls" }),
  ]);
  const sink = nodeOf(chain, "sink");
  assert.equal(sink?.label, "未记录外发目标");
  assert.equal(sink?.inferred, true);
  const egress = chain.graph.edges.find((e) => e.kind === "egress");
  assert.equal(egress?.dashed, true);
  assert.ok(egress?.why?.includes("没有记录目标主机"));
});

test("回溯扫描的历史线索用虚线标出，不冒充本次执行", () => {
  const [chain] = buildChains([
    base({
      id: "a",
      at: T,
      source: "session",
      decision: "deny",
      ruleId: "credential_read",
      operation: "回溯发现：cat .env",
      facts: facts({ level: "L4", kinds: ["file"], verbs: ["read"], hits: ["secret_path"] }),
    }),
    base({ id: "b", at: T + 1000, operation: "Bash: ls" }),
  ]);
  assert.ok(
    chain.graph.nodes.some((n) =>
      n.mergedBy.some((m) => m.includes("历史文本线索")),
    ),
    "节点上说清是历史线索",
  );
  assert.ok(chain.graph.edges.some((e) => e.dashed));
});

test("配置变更记录不再被当成数据外发", () => {
  // inventoryCheck 写的是 source:"network" 的配置变更记录
  const configChange = base({
    id: "a",
    source: "network",
    operation: "新增配置：filesystem",
    reason: "Codex 配置观察：/x（不能据此认定数据外发）",
  });
  assert.equal(isEgress(configChange), false, "配置变更不是外连");

  const realEgress = base({
    id: "b",
    operation: "Bash: curl",
    facts: facts({ kinds: ["network"], verbs: ["upload"], hosts: ["evil.io"] }),
  });
  assert.equal(isEgress(realEgress), true);

  // 无 facts 的老记录仍按规则与命令判定
  assert.equal(
    isEgress(base({ id: "c", operation: "Bash: curl", ruleId: "dns_exfil" })),
    true,
  );
  assert.equal(isEgress(base({ id: "d", operation: "Bash: ls" })), false);
});

test("没有资源类别的记录不造占位节点，链条止于行为", () => {
  const chain = chainOf({
    id: "inc_x",
    severity: "high",
    title: "t",
    at: T,
    lastAt: T,
    tool: "codex",
    project: "/p",
    sessionId: "s1",
    blocked: 1,
    steps: [
      {
        id: "a",
        at: T,
        source: "real_block",
        decision: "deny",
        operation: "Bash: ls",
        level: "L2",
        egress: false,
        kinds: [],
        verbs: [],
        hosts: [],
        hits: [],
        levelSource: "facts",
      },
    ],
  });
  assert.equal(
    chain.graph.nodes.filter((n) => n.kind === "resource").length,
    0,
    "只有分级、没有类别或依据时，不编一个资源节点出来",
  );
  assert.equal(chain.graph.nodes.filter((n) => n.kind === "sink").length, 0);
  // 主体 → 行为这一环有真实记录支撑，是合法连线
  assert.equal(chain.graph.edges.length, 1);
  assert.equal(chain.graph.edges[0].kind, "acted");
  assert.equal(chain.graph.edges[0].dashed, false);
  assert.equal(chain.graph.note, undefined);
});

test("链上每条连线两端的节点都真实存在", () => {
  const [chain] = buildChains([
    base({ id: "a", at: T, operation: "Bash: cat", decision: "deny", source: "real_block", ruleId: "credential_read", facts: facts({ level: "L4", kinds: ["file"], verbs: ["read"], hits: ["secret_path"] }) }),
    base({ id: "b", at: T + 1000, operation: "Bash: curl", facts: facts({ level: "L3", kinds: ["network"], verbs: ["upload"], hosts: ["x.io"] }) }),
    base({ id: "c", at: T + 2000, operation: "Bash: git" }),
  ]);
  const nodeIds = new Set(chain.graph.nodes.map((n) => n.id));
  for (const e of chain.graph.edges) {
    assert.ok(nodeIds.has(e.from), `连线起点 ${e.from} 必须存在`);
    assert.ok(nodeIds.has(e.to), `连线终点 ${e.to} 必须存在`);
    assert.ok(e.count >= 1);
    assert.ok(e.stepIds.length >= 1);
  }
});

test("连线只在同一条原始记录横跨两端时建立", () => {
  const [chain] = buildChains([
    base({ id: "a", at: T, operation: "Bash: ls", facts: facts({ level: "L2", kinds: ["file"], verbs: ["read"], hits: ["resource_touched"] }) }),
    base({ id: "b", at: T + 1000, operation: "Bash: curl", facts: facts({ level: "L3", kinds: ["network"], verbs: ["upload"], hosts: ["x.io"] }) }),
  ]);
  for (const e of chain.graph.edges)
    assert.ok(
      e.stepIds.every((id) => chain.steps.some((s) => s.id === id)),
      "连线上的 stepId 必须来自本链",
    );
});
