import { useEffect, useRef, useState } from "react";
import { FilePlus2, Loader2, Paperclip, RefreshCw } from "lucide-react";
import type { DesktopAPI } from "./shared/types";
import type { HandoffOptions } from "./shared/handoff";
import {
  attachmentSize,
  type HandoffAttachmentScan,
  type HandoffAttachmentSelection,
} from "./shared/handoff-attachments";

export default function HandoffAttachments({
  api,
  session,
  active,
  busy,
  options,
  onChange,
  onValidityChange,
  run,
}: {
  api: DesktopAPI;
  session: string;
  active: boolean;
  busy: boolean;
  options: HandoffOptions;
  onChange: (value: HandoffAttachmentSelection) => void;
  onValidityChange: (valid: boolean) => void;
  run: (action: () => Promise<void>) => Promise<void>;
}) {
  const [scan, setScan] = useState<HandoffAttachmentScan>();
  const [error, setError] = useState("");
  const attempted = useRef(false);
  const apply = (value: HandoffAttachmentScan) => {
    const excluded = new Set(
      scan?.entries
        .filter(
          (e) => e.status === "ready" && !options.attachmentIds?.includes(e.id),
        )
        .map((e) => `${e.sha256}:${e.messageId}:${e.name}`),
    );
    setScan(value);
    setError("");
    const ids = value.entries
      .filter(
        (e) =>
          e.status === "ready" &&
          !excluded.has(`${e.sha256}:${e.messageId}:${e.name}`),
      )
      .map((e) => e.id);
    onChange({
      attachmentScanToken: value.token,
      attachmentIds: ids,
      allowPartialAttachments: false,
      ...(!ids.length ? { packAttachments: false } : {}),
    });
  };
  const refresh = () =>
    run(async () => {
      setError("");
      // Hide the old list while rescanning: a failed rescan must never leave stale export choices.
      setScan(undefined);
      onChange({
        packAttachments: false,
        attachmentIds: [],
        attachmentScanToken: undefined,
        allowPartialAttachments: false,
      });
      try {
        apply(await api.scanHandoffAttachments(session));
      } catch {
        setError(
          "附件识别未完成，不能确认是否有附件。可重试，或继续仅复制文字。",
        );
      }
    });
  useEffect(() => {
    if (!active || busy || attempted.current) return;
    attempted.current = true;
    void refresh();
  }, [active, busy, session]);
  const available = scan?.entries.filter((e) => e.status === "ready") || [];
  const unavailable = scan?.entries.filter((e) => e.status !== "ready") || [];
  const partial = !!scan && (!scan.complete || unavailable.length > 0);
  const selected = available.filter((e) =>
    options.attachmentIds?.includes(e.id),
  );
  useEffect(() => {
    onValidityChange(
      !options.packAttachments ||
        (!!scan &&
          selected.length > 0 &&
          (!partial || !!options.allowPartialAttachments)),
    );
  }, [
    options.packAttachments,
    options.allowPartialAttachments,
    options.attachmentIds,
    scan,
  ]);
  return (
    <section className="handoff-attachments" aria-label="附件接力">
      <div className="handoff-attachments-heading">
        <div>
          <h3>
            <Paperclip size={17} /> 附件接力 <span>可选</span>
          </h3>
        </div>
        <div className="handoff-actions">
          <button
            type="button"
            className="handoff-read"
            disabled={busy}
            onClick={() => void refresh()}
            aria-label="重新识别附件"
          >
            <RefreshCw size={14} />
            重新识别
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                try {
                  const value = await api.addHandoffAttachments(session);
                  if (value) apply(value);
                } catch {
                  setScan(undefined);
                  onChange({
                    packAttachments: false,
                    attachmentIds: [],
                    attachmentScanToken: undefined,
                  });
                  setError("补充文件未完成，请重新识别后重试。");
                }
              })
            }
          >
            <FilePlus2 size={14} />
            补充文件
          </button>
        </div>
      </div>
      {!scan && !error && (
        <p className="handoff-attachment-status" role="status">
          <Loader2 size={14} className="spin" />
          {busy ? "正在识别附件…" : "等待识别附件…"}
        </p>
      )}
      {error && (
        <p className="notice amber" role="alert">
          {error}
        </p>
      )}
      {scan && (
        <>
          <div className="handoff-attachment-status" role="status">
            <strong>可打包 {available.length} 条</strong>
            <span>
              {attachmentSize(available.reduce((n, e) => n + e.size, 0))}
            </span>
            {unavailable.length > 0 && (
              <span className="handoff-attachment-problem">
                无法恢复 {unavailable.length} 条
              </span>
            )}
            {!scan.complete && (
              <span className="handoff-attachment-problem">扫描不完整</span>
            )}
          </div>
          {!scan.entries.length && scan.complete && (
            <p className="handoff-attachment-hint">
              未发现当前支持格式的附件记录。可直接复制文字；如有遗漏，可补充文件。
            </p>
          )}
          {scan.warnings.map((warning, i) => (
            <p key={i} className="handoff-attachment-problem">
              {warning}
            </p>
          ))}
          <label className="handoff-check handoff-pack-toggle">
            <input
              type="checkbox"
              checked={!!options.packAttachments}
              disabled={busy || !available.length}
              onChange={(e) =>
                onChange({
                  packAttachments: e.target.checked,
                  allowPartialAttachments: false,
                })
              }
            />
            <span>
              <strong>同时打包附件</strong>
              <small>
                {options.packAttachments
                  ? "导出 ZIP 后，再复制说明与附件包路径。"
                  : "未开启时只复制交接说明，图片和文档不会随文字传递。"}
              </small>
            </span>
          </label>
          {options.packAttachments && available.length > 1 && (
            <div className="handoff-attachment-selection">
              <span>选择要携带的附件</span>
              <button
                type="button"
                className="handoff-read"
                disabled={busy}
                onClick={() =>
                  onChange({ attachmentIds: available.map((e) => e.id) })
                }
              >
                全选
              </button>
              <button
                type="button"
                className="handoff-read"
                disabled={busy}
                onClick={() => onChange({ attachmentIds: [] })}
              >
                取消全选
              </button>
            </div>
          )}
          {!options.packAttachments && unavailable.length > 0 && (
            <details className="handoff-attachment-issues">
              <summary>查看无法恢复的附件（{unavailable.length}）</summary>
              <ul>
                {unavailable.map((item) => (
                  <li key={item.id}>
                    <strong>{item.name}</strong>
                    <span>{item.note}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {options.packAttachments && (
            <div className="handoff-attachment-list" aria-label="会话附件清单">
              {scan.entries.map((item) => (
                <label
                  key={item.id}
                  className={`handoff-attachment-row ${item.status !== "ready" ? "unavailable" : ""}`}
                >
                  <input
                    type="checkbox"
                    aria-label={`携带附件 ${item.name}`}
                    disabled={
                      busy ||
                      item.status !== "ready" ||
                      !options.packAttachments
                    }
                    checked={
                      !!options.packAttachments &&
                      item.status === "ready" &&
                      !!options.attachmentIds?.includes(item.id)
                    }
                    onChange={(e) =>
                      onChange({
                        attachmentIds: e.target.checked
                          ? [...(options.attachmentIds || []), item.id]
                          : (options.attachmentIds || []).filter(
                              (id) => id !== item.id,
                            ),
                      })
                    }
                  />
                  <span>
                    <strong title={item.name}>{item.name}</strong>
                    <small>
                      {item.status === "ready"
                        ? `${attachmentSize(item.size)} · ${item.mime}`
                        : item.status === "missing"
                          ? "文件已丢失"
                          : item.status === "unsupported"
                            ? "需手动补充"
                            : "读取失败"}{" "}
                      ·{" "}
                      {item.origin === "manual"
                        ? "手动补充"
                        : `消息 ${item.messageId}`}
                    </small>
                    <small>{item.note}</small>
                  </span>
                </label>
              ))}
            </div>
          )}
          {options.packAttachments && (
            <>
              <p className="handoff-attachment-hint">
                已选 {selected.length} 条 ·{" "}
                {attachmentSize(selected.reduce((n, e) => n + e.size, 0))}
                。相同内容会合并保存，并保留消息对应关系。附件原内容不做脱敏。
              </p>
              {!selected.length && (
                <p className="handoff-attachment-problem" role="alert">
                  请至少选择一个可打包附件，或关闭附件打包。
                </p>
              )}
              {partial && (
                <label className="handoff-check handoff-partial">
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={!!options.allowPartialAttachments}
                    onChange={(e) =>
                      onChange({ allowPartialAttachments: e.target.checked })
                    }
                  />
                  <span>
                    我了解存在无法恢复或未确认的附件，仅导出本次选择的可用部分。
                    <small>
                      缺失说明会保留在交接包中，不会标记为完整接力。
                    </small>
                  </span>
                </label>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
