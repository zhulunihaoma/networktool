import { useEffect, useState } from "react";
import {
  FolderOpen,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Square,
} from "lucide-react";
import type { DesktopAPI, ExportPreview } from "./shared/types";
import Modal from "./Modal";
import type {
  FileWorkspace,
  FilePolicy,
  FileDecision,
  FileOperation,
  AuditEvent,
  AuditPage,
} from "./shared/assistant";
export const operationLabel = {
  read: "读取",
  write: "修改",
  disclose: "发送模型",
  enumerate: "枚举元数据",
  policy_update: "更新策略",
};
const decisionLabel = { deny: "禁止", ask: "询问", allow: "允许" };
const resultLabel = {
  metadata_only: "仅元数据",
  policy_saved: "策略已保存",
  denied: "策略自检拒绝",
  confirmation_required: "需要单独授权",
  allowed_evaluation: "规则允许 · 未执行访问",
};
export default function FileProtection({
  api,
  onError,
}: {
  api: DesktopAPI;
  onError: (message: string) => void;
}) {
  const [workspace, setWorkspace] = useState<FileWorkspace>();
  const [selected, setSelected] = useState<string>();
  const [resourceId, setResourceId] = useState<string>();
  const [draft, setDraft] =
    useState<Omit<FilePolicy, "revision" | "activeRevision">>();
  const [expected, setExpected] = useState(0);
  const [busy, setBusy] = useState(false),
    [scanning, setScanning] = useState(false);
  const [message, setMessage] = useState("");
  const [audit, setAudit] = useState<AuditPage>({ events: [] });
  const [operation, setOperation] = useState("");
  const [tab, setTab] = useState("policies");
  const [recoveringScan, setRecoveringScan] = useState(false);
  const [report, setReport] = useState<ExportPreview & { scopeId?: string }>();
  const [reportFormat, setReportFormat] = useState<"md" | "json">("md");
  const loadAudit = async (scopeId?: string, op = operation) =>
    setAudit(
      await api.auditEvents({
        scopeId,
        operation: op ? (op as AuditEvent["operation"]) : undefined,
      }),
    );
  useEffect(() => {
    let active = true;
    void api
      .fileWorkspace()
      .then((value) => {
        if (active) {
          setWorkspace(value);
          setSelected(value.scopes[0]?.id);
          if (value.scanning) {
            setScanning(true);
            setBusy(true);
            setRecoveringScan(true);
          }
        }
      })
      .catch((error) => {
        if (active) onError(error.message);
      });
    return () => {
      active = false;
    };
  }, [api]);
  useEffect(() => {
    if (!recoveringScan) return;
    let active = true;
    const timer = setInterval(() => {
      void api
        .fileWorkspace()
        .then((value) => {
          if (!active) return;
          setWorkspace(value);
          if (!value.scanning) {
            setRecoveringScan(false);
            setScanning(false);
            setBusy(false);
            setSelected(value.scopes.at(-1)?.id);
          }
        })
        .catch((error) => {
          if (active) {
            setRecoveringScan(false);
            setScanning(false);
            setBusy(false);
            onError(error.message);
          }
        });
    }, 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api, recoveringScan]);
  useEffect(() => {
    let active = true;
    void api
      .auditEvents({
        scopeId: selected,
        operation: operation
          ? (operation as AuditEvent["operation"])
          : undefined,
      })
      .then((value) => {
        if (active) setAudit(value);
      })
      .catch((error) => {
        if (active) onError(error.message);
      });
    return () => {
      active = false;
    };
  }, [api, selected, operation]);
  const act = async (
    fn: () => Promise<FileWorkspace | undefined>,
    isScan = false,
  ) => {
    setBusy(true);
    setScanning(isScan);
    setMessage("");
    try {
      const next = await fn();
      if (next) {
        setWorkspace(next);
        if (isScan) {
          setSelected(next.scopes.at(-1)?.id);
          setResourceId(undefined);
          setDraft(undefined);
        }
        await loadAudit(isScan ? next.scopes.at(-1)?.id : selected);
      }
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
      setScanning(false);
    }
  };
  const scope = workspace?.scopes.find((s) => s.id === selected);
  const candidate = scope?.candidates.find((c) => c.id === resourceId);
  const savedPolicy = scope?.policies.find((p) => p.resourceId === resourceId);
  const dirty =
    !!draft &&
    (!savedPolicy ||
      (["read", "write", "disclose", "enabled"] as const).some(
        (field) => savedPolicy[field] !== draft[field],
      ));
  const selectCandidate = (id: string) => {
    const old = scope?.policies.find((p) => p.resourceId === id);
    setResourceId(id);
    setExpected(old?.revision || 0);
    setDraft({
      resourceId: id,
      read: old?.read || "deny",
      write: old?.write || "deny",
      disclose: old?.disclose || "deny",
      enabled: old?.enabled ?? true,
    });
    setMessage("");
  };
  return (
    <div className="file-protection">
      <div className="page-heading">
        <div>
          <div className="eyebrow">LOCAL FILE POLICIES</div>
          <h1>文件策略与访问记录</h1>
          <p>先选择范围，再确认敏感候选；读取、修改和发送模型分别设置。</p>
        </div>
        <button
          className="primary"
          disabled={busy}
          onClick={() => void act(() => api.chooseFileScope(), true)}
        >
          <FolderOpen size={16} />
          选择项目或目录
        </button>
      </div>
      <div className="notice amber" role="note">
        <strong>先确认保护边界：</strong>
        本页只校验和记录本助手自己发起的扫描与策略自检，不能监控、阻止或证明第三方工具、终端、其他
        MCP 或远端服务是否读取、修改或发送文件。
      </div>
      <section className="panel file-coverage" aria-label="实际保护覆盖">
        <h2>
          <ShieldCheck size={18} />
          实际覆盖 · 仅策略校验
        </h2>
        <div className="coverage-grid">
          <div>
            <strong>规则</strong>
            <span>
              {workspace?.coverage.ruleEnabled
                ? "已保存至本地校验器"
                : "尚未启用"}
            </span>
          </div>
          <div>
            <strong>事件采集</strong>
            <span>仅助手扫描与自检</span>
          </div>
          <div>
            <strong>工具访问阻止</strong>
            <span>未接入 · 不能阻止</span>
          </div>
          <div>
            <strong>覆盖缺口</strong>
            <span>已有工具、终端与远端</span>
          </div>
        </div>
        <div className="notice amber">
          当前不提供“AI
          未访问”或“全机禁读”的结论。没有采集到记录不代表没有访问；策略自检也不等于系统阻断。
        </div>
        <details className="plain-details">
          <summary>查看覆盖边界</summary>
          {workspace?.coverage.gaps.map((gap) => (
            <p key={gap}>{gap}</p>
          ))}
        </details>
      </section>
      {scanning && (
        <div className="notice">
          <Loader2 size={16} className="spin" />
          正在枚举元数据，最多 10,000 条目 / 10 秒…
          <button
            className="secondary"
            onClick={async () => {
              try {
                await api.cancelFileScan();
              } catch (error) {
                onError((error as Error).message);
              }
            }}
          >
            <Square size={14} />
            停止扫描
          </button>
        </div>
      )}
      <div className="protection-toolbar">
        <label>
          项目范围
          <select
            aria-label="项目范围"
            disabled={busy}
            value={selected || ""}
            onChange={(e) => {
              setSelected(e.target.value);
              setDraft(undefined);
              setResourceId(undefined);
              setMessage("");
            }}
          >
            <option value="">全部记录 / 未选择</option>
            {workspace?.scopes.map((s) => (
              <option value={s.id} key={s.id}>
                {s.name} · {s.candidates.length} 个候选
              </option>
            ))}
          </select>
        </label>
        <div className="segmented">
          {[
            ["policies", "候选与策略"],
            ["audit", "审计时间线"],
            ["alerts", "自检提醒"],
          ].map(([id, label]) => (
            <button
              key={id}
              className={tab === id ? "active" : ""}
              aria-pressed={tab === id}
              onClick={() => setTab(id)}
            >
              {label}
              {id === "alerts"
                ? ` (${workspace?.alerts.filter((a) => a.state === "open").length || 0})`
                : ""}
            </button>
          ))}
        </div>
        <button
          className="secondary"
          disabled={busy || !workspace}
          onClick={async () => {
            setBusy(true);
            try {
              setReport({
                ...(await api.previewFileAudit(selected, reportFormat)),
                scopeId: selected,
              });
            } catch (error) {
              onError((error as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          预览脱敏审计报告
        </button>
      </div>
      {tab === "policies" &&
        (!scope ? (
          <section className="panel empty">
            <h3>选择一个项目开始</h3>
            <p>
              初始扫描只枚举名称、类型和大小，不打开正文。名称只能提示候选，需要你确认。
            </p>
          </section>
        ) : (
          <>
            <section className="panel">
              <div className="section-heading">
                <div>
                  <h2>{scope.name} · 敏感候选</h2>
                  <p>
                    枚举 {scope.examined} 条目 · 跳过 {scope.skipped} 条目 ·{" "}
                    {new Date(scope.scannedAt).toLocaleString("zh-CN")}
                  </p>
                </div>
                <div className="card-actions">
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void act(() => api.chooseSensitiveFile(scope.id))
                    }
                  >
                    添加指定文件
                  </button>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void act(() => api.rescanFileScope(scope.id), true)
                    }
                  >
                    <RefreshCw size={15} />
                    重新扫描
                  </button>
                </div>
              </div>
              {scope.warnings.map((warning) => (
                <div className="notice amber" key={warning}>
                  {warning}
                </div>
              ))}
              <div className="candidate-layout">
                <div className="candidate-list">
                  {scope.candidates.map((file) => {
                    const policy = scope.policies.find(
                      (p) => p.resourceId === file.id,
                    );
                    return (
                      <button
                        key={file.id}
                        className={`candidate-item ${resourceId === file.id ? "selected" : ""}`}
                        disabled={busy}
                        onClick={() => selectCandidate(file.id)}
                      >
                        <strong>{file.relativePath}</strong>
                        <span>
                          {file.reason} · {file.size} 字节
                          {file.unsupported ? " · 多硬链接，暂不支持" : ""}
                        </span>
                        <small>
                          {policy?.enabled
                            ? `规则 v${policy.revision} · 读${decisionLabel[policy.read]} / 改${decisionLabel[policy.write]} / 发${decisionLabel[policy.disclose]}`
                            : "未配置启用规则"}
                        </small>
                      </button>
                    );
                  })}
                  {!scope.candidates.length && (
                    <p className="empty">
                      没有发现已知类型候选；不表示此目录没有敏感文件。
                    </p>
                  )}
                </div>
                {candidate && draft ? (
                  <form
                    className="policy-editor"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void act(async () => {
                        const next = await api.saveFilePolicy(
                          scope.id,
                          draft,
                          expected,
                        );
                        const saved = next.scopes
                          .find((s) => s.id === scope.id)
                          ?.policies.find((p) => p.resourceId === candidate.id);
                        setExpected(saved?.revision || 0);
                        setMessage("策略已保存；第三方工具访问仍未覆盖。");
                        return next;
                      });
                    }}
                  >
                    <h3>{candidate.relativePath}</h3>
                    <p>
                      策略仅供本地校验器使用。放宽读取不会自动允许修改或发送模型。
                    </p>
                    {(["read", "write", "disclose"] as FileOperation[]).map(
                      (op) => (
                        <label key={op}>
                          {operationLabel[op]}
                          <select
                            aria-label={`${operationLabel[op]}策略`}
                            value={draft[op]}
                            disabled={busy}
                            onChange={(event) =>
                              setDraft({
                                ...draft,
                                [op]: event.target.value as FileDecision,
                              })
                            }
                          >
                            {(["deny", "ask", "allow"] as FileDecision[]).map(
                              (value) => (
                                <option key={value} value={value}>
                                  {decisionLabel[value]}
                                </option>
                              ),
                            )}
                          </select>
                        </label>
                      ),
                    )}
                    <label className="policy-enabled">
                      <input
                        type="checkbox"
                        checked={draft.enabled}
                        disabled={busy}
                        onChange={(event) =>
                          setDraft({ ...draft, enabled: event.target.checked })
                        }
                      />
                      在本地校验器启用此规则
                    </label>
                    {dirty ? (
                      <p className="policy-draft-note">
                        当前修改尚未保存；保存后才更新本地校验规则。
                      </p>
                    ) : (
                      <p>已保存 v{expected} · 仅本地校验器确认</p>
                    )}
                    <button
                      className="primary"
                      type="submit"
                      disabled={busy || !dirty}
                    >
                      保存策略
                    </button>
                    <div className="policy-self-check">
                      <strong>使用已保存策略自检</strong>
                      <p>
                        自检只评估请求，不会读、改或发送文件。结果会明确标注来源。
                      </p>
                      {(["read", "write", "disclose"] as FileOperation[]).map(
                        (op) => (
                          <button
                            type="button"
                            className="secondary"
                            key={op}
                            disabled={busy || dirty}
                            onClick={() =>
                              void act(async () => {
                                const result = await api.evaluateFilePolicy(
                                  scope.id,
                                  candidate.id,
                                  op,
                                );
                                setMessage(
                                  `策略自检：${operationLabel[op]}${decisionLabel[result.decision]}。未执行实际文件访问。`,
                                );
                                return result.workspace;
                              })
                            }
                          >
                            {operationLabel[op]}自检
                          </button>
                        ),
                      )}
                    </div>
                  </form>
                ) : (
                  <div className="empty">
                    <h3>选择候选文件设置策略</h3>
                    <p>默认建议三项禁止；需要点击保存才写入本地规则。</p>
                  </div>
                )}
              </div>
            </section>
          </>
        ))}
      {message && (
        <div className="notice" role="status">
          {message}
        </div>
      )}
      {tab === "audit" && (
        <section className="panel">
          <div className="section-heading">
            <div>
              <h2>审计时间线</h2>
              <p>以下仅为助手事件；没有第三方工具读取或模型提交证据。</p>
            </div>
            <select
              aria-label="按操作筛选审计"
              disabled={busy}
              value={operation}
              onChange={(e) => setOperation(e.target.value)}
            >
              <option value="">全部操作</option>
              {Object.entries(operationLabel).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          {audit.events.map((event) => (
            <div className="audit-row" key={event.id}>
              <time>{new Date(event.time).toLocaleString("zh-CN")}</time>
              <div>
                <strong>
                  {operationLabel[event.operation]} ·{" "}
                  {resultLabel[event.result]}
                </strong>
                <p>{event.detail}</p>
                <small>
                  来源：{event.source} · 序号 {event.seq}
                  {event.policyRevision
                    ? ` · 策略 v${event.policyRevision}`
                    : ""}{" "}
                  · 对象{" "}
                  {event.resourceId
                    ? `文件 ${event.resourceId.slice(0, 8)}`
                    : "范围"}
                </small>
              </div>
            </div>
          ))}
          {!audit.events.length && (
            <div className="empty">
              <h3>此筛选下没有记录</h3>
              <p>记录从助手采集开始，不能追溯此前工具访问。</p>
            </div>
          )}
          {audit.nextCursor && (
            <button
              className="secondary"
              onClick={async () => {
                try {
                  const next = await api.auditEvents({
                    scopeId: selected,
                    operation: operation
                      ? (operation as AuditEvent["operation"])
                      : undefined,
                    cursor: audit.nextCursor,
                  });
                  setAudit({
                    events: [...audit.events, ...next.events],
                    nextCursor: next.nextCursor,
                  });
                } catch (error) {
                  onError((error as Error).message);
                }
              }}
            >
              加载更早记录
            </button>
          )}
        </section>
      )}
      {tab === "alerts" && (
        <section className="panel">
          <h2>策略自检提醒</h2>
          <p>
            这些提醒由你点击自检产生，不代表 AI
            已尝试访问；确认提醒不会修改策略，也不表示保护恢复。
          </p>
          {workspace?.alerts
            .filter((alert) => !selected || alert.scopeId === selected)
            .map((alert) => (
              <div className="audit-row" key={alert.id}>
                <span className="badge amber">{alert.ruleId}</span>
                <div>
                  <strong>
                    {operationLabel[alert.operation]}
                    {alert.ruleId === "F06"
                      ? "自检发现文件身份或支持范围变化"
                      : "自检命中禁止策略"}{" "}
                    · {alert.count} 次
                  </strong>
                  <p>
                    来源：policy_validation · 对象别名{" "}
                    {alert.resourceId.slice(0, 8)} · {alert.evidenceIds.length}{" "}
                    条证据
                  </p>
                  <small>
                    {new Date(alert.last).toLocaleString("zh-CN")} ·{" "}
                    {alert.state === "open" ? "未确认" : "已确认 · 未解除规则"}
                  </small>
                </div>
                <button
                  className="secondary"
                  disabled={busy || alert.state === "acknowledged"}
                  onClick={() =>
                    void act(() => api.acknowledgeFileAlert(alert.id))
                  }
                >
                  {alert.state === "open" ? "确认提醒" : "已确认"}
                </button>
              </div>
            ))}
          {!workspace?.alerts.some(
            (alert) => !selected || alert.scopeId === selected,
          ) && (
            <div className="empty">
              <h3>没有策略自检提醒</h3>
              <p>第三方工具访问未采集，不据此判断文件没有被读取。</p>
            </div>
          )}
        </section>
      )}
      {report && (
        <Modal
          title="脱敏审计报告预览"
          subtitle="保存前核对实际内容；报告只含助手事件，路径和自由文本已隐藏。"
          wide
          onClose={() => {
            if (!busy) setReport(undefined);
          }}
        >
          <div className="modal-body">
            <label>
              报告格式
              <select
                aria-label="审计报告格式"
                value={report.format}
                disabled={busy}
                onChange={async (event) => {
                  const type = event.target.value as "md" | "json";
                  setBusy(true);
                  try {
                    setReport({
                      ...(await api.previewFileAudit(report.scopeId, type)),
                      scopeId: report.scopeId,
                    });
                    setReportFormat(type);
                  } catch (error) {
                    onError((error as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <option value="md">Markdown</option>
                <option value="json">JSON</option>
              </select>
            </label>
            <pre className="report-preview">{report.content}</pre>
          </div>
          <div className="modal-footer">
            <button
              className="secondary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  setReport({
                    ...(await api.previewFileAudit(
                      report.scopeId,
                      report.format,
                    )),
                    scopeId: report.scopeId,
                  });
                } catch (error) {
                  onError((error as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              刷新预览
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const result = await api.exportFileAudit(
                    report.scopeId,
                    report.digest,
                    report.format,
                  );
                  if (!result.cancelled && result.path) {
                    setMessage(`审计报告已保存：${result.path}`);
                    setReport(undefined);
                  }
                } catch (error) {
                  onError((error as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              选择位置并保存
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
