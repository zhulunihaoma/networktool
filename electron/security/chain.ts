import type {
  ChainEdge,
  ChainFilter,
  ChainGraph,
  ChainNode,
  ChainNodeKind,
  DataLevel,
  IncidentStep,
  SecurityChain,
  SecurityEvent,
} from "../../src/shared/security";
import {
  DATA_LEVEL_LABELS,
  HIT_LABELS,
  KIND_LABELS,
  VERB_LABELS,
} from "../../src/shared/security";
import { LEVEL_ORDER } from "./classification";
import { buildIncidents } from "./incidents";

/**
 * Tracking-chain projection: the same incidents the list shows, laid out as a
 * left-to-right flow 主体 → 行为 → 资源 → 出口.
 *
 * Read-only, like `buildIncidents`. Nothing here appends to the event log, so
 * the hash chain, exports and forwarding are unaffected.
 *
 * What this layer is allowed to claim is bounded by what the log actually
 * stores. The guard writes `operation` as `<toolName>: <first word of command>`
 * — no arguments, no file paths (see guard-protocol.ts). Resource identity
 * therefore comes from the guard-time `facts` (kinds / verbs / hosts / hits),
 * never from parsing the command text. Where a step predates `facts`, the node
 * is marked inferred and its edges are dashed, because re-deriving a level from
 * a truncated operation string is a guess, not evidence.
 */

/** Max categories drawn per column before folding the tail into one node. */
const MAX_PER_COLUMN = 8;

const LEVEL_RANK = (l: DataLevel) => LEVEL_ORDER.indexOf(l);
const maxLevel = (levels: DataLevel[]): DataLevel =>
  levels.reduce<DataLevel>(
    (max, l) => (LEVEL_RANK(l) > LEVEL_RANK(max) ? l : max),
    "L1",
  );
const worstDecision = (steps: IncidentStep[]): "deny" | "ask" | "allow" =>
  steps.some((s) => s.decision === "deny")
    ? "deny"
    : steps.some((s) => s.decision === "ask")
      ? "ask"
      : "allow";

const hhmm = (at: number) =>
  new Date(at).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });

const uniq = (values: string[]) => [...new Set(values)];

/** `Bash: git` — the most detail the log keeps about the command itself. */
const actionLabel = (operation: string) => operation.trim() || "未记录操作";

/**
 * Resource identity: category + sensitivity. There is no path in the log.
 *
 * A resource node needs the log to say *what* was touched — a recorded kind
 * (`file`/`db`/`cloud`/…) or a recorded hit (`secret_path`, …). A bare level is
 * not an entity, so such a step gets no resource node instead of a placeholder
 * one, and the chain honestly ends at the action for it.
 */
function resourceKey(step: IncidentStep): string | undefined {
  const kind = step.resourceKind ?? step.kinds?.[0] ?? "";
  if (!kind && !(step.hits?.length ?? 0)) return undefined;
  return `${step.level}\u0000${kind}`;
}

/**
 * Why a resource node says what it says. Uses the recorded `hits` when present
 * so the UI can point at a reason instead of asserting a level.
 */
function resourceBasis(step: IncidentStep): string {
  const hits = step.hits ?? [];
  const named = hits.filter((h) => HIT_LABELS[h]);
  if (named.length)
    return named
      .slice(0, 3)
      .map((h) => HIT_LABELS[h])
      .join("、");
  return step.levelSource === "facts" ? "守卫期判定" : "按命令文本推断";
}

type Bucket = {
  key: string;
  steps: IncidentStep[];
};

/** Accumulates steps under a key while preserving first-seen order. */
function bucketize(
  steps: IncidentStep[],
  keyOf: (s: IncidentStep) => string | undefined,
): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const s of steps) {
    const key = keyOf(s);
    if (key === undefined) continue;
    const found = map.get(key);
    if (found) found.steps.push(s);
    else map.set(key, { key, steps: [s] });
  }
  return [...map.values()];
}

/**
 * Fold the tail of a column into one honest "其余 N 类" node.
 *
 * Folding is visible and reversible: the folded node keeps every raw step id,
 * so nothing disappears from the chain — it is only collapsed on screen.
 */
