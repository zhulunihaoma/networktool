import { useEffect, useState } from "react";
import type { DesktopAPI } from "./shared/types";
import type { ContextArchive, ContextPage } from "./shared/history";

export default function HistoryContext({
  api,
  archive,
  busy,
  exported,
  onExport,
}: {
  api: DesktopAPI;
  archive: ContextArchive;
  busy: boolean;
  exported?: string;
  onExport: () => void;
}) {
  const [page, setPage] = useState<ContextPage>(),
    [offsets, setOffsets] = useState<number[]>([0]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [reviewed, setReviewed] = useState(false);
  const offset = offsets.at(-1) || 0;
  useEffect(() => {
    let active = true;
    setLoading(true);
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
  }, [api, archive.id, offset]);
  return (
    <section className="handoff-transcript" aria-label="完整上下文">
      <h3>
        完整原始上下文 · {(archive.bytes / 1024 / 1024).toFixed(2)} MB ·{" "}
        {archive.records.toLocaleString()} 条记录
      </h3>
      <p>
        按片段浏览，不受 8 MB
        总量限制。原始记录未经脱敏；历史内容仅供核对，不自动执行。
      </p>
      {!archive.complete && (
        <p role="alert">正文仍有缺口：{archive.warnings.join("；")}</p>
      )}
      {archive.attachmentsComplete === false && (
        <p role="alert">
          有 {archive.missingAttachments || 0}{" "}
          项历史附件原件不可取得；导出清单保留了具体缺口。
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {loading ? (
        <p role="status">正在读取片段…</p>
      ) : (
        <pre>{page?.text || "尚无正文片段。"}</pre>
      )}
      <div className="handoff-actions">
        <button
          className="secondary"
          disabled={loading || offsets.length < 2}
          onClick={() => setOffsets((v) => v.slice(0, -1))}
        >
          上一片段
        </button>
        <span>
          位置 {offset.toLocaleString()} / {archive.bytes.toLocaleString()} 字节
        </span>
        <button
          className="secondary"
          disabled={loading || page?.nextOffset === undefined}
          onClick={() => setOffsets((v) => [...v, page!.nextOffset!])}
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
