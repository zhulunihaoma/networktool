import { useState } from "react";
import { highlightSecurityText } from "./shared/security-highlights";
import {
  CATEGORY_LABELS,
  TOOL_NAMES,
  type Finding,
  type SecurityTool,
} from "./shared/security";

export interface FindingHandlers {
  busy: boolean;
  /** Runs the finding's own action (fix / trust / enable / reveal / recheck). */
  act: (finding: Finding) => void;
  ignore: (finding: Finding, ignored: boolean) => void;
}

const LEVEL_TEXT = { high: "高风险", medium: "中风险", low: "低风险" } as const;

function HighlightedText({ text }: { text: string }) {
  return highlightSecurityText(text).map((part, i) =>
    part.kind ? (
      <mark className={`finding-highlight highlight-${part.kind}`} key={i}>
        {part.text}
      </mark>
    ) : (
      part.text
    ),
  );
}

function toolName(tool: string) {
  return tool === "system"
    ? "系统"
    : (TOOL_NAMES[tool as SecurityTool] ?? tool);
}

/** One problem with a plain-language explanation and exactly one primary action. */
export function FindingCard({
  finding: f,
  handlers,
  ignored,
  open: initiallyOpen,
}: {
  finding: Finding;
  handlers: FindingHandlers;
  ignored?: boolean;
  open?: boolean;
}) {
  const [open, setOpen] = useState(!!initiallyOpen);
  return (
    <div
      className={`finding finding-${f.level}${ignored ? " finding-ignored" : ""}`}
      id={`finding-${f.id}`}
      data-testid="finding"
    >
      <div className="finding-main">
        <span className={`level-tag level-${f.level}`}>
          {LEVEL_TEXT[f.level]}
        </span>
        <div className="finding-text">
          <b>{f.title}</b>
          <small>
            {toolName(f.tool)} · {CATEGORY_LABELS[f.category]}
            {!ignored ? " · 同类合并计分" : ""}
          </small>
        </div>
        <div className="finding-buttons">
          <button
            className="link-button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? "收起" : "详情"}
          </button>
          {ignored ? (
            <button
              className="secondary"
              disabled={handlers.busy}
              onClick={() => handlers.ignore(f, false)}
            >
              恢复提醒
            </button>
          ) : (
            f.action && (
              <button
                className={
                  f.action.kind === "reveal" || f.action.kind === "recheck"
                    ? "secondary"
                    : "primary"
                }
                disabled={handlers.busy}
                onClick={() => handlers.act(f)}
              >
                {f.action.label}
              </button>
            )
          )}
        </div>
      </div>
      {open && (
        <div className="finding-detail">
          <p>
            <b>为什么有风险：</b>
            <HighlightedText text={f.why} />
          </p>
          <div className="finding-evidence">
            <div className="finding-evidence-heading">
              <b>检查到的证据：</b>
              <span className="evidence-legend">
                <span className="legend-sensitive">敏感字段</span>
                <span className="legend-path">文件路径</span>
                <span className="legend-risk">风险配置</span>
              </span>
            </div>
            <pre>
              <HighlightedText text={f.evidence} />
            </pre>
          </div>
          <div>
            <b>怎么处理：</b>
            {f.steps?.length ? (
              <ol>
                {f.steps.map((s) => (
                  <li key={s}>
                    <HighlightedText text={s} />
                  </li>
                ))}
              </ol>
            ) : (
              <span>
                <HighlightedText text={f.fix} />
              </span>
            )}
          </div>
          {f.path && (
            <p className="finding-path">
              <b>相关文件：</b>
              <code className="finding-highlight highlight-path">{f.path}</code>
            </p>
          )}
          {!ignored && (
            <button
              className="link-button"
              disabled={handlers.busy}
              onClick={() => handlers.ignore(f, true)}
            >
              我确认这是有意设置，暂不处理（不再扣分）
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Findings grouped by risk level, with a fix-all entry for automatic fixes. */
export function FindingList({
  findings,
  ignored,
  handlers,
  fixAll,
  expandFirst,
}: {
  findings: Finding[];
  ignored: Finding[];
  handlers: FindingHandlers;
  fixAll: () => void;
  expandFirst?: boolean;
}) {
  const [showIgnored, setShowIgnored] = useState(false);
  const autoFixable = findings.filter((f) => f.action?.kind === "auto_fix");
  return (
    <div className="finding-list">
      {findings.length === 0 ? (
        <div className="finding-empty">
          <b>已检查项目没有待处理的问题</b>
          <p>体检只覆盖已知配置，未检查的部分不代表一定安全。</p>
        </div>
      ) : (
        <>
          {autoFixable.length > 1 && (
            <div className="fix-all">
              <span>其中 {autoFixable.length} 项可以自动修复</span>
              <button
                className="primary"
                disabled={handlers.busy}
                onClick={fixAll}
              >
                一键修复 {autoFixable.length} 项
              </button>
            </div>
          )}
          {findings.map((f, i) => (
            <FindingCard
              key={f.id}
              finding={f}
              handlers={handlers}
              open={expandFirst && i === 0 && f.level === "high"}
            />
          ))}
        </>
      )}
      {ignored.length > 0 && (
        <div className="ignored-block">
          <button
            className="link-button"
            onClick={() => setShowIgnored(!showIgnored)}
          >
            {showIgnored ? "收起" : "查看"}已暂不处理的 {ignored.length} 项
          </button>
          {showIgnored &&
            ignored.map((f) => (
              <FindingCard key={f.id} finding={f} handlers={handlers} ignored />
            ))}
        </div>
      )}
    </div>
  );
}