function fold(
  buckets: Bucket[],
  kind: ChainNodeKind,
  column: 0 | 1 | 2 | 3,
  idPrefix: string,
  build: (b: Bucket) => ChainNode,
): ChainNode[] {
  if (buckets.length <= MAX_PER_COLUMN) return buckets.map(build);
  const keep = buckets.slice(0, MAX_PER_COLUMN - 1);
  const rest = buckets.slice(MAX_PER_COLUMN - 1);
  const steps = rest.flatMap((b) => b.steps);
  const folded: ChainNode = {
    id: `${idPrefix}_fold`,
    kind,
    column,
    label: `其余 ${rest.length} 类`,
    sub: `已折叠 ${steps.length} 条记录 · 展开可看每一步`,
    count: steps.length,
    firstAt: steps[0].at,
    lastAt: steps[steps.length - 1].at,
    stepIds: steps.map((s) => s.id),
    level: maxLevel(steps.map((s) => s.level)),
    decision: worstDecision(steps),
    mergedBy: [
      `超过单列 ${MAX_PER_COLUMN} 类展示上限，折叠为一条`,
      "折叠不删除任何记录，展开后仍是逐条原始事件",
    ],
  };
  return [...keep.map(build), folded];
}

/**
 * Is this step's place on the chain inferred rather than recorded?
 *
 * Only two cases qualify, and both are statements about missing evidence rather
 * than about the AI's intent:
 *   1. `session` rows are retrospective text hits, not operations this run ran.
 *   2. A step with no guard-time verdict has its level re-derived from the
 *      truncated `operation` string, which cannot distinguish e.g. a read from
 *      a write of the same first word.
 * A missing host is handled at the sink node, where it is visible as
 * "未记录外发目标" and its own edge is dashed — not here.
 */
function inferredWhy(step: IncidentStep): string | undefined {
  if (step.source === "session")
    return "回溯扫描读到的历史文本线索，不是本次实际执行的动作";
  if (step.levelSource === "heuristic")
    return "该记录没有守卫期判定，资源类别按命令首词推断";
  return undefined;
}

/** True when the log actually names a destination host for this step. */
const hasRecordedHost = (step: IncidentStep) => (step.hosts?.length ?? 0) > 0;

function sinkKeyOf(step: IncidentStep): string | undefined {
  if (!step.egress) return undefined;
  const host = step.hosts?.[0];
  return host ? `h:${host}` : "h:unknown";
}

function nodeTone(steps: IncidentStep[]): ChainEdge["tone"] {
  if (steps.some((s) => s.decision === "deny")) return "danger";
  if (steps.some((s) => s.egress)) return "warn";
  if (maxLevel(steps.map((s) => s.level)) === "L4") return "warn";
  return "info";
}

