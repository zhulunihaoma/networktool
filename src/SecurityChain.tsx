import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DATA_LEVEL_LABELS,
  RULE_TITLES,
  SOURCE_LABELS,
  TOOL_NAMES,
  type ChainEdge,
  type ChainNode,
  type DataLevel,
  type IncidentStep,
  type SecurityAPI,
  type SecurityChain,
  type SecurityTool,
} from "./shared/security";
import {
  COLUMN_LABELS,
  NODE_HEIGHT,
  edgeWidth,
  layoutChain,
} from "./shared/chain-layout";
import { ago } from "./security-format";
import Modal from "./Modal";
import "./styles-chain.css";

/** What the user clicked, either a node or an edge. */
type Focus = { kind: "node"; id: string } | { kind: "edge"; id: string };

const SEVERITY_LABEL: Record<SecurityChain["severity"], string> = {
  critical: "critical",
  high: "high",
  medium: "medium",
  low: "low",
};

function toolName(tool: string) {
  return TOOL_NAMES[tool as SecurityTool] ?? tool;
}
function shortProject(project: string) {
  return project ? (project.split(/[\\/]/).filter(Boolean).pop() ?? project) : "";
}
function clock(at: number) {
  return new Date(at).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
const levelWord = (l: DataLevel) => `${l} ${DATA_LEVEL_LABELS[l]}`;

/**
 * Tracking-chain view: one incident drawn as 主体 → 行为 → 资源 → 出口.
 *
 * Every node and edge is clickable and opens the same detail drawer, so the
 * graph is a way into the raw rows, never a replacement for them. Where the
 * log does not hold enough to connect two things, the link is dashed and the
 * drawer says why — the drawing never guesses on the user's behalf.
 */
export default function SecurityChainView({
  service,
  run,
  notify,
  addException,
  openEvents,
}: {
  service: SecurityAPI;
  run: (fn: () => Promise<void>) => Promise<void>;
  notify: (text: string) => void;
  /** Same project exception the event list offers, for a real block. */
  addException?: (target: { id: string; project: string; ruleId: string }) => void;
  /** Switch to the flat event list (records that do not form a chain live there). */
  openEvents?: () => void;
}) {
  const [chains, setChains] = useState<SecurityChain[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string>();
  const [focus, setFocus] = useState<Focus>();
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const [width, setWidth] = useState(0);
  // Callback ref: the canvas only mounts once a chain is selected, so a
  // mount-time effect on a plain ref would observe null and never re-run.
  const [canvas, setCanvas] = useState<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await service.securityChains({ limit: 100 });
      setChains(list);
      setSelected((prev) =>
        prev && list.some((c) => c.id === prev) ? prev : list[0]?.id,
      );
    } finally {
      setLoading(false);
    }
  }, [service]);

  useEffect(() => {
    void load().catch((e) => notifyRef.current(String(e)));
  }, [load]);
  // New hook events can extend the open chain; reload without resetting focus.
  useEffect(
    () => service.onSecurity(() => void load().catch(() => {})),
    [service, load],
  );

  // The four columns must fill the panel; measure instead of guessing.
  useEffect(() => {
    if (!canvas) return;
    setWidth(canvas.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      if (next) setWidth(next);
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [canvas]);

  const active = useMemo(
    () => chains.find((c) => c.id === selected),
    [chains, selected],
  );

  const layout = useMemo(
    () => (active && width ? layoutChain(active.graph, width) : undefined),
    [active, width],
  );

  const focused = useMemo(() => {
    if (!active || !focus) return undefined;
    if (focus.kind === "node") {
      const node = active.graph.nodes.find((n) => n.id === focus.id);
      if (!node) return undefined;
      const edges = active.graph.edges.filter(
        (e) => e.from === node.id || e.to === node.id,
      );
      return { kind: "node" as const, node, edges };
    }
    const edge = active.graph.edges.find((e) => e.id === focus.id);
    if (!edge) return undefined;
    const from = active.graph.nodes.find((n) => n.id === edge.from);
    const to = active.graph.nodes.find((n) => n.id === edge.to);
    return { kind: "edge" as const, edge, from, to };
  }, [active, focus]);

  // A reload can rebuild the graph; drop a focus that no longer resolves.
  useEffect(() => {
    if (focus && !focused) setFocus(undefined);
  }, [focus, focused]);

  /** Raw rows behind whatever is focused; falls back to the whole chain. */
  const focusSteps = useMemo(() => {
    if (!active) return [];
    if (!focused) return active.steps;
    const ids =
      focused.kind === "node" ? focused.node.stepIds : focused.edge.stepIds;
    const set = new Set(ids);
    return active.steps.filter((s) => set.has(s.id));
  }, [active, focused]);

  if (loading && !chains.length)
    return (
      <div className="security-box">
        <p>正在整理追踪链…</p>
      </div>
    );

  if (!chains.length)
    return (
      <div className="security-box">
        <div className="security-title">
          <h3>追踪链</h3>
        </div>
        <p>
          还没有可以画出追踪链的记录。同一工具、同一项目、同一会话里 15 分钟内的连续操作会被合成一条链，
          需要至少 2 条记录，或 1 条真实拦截。
        </p>
        {openEvents && (
          <p>
            <button type="button" className="link-button" onClick={openEvents}>
              查看事件列表 →
            </button>
          </p>
        )}
        <p>
          <small>
            追踪链只读取已有记录，不新增、不修改日志，因此不影响哈希链校验与已有导出。
          </small>
        </p>
      </div>
    );

  return (
    <div>
      <div className="security-box" style={{ paddingBottom: 16 }}>
        <div className="security-title">
          <h3>追踪链</h3>
          <button
            type="button"
            onClick={() => {
              void run(async () => {
                await load();
                setFocus(undefined);
                notify("已重新整理追踪链");
              });
            }}
          >
            刷新
          </button>
        </div>
        <p>
          从左到右依次是一次操作的主体、行为、触碰的资源和最终的出口。线越粗代表涉及记录越多，
          虚线代表这一环是按已有记录推断的 —— 点任一节点或连线可以查看它背后的原始记录。
        </p>
        <p className="hint">
          资源类别由操作请求分析得出，不表示已确认连接成功、服务正在运行或操作已经完成。
          {active?.steps.some((s) => !s.classifierVersion) &&
            "当前链含旧版分类记录，可能存在关键词误判；原始命令未保留，刷新不会重算历史分类。"}
        </p>
        <div className="chain-legend" aria-hidden="true">
          <span className="legend-item">
            <i className="legend-line solid" /> 记录直接支持
          </span>
          <span className="legend-item">
            <i className="legend-line dashed" /> 记录不足以断定
          </span>
          <span className="legend-item">
            <i className="legend-line thick" /> 线粗 = 记录条数多
          </span>
          <span className="legend-item legend-note">
            线不等于网络连接，只表示同一会话内这些记录被连在一起
          </span>
        </div>
      </div>

      <div className="chains">
        <ul className="chain-list">
          {chains.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className={`chain-item${c.id === selected ? " active" : ""}`}
                onClick={() => {
                  setSelected(c.id);
                  setFocus(undefined);
                }}
              >
                <div className="chain-item-top">
                  <span className={`sev sev-${c.severity}`}>
                    {SEVERITY_LABEL[c.severity]}
                  </span>
                  {c.blocked > 0 && (
                    <span className="sev sev-critical">已拦截 {c.blocked}</span>
                  )}
                </div>
                <div className="chain-item-title">{c.title}</div>
                <div className="chain-item-sub">
                  {toolName(c.tool)}
                  {shortProject(c.project) ? ` · ${shortProject(c.project)}` : ""}
                  {" · "}
                  {c.steps.length} 条记录 · {ago(c.lastAt)}
                </div>
              </button>
            </li>
          ))}
        </ul>

        <div className="security-box chain-detail">
          {!active ? (
            <div className="chain-empty">选择左侧一条链查看追踪视图</div>
          ) : (
            <>
              <div className="chain-detail-head">
                <div className="chain-item-top">
                  <span className={`sev sev-${active.severity}`}>
                    {SEVERITY_LABEL[active.severity]}
                  </span>
                  {[
                    ...new Set(active.steps.map((s) => s.level)),
                  ]
                    .sort()
                    .reverse()
                    .map((l) => (
                      <span key={l} className={`lvl lvl-${l}`}>
                        {levelWord(l as DataLevel)}
                      </span>
                    ))}
                </div>
                <h3>{active.title}</h3>
                <div className="chain-item-sub">
                  {toolName(active.tool)}
                  {shortProject(active.project)
                    ? ` · ${shortProject(active.project)}`
                    : ""}{" "}
                  · {new Date(active.at).toLocaleString("zh-CN")} 起 · 持续{" "}
                  {Math.max(1, Math.round((active.lastAt - active.at) / 60000))} 分钟
                </div>
              </div>

              <div className="chain-canvas" ref={setCanvas}>
                {layout && (
                  <div
                    className="chain-graph"
                    style={{ height: layout.height }}
                    role="group"
                    aria-label="追踪链图"
                  >
                    <div className="chain-graph-columns" aria-hidden="true">
                      {layout.columns.map((col) => (
                        <span
                          key={col.column}
                          style={{
                            left: col.x - layout.columnWidth / 2,
                            width: layout.columnWidth,
                          }}
                        >
                          {COLUMN_LABELS[col.column]}
                        </span>
                      ))}
                    </div>
                    <svg
                      className="chain-graph-edges"
                      width={layout.width}
                      height={layout.height}
                      aria-hidden="true"
                    >
                      {layout.edges.map((e) => (
                        <g key={e.id} data-tone={e.tone}>
                          <path
                            d={e.path}
                            className={`edge edge-${e.kind}${e.dashed ? " is-dashed" : ""}`}
                            stroke={toneColor(e.tone)}
                            strokeWidth={edgeWidth(e.count)}
                          />
                          {e.count > 1 && (
                            <text x={e.cx} y={e.cy - 5} className="edge-count">
                              {e.count}
                            </text>
                          )}
                        </g>
                      ))}
                    </svg>
                    {layout.nodes.map((n) => (
                      <button
                        key={n.id}
                        type="button"
                        className={`chain-node node-${n.kind}${
                          n.inferred ? " is-inferred" : ""
                        }${n.decision === "deny" ? " is-blocked" : ""}`}
                        style={{
                          left: n.x - n.width / 2,
                          top: n.y,
                          width: n.width,
                          height: NODE_HEIGHT,
                        }}
                        onClick={() => setFocus({ kind: "node", id: n.id })}
                        title={`${n.label}｜${n.sub}`}
                      >
                        <span className="chain-node-label">{n.label}</span>
                        <span className="chain-node-sub">{n.sub}</span>
                        {n.count > 1 && (
                          <span className="chain-node-count">×{n.count}</span>
                        )}
                        {n.inferred && (
                          <span className="chain-node-flag" aria-label="推断">
                            推断
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
                {active.graph.note && (
                  <p className="chain-graph-note">{active.graph.note}</p>
                )}
              </div>

              <div className="chain-caveat">{active.caveat}</div>

              <div className="chain-section-head">
                <h4>
                  {focused
                    ? focused.kind === "node"
                      ? `节点「${focused.node.label}」背后的原始记录`
                      : `连线「${focused.from?.label ?? "?"} → ${focused.to?.label ?? "?"}」背后的原始记录`
                    : "合并前的每一步"}
                </h4>
                {focused && (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => setFocus(undefined)}
                  >
                    返回整条链
                  </button>
                )}
              </div>
              <ul className="chain">
                {focusSteps.map((s) => (
                  <li key={s.id} data-tone={stepTone(s)}>
                    <time>{clock(s.at)}</time>
                    <div className="rail">
                      <i className="node" />
                    </div>
                    <div className="card">
                      <div className="card-head">
                        <span>{s.operation}</span>
                        <span className={`lvl lvl-${s.level}`}>{s.level}</span>
                        <span
                          className={`sev ${s.decision === "deny" ? "sev-critical" : "sev-low"}`}
                        >
                          {decisionWord(s)}
                        </span>
                        {s.levelSource === "heuristic" && (
                          <span className="chain-flag">推断分级</span>
                        )}
                      </div>
                      <div className="card-body">
                        {s.ruleId && (
                          <>命中「{RULE_TITLES[s.ruleId] ?? s.ruleId}」。</>
                        )}
                        {s.reason ?? "未命中规则。"}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>

              <div className="chain-note">
                追踪链只做归并，不改变任何已有记录；哈希链与导出保持不变。点节点或连线可在右侧看到背后的原始记录，
                真实拦截可以直接在那里设为项目例外。不足以成链的单条记录只出现在
                {openEvents ? (
                  <button type="button" className="link-button" onClick={openEvents}>
                    事件列表
                  </button>
                ) : (
                  "事件列表"
                )}
                。
              </div>
            </>
          )}
        </div>
      </div>

      {focused && active && (
        <Modal
          drawer
          drawerSide="right"
          title={
            focused.kind === "node"
              ? focused.node.label
              : `${focused.from?.label ?? "?"} → ${focused.to?.label ?? "?"}`
          }
          subtitle={
            focused.kind === "node"
              ? COLUMN_LABELS[focused.node.column]
              : "连线详情"
          }
          onClose={() => setFocus(undefined)}
        >
          <div className="modal-body chain-drawer">
            {focused.kind === "node" ? (
              <>
                <p className="chain-drawer-sub">{focused.node.sub}</p>
                <dl className="chain-facts">
                  <dt>归并了</dt>
                  <dd>{focused.node.count} 条原始记录</dd>
                  <dt>时间范围</dt>
                  <dd>
                    {clock(focused.node.firstAt)}
                    {focused.node.lastAt !== focused.node.firstAt
                      ? ` – ${clock(focused.node.lastAt)}`
                      : ""}
                  </dd>
                  {focused.node.level && (
                    <>
                      <dt>数据分级</dt>
                      <dd>{levelWord(focused.node.level)}</dd>
                    </>
                  )}
                  <dt>所在列</dt>
                  <dd>{COLUMN_LABELS[focused.node.column]}</dd>
                </dl>
                <h4>为什么是同一个节点</h4>
                <ul className="chain-reasons">
                  {focused.node.mergedBy.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
                {focused.edges.length > 0 && (
                  <>
                    <h4>与它相连</h4>
                    <ul className="chain-links">
                      {focused.edges.map((e) => {
                        const other =
                          e.from === focused.node.id ? e.to : e.from;
                        const otherNode = active.graph.nodes.find(
                          (n) => n.id === other,
                        );
                        return (
                          <li key={e.id}>
                            <button
                              type="button"
                              className="link-button"
                              onClick={() => setFocus({ kind: "edge", id: e.id })}
                            >
                              {e.from === focused.node.id ? "→" : "←"}{" "}
                              {otherNode?.label ?? other}（{e.count} 条
                              {e.dashed ? "，虚线" : ""}）
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </>
            ) : (
              <>
                <p className="chain-drawer-sub">
                  {focused.edge.count} 条原始记录同时落在这两端
                </p>
                <dl className="chain-facts">
                  <dt>类型</dt>
                  <dd>{EDGE_KIND_LABEL[focused.edge.kind]}</dd>
                  <dt>线条</dt>
                  <dd>
                    {focused.edge.dashed ? "虚线（记录不足以断定）" : "实线（记录直接支持）"}
                  </dd>
                  <dt>来自</dt>
                  <dd>{focused.from?.label ?? "?"}</dd>
                  <dt>去向</dt>
                  <dd>{focused.to?.label ?? "?"}</dd>
                </dl>
                {focused.edge.dashed && focused.edge.why && (
                  <>
                    <h4>为什么画成虚线</h4>
                    <p className="chain-drawer-note">{focused.edge.why}</p>
                  </>
                )}
                {!focused.edge.dashed && (
                  <>
                    <h4>这条线说明了什么</h4>
                    <p className="chain-drawer-note">
                      同一条记录里同时出现了这两端，所以它们之间是记录到的事实关系，
                      不是按时间先后猜出来的。
                    </p>
                  </>
                )}
              </>
            )}

            <h4>原始记录（{focusSteps.length} 条）</h4>
            <ul className="chain-raw">
              {focusSteps.map((s) => (
                <li key={s.id}>
                  <time>{clock(s.at)}</time>
                  <div>
                    <strong>{s.operation}</strong>
                    <span className="chain-raw-meta">
                      {SOURCE_LABELS[s.source]} · {decisionWord(s)} · {s.level}
                      {s.hosts?.length ? ` · ${s.hosts.join("、")}` : ""}
                    </span>
                    {s.ruleId && (
                      <span className="chain-raw-meta">
                        命中「{RULE_TITLES[s.ruleId] ?? s.ruleId}」
                      </span>
                    )}
                    {addException &&
                      s.source === "real_block" &&
                      s.ruleId &&
                      active.project && (
                        <button
                          type="button"
                          className="link-button chain-raw-action"
                          onClick={() => {
                            // Close the drawer first so two dialogs never fight over focus.
                            setFocus(undefined);
                            addException({
                              id: s.id,
                              project: active.project,
                              ruleId: s.ruleId!,
                            });
                          }}
                        >
                          以后在这个项目允许
                        </button>
                      )}
                  </div>
                </li>
              ))}
            </ul>
            <p className="chain-drawer-note">
              这些是日志里已有的记录本身，归并没有改动它们。
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}

const EDGE_KIND_LABEL: Record<ChainEdge["kind"], string> = {
  acted: "主体执行了该行为",
  touched: "该行为触碰了该资源",
  egress: "数据流向该出口",
};

function toneColor(tone: ChainEdge["tone"]) {
  return tone === "danger"
    ? "#b64848"
    : tone === "warn"
      ? "#a9792f"
      : "#7b8a99";
}
function stepTone(step: IncidentStep) {
  if (step.decision === "deny") return "danger";
  if (step.egress) return "warn";
  return "info";
}
function decisionWord(step: IncidentStep) {
  if (step.source === "real_block") return "已拦截";
  if (step.source === "session") return "历史线索";
  if (step.decision === "deny") return "需确认";
  return "已放行";
}
