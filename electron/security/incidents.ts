import type {
  EvidenceSource,
  IncidentStep,
  RiskLevel,
  SecurityEvent,
  SecurityIncident as SharedIncident,
} from "../../src/shared/security";
import { TOOL_NAMES } from "../../src/shared/security";
import { classifyResource, type DataLevel } from "./classification";

/**
 * Incident grouping: turns the flat chained event log into the small number of
 * things a human actually has to look at.
 *
 * This is a read-only projection. Nothing here writes to events.jsonl, so the
 * hash chain and every existing timeline/export path stay untouched.
 */

/** Re-exported so callers import the same shape the renderer renders. */
export type SecurityIncident = SharedIncident;

export interface IncidentQuery {
  severity?: SecurityIncident["severity"] | "all";
  limit?: number;
  now?: number;
}

/** Merge window: a new step joins if it is within 15 minutes of the previous. */
const WINDOW_MS = 15 * 60 * 1000;
/** Hard cap so one runaway session cannot merge an entire day. */
const MAX_SPAN_MS = 60 * 60 * 1000;
/** Below this many steps a group is noise, unless it contains a real block. */
const MIN_STEPS = 2;

const LEVEL_RANK: Record<DataLevel, number> = { L1: 0, L2: 1, L3: 2, L4: 3 };
const SEVERITY_RANK: Record<SecurityIncident["severity"], number> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0,
};

const EGRESS_RULE = /dns_exfil|cloud_delete|prod_write/;
const EGRESS_CMD =
  /\b(?:curl|wget|scp|rsync|ssh|nc|ncat|ftp|rclone)\b|\baws\s+s3\s+cp\b/;

/**
 * Does this step move data off the machine?
 *
 * `source: "network"` is deliberately NOT treated as egress: the only writer of
 * that source is `inventoryCheck`, which records config changes (新增/移除/变更
 * 配置). Scoring those as outbound traffic made an MCP config edit look like
 * data leaving the machine. Egress now comes from recorded facts first, then
 * from an explicit egress rule or an egress command in the operation text.
 */
export function isEgress(e: SecurityEvent): boolean {
  if (e.facts) {
    if ((e.facts.hosts?.length ?? 0) > 0) return true;
    if (
      e.facts.kinds.includes("network") &&
      e.facts.verbs.some((v) => v === "upload")
    )
      return true;
    // New conclusions already distinguish literals/help from real commands.
    // Falling back to the abbreviated operation would undo that distinction.
    if (e.facts.classifierVersion) return (
      EGRESS_RULE.test(e.ruleId ?? "") ||
      (e.facts.kinds.includes("network") && e.facts.verbs.some((v) => v === "download" || v === "exec"))
    );
  }
  if (EGRESS_RULE.test(e.ruleId ?? "")) return true;
  return EGRESS_CMD.test(e.operation);
}

const isBlocked = (e: SecurityEvent) =>
  e.decision === "deny" && e.source === "real_block";

/**
 * Only real hook traffic forms incidents. Self-check, scan and action rows are
 * kept out: they are evidence about the tool, not about what the AI did.
 */
const MERGEABLE: EvidenceSource[] = [
  "real_block",
  "real_allow",
  "network",
  "session",
];

export function stepOf(e: SecurityEvent): IncidentStep {
  const resource = classifyResource(e);
  const facts = e.facts;
  return {
    classifierVersion: facts?.classifierVersion,
    id: e.id,
    at: e.at,
    source: e.source,
    decision: e.decision,
    ruleId: e.ruleId,
    operation: e.operation,
    reason: e.reason,
    level: resource.level,
    resourceKind: resource.kind,
    egress: isEgress(e),
    kinds: facts ? facts.kinds : resource.kind ? [resource.kind] : [],
    verbs: facts ? facts.verbs : [],
    hosts: facts?.hosts ?? [],
    hits: facts ? facts.hits : resource.hits,
    // A verdict taken at guard time is evidence; anything re-derived from the
    // truncated `operation` text is a heuristic and must be labelled as such.
    levelSource: facts ? "facts" : "heuristic",
  };
}

/** Merge key: same tool + session + project. Missing session falls back per event. */
function groupKey(e: SecurityEvent): string | undefined {
  if (!MERGEABLE.includes(e.source)) return undefined;
  // Without a session id there is no reliable way to prove these belong together.
  if (!e.sessionId) return undefined;
  return `${e.tool}\u0000${e.project}\u0000${e.sessionId}`;
}

/**
 * Split the log into the raw event groups an incident — and therefore a chain —
 * is built from. Exported so `chain.ts` groups by exactly the same rules
 * instead of keeping a second, drifting copy of the merge window.
 *
 * Each returned group is in ascending time order and satisfies: same
 * tool+project+session, consecutive gaps ≤ WINDOW_MS, total span ≤ MAX_SPAN_MS.
 */