/** Steps that justify one graph; the chain keeps every step regardless. */
export function graphOf(incident: {
  title: string;
  tool: string;
  project: string;
  steps: IncidentStep[];
}): ChainGraph {
  const steps = incident.steps;
  if (!steps.length) return { nodes: [], edges: [] };

  const toolLabel = incident.tool;
  const projectLabel = incident.project
    ? (incident.project.split(/[\\/]/).filter(Boolean).pop() ?? incident.project)
    : "";

  // ---- column 0: actor ----------------------------------------------------
  const actor: ChainNode = {
    id: "n_actor",
    kind: "actor",
    column: 0,
    label: toolLabel,
    sub: projectLabel ? `项目 ${projectLabel}` : "未记录项目",
    count: steps.length,
    firstAt: steps[0].at,
    lastAt: steps[steps.length - 1].at,
    stepIds: steps.map((s) => s.id),
    decision: worstDecision(steps),
    mergedBy: [
      "同一条链的每一步都来自同一个工具、同一个项目、同一个会话",
      "会话不同或间隔超过 15 分钟即拆成两条链，不做跨会话推断",
    ],
  };

  // ---- column 1: action ---------------------------------------------------
  const actionBuckets = bucketize(steps, (s) => actionLabel(s.operation));
  const actionNodes: ChainNode[] = fold(actionBuckets, "action", 1, "n_a", (b) => {
    const node: ChainNode = {
      id: `n_a_${actionBuckets.indexOf(b)}`,
      kind: "action",
      column: 1,
      label: actionLabel(b.steps[0].operation),
      sub:
        b.steps.length > 1
          ? `${b.steps.length} 次 · ${hhmm(b.steps[0].at)}–${hhmm(b.steps[b.steps.length - 1].at)}`
          : `${hhmm(b.steps[0].at)} · 1 次`,
      count: b.steps.length,
      firstAt: b.steps[0].at,
      lastAt: b.steps[b.steps.length - 1].at,
      stepIds: b.steps.map((s) => s.id),
      level: maxLevel(b.steps.map((s) => s.level)),
      decision: worstDecision(b.steps),
      mergedBy:
        b.steps.length > 1
          ? [
              "日志只保存「工具名 + 命令首词」，这几条记录的该字段完全相同",
              "字段相同即无法在数据层面区分，分开画会暗示一个不存在的差别",
            ]
          : ["该操作在这一窗口内只出现一次"],
    };
    const why = b.steps.map(inferredWhy).find(Boolean);
    if (why) {
      node.inferred = true;
      node.mergedBy = [...node.mergedBy, why];
    }
    return node;
  });

  // ---- column 2: resource -------------------------------------------------
  const resourceBuckets = bucketize(steps, resourceKey);
  const resourceNodes: ChainNode[] = fold(resourceBuckets, "resource", 2, "n_r", (b) => {
    const kind = b.steps[0].resourceKind ?? b.steps[0].kinds?.[0] ?? "";
    const level = maxLevel(b.steps.map((s) => s.level));
    const verbs = uniq(b.steps.flatMap((s) => s.verbs ?? []));
    const node: ChainNode = {
      id: `n_r_${resourceBuckets.indexOf(b)}`,
      kind: "resource",
      column: 2,
      label: kind ? (KIND_LABELS[kind] ?? kind) : "未记录资源类别",
      sub: [
        `${level} ${DATA_LEVEL_LABELS[level]}`,
        verbs.length
          ? verbs.map((v) => VERB_LABELS[v] ?? v).join("/")
          : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
      count: b.steps.length,
      firstAt: b.steps[0].at,
      lastAt: b.steps[b.steps.length - 1].at,
      stepIds: b.steps.map((s) => s.id),
      level,
      decision: worstDecision(b.steps),
      mergedBy: [
        "资源按「类别 + 分级」归并，同一类同一级算一个节点",
        `分级依据：${uniq(b.steps.map(resourceBasis)).join("、")}`,
      ],
    };
    if (kind) node.mergedBy.push(`资源类别来自守卫期记录：${KIND_LABELS[kind] ?? kind}`);
    else node.mergedBy.push("该记录没有资源类别，只能标为未记录");
    const why = b.steps.map(inferredWhy).find(Boolean);
    if (why) {
      node.inferred = true;
      node.mergedBy = [...node.mergedBy, why];
    }
    return node;
  });

  // ---- column 3: sink -----------------------------------------------------
  const sinkBuckets = bucketize(steps, sinkKeyOf);
  const sinkNodes: ChainNode[] = fold(sinkBuckets, "sink", 3, "n_s", (b) => {
    const key = b.key;
    const host = key.startsWith("h:") ? key.slice(2) : "";
    const unknown = host === "unknown";
    const node: ChainNode = {
      id: `n_s_${sinkBuckets.indexOf(b)}`,
      kind: "sink",
      column: 3,
      label: unknown ? "未记录外发目标" : host,
      sub: unknown
        ? "命中外发规则，但没有留下主机名"
        : `${b.steps.length} 次连接`,
      count: b.steps.length,
      firstAt: b.steps[0].at,
      lastAt: b.steps[b.steps.length - 1].at,
      stepIds: b.steps.map((s) => s.id),
      level: maxLevel(b.steps.map((s) => s.level)),
      decision: worstDecision(b.steps),
      mergedBy: unknown
        ? [
            "记录了「对外发起连接」，但主机名未留存",
            "因此无法指出具体目的地，只标到规则与次数",
          ]
        : [
            "出口按主机名归并，只保留主机名，不含路径与查询串",
            "主机名来自守卫期记录，不是事后从命令文本里抠出来的",
          ],
    };
    if (unknown) node.inferred = true;
    return node;
  });

  const nodes = [actor, ...actionNodes, ...resourceNodes, ...sinkNodes];

  // ---- edges --------------------------------------------------------------
  // An edge exists only when at least one raw step sits on both endpoints, so
  // the graph never links two things that merely happen to appear in the same
  // chain.
  const edgeMap = new Map<string, { from: string; to: string; kind: ChainEdge["kind"]; steps: IncidentStep[] }>();
  const addEdge = (
    from: string,
    to: string,
    kind: ChainEdge["kind"],
    step: IncidentStep,
  ) => {
    const key = `${from}\u0000${to}\u0000${kind}`;
    const found = edgeMap.get(key);
    if (found) found.steps.push(step);
    else edgeMap.set(key, { from, to, kind, steps: [step] });
  };

  const actionNodeOf = new Map<string, ChainNode>();
  for (const node of actionNodes)
    for (const id of node.stepIds) actionNodeOf.set(id, node);
  const resourceNodeOf = new Map<string, ChainNode>();
  for (const node of resourceNodes)
    for (const id of node.stepIds) resourceNodeOf.set(id, node);
  const sinkNodeOf = new Map<string, ChainNode>();
  for (const node of sinkNodes)
    for (const id of node.stepIds) sinkNodeOf.set(id, node);

  for (const step of steps) {
    const a = actionNodeOf.get(step.id);
    if (a) addEdge(actor.id, a.id, "acted", step);
    const r = resourceNodeOf.get(step.id);
    if (a && r) addEdge(a.id, r.id, "touched", step);
    const s = sinkNodeOf.get(step.id);
    if (r && s) addEdge(r.id, s.id, "egress", step);
    else if (!r && s && a) addEdge(a.id, s.id, "egress", step);
  }

  const edges: ChainEdge[] = [...edgeMap.values()].map((e, i) => {
    const tone = nodeTone(e.steps);
    const why = e.steps.map(inferredWhy).find(Boolean);
    const dashed = !!why || e.steps.every((s) => s.egress && !hasRecordedHost(s) && e.kind === "egress");
    return {
      id: `e${i}`,
      from: e.from,
      to: e.to,
      count: e.steps.length,
      stepIds: e.steps.map((s) => s.id),
      kind: e.kind,
      tone,
      dashed,
      why: dashed
        ? (why ?? "该步只记录了「对外发起连接」，没有记录目标主机")
        : undefined,
    };
  });

  // A chain with a single node has nothing to connect; say so instead of
  // drawing a decorative line.
  const note =
    edges.length === 0
      ? "这一步没有可连接的下一环：日志里没有对应的资源或出口记录。"
      : undefined;

  return { nodes, edges, note };
}

/**
 * Build the graph for one incident, already carrying the honest caveat.
 * Pure: the same incident always produces the same graph.
 */
export function chainOf(incident: {
  id: string;
  severity: SecurityChain["severity"];
  title: string;
  at: number;
  lastAt: number;
  tool: string;
  project: string;
  sessionId: string;
  steps: IncidentStep[];
  blocked: number;
}): SecurityChain {
  const graph = graphOf(incident);
  const heuristic = incident.steps.some((s) => s.levelSource === "heuristic");
  const caveat = heuristic
    ? "部分记录没有守卫期判定，相关节点与连线用虚线标出：那是一致性推断，不能当作已核实的事实。"
    : "连线只表示这些记录在时间上相邻、属于同一会话，并按记录到的资源与出口相连；它不代表 AI 一定把这些数据发到了那个主机。";
  return {
    id: incident.id,
    incidentId: incident.id,
    severity: incident.severity,
    title: incident.title,
    at: incident.at,
    lastAt: incident.lastAt,
    tool: incident.tool,
    project: incident.project,
    sessionId: incident.sessionId,
    steps: incident.steps,
    blocked: incident.blocked,
    graph,
    caveat,
  };
}

export interface ChainQuery extends ChainFilter {
  now?: number;
}

/**
 * Incidents → tracking chains, using the exact same grouping as the incident
 * list. Two views over one projection, so they can never disagree about where
 * a boundary is.
 */
export function buildChains(
  events: SecurityEvent[],
  query: ChainQuery = {},
): SecurityChain[] {
  const incidents = buildIncidents(events, {
    severity: query.severity,
    limit: query.limit ?? 100,
  });
  const selected = query.incidentId
    ? incidents.filter((i) => i.id === query.incidentId)
    : incidents;
  return selected.map(chainOf);
}
