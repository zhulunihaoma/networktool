import { AI_PLATFORMS } from "./platforms";
import type { TriageRun, TriageAction, AIPlatform, TriageStep } from "./types";

// Codex uses this public entrance only as a connectivity reference. It is not a model/API health check.
export const TRIAGE_TARGETS: AIPlatform[] = [
  {
    ...AI_PLATFORMS.find((p) => p.id === "chatgpt")!,
    id: "codex",
    name: "Codex",
    processNames: ["Codex", "codex"],
    description: "公开入口与本机连接观察，需在 Codex 中复现",
  },
  ...AI_PLATFORMS,
];
export const TRIAGE_ACTIONS: Record<TriageAction, string> = {
  retry: "重新检查",
  network_settings: "打开网络设置",
  proxy_settings: "打开代理设置",
  date_settings: "打开日期与时间",
  open_platform: "打开平台入口",
  service_status: "查看官方服务状态",
  reset_probe: "重建检测连接",
  observe: "观察重连（60 秒）",
  copy_report: "复制排查结果给 IT",
};
export function newTriage(targetId: string, id = "initial"): TriageRun {
  const steps: TriageStep[] = [
    {
      id: "network",
      title: "基础网络",
      status: "pending",
      summary: "等待检查本机网络地址",
      suggestion: "",
      evidence: [],
      actions: [],
      support: "none",
    },
    {
      id: "proxy",
      title: "代理与 VPN 入口",
      status: "pending",
      summary: "等待检查系统代理路径",
      suggestion: "",
      evidence: [],
      actions: [],
      support: "none",
    },
    {
      id: "dns",
      title: "域名解析",
      status: "pending",
      summary: "等待检查系统解析结果",
      suggestion: "",
      evidence: [],
      actions: [],
      support: "none",
    },
    {
      id: "entry",
      title: "安全连接与平台响应",
      status: "pending",
      summary: "等待检查公开入口",
      suggestion: "",
      evidence: [],
      actions: [],
      support: "none",
    },
    {
      id: "stability",
      title: "持续使用与重连观察",
      status: "pending",
      summary: "需要在原工具中复现问题",
      suggestion: "",
      evidence: [],
      actions: [],
      support: "none",
    },
  ];
  return {
    id,
    targetId,
    status: "idle",
    steps,
    priorityIds: [],
    summary: "按依赖顺序排查，再根据证据推荐先处理的项目",
    observation: {
      status: "idle",
      duration: 60,
      samples: 0,
      processCount: 0,
      maxConnections: 0,
      networkChanges: 0,
      proxyChanges: 0,
      missingProcesses: 0,
      errors: 0,
      markers: [],
      events: [],
    },
    verification: "unknown",
  };
}
export function triageText(run: TriageRun): string {
  const name =
    TRIAGE_TARGETS.find((p) => p.id === run.targetId)?.name || run.targetId;
  return [
    `360AI盒子 顺序排查：${name}`,
    `时间：${run.started ? new Date(run.started).toISOString() : "尚未开始"}`,
    `结论：${run.summary}`,
    "排序：逻辑依赖与本次证据，不是故障概率统计。",
    ...run.steps.map(
      (s) =>
        `${s.title} [${s.status}]：${s.summary}\n证据：${s.evidence.join("；") || "未取得"}\n建议：${s.suggestion || "等待检查"}`,
    ),
    run.comparison ? `复测比较：${run.comparison}` : "",
    `用户复测：${run.verification === "restored" ? "用户确认已恢复" : run.verification === "still_failed" ? "用户确认仍有问题" : "用户尚未确认"}`,
    `观察：${run.observation.samples} 次快照；标记 ${run.observation.markers.length} 次；网络变化 ${run.observation.networkChanges} 次；代理路径变化 ${run.observation.proxyChanges} 次；采集错误 ${run.observation.errors} 次。`,
    ...run.observation.markers.map(
      (time) =>
        `用户标记的错误时刻（未自动判定故障）：${new Date(time).toISOString()}`,
    ),
    ...run.observation.events.map(
      (event) =>
        `观察事件：${new Date(event.time).toISOString()} ${event.message}`,
    ),
    "范围：公开入口和本机快照，未读取账号凭据、应用日志或请求正文；不验证真实流式响应。",
  ]
    .filter(Boolean)
    .join("\n\n");
}
