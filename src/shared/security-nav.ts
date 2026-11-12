import type { EvidenceSource } from "./security";

/**
 * Navigation is grouped by the question the user is asking, not by backend
 * module. Each view belongs to exactly one group; a group remembers which of
 * its views was last open so switching back does not lose the user's place.
 */
export type SecurityView =
  | "overview"
  | "report"
  | "chain"
  | "events"
  | "retro"
  | "protect"
  | "rules"
  | "doctor"
  | "inventory"
  | "install"
  | "files"
  | "forward";
export const GROUPS: { name: string; views: { id: SecurityView; label: string }[] }[] = [
  {
    name: "总览",
    views: [
      { id: "overview", label: "当前状态" },
      { id: "report", label: "近 7 天报告" },
    ],
  },
  {
    name: "事件分析",
    views: [
      { id: "chain", label: "追踪链" },
      { id: "events", label: "事件列表" },
      { id: "retro", label: "回溯扫描" },
    ],
  },
  {
    name: "防护与规则",
    views: [
      { id: "protect", label: "防护开关" },
      { id: "rules", label: "操作规则" },
    ],
  },
  {
    name: "配置检查",
    views: [
      { id: "doctor", label: "配置体检" },
      { id: "inventory", label: "变更巡检" },
      { id: "install", label: "安装前检查" },
    ],
  },
  {
    name: "数据边界",
    views: [
      { id: "files", label: "文件策略" },
      { id: "forward", label: "日志外送" },
    ],
  },
];
export const groupOf = (view: SecurityView) =>
  GROUPS.find((g) => g.views.some((v) => v.id === view)) ?? GROUPS[0];

export type EventView = "attention" | "ai" | "history" | "app";
/**
 * Every source lands in exactly one view. Retro-scan rows ("session") are past
 * AI operations recovered from session files, so they get their own view
 * rather than sitting with the app's own bookkeeping.
 */
export const EVENT_VIEWS: Record<EventView, { label: string; sources: EvidenceSource[] }> = {
  attention: { label: "敏感事件", sources: ["real_block", "error"] },
  ai: { label: "全部 AI 操作", sources: ["real_block", "real_allow", "error"] },
  history: { label: "历史线索", sources: ["session"] },
  app: {
    label: "安全中心记录",
    sources: ["self_check", "scan", "network", "action"],
  },
};
export const eventViewCount = (v: EventView, counts: Record<EvidenceSource, number>) =>
  EVENT_VIEWS[v].sources.reduce((n, s) => n + counts[s], 0);
