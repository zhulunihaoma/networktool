import { createHash } from "node:crypto";
import packageInfo from "../../package.json";
import type { ExportPreview, Session } from "../../src/shared/types";
export function buildReport(
  s: Session,
  format: "md" | "json",
  redact: boolean,
): ExportPreview {
  const aliases = new Map<string, string>();
  const alias = (s: string, prefix = "target") => {
    if (!aliases.has(s)) aliases.set(s, `${prefix}_${aliases.size + 1}`);
    return aliases.get(s)!;
  };
  const payload = {
    schema_version: 1,
    app_version: packageInfo.version,
    rule_version: 1,
    session_id: s.id,
    name: redact ? "诊断会话" : s.name,
    target: redact ? alias(s.target) : s.target,
    status: s.status,
    started: new Date(s.started).toISOString(),
    ended: s.ended ? new Date(s.ended).toISOString() : null,
    mode: s.mode,
    tool_context: s.toolContext
      ? {
          product: redact
            ? alias(s.toolContext.productId, "tool")
            : s.toolContext.productId,
          component: redact
            ? alias(s.toolContext.componentName, "component")
            : s.toolContext.componentName,
          version: s.toolContext.version || "unknown",
          feature: s.toolContext.feature,
          runtime: s.toolContext.runtime,
          adapter_status: s.toolContext.adapterStatus,
          identity_status: s.toolContext.identityStatus,
          source: s.toolContext.source,
        }
      : undefined,
    verified: s.verified || "unknown",
    verification_source: s.verified
      ? "用户声明，非目标 HTTP 成功证据"
      : "尚未复测",
    coverage: s.coverage,
    baseline_ended: s.baselineEnded
      ? new Date(s.baselineEnded).toISOString()
      : null,
    dropped: s.dropped,
    findings: s.findings,
    config: s.config.map((c) => ({
      name: c.name,
      source: c.source,
      state: c.state,
      value: redact ? "[已隐藏配置值]" : c.value,
    })),
    evidence: s.evidence.map((e) => ({
      ...e,
      route: ["direct", "local", "target_context"].includes(e.route)
        ? e.route
        : redact
          ? alias(e.route, "proxy")
          : e.route,
      detail: redact
        ? "[自由文本已隐藏；阶段、结果、原始错误码与耗时保留]"
        : e.detail,
    })),
    connections: s.flows.map((f) => ({
      ...f,
      process: redact ? alias(f.process, "app") : f.process,
      processKey: redact ? alias(f.processKey, "process") : f.processKey,
      pid: redact ? undefined : f.pid,
      local: redact ? alias(f.local) : f.local,
      remote: redact ? alias(f.remote) : f.remote,
    })),
    redacted_fields: redact
      ? ["目标", "进程标识", "本地与远端地址", "配置值", "自由文本", "会话名称"]
      : [],
    retained_fields: [
      "阶段与状态",
      "错误码",
      "耗时",
      "证据 ID",
      "规则结论",
      "覆盖范围",
      "用户复测声明",
    ],
    limitations: [
      "仅观察连接元数据，不采集请求正文。",
      "诊断器结果不等同于目标应用结果。",
      "逻辑删除不承诺物理安全擦除。",
    ],
  };
  const escape = (v: unknown) =>
    String(v ?? "")
      .replace(/[\r\n]+/g, " ")
      .replace(/[|`<>]/g, " ");
  let content =
    format === "json"
      ? JSON.stringify(payload, null, 2)
      : `# 360AI盒子 网络诊断报告\n\n会话：${escape(payload.session_id)}\n\n目标：${escape(payload.target)}\n\n时间：${payload.started}\n\n状态：${payload.status} · 复测：${payload.verified}（${payload.verification_source}）\n\n## 诊断结论\n\n${payload.findings.map((f) => `### ${f.ruleId} ${f.title}\n\n${f.description}\n\n支持等级：${f.support === "limited" ? "支持有限" : "不足以判断"}\n\n证据：${f.evidenceIds.join(", ") || "缺失"}\n\n未确认：${f.missing.join("；")}\n\n下一步：${f.nextCheck}`).join("\n\n")}\n\n## 分层探测证据\n\n| ID | 阶段 | 路径 | 状态 | 错误 / HTTP | 耗时 |\n| --- | --- | --- | --- | --- | --- |\n${payload.evidence.map((e) => `| ${escape(e.id)} | ${e.stage} | ${escape(e.route)} | ${e.status} | ${escape(e.code || e.httpStatus)} | ${e.duration ?? "—"} ms |`).join("\n")}\n\n## 覆盖范围与限制\n\n来源：${payload.coverage.collector}\n\n${payload.coverage.limitations.map((v) => `- ${v}`).join("\n")}\n\n记录丢失 / 截断：${payload.dropped}\n\n## 脱敏\n\n${redact ? "目标、地址、进程标识、配置值与自由文本已隐藏。" : "用户选择保留网络地址与配置值。"}\n\n规则版本 1 · 程序版本 ${packageInfo.version} · 所有主动探测由 diagnostic_probe 执行。\n`;
  if (format === "md" && payload.tool_context) {
    const context = payload.tool_context;
    content = content.replace(
      "## 诊断结论",
      `## 冻结的工具范围\n\n工具：${escape(context.product)} · 组件：${escape(context.component)} · 版本：${escape(context.version)} · 功能：${context.feature} · 运行位置：${context.runtime}\n\n适配状态：${context.adapter_status}；诊断器结果不证明目标功能恢复。\n\n## 诊断结论`,
    );
  }
  return {
    format,
    content,
    digest: createHash("sha256").update(content).digest("hex"),
  };
}
