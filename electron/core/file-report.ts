import { createHash } from "node:crypto";
import type { FileWorkspace, AuditEvent } from "../../src/shared/assistant";
import type { ExportPreview } from "../../src/shared/types";
const alias = (id: string, prefix: string) =>
  prefix + "_" + createHash("sha256").update(id).digest("hex").slice(0, 12);
export function fileAuditReport(
  workspace: FileWorkspace,
  events: AuditEvent[],
  scopeId: string | undefined,
  format: "md" | "json",
): ExportPreview {
  const payload = {
    schema_version: 1,
    scope: scopeId ? alias(scopeId, "scope") : "all",
    coverage: workspace.coverage,
    events: events
      .filter((e) => !scopeId || e.scopeId === scopeId)
      .map((e) => ({
        event_id: e.id,
        seq: e.seq,
        time: new Date(e.time).toISOString(),
        scope: alias(e.scopeId, "scope"),
        object: e.resourceId ? alias(e.resourceId, "file") : null,
        source: e.source,
        operation: e.operation,
        result: e.result,
        policy_revision: e.policyRevision ?? null,
        attribution_quality: "assistant_only",
        bytes_returned: null,
        model_receipt: null,
      })),
    alerts: workspace.alerts
      .filter((a) => !scopeId || a.scopeId === scopeId)
      .map((a) => ({
        id: a.id,
        rule: a.ruleId,
        object: alias(a.resourceId, "file"),
        scope: alias(a.scopeId, "scope"),
        state: a.state,
        count: a.count,
        first: a.first,
        last: a.last,
        evidence_ids: a.evidenceIds,
        source: "policy_validation",
        operation: a.operation,
      })),
    redacted_fields: [
      "目录名称与根路径",
      "文件路径与名称",
      "自由文本",
      "文件正文",
    ],
    limitations: [
      "只记录助手元数据扫描与本地策略校验，不代表第三方 AI 工具访问。",
      "自检拒绝不是实际网关或系统阻断；没有工具上传或模型提交证据。",
      "确认提醒不改变规则，也不表示保护恢复。",
    ],
  };
  const content =
    format === "json"
      ? JSON.stringify(payload, null, 2)
      : [
          "# 360AI盒子 文件策略审计报告",
          "",
          `范围：${payload.scope}`,
          "",
          "## 实际覆盖",
          "",
          ...payload.limitations.map((line) => `- ${line}`),
          "",
          "## 助手事件",
          "",
          "| 序号 | 时间 | 对象别名 | 操作 | 结果 | 来源 | 策略版本 |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          ...payload.events.map(
            (e) =>
              `| ${e.seq} | ${e.time} | ${e.object || e.scope} | ${e.operation} | ${e.result} | ${e.source} | ${e.policy_revision ?? "—"} |`,
          ),
          "",
          "## 自检提醒",
          "",
          ...payload.alerts.map(
            (a) =>
              `- ${a.rule} · ${a.object} · ${a.operation} · ${a.count} 次 · ${a.state} · 证据 ${a.evidence_ids.join(", ")}`,
          ),
          "",
          "路径、名称和自由文本已隐藏；文件正文从未采集。",
        ].join("\n");
  return {
    content,
    format,
    digest: createHash("sha256").update(content).digest("hex"),
  };
}
