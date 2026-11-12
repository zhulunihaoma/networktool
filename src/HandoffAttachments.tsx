import { useEffect, useRef, useState } from "react";
import {
  FilePlus2,
  Loader2,
  Paperclip,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
} from "lucide-react";
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
  run,
}: {
  api: DesktopAPI;
  session: string;
  active: boolean;
  busy: boolean;
  options: HandoffOptions;
  onChange: (value: HandoffAttachmentSelection) => void;
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
    });
  };
  const refresh = () =>
    run(async () => {
      setError("");
      // Hide the old list while rescanning: a failed rescan must never leave stale export choices.
      setScan(undefined);
      onChange({
        attachmentIds: [],
        attachmentScanToken: undefined,
        allowPartialAttachments: false,
      });
      try {
        apply(await api.scanHandoffAttachments(session));
      } catch {
        onChange({ packAttachments: false });
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
  const blocked = scan?.entries.filter((e) => e.status === "blocked") || [];
  const unavailable =
    scan?.entries.filter(
      (e) => e.status !== "ready" && e.status !== "blocked",
    ) || [];
  const redacted = scan?.security?.redacted || [];
  const hits = redacted.reduce((n, r) => n + r.hits, 0);
  const partial = !!scan && (!scan.complete || unavailable.length > 0);
  const selected = available.filter((e) =>
    options.attachmentIds?.includes(e.id),
  );
  return (
    <section className="handoff-attachments" aria-label="附件接续">
      <div className="handoff-attachments-heading">
        <div>
          <h3>
            <Paperclip size={17} /> 附件接续 <span>可选</span>
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
            {blocked.length > 0 && (
              <span className="handoff-attachment-blocked">
                已拦截 {blocked.length} 条
              </span>
            )}
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
          {(blocked.length > 0 || redacted.length > 0) && (
            <div
              className={`handoff-leak-guard ${blocked.length ? "warn" : "ok"}`}
              role="status"
              aria-label="防泄露检查"
            >
              {blocked.length ? (
                <ShieldAlert size={18} />
              ) : (
                <ShieldCheck size={18} />
              )}
              <div>
                <strong>
                  {[
                    blocked.length && `已为你拦下 ${blocked.length} 个敏感文件`,
                    redacted.length &&
                      `对 ${redacted.length} 个文件中的 ${hits} 处密钥做了遮盖`,
                  ]
                    .filter(Boolean)
                    .join("，")}
                </strong>
                <small>
                  {blocked.length
                    ? "这些文件像是密钥、证书或登录凭据，带走后可能被别人看到，所以不会放进接续包。"
                    : "接续包里的文字附件已自动遮盖密钥，原文件不受影响。"}
                  {redacted.length > 0 &&
                    blocked.length > 0 &&
                    " 文字附件中的密钥也已自动遮盖，原文件不受影响。"}
                </small>
                {blocked.length > 0 && (
                  <ul>
                    {blocked.map((item) => (
                      <li key={item.id}>
                        <b>{item.name}</b> ·{" "}
                        {scan.security?.blocked.find(
                          (b) => b.name === item.name,
                        )?.reason || "凭据文件"}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
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
              disabled={busy}
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
                  ? "自动携带所选可用附件；没有可用附件时只复制文字，无需导出。"
                  : "有图片或文档需要带走时开启；仅接续文字可跳过。"}
              </small>
            </span>
          </label>
          {options.packAttachments && selected.length > 0 && (
            <div className="handoff-export-guide" role="note">
              <strong>附件留在本机，粘贴文字与路径即可接续</strong>
              <p>
                同机且支持本地文件的工具可按路径读取，无需搬动文件。网页工具或另一台设备需手动上传附件包。
              </p>
            </div>
          )}
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
                  className={`handoff-attachment-row ${item.status === "blocked" ? "blocked" : item.status !== "ready" ? "unavailable" : ""}`}
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
                            : item.status === "blocked"
                              ? "已拒绝打包"
                              : "读取失败"}
                      {item.redactions
                        ? ` · 已遮盖 ${item.redactions} 处密钥`
                        : ""}{" "}
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
              <p className="handoff-selected-size">
                <strong>
                  已选 {selected.length} 条 ·{" "}
                  {attachmentSize(selected.reduce((n, e) => n + e.size, 0))}
                </strong>
                <span>附件大小不计入剪贴板文字量；相同内容会合并保存。</span>
              </p>
              <p className="handoff-attachment-hint">
                文字附件中的已知密钥会自动遮盖；图片、PDF
                等二进制附件保持原样，请检查后导出。
              </p>
              {!selected.length && (
                <p className="handoff-attachment-hint" role="status">
                  本次只复制文字，无需导出附件，可直接生成接续预览。如需携带文件，可选择附件或点击“补充文件”。
                </p>
              )}
              {partial && (
                <p className="handoff-attachment-hint" role="status">
                  无法恢复或未确认的附件会自动跳过，缺失说明会保留在接续内容中，不影响继续。
                </p>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
