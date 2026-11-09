import { useEffect, useState } from "react";
import { textPreviewPage } from "./shared/text-preview";
import type { DesktopAPI } from "./shared/types";
import type { ContextArchive, ContextPage } from "./shared/history";

export default function HistoryContext({
  api,
  archive,
  busy,
  conversation,
  exported,
  onExport,
}: {
  api: DesktopAPI;
  archive: ContextArchive;
  busy: boolean;
  conversation?: { text: string; count: number };
  exported?: string;
  onExport: () => void;
}) {
  const [page, setPage] = useState<ContextPage>(),
    [offsets, setOffsets] = useState<number[]>([0]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [reviewed, setReviewed] = useState(false),
    [raw, setRaw] = useState(!conversation),
    [textPage, setTextPage] = useState(0);
  const offset = offsets.at(-1) || 0;
  const conversationPage = textPreviewPage(conversation?.text || "", textPage);
  const textStart = conversationPage.start;
  useEffect(() => {
    if (!raw) return;
    let active = true;
    setLoading(true);
    setPage(undefined);
    setError("");
    void api
      .readHandoffContext?.(archive.id, offset)
      .then(
        (v) => {
          if (active) setPage(v);
        },
        (e) => {
          if (active) setError(String(e.message));
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, archive.id, offset, raw]);
  return (
    <section className="handoff-transcript" aria-label="完整上下文">
      <h3>
        完整原始上下文 · {(archive.bytes / 1024 / 1024).toFixed(2)} MB ·{" "}
        {archive.records.toLocaleString()} 条原始事件
      </h3>
      <p>
        按片段核对历史。完整原始上下文可选导出，不影响复制对话文字；原始记录与附件未经脱敏，导出前需人工检查。
      </p>
      {conversation && (
        <div className="handoff-actions">
          <button
            className="secondary"
            aria-pressed={!raw}
            onClick={() => setRaw(false)}
          >
            对话正文（{conversation.count} 条消息）
          </button>
          <button
            className="secondary"
            aria-pressed={raw}
            onClick={() => setRaw(true)}
          >
            原始记录
          </button>
          {!raw && (
            <p>
              下面按页显示全部已提取的用户请求与 AI
              回复，复制时携带所有页；已知敏感信息已脱敏。
            </p>
          )}
        </div>
      )}
      {!archive.complete && (
        <p role="alert">正文仍有缺口：{archive.warnings.join("；")}</p>
      )}
      {archive.attachmentsComplete === false && (
        <p role="alert">
          有 {archive.missingAttachments || 0}{" "}
          项历史附件原件不可取得；导出清单保留了具体缺口。
        </p>
      )}
      {raw && error && <p role="alert">{error}</p>}
      {raw && loading ? (
        <p role="status">正在读取片段…</p>
      ) : (
        <pre>
          {raw
            ? page?.text || "尚无正文片段。"
            : conversationPage.text ||
              "未提取到可识别的用户请求或 AI 回复文字。"}
        </pre>
      )}
      <div className="handoff-actions">
        <button
          className="secondary"
          disabled={raw ? loading || offsets.length < 2 : textPage === 0}
          onClick={() =>
            raw ? setOffsets((v) => v.slice(0, -1)) : setTextPage((v) => v - 1)
          }
        >
          上一片段
        </button>
        <span>
          {raw ? (
            <>
              位置 {offset.toLocaleString()} / {archive.bytes.toLocaleString()}{" "}
              字节
            </>
          ) : (
            <>
              位置 {textStart.toLocaleString()} /{" "}
              {(conversation?.text.length || 0).toLocaleString()} 字符
            </>
          )}
        </span>
        <button
          className="secondary"
          disabled={
            raw
              ? loading || page?.nextOffset === undefined
              : conversationPage.current + 1 >= conversationPage.pages
          }
          onClick={() =>
            raw
              ? setOffsets((v) => [...v, page!.nextOffset!])
              : setTextPage((v) => v + 1)
          }
        >
          下一片段
        </button>
      </div>
      <label className="handoff-check">
        <input
          type="checkbox"
          checked={reviewed}
          disabled={busy}
          onChange={(e) => setReviewed(e.target.checked)}
        />
        已确认导出原始上下文未经脱敏，仅保存到本机所选目录
      </label>
      <button
        className="secondary"
        disabled={busy || !reviewed}
        onClick={onExport}
      >
        导出完整上下文
      </button>
      {exported && (
        <p role="status">
          已导出：<code>{exported}</code>。附件原件覆盖状态见
          manifest；仅复制说明不会上传文件。
        </p>
      )}
    </section>
  );
}
