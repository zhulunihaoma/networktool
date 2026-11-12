import { useEffect, useRef, useState } from "react";
import type {
  DayStat,
  ScoreHistoryItem,
} from "./shared/security";

/**
 * 手写 SVG 图表（无第三方依赖），数据全部来自事件链/体检快照，
 * 空数据时展示引导语而不是空白。
 */

/** 30 天检查/拦截双柱趋势图。 */
export function TrendChart({ days }: { days: DayStat[] }) {
  const W = 640,
    H = 140,
    PAD = 6,
    BAR = 5;
  const max = Math.max(1, ...days.map((d) => Math.max(d.checked, d.blocked)));
  const slot = (W - PAD * 2) / Math.max(days.length, 1);
  const h = (v: number) => (v / max) * (H - 28);
  const empty = days.every((d) => d.checked === 0);
  if (empty)
    return (
      <p className="chart-empty">
        还没有检查记录。开启防护并让 AI 工具执行几次操作后，这里会出现每日趋势。
      </p>
    );
  return (
    <div className="trend-chart" role="img" aria-label="最近 30 天检查与拦截趋势">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg">
        {days.map((d, i) => {
          const x = PAD + i * slot;
          const checked = h(d.checked);
          const blocked = h(d.blocked);
          return (
            <g key={d.day}>
              <title>{`${d.day}：检查 ${d.checked} 次，拦截 ${d.blocked} 次`}</title>
              <rect
                x={x}
                y={H - 18 - checked}
                width={BAR * 2}
                height={checked}
                className="bar-checked"
                rx={1}
              />
              {d.blocked > 0 && (
                <rect
                  x={x + BAR}
                  y={H - 18 - blocked}
                  width={BAR}
                  height={blocked}
                  className="bar-blocked"
                  rx={1}
                />
              )}
            </g>
          );
        })}
        <line x1={0} y1={H - 17} x2={W} y2={H - 17} className="chart-axis" />
      </svg>
      <div className="chart-legend">
        <span>
          <i className="dot dot-checked" />检查
        </span>
        <span>
          <i className="dot dot-blocked" />拦截
        </span>
        <small>近 30 天</small>
      </div>
    </div>
  );
}

/** 体检评分历史折线（来自每次体检后的真实快照）。 */
export function ScoreLine({ history }: { history: ScoreHistoryItem[] }) {
  const W = 640,
    H = 140,
    PAD = 10;
  if (history.length < 2)
    return (
      <p className="chart-empty">
        评分历史会在每次体检后记录一个点，再体检一次就能看到趋势。
      </p>
    );
  const xs = (i: number) =>
    PAD + (i / Math.max(history.length - 1, 1)) * (W - PAD * 2);
  const ys = (score: number) => H - 12 - (score / 100) * (H - 24);
  const line = history.map((p, i) => `${xs(i)},${ys(p.score)}`).join(" ");
  const first = history[0].score;
  const last = history[history.length - 1].score;
  return (
    <div className="score-line" role="img" aria-label="体检评分历史">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg">
        <line x1={PAD} y1={ys(85)} x2={W - PAD} y2={ys(85)} className="chart-guide" />
        <line x1={PAD} y1={ys(60)} x2={W - PAD} y2={ys(60)} className="chart-guide risk" />
        <polyline points={line} className="score-path" />
        {history.map((p, i) => (
          <circle key={p.at} cx={xs(i)} cy={ys(p.score)} r={i === history.length - 1 ? 4 : 2.5} className="score-dot">
            <title>{`${new Date(p.at).toLocaleString("zh-CN")}：${p.score} 分（高 ${p.high} / 中 ${p.medium} / 低 ${p.low}）`}</title>
          </circle>
        ))}
      </svg>
      <div className="chart-legend">
        <span>
          首次 {first} 分 → 最近 {last} 分
          {last > first ? "（在变好）" : last < first ? "（有新问题）" : ""}
        </span>
        <small>{history.length} 次体检</small>
      </div>
    </div>
  );
}

/** 横条分布（按规则/按工具拦截次数）。 */
export function BarList({
  items,
  emptyText,
}: {
  items: { label: string; sub?: string; value: number }[];
  emptyText: string;
}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  if (!items.length) return <p className="chart-empty">{emptyText}</p>;
  return (
    <ul className="bar-list">
      {items.map((item) => (
        <li key={item.label}>
          <span className="bar-label">
            {item.label}
            {item.sub && <small>{item.sub}</small>}
          </span>
          <span className="bar-track">
            <span
              className="bar-fill"
              style={{ width: `${(item.value / max) * 100}%` }}
            />
          </span>
          <b className="bar-value">{item.value}</b>
        </li>
      ))}
    </ul>
  );
}

/** 数值滚动动画：体检完成后的分数变化。 */
export function useCountUp(target: number | undefined, duration = 600) {
  const [value, setValue] = useState(target);
  const fromRef = useRef(target);
  useEffect(() => {
    if (target === undefined) return;
    const from = fromRef.current ?? target;
    if (from === target) {
      setValue(target);
      return;
    }
    const started = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - started) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(from + (target - from) * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return value;
}
