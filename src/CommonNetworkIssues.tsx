import { useState } from "react";
import { BookOpen, ChevronDown, ChevronRight, Search } from "lucide-react";
import { COMMON_NETWORK_ISSUES } from "./shared/common-issues";

export default function CommonNetworkIssues({
  onTriage,
}: {
  onTriage: () => void;
}) {
  const [query, setQuery] = useState("");
  const term = query.trim().toLowerCase();
  const issues = COMMON_NETWORK_ISSUES.filter((issue) =>
    [issue.symptom, issue.classification, issue.explanation, ...issue.checks]
      .join(" ")
      .toLowerCase()
      .includes(term),
  );

  return (
    <section
      className="common-issues panel"
      aria-labelledby="common-issues-title"
    >
      <div className="common-issues-heading">
        <div>
          <h2 id="common-issues-title">
            <BookOpen size={19} />
            常见问题与自查方案
          </h2>
          <p>找到与你相似的现象，展开后按步骤检查，再回到原工具复测。</p>
        </div>
        <div className="search-field">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            aria-label="搜索常见网络问题"
            placeholder="搜索现象或错误码，如 407、DNS"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>
      <p className="common-issues-count" role="status">
        {term
          ? `找到 ${issues.length} 项相关问题`
          : `${issues.length} 类常见问题 · 点击查看自查步骤`}
      </p>
      <div className="common-issue-list">
        {issues.map((issue) => (
          <details key={issue.id} className="common-issue-row">
            <summary>
              <span>
                <small>{issue.classification}</small>
                <strong>{issue.symptom}</strong>
              </span>
              <ChevronDown size={16} aria-hidden="true" />
            </summary>
            <div className="common-issue-body">
              <p>{issue.explanation}</p>
              <h3>按顺序自查</h3>
              <ol>
                {issue.checks.map((check) => (
                  <li key={check}>{check}</li>
                ))}
              </ol>
              <div className="common-issue-outcome">
                <strong>如何确认恢复</strong>
                <p>{issue.expected}</p>
              </div>
              <p>
                <strong>仍未解决：</strong>
                {issue.unresolved}
              </p>
              <div className="common-issue-footer">
                <small>对应排查：{issue.step}</small>
                <button className="text-button" onClick={onTriage}>
                  打开顺序排查
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
          </details>
        ))}
      </div>
      {!issues.length && (
        <div className="common-issues-empty">
          <p>没有找到匹配的问题，试试其他现象或错误码，也可以打开顺序排查。</p>
          <button className="text-button" onClick={() => setQuery("")}>
            查看全部问题
          </button>
          <button className="text-button" onClick={onTriage}>
            打开顺序排查
          </button>
        </div>
      )}
    </section>
  );
}
