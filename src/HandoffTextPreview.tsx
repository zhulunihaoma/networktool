import { useEffect, useRef, useState } from "react";
import { textPreviewPage } from "./shared/text-preview";

export default function HandoffTextPreview({
  text,
  className = "handoff-prompt",
}: {
  text: string;
  className?: string;
}) {
  const [page, setPage] = useState(0);
  const value = textPreviewPage(text, page);
  const preview = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (preview.current) preview.current.scrollTop = 0;
  }, [value.current]);
  return (
    <section className="handoff-text-preview" aria-label="接续内容分页预览">
      <pre ref={preview} className={className} tabIndex={0}>
        {value.text || "没有可展示的文字。"}
      </pre>
      {value.pages > 1 && (
        <div className="handoff-actions handoff-pagination">
          <button
            className="secondary"
            disabled={value.current === 0}
            onClick={() => setPage(0)}
          >
            首段
          </button>
          <button
            className="secondary"
            disabled={value.current === 0}
            onClick={() => setPage(value.current - 1)}
          >
            上一片段
          </button>
          <span role="status">
            第 {value.current + 1} / {value.pages} 片段 · 复制包含全部文字
          </span>
          <button
            className="secondary"
            disabled={value.current === value.pages - 1}
            onClick={() => setPage(value.current + 1)}
          >
            下一片段
          </button>
          <button
            className="secondary"
            disabled={value.current === value.pages - 1}
            onClick={() => setPage(value.pages - 1)}
          >
            末段
          </button>
        </div>
      )}
    </section>
  );
}
