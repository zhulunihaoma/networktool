import { useMemo } from "react";
import {
  TOOL_NAMES,
  type SecurityOverview,
  type SecurityTool,
} from "./shared/security";
import { ago } from "./security-format";
import { BarList, TrendChart } from "./security-charts";

/**
 * 安全报告（周报视角）：近 7 天防护活动的可分享摘要，
 * 数据全部来自事件链与体检快照聚合，无手工数据。
 */
const DAY = 86400000;
export default function SecurityReport({
  overview,
  onExport,
  busy,
}: {
  overview: SecurityOverview;
  onExport: () => void;
  busy: boolean;
}) {
  const week = useMemo(() => {
    const since = Date.now() - 7 * DAY;
    const days = overview.stats.byDay.slice(-7);
    return {
      since,
      days,
      checked: days.reduce((n, d) => n + d.checked, 0),
      blocked: days.reduce((n, d) => n + d.blocked, 0),
      actions: overview.stats.actions.filter((a) => a.at >= since),
      doctorRuns: overview.scoreHistory.filter((s) => s.at >= since).length,
      firstScore: overview.scoreHistory.filter((s) => s.at >= since)[0]?.score,
      lastScore: overview.scoreHistory.filter((s) => s.at >= since).at(-1)?.score,
    };
  }, [overview]);
  const byTool = Object.entries(overview.stats.byTool)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([id, n]) => ({
      label: TOOL_NAMES[id as SecurityTool] ?? id,
      value: n,
    }));
  return (
    <div className="panel security-box security-report">
      <div className="security-title">
        <div>
          <h2>安全报告</h2>
          <p>
            近 7 天（自 {new Date(week.since).toLocaleDateString("zh-CN")} 起）的防护活动摘要。
            所有数字来自本地事件记录，未上传任何内容。
          </p>
        </div>
        <button className="secondary" disabled={busy} onClick={onExport}>
          导出完整报告
        </button>
      </div>
      <div className="report-grid">
        <div className="report-card">
          <b>{week.checked}</b>
          <span>AI 操作被检查</span>
        </div>
        <div className="report-card">
          <b>{week.blocked}</b>
          <span>风险操作被拦截</span>
        </div>
        <div className="report-card">
          <b>{week.doctorRuns}</b>
          <span>次配置体检</span>
        </div>
        <div className="report-card">
          <b>
            {week.firstScore !== undefined && week.lastScore !== undefined
              ? week.lastScore >= week.firstScore
                ? `+${week.lastScore - week.firstScore}`
                : `${week.lastScore - week.firstScore}`
              : "—"}
          </b>
          <span>评分变化（周内）</span>
        </div>
      </div>
      <h3>近 7 天趋势</h3>
      <TrendChart days={week.days} />
      <div className="report-columns">
        <div>
          <h3>本周做过的处理</h3>
          {week.actions.length ? (
            <ul className="action-feed">
              {week.actions.map((a) => (
                <li key={a.at + a.operation}>
                  <time>{ago(a.at)}</time>
                  <span>
                    <b>{a.operation}</b>
                    {a.reason && <small>{a.reason}</small>}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="chart-empty">
              本周还没有防护相关的操作记录；体检、开启防护、修复问题都会记在这里。
            </p>
          )}
        </div>
        <div>
          <h3>累计拦截最多的工具</h3>
          <BarList items={byTool} emptyText="还没有拦截记录。" />
          <h3>当前状态</h3>
          <ul className="report-status">
            <li>
              安全评分：<b>{overview.score}</b>（
              {overview.level === "safe"
                ? "较安全"
                : overview.level === "attention"
                  ? "需关注"
                  : "有风险"}
              ）
            </li>
            <li>
              待处理问题：<b>{overview.findings.length}</b> 项（高{" "}
              {overview.openFindings.high} / 中 {overview.openFindings.medium} / 低{" "}
              {overview.openFindings.low}）
            </li>
            <li>
              已接入防护的工具：
              <b>
                {
                  overview.tools.filter((t) =>
                    ["enabled", "verified", "needs_restart"].includes(t.state),
                  ).length
                }
                /{overview.tools.filter((t) => t.canToggle).length}
              </b>
            </li>
            <li>
              记录完整性：
              {overview.stats.totalChecked || overview.stats.actions.length
                ? "本地哈希链校验（见事件分析 → 事件列表）"
                : "暂无记录"}
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