export function groupEvents(events: SecurityEvent[]): SecurityEvent[][] {
  const sorted = [...events].sort((a, b) => a.at - b.at);
  const groups = new Map<string, SecurityEvent[]>();
  for (const e of sorted) {
    const key = groupKey(e);
    if (!key) continue;
    const bucket = groups.get(key);
    if (bucket) bucket.push(e);
    else groups.set(key, [e]);
  }
  const out: SecurityEvent[][] = [];
  for (const [, list] of groups) {
    // Split one session into windows; a long-running session is not one incident.
    let current: SecurityEvent[] = [];
    const flush = () => {
      if (current.length >= MIN_STEPS || current.some(isBlocked))
        out.push(current);
      current = [];
    };
    for (const e of list) {
      if (!current.length) {
        current.push(e);
        continue;
      }
      const prev = current[current.length - 1];
      const span = e.at - current[0].at;
      if (e.at - prev.at > WINDOW_MS || span > MAX_SPAN_MS) {
        flush();
        current.push(e);
      } else current.push(e);
    }
    flush();
  }
  return out;
}

function severityOf(steps: IncidentStep[]): {
  severity: SecurityIncident["severity"];
  reasons: string[];
} {
  const reasons: string[] = [];
  const topLevel = steps.reduce<DataLevel>(
    (max, s) => (LEVEL_RANK[s.level] > LEVEL_RANK[max] ? s.level : max),
    "L1",
  );
  const blocked = steps.some(
    (s) => s.decision === "deny" && s.source === "real_block",
  );
  const egress = steps.some((s) => s.egress);
  const kinds = new Set(steps.map((s) => s.resourceKind).filter(Boolean));
  let score = 0;
  if (topLevel === "L4") {
    score = 2;
    reasons.push("含 L4（机密）资源");
  } else if (topLevel === "L3") {
    score = 1;
    reasons.push("含 L3（敏感）资源");
  }
  if (blocked) {
    score += 1;
    reasons.push("含执行前拦截");
  }
  if (egress) {
    score += 1;
    reasons.push("含对外发起连接");
  }
  if (kinds.size >= 2) {
    reasons.push(`跨 ${kinds.size} 类资源`);
  }
  if (topLevel === "L4" && egress) {
    reasons.push("机密资源与对外连接同时出现");
    score += 1;
  }
  if (blocked && egress) reasons.push("绕过尝试：拦截后仍有对外连接");
  const severity: SecurityIncident["severity"] =
    score >= 4 ? "critical" : score === 3 ? "high" : score === 2 ? "medium" : "low";
  return { severity, reasons };
}

function titleOf(steps: IncidentStep[], toolName: string): string {
  const blocked = steps.filter((s) => s.decision === "deny");
  const top = steps.reduce<IncidentStep | undefined>(
    (best, s) => (!best || LEVEL_RANK[s.level] > LEVEL_RANK[best.level] ? s : best),
    undefined,
  );
  if (blocked.length)
    return `${toolName}：${blocked.length} 次高危操作被拦截（${top?.level ?? "L2"} 资源）`;
  if (top && LEVEL_RANK[top.level] >= 3)
    return `${toolName}：读取了${top.level}（${top.level === "L4" ? "机密" : "敏感"}）资源`;
  return `${toolName}：${steps.length} 次关联操作`;
}

/**
 * Group events into incidents.
 * @param events newest-first or oldest-first; sorted internally.
 */
export function buildIncidents(
  events: SecurityEvent[],
  query: IncidentQuery = {},
): SecurityIncident[] {
  const limit = Math.min(query.limit ?? 100, 500);
  const incidents = groupEvents(events).map(toIncident);
  const filtered =
    query.severity && query.severity !== "all"
      ? incidents.filter((i) => i.severity === query.severity)
      : incidents;
  return filtered
    .sort(
      (a, b) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        b.lastAt - a.lastAt,
    )
    .slice(0, limit);
}

/** One group of raw events → one incident. Exported for `chain.ts`. */
export function toIncident(events: SecurityEvent[]): SecurityIncident {
  const steps = events.map(stepOf);
  const { severity, reasons } = severityOf(steps);
  const first = events[0];
  const ruleIds = [
    ...new Set(steps.map((s) => s.ruleId).filter((r): r is string => !!r)),
  ];
  const levels = [
    ...new Set(steps.map((s) => s.level)),
  ].sort((a, b) => LEVEL_RANK[b] - LEVEL_RANK[a]);
  return {
    id: `inc_${first.sessionId.slice(0, 12)}_${first.at}`,
    severity,
    at: first.at,
    lastAt: events[events.length - 1].at,
    tool: first.tool,
    project: first.project,
    sessionId: first.sessionId,
    title: titleOf(
      steps,
      TOOL_NAMES[first.tool as keyof typeof TOOL_NAMES] ?? first.tool,
    ),
    reasons,
    ruleIds,
    levels,
    steps,
    blocked: steps.filter(
      (s) => s.decision === "deny" && s.source === "real_block",
    ).length,
    sources: [...new Set(steps.map((s) => s.source))],
  };
}

/** Risk level per rule id, for chips in the UI. */
export const RULE_RISK: Record<string, RiskLevel> = {
  protected_branch: "high",
  destructive: "high",
  remote_exec: "high",
  credential_read: "high",
  credential_write: "high",
  privilege: "medium",
  protected_path_write: "medium",
  dns_exfil: "medium",
  infra_destroy: "high",
  db_destroy: "high",
  cloud_delete: "high",
  prod_write: "medium",
  input_limit: "medium",
};
