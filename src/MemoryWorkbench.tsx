import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  FileText,
  FolderOpen,
  GitBranch,
  Loader2,
  Network,
  RefreshCw,
} from "lucide-react";
import type { DesktopAPI } from "./shared/types";
import {
  MEMORY_AGENTS,
  MEMORY_KIND_LABELS,
  type MemoryAgent,
  type MemoryNode,
  type MemorySnapshot,
} from "./shared/memory";
import {
  memoryReading,
  memoryReadingScope,
  type MemoryReadingFile,
  type MemoryReadingItem,
} from "./shared/memory-reading";
import { memoryOverviewGraph } from "./shared/memory-graph";

type View = {
  fileId: string;
  selectedId: string;
  groupId: string;
  mode: "read" | "map";
};
const initialView: View = {
  fileId: "",
  selectedId: "",
  groupId: "",
  mode: "read",
};
const message = (error: unknown) =>
  (error as Error).message.replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    "",
  );
const range = (node: MemoryNode) =>
  node.startLine === node.endLine
    ? `${node.startLine}`
    : `${node.startLine}–${node.endLine}`;

export default function MemoryWorkbench({ api }: { api: DesktopAPI }) {
  const [agent, setAgent] = useState<MemoryAgent>("codex");
  const [snapshot, setSnapshot] = useState<MemorySnapshot>();
  const [view, setView] = useState<View>(initialView);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [page, setPage] = useState(0);
  const [width, setWidth] = useState(500);
  const [groupLimit, setGroupLimit] = useState(8);
  const [itemLimits, setItemLimits] = useState<Record<string, number>>({});
  const revision = useRef(0);
  const graphRef = useRef<HTMLDivElement>(null);
  const directoryRef = useRef<HTMLElement>(null);
  const agentLabel = MEMORY_AGENTS.find((a) => a.id === agent)!.label;
  const reading = useMemo(
    () =>
      snapshot ? memoryReading(snapshot) : { files: [], items: [], groups: [] },
    [snapshot],
  );
  const scopedGroups = useMemo(
    () => memoryReadingScope(reading.groups, view.fileId, view.groupId),
    [reading, view.fileId, view.groupId],
  );
  const count = scopedGroups.reduce(
    (sum, group) => sum + group.items.length,
    0,
  );
  const selectedNode = snapshot?.nodes.find(
    (node) => node.id === view.selectedId,
  );
  const selectedItem = reading.items.find(
    (item) => item.node.id === view.selectedId,
  );
  const selectedFile = reading.files.find(
    (file) => file.document.id === selectedNode?.documentId,
  );
  const activeFile = reading.files.find(
    (file) => file.document.id === view.fileId,
  );
  const activeGroup = reading.groups.find((group) => group.id === view.groupId);
  const graph = useMemo(
    () =>
      snapshot
        ? memoryOverviewGraph(snapshot, scopedGroups, page, width)
        : undefined,
    [snapshot, scopedGroups, page, width],
  );
  const related =
    snapshot?.edges.filter(
      (edge) =>
        edge.kind === "reference" &&
        (edge.from === view.selectedId || edge.to === view.selectedId),
    ) || [];

  const load = async (mode?: "project" | "memory") => {
    const request = ++revision.current;
    setBusy(true);
    setError("");
    try {
      const result = mode
        ? await api.chooseMemoryDirectory(agent, mode)
        : await api.memories(agent);
      if (request !== revision.current || !result || result.agent !== agent)
        return;
      setSnapshot(result);
      const next = memoryReading(result);
      setView((current) => {
        const fileId = result.documents.some((d) => d.id === current.fileId)
          ? current.fileId
          : "";
        const candidates = next.items.filter(
          (item) => !fileId || item.node.documentId === fileId,
        );
        const selectedId = result.nodes.some(
          (node) =>
            node.id === current.selectedId &&
            (!fileId || node.documentId === fileId),
        )
          ? current.selectedId
          : (
              candidates.find((item) => item.file.role === "topic") ||
              candidates[0]
            )?.node.id ||
            result.documents[0]?.rootId ||
            "";
        return { ...current, fileId, selectedId, groupId: "" };
      });
    } catch (e) {
      if (request === revision.current) setError(message(e));
    } finally {
      if (request === revision.current) setBusy(false);
    }
  };
  useEffect(() => {
    setSnapshot(undefined);
    setView(initialView);
    setPage(0);
    setGroupLimit(8);
    setItemLimits({});
    void load();
    return () => {
      revision.current++;
    };
  }, [api, agent]);
  useEffect(() => {
    setPage(0);
    setGroupLimit(8);
    setItemLimits({});
  }, [view.fileId, view.groupId]);
  useEffect(() => {
    const element = graphRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) =>
      setWidth(Math.max(200, entries[0].contentRect.width)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [view.mode, !!snapshot?.documents.length, error]);
  const selectNode = (node: MemoryNode) => {
    const target = reading.items.find((item) => item.node.id === node.id);
    setView((current) => ({
      ...current,
      selectedId: node.id,
      fileId:
        current.fileId && current.fileId !== node.documentId
          ? ""
          : current.fileId,
      groupId:
        current.groupId && target?.groupId !== current.groupId
          ? ""
          : current.groupId,
    }));
  };
  const selectFile = (file: MemoryReadingFile) =>
    setView((current) => ({
      ...current,
      fileId: file.document.id,
      selectedId: file.document.rootId,
      groupId: "",
    }));
  const locateSource = () => {
    if (!selectedFile) return;
    const button = directoryRef.current?.querySelector<HTMLButtonElement>(
      `[data-document="${selectedFile.document.id}"]`,
    );
    button?.closest("details")?.setAttribute("open", "");
    button?.scrollIntoView({ behavior: "auto", block: "nearest" });
    button?.focus({ preventScroll: true });
  };
  const all = () =>
    setView((current) => ({ ...current, fileId: "", groupId: "" }));
  const tabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = MEMORY_AGENTS.findIndex((a) => a.id === agent);
    const next =
      event.key === "Home"
        ? MEMORY_AGENTS[0]
        : event.key === "End"
          ? MEMORY_AGENTS.at(-1)!
          : MEMORY_AGENTS[
              (index +
                (event.key === "ArrowRight" ? 1 : -1) +
                MEMORY_AGENTS.length) %
                MEMORY_AGENTS.length
            ];
    setAgent(next.id);
    event.currentTarget
      .querySelector<HTMLButtonElement>(`[data-agent="${next.id}"]`)
      ?.focus();
  };
  const card = (item: MemoryReadingItem) => (
    <button
      type="button"
      key={item.node.id}
      className="memory-reading-card"
      data-entry={item.node.id}
      aria-pressed={view.selectedId === item.node.id}
      onClick={() => selectNode(item.node)}
    >
      <strong>{item.title}</strong>
      {item.summary !== item.title && (
        <span className="memory-card-summary">{item.summary}</span>
      )}
      {item.context.length > 1 && (
        <span className="memory-card-context">
          {item.context.slice(1).join(" / ")}
        </span>
      )}
      <span className="memory-card-source">
        <span>{item.file.pathLabel}</span>
        <small>原文 {range(item.node)} 行</small>
      </span>
    </button>
  );
  return (
    <div className="memory-page">
      <div className="page-heading">
        <div>
          <h1>记忆工作台</h1>
          <p>跨文件阅读记忆，随时对照来源与原文。</p>
        </div>
        <span className="memory-local">
          <Network size={15} /> 本地只读
        </span>
      </div>
      <div
        className="memory-tabs"
        role="tablist"
        aria-label="记忆来源 Agent"
        onKeyDown={tabKey}
      >
        {MEMORY_AGENTS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`memory-tab-${item.id}`}
            data-agent={item.id}
            tabIndex={agent === item.id ? 0 : -1}
            aria-selected={agent === item.id}
            aria-controls="memory-panel"
            className={agent === item.id ? "active" : ""}
            onClick={() => {
              if (agent !== item.id) setAgent(item.id);
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      <section
        id="memory-panel"
        role="tabpanel"
        aria-labelledby={`memory-tab-${agent}`}
        aria-busy={busy}
      >
        <div className="memory-toolbar">
          <span>
            {snapshot
              ? `${snapshot.documents.length} 个来源文件 · ${reading.items.length} 段原文内容`
              : `${agentLabel} 的本地记忆`}
          </span>
          <div className="memory-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void load("project")}
            >
              <FolderOpen size={15} /> 选择项目
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void load("memory")}
            >
              <FileText size={15} /> 添加记忆目录
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void load()}
            >
              <RefreshCw size={15} className={busy ? "spin" : ""} /> 刷新
            </button>
          </div>
        </div>
        {busy && (
          <div className="memory-status" role="status">
            <Loader2 size={18} className="spin" /> 正在读取 {agentLabel}{" "}
            的本地文档…
          </div>
        )}
        {error && (
          <div className="notice amber" role="alert">
            <div>
              <strong>记忆读取失败</strong>
              <p>{error}</p>
            </div>
          </div>
        )}
        {!busy && !error && snapshot && !snapshot.documents.length && (
          <div className="memory-empty">
            <GitBranch size={32} />
            <h2>未发现 {agentLabel} 的可读取内容</h2>
            <p>
              {snapshot.mode === "demo"
                ? "浏览器演示不读取本机记忆。请在桌面本地模式使用。"
                : "可选择项目读取指令文件，或添加实际保存记忆的目录。"}
            </p>
          </div>
        )}
        {!error && snapshot && snapshot.documents.length > 0 && (
          <div className="memory-workspace">
            <nav
              className="memory-directory"
              aria-label="记忆文件目录"
              ref={directoryRef}
            >
              <div className="memory-directory-heading">
                <span>文件目录</span>
                <span>{reading.files.length} 个</span>
              </div>
              <button
                className="memory-all"
                type="button"
                aria-pressed={!view.fileId && !view.groupId}
                onClick={all}
              >
                <strong>全部记忆</strong>
                <span>{reading.items.length}</span>
              </button>
              {[
                { label: "总览与索引", roles: ["overview", "index"] },
                { label: "主题内容与指令", roles: ["topic", "instruction"] },
              ].map((group) => {
                const files = reading.files.filter((file) =>
                  group.roles.includes(file.role),
                );
                return (
                  files.length > 0 && (
                    <details
                      open
                      className="memory-file-group"
                      key={group.label}
                    >
                      <summary>
                        {group.label} · {files.length}
                      </summary>
                      <div className="memory-file-list">
                        {files.map((file) => (
                          <button
                            type="button"
                            className="memory-file"
                            key={file.document.id}
                            data-document={file.document.id}
                            data-linked={
                              selectedFile?.document.id === file.document.id
                            }
                            aria-pressed={view.fileId === file.document.id}
                            onClick={() => selectFile(file)}
                            title={file.document.path}
                          >
                            <strong>{file.label}</strong>
                            <code>{file.pathLabel}</code>
                            <span>
                              <small>
                                {file.roleLabel} · {file.count} 项
                              </small>
                              {selectedFile?.document.id ===
                                file.document.id && (
                                <small className="memory-current-source">
                                  当前出处
                                </small>
                              )}
                            </span>
                          </button>
                        ))}
                      </div>
                    </details>
                  )
                );
              })}
            </nav>
            <section
              className="memory-center"
              aria-label={`${agentLabel} 记忆内容`}
            >
              <div className="memory-center-heading">
                <div>
                  <strong>
                    {activeGroup?.label || activeFile?.label || "全部记忆"}
                  </strong>
                  <span>
                    {count} 段内容
                    {!activeFile &&
                      ` · 跨 ${new Set(scopedGroups.flatMap((group) => group.items.map((item) => item.node.documentId))).size} 个文件`}
                  </span>
                </div>
                <p>
                  {activeFile
                    ? activeFile.pathLabel
                    : "按原文章节归类阅读；点击文件可聚焦来源。"}
                  {activeGroup && (
                    <>
                      {" "}
                      ·{" "}
                      <button
                        className="memory-text-button"
                        onClick={() =>
                          setView((current) => ({ ...current, groupId: "" }))
                        }
                      >
                        返回所有主题
                      </button>
                    </>
                  )}
                </p>
                <div className="memory-view-switch" aria-label="浏览方式">
                  <button
                    type="button"
                    aria-pressed={view.mode === "read"}
                    onClick={() =>
                      setView((current) => ({ ...current, mode: "read" }))
                    }
                  >
                    内容总览
                  </button>
                  <button
                    type="button"
                    aria-pressed={view.mode === "map"}
                    onClick={() =>
                      setView((current) => ({ ...current, mode: "map" }))
                    }
                  >
                    关系地图
                  </button>
                </div>
              </div>
              {view.mode === "read" ? (
                <div className="memory-reading">
                  {scopedGroups.length ? (
                    scopedGroups.slice(0, groupLimit).map((group) => (
                      <section className="memory-reading-group" key={group.id}>
                        <header>
                          <h2>{group.label}</h2>
                          <span>
                            {group.items.length} 项 ·{" "}
                            {
                              new Set(
                                group.items.map((item) => item.node.documentId),
                              ).size
                            }{" "}
                            个来源
                          </span>
                        </header>
                        <div className="memory-reading-cards">
                          {group.items
                            .slice(0, itemLimits[group.id] || 2)
                            .map(card)}
                        </div>
                        {group.items.length > (itemLimits[group.id] || 2) && (
                          <button
                            className="memory-expand"
                            onClick={() =>
                              setItemLimits((current) => ({
                                ...current,
                                [group.id]: (current[group.id] || 2) + 8,
                              }))
                            }
                          >
                            展开更多内容（剩余{" "}
                            {group.items.length - (itemLimits[group.id] || 2)}{" "}
                            项）
                            <ChevronRight size={14} />
                          </button>
                        )}
                      </section>
                    ))
                  ) : (
                    <div className="memory-no-content">
                      此文件没有可拆分的段落。右侧可直接查看文件原文及元信息。
                    </div>
                  )}
                  {scopedGroups.length > groupLimit && (
                    <button
                      className="secondary"
                      onClick={() => setGroupLimit((current) => current + 8)}
                    >
                      继续查看其他主题（{scopedGroups.length - groupLimit}）
                    </button>
                  )}
                </div>
              ) : (
                <div className="memory-map-view">
                  <div className="memory-map-heading">
                    <span>跨文件内容关系</span>
                    <div className="memory-pagination">
                      <button
                        className="icon-button"
                        aria-label="上一组记忆"
                        disabled={!graph || graph.page === 0}
                        onClick={() => setPage((graph?.page || 0) - 1)}
                      >
                        <ChevronLeft size={16} />
                      </button>
                      <span>
                        {(graph?.page || 0) + 1} / {graph?.pages || 1}
                      </span>
                      <button
                        className="icon-button"
                        aria-label="下一组记忆"
                        disabled={!graph || graph.page + 1 >= graph.pages}
                        onClick={() => setPage((graph?.page || 0) + 1)}
                      >
                        <ChevronRight size={16} />
                      </button>
                    </div>
                  </div>
                  <div
                    className="memory-canvas"
                    ref={graphRef}
                    style={{ height: graph?.height || 300 }}
                  >
                    <svg
                      className="memory-wires"
                      viewBox={`0 0 ${width} ${graph?.height || 300}`}
                      aria-hidden="true"
                    >
                      {graph?.edges.map((edge, i) => {
                        const a = graph.nodes.find(
                            (node) => node.id === edge.from,
                          )!,
                          b = graph.nodes.find((node) => node.id === edge.to)!;
                        const start = a.y + a.height / 2,
                          end = b.y - b.height / 2,
                          rail = b.x - b.width / 2 - 7;
                        const d =
                          edge.kind === "contains" &&
                          a.x === b.x &&
                          b.y - a.y > 160
                            ? `M ${a.x} ${start} Q ${rail} ${start + 15} ${rail} ${start + 30} L ${rail} ${b.y} L ${b.x - b.width / 2} ${b.y}`
                            : `M ${a.x} ${start} C ${a.x} ${(start + end) / 2}, ${b.x} ${(start + end) / 2}, ${b.x} ${end}`;
                        return (
                          <path
                            key={`${edge.from}-${edge.to}-${i}`}
                            d={d}
                            className={`${edge.kind === "reference" ? "reference" : ""} ${edge.from === view.selectedId || edge.to === view.selectedId ? "selected" : ""}`}
                          />
                        );
                      })}
                    </svg>
                    {graph?.nodes.map((node) => (
                      <button
                        type="button"
                        key={node.id}
                        className={`memory-node ${node.kind}`}
                        style={{
                          left: node.x,
                          top: node.y,
                          width: node.width,
                          height: node.height,
                        }}
                        title={node.title}
                        aria-pressed={node.id === view.selectedId}
                        onClick={() => {
                          if (node.kind === "root") all();
                          else if (node.kind === "group")
                            setView((current) => ({
                              ...current,
                              groupId: node.groupId!,
                              mode: "read",
                            }));
                          else if (node.node) selectNode(node.node);
                        }}
                      >
                        <strong>
                          {node.kind === "root"
                            ? `${agentLabel} 的记忆`
                            : node.title}
                        </strong>
                        <small>{node.subtitle}</small>
                      </button>
                    ))}
                  </div>
                  <div className="memory-legend">
                    <span>
                      <i /> 按原文章节归类
                    </span>
                    <span>
                      <i className="reference" /> 显式文档引用
                    </span>
                    <span>分类节点可打开全部内容</span>
                  </div>
                </div>
              )}
            </section>
            <aside
              className="memory-detail"
              aria-label="记忆详情"
              aria-live="polite"
            >
              <div className="memory-detail-heading">
                <span>{selectedItem ? "内容解读" : "文件说明"}</span>
                {selectedFile && (
                  <span className="memory-node-kind">
                    {selectedFile.roleLabel}
                  </span>
                )}
              </div>
              {selectedFile && selectedNode ? (
                <>
                  <h2>{selectedItem?.title || selectedFile.label}</h2>
                  {selectedItem ? (
                    <>
                      <span className="memory-detail-label">
                        阅读整理 · 保留原文措辞
                      </span>
                      <div className="memory-readable-text">
                        {selectedItem.text}
                      </div>
                      {selectedItem.context.length > 0 && (
                        <div className="memory-context">
                          <span>所属章节</span>
                          <p>{selectedItem.context.join(" / ")}</p>
                        </div>
                      )}
                      {selectedItem.when && (
                        <div className="memory-context">
                          <span>原文中的适用场景</span>
                          <p>{selectedItem.when}</p>
                        </div>
                      )}
                      {selectedItem.example && (
                        <div className="memory-example">
                          <span>原文中的示例</span>
                          <p>{selectedItem.example}</p>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <p className="memory-file-purpose">
                        {selectedFile.purpose}
                      </p>
                      <p className="memory-muted">
                        已读取 {selectedFile.count}{" "}
                        段内容，可在中间直接浏览。条数按原文段落统计，同一内容可能在多个文件中出现。
                      </p>
                    </>
                  )}
                  <div className="memory-origin">
                    <span>对应的来源文件</span>
                    <button
                      type="button"
                      className="memory-source-link"
                      onClick={locateSource}
                    >
                      {selectedFile.pathLabel} ↗
                    </button>
                    <small>
                      原文第 {range(selectedNode)} 行 · 点击定位左侧文件
                    </small>
                  </div>
                  <details className="memory-original" open>
                    <summary>{selectedItem ? "原文对照" : "文件原文"}</summary>
                    <pre className="memory-content">
                      {selectedItem
                        ? selectedNode.content
                        : (selectedFile.document.sourceText ??
                          selectedFile.document.frontmatter ??
                          "此来源未返回完整文本，请刷新后重试。")}
                    </pre>
                  </details>
                  <dl className="memory-metadata">
                    <dt>完整来源路径</dt>
                    <dd>{selectedFile.document.path}</dd>
                    <dt>内容类型 / 范围</dt>
                    <dd>
                      {MEMORY_KIND_LABELS[selectedFile.document.kind]} ·{" "}
                      {selectedFile.document.scope}
                    </dd>
                    <dt>文件修改时间</dt>
                    <dd>
                      {selectedFile.document.modified
                        ? new Date(
                            selectedFile.document.modified,
                          ).toLocaleString("zh-CN")
                        : "未知"}
                    </dd>
                  </dl>
                  {selectedFile.document.frontmatter && (
                    <details className="memory-frontmatter">
                      <summary>文档元信息与触发条件</summary>
                      <pre className="memory-content">
                        {selectedFile.document.frontmatter}
                      </pre>
                    </details>
                  )}
                  {related.length > 0 && (
                    <div className="memory-references">
                      <strong>原文引用关系</strong>
                      {related.map((edge, i) => {
                        const other = snapshot.nodes.find(
                          (node) =>
                            node.id ===
                            (edge.from === view.selectedId
                              ? edge.to
                              : edge.from),
                        );
                        return (
                          other && (
                            <button
                              className="secondary"
                              key={i}
                              onClick={() => selectNode(other)}
                            >
                              {edge.from === view.selectedId
                                ? "引用"
                                : "被引用于"}{" "}
                              · {other.title}
                              <ChevronRight size={14} />
                            </button>
                          )
                        );
                      })}
                    </div>
                  )}
                </>
              ) : (
                <p className="memory-muted">
                  选择一条内容，查看阅读整理和对应原文。
                </p>
              )}
            </aside>
          </div>
        )}
        {snapshot && !busy && (
          <details className="memory-sources">
            <summary>
              读取范围与状态 · {snapshot.documents.length} 个文档
              {snapshot.warnings.length
                ? ` · ${snapshot.warnings.length} 条提示`
                : ""}
            </summary>
            <p>
              阅读整理只移除 Markdown
              格式标记，保留原文措辞；场景、示例仅在原文明确提供时展示。归类依据原文章节，不自动推断事实关系。
            </p>
            <p>
              仅扫描默认目录、所选项目入口和手动目录；文件存在不代表 Agent
              当前已加载它。自定义配置、远端记忆和聊天全文不在默认读取范围。
            </p>
            {snapshot.project && <p>所选项目：{snapshot.project}</p>}
            {snapshot.warnings.map((warning, i) => (
              <p key={i} className="memory-warning">
                {warning}
              </p>
            ))}
            <ul>
              {snapshot.roots.map((r, i) => (
                <li key={i}>
                  <code>{r.path}</code>
                  <span>
                    {r.status === "read"
                      ? "已检查"
                      : r.status === "missing"
                        ? "未发现"
                        : "无法读取"}
                    {r.message && ` · ${r.message}`}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </div>
  );
}
