import { useCallback, useEffect, useRef, useState } from "react";
import {
  FolderOpen,
  ShieldCheck,
  FileSearch,
  ArrowRight,
  Check,
  LockKeyhole,
  RefreshCw,
  AlertTriangle,
} from "lucide-react";
import type { DesktopAPI, ExportPreview } from "./shared/types";
import type {
  AuditEvent,
  AuditPage,
  FileWorkspace,
  FileCandidate,
  FileDecision,
} from "./shared/assistant";
import {
  FILE_OPERATIONS,
  type FileDraft,
  type FileTrial,
  type FileTask,
  type FileTaskResult,
} from "./shared/file-workflow";
import Modal from "./Modal";
import "./styles-file-policy.css";

export const operationLabel = {
  read: "读取",
  write: "修改",
  delete: "删除",
  disclose: "发送模型",
  enumerate: "枚举元数据",
  policy_update: "更新策略",
};
const decisionLabel = { deny: "禁止", ask: "需确认", allow: "允许" };
const taskLabel: Record<FileTask["status"], string> = {
  awaiting_approval: "待授权 · 未读取",
  denied: "已阻止 · 未读取",
  ready: "准备执行",
  running: "执行中",
  completed: "本地处理完成",
  failed: "任务未完成",
  stale: "条件变化失效",
};
const resultLabel: Record<AuditEvent["result"], string> = {
  metadata_only: "仅元数据",
  policy_saved: "旧版策略保存",
  denied: "自检拒绝 · 未访问",
  confirmation_required: "自检需确认 · 未访问",
  allowed_evaluation: "规则允许 · 未执行",
};
const sections = [
  ["home", "保护工作台"],
  ["files", "文件发现与策略"],
  ["tasks", "本地处理任务"],
  ["records", "授权与记录"],
  ["coverage", "覆盖与健康"],
] as const;
type Tab = (typeof sections)[number][0];
function Stamp({
  children,
  tone = "quiet",
}: {
  children: React.ReactNode;
  tone?: string;
}) {
  return <span className={`fp-stamp ${tone}`}>{children}</span>;
}
export default function FileProtection({
  api,
  onError,
}: {
  api: DesktopAPI;
  onError: (message: string) => void;
}) {
  const [workspace, setWorkspace] = useState<FileWorkspace>();
  const [scopeId, setScopeId] = useState(""),
    [fileId, setFileId] = useState(""),
    [tab, setTab] = useState<Tab>("home");
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const [draftTouched, setDraftTouched] = useState(false);
  const [draft, setDraft] = useState<FileDraft>(),
    [expected, setExpected] = useState(0),
    [trial, setTrial] = useState<FileTrial>();
  const [query, setQuery] = useState(""),
    [appliedQuery, setAppliedQuery] = useState("");
  const [confirmation, setConfirmation] = useState<{
    title: string;
    body: string;
    run: () => void;
  }>();
  const [grantTask, setGrantTask] = useState<FileTask>(),
    [reason, setReason] = useState("");
  const [preview, setPreview] = useState<FileTaskResult>(),
    [copyConfirmed, setCopyConfirmed] = useState(false);
  const [report, setReport] = useState<ExportPreview>(),
    [audit, setAudit] = useState<AuditPage>({ events: [] });
  const auditScope = useRef(scopeId);
  const lock = useRef(false),
    mounted = useRef(true);
  const scope = workspace?.scopes.find((s) => s.id === scopeId),
    candidate = scope?.candidates.find((c) => c.id === fileId);
  const saved = scope?.policies.find((p) => p.resourceId === fileId);
  const hasChanges =
    !!draft &&
    (!saved ||
      ["read", "write", "delete", "disclose", "enabled"].some(
        (k) =>
          (saved as unknown as Record<string, unknown>)[k] !==
          (draft as unknown as Record<string, unknown>)[k],
      ));
  const dirty = draftTouched && hasChanges;
  const workflow = workspace?.workflow;
  const tasks =
    workflow?.tasks.filter((t) => !scopeId || t.scopeId === scopeId) || [];
  const events =
    workflow?.events.filter((e) => !scopeId || e.scopeId === scopeId) || [];
  const reload = useCallback(async () => {
    const w = await api.fileWorkspace();
    if (mounted.current) setWorkspace(w);
    return w;
  }, [api]);
  useEffect(() => {
    mounted.current = true;
    void reload().catch((e) => setError(e.message));
    return () => {
      mounted.current = false;
    };
  }, [reload]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!lock.current) void reload().catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [reload]);
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, [dirty]);
  useEffect(() => {
    let active = true;
    const sameScope = auditScope.current === scopeId;
    auditScope.current = scopeId;
    void api
      .auditEvents({ scopeId: scopeId || undefined })
      .then((v) => {
        if (active)
          setAudit((previous) =>
            !sameScope
              ? v
              : {
                  ...v,
                  events: [
                    ...new Map(
                      [
                        ...v.events,
                        ...previous.events.filter(
                          (e) => !scopeId || e.scopeId === scopeId,
                        ),
                      ].map((e) => [e.id, e]),
                    ).values(),
                  ].sort((a, b) => b.seq - a.seq),
                  nextCursor:
                    previous.events.length > 100 &&
                    previous.events.some(
                      (e) => !scopeId || e.scopeId === scopeId,
                    )
                      ? previous.nextCursor
                      : v.nextCursor,
                },
          );
      })
      .catch((e) => setError(e.message));
    return () => {
      active = false;
    };
  }, [api, scopeId, workspace]);
  const act = async (
    fn: () => Promise<void | FileWorkspace>,
    success?: string,
  ) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    onError("");
    try {
      const value = await fn();
      if (value) setWorkspace(value);
      else await reload();
      if (success) setNotice(success);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const leave = (fn: () => void) => {
    if (busy) return;
    if (dirty)
      setConfirmation({
        title: "当前策略尚未发布",
        body: "离开会丢弃当前草稿和试运行结果。已生效版本不变；继续编辑可保留输入。",
        run: () => {
          setDraft(undefined);
          setTrial(undefined);
          setConfirmation(undefined);
          fn();
        },
      });
    else fn();
  };
  const navigate = (next: Tab) =>
    leave(() => {
      setTab(next);
      setDraft(undefined);
      setTrial(undefined);
    });
  const selectFile = (c: FileCandidate) => {
    const old = scope?.policies.find((p) => p.resourceId === c.id);
    setFileId(c.id);
    setExpected(old?.revision || 0);
    setDraftTouched(false);
    setDraft({
      resourceId: c.id,
      read: old?.read || "deny",
      write: old?.write || "deny",
      delete: old?.delete || "deny",
      disclose: old?.disclose || "deny",
      enabled: old?.enabled ?? true,
    });
    setTrial(undefined);
    setError("");
  };
  const loadScope = () =>
    leave(
      () =>
        void act(async () => {
          const next = await api.chooseFileScope();
          if (next) {
            setScopeId(next.scopes.at(-1)?.id || "");
            setTab("files");
            setFileId("");
            return next;
          }
        }),
    );
  const applyTemplate = (kind: "credential" | "office") => {
    if (!draft) return;
    setDraftTouched(true);
    setDraft({
      ...draft,
      read: kind === "credential" ? "deny" : "ask",
      write: kind === "credential" ? "deny" : "ask",
      delete: "deny",
      disclose: kind === "credential" ? "deny" : "ask",
      enabled: true,
    });
    setTrial(undefined);
  };
  const publish = () => {
    if (!trial) return;
    setConfirmation({
      title: "确认发布文件策略？",
      body: `${candidate?.relativePath} 将更新为 v${expected + 1}。已有本地单次授权将失效。AI 钩子只限制支持的操作；系统和模型提交能力分别显示。`,
      run: () => {
        setConfirmation(undefined);
        void act(async () => {
          const next = await api.publishFilePolicy(trial.id);
          const policy = next.scopes
            .find((s) => s.id === scopeId)
            ?.policies.find((p) => p.resourceId === fileId);
          setExpected(policy?.revision || 0);
          setDraft(
            policy
              ? {
                  resourceId: policy.resourceId,
                  read: policy.read,
                  write: policy.write,
                  delete: policy.delete || "deny",
                  disclose: policy.disclose,
                  enabled: policy.enabled,
                }
              : undefined,
          );
          setTrial(undefined);
          setDraftTouched(false);
          return next;
        }, "本地策略已发布；请查看钩子下发状态，工具加载状态在操作规则页核验。");
      },
    });
  };
  const result = async (value: FileTaskResult) => {
    if (value.content !== undefined) {
      setPreview(value);
      setCopyConfirmed(false);
    } else setNotice(value.task.detail);
  };
  const start = (kind: FileTask["kind"]) =>
    leave(
      () =>
        void act(async () => {
          if (!scopeId || !fileId) throw new Error("请先选择一个候选文件。");
          const value = await api.startFileTask(scopeId, fileId, kind);
          await result(value);
          setTab("tasks");
        }),
    );
  const status = (c: FileCandidate) => {
    const p = scope?.policies.find((p) => p.resourceId === c.id);
    return c.review === "stale"
      ? "版本待确认 · 原规则保留"
      : p?.enabled
        ? "已配置策略"
        : c.review === "deferred"
          ? "暂缓确认"
          : "待确认";
  };
  const fileName = (id: string) =>
    scope?.candidates.find((c) => c.id === id)?.relativePath ||
    "已变更或其他范围的文件";
  const configured = scope?.policies.filter((p) => p.enabled).length || 0;
  const taskColor = (s: FileTask["status"]) =>
    s === "completed"
      ? "good"
      : s === "denied" || s === "failed"
        ? "risk"
        : "attention";
  const grants =
    workflow?.grants.filter((g) => tasks.some((t) => t.id === g.taskId)) || [];
  if (!workspace)
    return (
      <section className="panel fp-loading" role="status">
        {error ? (
          <>
            <p>{error}</p>
            <button
              className="secondary"
              onClick={() => void reload().catch((e) => setError(e.message))}
            >
              重新加载
            </button>
          </>
        ) : (
          <>
            <RefreshCw size={20} />
            正在读取本机文件策略…
          </>
        )}
      </section>
    );
  return (
    <div className="file-protection fp-workbench" aria-label="文件权限工作台">
      <div className="page-heading">
        <div>
          <div className="eyebrow">FILE PERMISSIONS</div>
          <h1>让文件有边界，让工作继续</h1>
          <p>
            发现需要保护的文件，明确读、改、删、外发的权限，用真实回执核验本地任务。
          </p>
        </div>
        <button
          className="primary"
          disabled={busy || workspace.scanning}
          onClick={loadScope}
        >
          <FolderOpen size={16} />
          选择项目或目录
        </button>
      </div>
      <div className="fp-context">
        <label>
          当前范围
          <select
            aria-label="项目范围"
            disabled={busy}
            value={scopeId}
            onChange={(e) => {
              const id = e.target.value;
              leave(() => {
                setScopeId(id);
                setFileId("");
                setDraft(undefined);
                setTrial(undefined);
                setAppliedQuery("");
                setQuery("");
              });
            }}
          >
            <option value="">选择已添加范围</option>
            {workspace.scopes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.candidates.length} 个候选
              </option>
            ))}
          </select>
        </label>
        <span className="fp-muted">
          发现仅枚举元数据；本地预览和副本处理会在明确请求后读取文本。
        </span>
      </div>
      <nav className="fp-tabs" aria-label="文件策略分区">
        {sections.map(([id, title]) => (
          <button
            key={id}
            aria-current={id === tab ? "page" : undefined}
            className={id === tab ? "active" : ""}
            disabled={busy}
            onClick={() => navigate(id)}
          >
            {title}
          </button>
        ))}
      </nav>
      {error && (
        <div className="notice amber" role="alert">
          <AlertTriangle size={16} />
          <div>
            {error}
            <p>本次输入已保留；请按提示处理后重试。</p>
          </div>
        </div>
      )}
      {notice && (
        <div className="notice" role="status">
          <Check size={16} />
          {notice}
        </div>
      )}
      {workspace.scanning && (
        <div className="notice" role="status">
          正在扫描，最多 10,000 条目 / 10 秒。已保存规则保持原样。
          <button
            className="secondary"
            onClick={() =>
              void api.cancelFileScan().catch((e) => setError(e.message))
            }
          >
            停止扫描
          </button>
        </div>
      )}
      {tab === "home" && (
        <>
          <section className="fp-hero panel">
            <div>
              <div className="eyebrow">文件使用权，始终掌握在你手中</div>
              <h2>
                允许必要的工作，
                <br />
                把敏感操作留在边界内。
              </h2>
              <p>
                开发凭据默认禁止，办公资料按需确认。被阻止后可选择安全样例，或为指定本地任务授权一次。
              </p>
              <div className="fp-actions">
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => navigate("files")}
                >
                  <FileSearch size={16} />
                  发现并设置策略
                </button>
                <button
                  className="secondary"
                  onClick={() => navigate("coverage")}
                >
                  查看覆盖范围
                </button>
              </div>
            </div>
            <div className="fp-route">
              <div>
                <FileSearch />
                <strong>发现与确认</strong>
                <small>候选有依据</small>
              </div>
              <ArrowRight />
              <div>
                <LockKeyhole />
                <strong>按操作授权</strong>
                <small>权限不混用</small>
              </div>
              <ArrowRight />
              <div>
                <ShieldCheck />
                <strong>核验与恢复</strong>
                <small>任务有回执</small>
              </div>
            </div>
          </section>
          <section className="fp-metrics">
            <div>
              <span>当前范围候选</span>
              <strong>{scope?.candidates.length || 0}</strong>
            </div>
            <div>
              <span>已启用文件策略</span>
              <strong>{configured}</strong>
            </div>
            <div>
              <span>待授权本地任务</span>
              <strong>
                {tasks.filter((t) => t.status === "awaiting_approval").length}
              </strong>
            </div>
            <div>
              <span>本地任务完成</span>
              <strong>
                {tasks.filter((t) => t.status === "completed").length}
              </strong>
            </div>
          </section>
          <div className="fp-columns">
            <section className="panel">
              <h2>下一步做什么</h2>
              {!scope ? (
                <div className="empty">
                  <FolderOpen />
                  <h3>选择具体目录开始</h3>
                  <p>
                    开发项目、凭据目录或指定办公目录。不会默认扫描整个主目录。
                  </p>
                  <button className="secondary" onClick={loadScope}>
                    选择目录
                  </button>
                </div>
              ) : (
                <>
                  <p>
                    {scope.name} · 元数据枚举 {scope.examined} 条，跳过{" "}
                    {scope.skipped} 条。
                  </p>
                  <div className="fp-next">
                    <span>01</span>
                    <div>
                      <strong>确认发现的候选文件</strong>
                      <p>名称只能提示风险，需要本人判断用途。</p>
                    </div>
                    <button
                      className="secondary"
                      onClick={() => navigate("files")}
                    >
                      去确认
                    </button>
                  </div>
                  <div className="fp-next">
                    <span>02</span>
                    <div>
                      <strong>试运行后再发布</strong>
                      <p>对比四种动作；文件或策略变化时重新检查。</p>
                    </div>
                    <button
                      className="secondary"
                      onClick={() => navigate("files")}
                    >
                      设置权限
                    </button>
                  </div>
                  <div className="fp-next">
                    <span>03</span>
                    <div>
                      <strong>通过本地处理验证效果</strong>
                      <p>授权创建不代表已经执行；取得回执才算完成。</p>
                    </div>
                    <button
                      className="secondary"
                      onClick={() => navigate("tasks")}
                    >
                      查看任务
                    </button>
                  </div>
                </>
              )}
            </section>
            <section className="panel">
              <h2>当前保护边界</h2>
              <div className="fp-health-row">
                <strong>本地文本处理</strong>
                <Stamp tone="good">受控入口已接入</Stamp>
              </div>
              <p>实际读取前校验文件身份和版本；授权消费后不再复用。</p>
              <div className="fp-health-row">
                <strong>AI 文件操作钩子</strong>
                <Stamp
                  tone={
                    workflow?.hook.state === "published" ? "info" : "attention"
                  }
                >
                  {workflow?.hook.state === "published"
                    ? "规则快照已下发"
                    : "待核验下发"}
                </Stamp>
              </div>
              <p>仅支持的路径和操作。快照下发不等于工具已加载。</p>
              <div className="fp-health-row">
                <strong>系统保护 / 模型提交</strong>
                <Stamp tone="attention">未接入</Stamp>
              </div>
              <p>不声称全机禁读，也不把副本生成当作模型提交。</p>
            </section>
          </div>
        </>
      )}
      {tab === "files" &&
        (!scope ? (
          <section className="panel empty">
            <h2>先选定一个保护范围</h2>
            <p>扫描只查询名称、类型、大小；不打开文件正文。</p>
            <button className="primary" onClick={loadScope}>
              选择项目或目录
            </button>
          </section>
        ) : (
          <>
            <section className="panel">
              <div className="fp-section-head">
                <div>
                  <h2>{scope.name} · 文件发现</h2>
                  <p>
                    枚举 {scope.examined} · 跳过 {scope.skipped} ·{" "}
                    {new Date(scope.scannedAt).toLocaleString("zh-CN")}
                  </p>
                </div>
                <div className="fp-actions">
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      leave(
                        () => void act(() => api.chooseSensitiveFile(scope.id)),
                      )
                    }
                  >
                    添加指定文件
                  </button>
                  <button
                    className="secondary"
                    disabled={busy || workspace.scanning}
                    onClick={() =>
                      leave(
                        () =>
                          void act(async () => {
                            setDraft(undefined);
                            setTrial(undefined);
                            setFileId("");
                            return api.rescanFileScope(scope.id);
                          }),
                      )
                    }
                  >
                    重新扫描
                  </button>
                </div>
              </div>
              {scope.warnings.map((w) => (
                <p className="fp-warning" key={w}>
                  {w}
                </p>
              ))}
              <form
                className="fp-search"
                onSubmit={(e) => {
                  e.preventDefault();
                  setAppliedQuery(query.trim());
                }}
              >
                <input
                  aria-label="搜索候选文件"
                  placeholder="搜索文件名称或发现依据"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <button className="secondary" type="submit">
                  搜索
                </button>
                <button
                  className="secondary"
                  type="button"
                  onClick={() => setQuery("")}
                >
                  清空
                </button>
              </form>
              <div className="fp-table">
                <table>
                  <thead>
                    <tr>
                      <th>候选文件</th>
                      <th>发现依据</th>
                      <th>处理状态</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scope.candidates
                      .filter((c) =>
                        (c.relativePath + " " + c.reason)
                          .toLowerCase()
                          .includes(appliedQuery.toLowerCase()),
                      )
                      .map((c) => (
                        <tr
                          key={c.id}
                          className={c.id === fileId ? "selected" : ""}
                        >
                          <td title={c.relativePath}>
                            {c.relativePath}
                            <small>
                              {c.size} 字节
                              {c.unsupported ? " · 多硬链接，暂不支持" : ""}
                            </small>
                          </td>
                          <td title={c.reason}>{c.reason}</td>
                          <td>
                            <Stamp
                              tone={
                                status(c) === "已配置策略"
                                  ? "info"
                                  : "attention"
                              }
                            >
                              {status(c)}
                            </Stamp>
                          </td>
                          <td>
                            <button
                              className="link-button"
                              disabled={busy || c.unsupported}
                              onClick={() => leave(() => selectFile(c))}
                            >
                              {c.review === "stale"
                                ? "查看原规则"
                                : "确认并设置"}
                            </button>
                            {c.review === "stale" && (
                              <button
                                className="link-button"
                                disabled={busy}
                                onClick={() =>
                                  leave(() =>
                                    setConfirmation({
                                      title: "重新确认文件版本？",
                                      body: `${c.relativePath} 已变化或此前未发现。确认后将保留原操作规则并创建新版本，旧授权和试运行失效。请先核对文件来源。`,
                                      run: () => {
                                        setConfirmation(undefined);
                                        void act(async () => {
                                          const next =
                                            await api.reconfirmFileCandidate(
                                              scope.id,
                                              c.id,
                                            );
                                          setDraft(undefined);
                                          setTrial(undefined);
                                          setDraftTouched(false);
                                          setFileId("");
                                          setNotice(
                                            next.workflow?.hook.state ===
                                              "published"
                                              ? "文件版本已重新确认，规则快照已更新；请核验工具是否加载。"
                                              : "新版本已保存，但钩子快照未确认更新。旧版本仍按变化处理，请到覆盖与健康重试下发。",
                                          );
                                          return next;
                                        });
                                      },
                                    }),
                                  )
                                }
                              >
                                重新确认版本
                              </button>
                            )}
                            <button
                              className="link-button"
                              disabled={busy || c.review === "stale"}
                              onClick={() =>
                                void act(() =>
                                  api.reviewFileCandidate(
                                    scope.id,
                                    c.id,
                                    c.review !== "deferred",
                                  ),
                                )
                              }
                            >
                              {c.review === "deferred" ? "重新纳入" : "暂缓"}
                            </button>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                {!scope.candidates.some((c) =>
                  (c.relativePath + " " + c.reason)
                    .toLowerCase()
                    .includes(appliedQuery.toLowerCase()),
                ) && (
                  <div className="empty">
                    <p>
                      {scope.candidates.length
                        ? "暂无匹配数据，请调整筛选条件。"
                        : "没有发现已知类型候选，不表示目录中没有敏感文件。可添加指定文件。"}
                    </p>
                  </div>
                )}
              </div>
              <p className="fp-muted">
                候选不等于已确认敏感，暂缓不代表安全；已配置策略也不代表所有应用都被覆盖。
              </p>
            </section>
            {candidate && draft && (
              <section className="panel fp-editor" aria-label="文件策略编辑">
                <div className="fp-section-head">
                  <div>
                    <div className="eyebrow">精准到文件 · 独立到操作</div>
                    <h2>{candidate.relativePath}</h2>
                    <p>
                      作用主体：经过本应用钩子的 AI
                      操作和本应用的本地处理入口。不会修改系统文件权限。
                    </p>
                  </div>
                  <Stamp>当前 v{expected}</Stamp>
                </div>
                <div className="fp-actions">
                  <span>推荐起点</span>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => applyTemplate("credential")}
                  >
                    开发凭据 · 默认禁止
                  </button>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => applyTemplate("office")}
                  >
                    办公资料 · 按需确认
                  </button>
                </div>
                <div className="fp-operation-grid">
                  {FILE_OPERATIONS.map((op) => (
                    <label key={op}>
                      <span>{operationLabel[op]}</span>
                      <select
                        aria-label={`${operationLabel[op]}策略`}
                        disabled={busy}
                        value={draft[op] || "deny"}
                        onChange={(e) => {
                          setDraftTouched(true);
                          setDraft({
                            ...draft,
                            [op]: e.target.value as FileDecision,
                          });
                          setTrial(undefined);
                        }}
                      >
                        {(["deny", "ask", "allow"] as const).map((d) => (
                          <option key={d} value={d}>
                            {decisionLabel[d]}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
                <label className="fp-checkbox">
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={draft.enabled}
                    onChange={(e) => {
                      setDraftTouched(true);
                      setDraft({ ...draft, enabled: e.target.checked });
                      setTrial(undefined);
                    }}
                  />
                  启用这条规则
                </label>
                {candidate.review === "stale" && (
                  <p className="fp-warning">
                    文件版本已变化或未发现，原规则继续限制访问。请先检查文件并在列表中重新确认版本；文件不存在时请先恢复它。
                  </p>
                )}
                <p className="fp-warning">
                  发送模型与本地读取独立。当前未接入模型提交关口；本页的临时授权仅用于本地文本处理，不能放行
                  AI 工具。
                </p>
                <div className="fp-actions">
                  <button
                    className="secondary"
                    disabled={
                      busy || !hasChanges || candidate.review === "stale"
                    }
                    onClick={() =>
                      void act(async () => {
                        setTrial(
                          await api.trialFilePolicy(scope.id, draft, expected),
                        );
                      }, "试运行完成；没有打开正文或执行文件操作。")
                    }
                  >
                    试运行当前草稿
                  </button>
                  <button
                    className="primary"
                    disabled={
                      busy ||
                      !hasChanges ||
                      !trial ||
                      candidate.review === "stale"
                    }
                    onClick={publish}
                  >
                    确认发布策略
                  </button>
                  {saved &&
                    workflow?.history.some(
                      (h) =>
                        h.scopeId === scope.id && h.resourceId === candidate.id,
                    ) && (
                      <button
                        className="secondary"
                        disabled={busy || dirty}
                        onClick={() =>
                          setConfirmation({
                            title: "回滚这条文件规则？",
                            body: "将以历史配置创建新版本，当前本地授权失效。任务记录保留，已发生的访问不会撤回。",
                            run: () => {
                              setConfirmation(undefined);
                              void act(async () => {
                                const next = await api.rollbackFilePolicy(
                                  scope.id,
                                  candidate.id,
                                  expected,
                                );
                                setDraft(undefined);
                                setTrial(undefined);
                                return next;
                              }, "回滚已生成新版本，请核验下发状态。");
                            },
                          })
                        }
                      >
                        回滚上一版
                      </button>
                    )}
                </div>
                <p className="fp-muted">
                  {hasChanges
                    ? "建议规则尚未发布；确认后试运行并发布。"
                    : "当前规则已保存。本地生效与 AI 钩子下发状态分别核验。"}
                </p>
                {trial && (
                  <div className="fp-trial">
                    <h3>
                      影响预览 · v{expected} → v{expected + 1}
                    </h3>
                    <p>
                      试运行有效至{" "}
                      {new Date(trial.expiresAt).toLocaleTimeString("zh-CN")}
                      ；只评估规则，不代表执行证据。
                    </p>
                    <div className="fp-table">
                      <table>
                        <thead>
                          <tr>
                            <th>动作</th>
                            <th>原规则</th>
                            <th>发布后</th>
                            <th>执行范围</th>
                          </tr>
                        </thead>
                        <tbody>
                          {trial.checks.map((c) => (
                            <tr key={c.operation}>
                              <td>{operationLabel[c.operation]}</td>
                              <td>{decisionLabel[c.before]}</td>
                              <td>{decisionLabel[c.after]}</td>
                              <td>
                                {c.operation === "disclose"
                                  ? "未接入，不可声称外发受控"
                                  : c.operation === "read"
                                    ? "本地任务 + 支持的 AI 钩子"
                                    : "支持的 AI 钩子；不在本页执行"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
                <div className="fp-self-check">
                  <h3>已保存规则自检</h3>
                  <p>
                    这里的结果仅为规则检查；需要真实读取回执，请到“本地处理任务”。
                  </p>
                  <div className="fp-actions">
                    {FILE_OPERATIONS.map((op) => (
                      <button
                        className="secondary"
                        key={op}
                        disabled={busy || dirty || !saved}
                        onClick={() =>
                          void act(async () => {
                            const r = await api.evaluateFilePolicy(
                              scope.id,
                              candidate.id,
                              op,
                            );
                            setNotice(
                              `${operationLabel[op]}自检：${decisionLabel[r.decision]}。未执行真实文件操作。`,
                            );
                            return r.workspace;
                          })
                        }
                      >
                        {operationLabel[op]}自检
                      </button>
                    ))}
                  </div>
                </div>
              </section>
            )}
          </>
        ))}
      {tab === "tasks" && (
        <>
          <section className="panel">
            <div className="fp-section-head">
              <div>
                <h2>安全完成本地文本任务</h2>
                <p>
                  支持 256 KiB 以内 UTF-8 文本；Word、Excel、PDF
                  解析暂未接入。不会修改或删除原件，不会向模型发送。
                </p>
              </div>
              <Stamp tone="good">真实本地执行入口</Stamp>
            </div>
            <label className="fp-field">
              选择文件
              <select
                aria-label="任务文件"
                disabled={busy}
                value={fileId}
                onChange={(e) => setFileId(e.target.value)}
              >
                <option value="">请选择范围内文件</option>
                {scope?.candidates.map((c) => (
                  <option key={c.id} value={c.id} disabled={c.unsupported}>
                    {c.relativePath}
                  </option>
                ))}
              </select>
            </label>
            <div className="fp-actions">
              <button
                className="primary"
                disabled={busy || !fileId}
                onClick={() => start("preview")}
              >
                读取并预览文本
              </button>
              <button
                className="secondary"
                disabled={busy || !fileId}
                onClick={() => start("redact")}
              >
                生成本地脱敏副本
              </button>
            </div>
            <p className="fp-muted">
              这两个操作都会读取所选文件。禁止时不会打开正文；需确认时先创建单次许可，再由你执行。
            </p>
          </section>
          <section className="panel">
            <h2>任务与执行回执</h2>
            {tasks.map((t) => (
              <div className="fp-task" key={t.id}>
                <div>
                  <div className="fp-actions">
                    <strong>
                      {t.kind === "preview" ? "文本预览" : "脱敏副本"} ·{" "}
                      {fileName(t.resourceId)}
                    </strong>
                    <Stamp tone={taskColor(t.status)}>
                      {taskLabel[t.status]}
                    </Stamp>
                  </div>
                  <p>{t.detail}</p>
                  <small>
                    v{t.revision} · 本地处理 ·{" "}
                    {new Date(t.createdAt).toLocaleString("zh-CN")} · 请求{" "}
                    {t.id.slice(0, 8)}
                  </small>
                </div>
                <div className="fp-actions">
                  {t.status === "awaiting_approval" && (
                    <>
                      <button
                        className="secondary"
                        disabled={
                          busy ||
                          grants.some(
                            (g) =>
                              g.taskId === t.id &&
                              g.status === "active" &&
                              g.expiresAt > Date.now(),
                          )
                        }
                        onClick={() => {
                          setReason("");
                          setGrantTask(t);
                        }}
                      >
                        {grants.some(
                          (g) =>
                            g.taskId === t.id &&
                            g.status === "active" &&
                            g.expiresAt > Date.now(),
                        )
                          ? "已授权，请执行"
                          : "仅授权这个任务"}
                      </button>
                      <button
                        className="primary"
                        disabled={
                          busy ||
                          !grants.some(
                            (g) =>
                              g.taskId === t.id &&
                              g.status === "active" &&
                              g.expiresAt > Date.now(),
                          )
                        }
                        onClick={() =>
                          void act(async () => {
                            await result(await api.runFileTask(t.id));
                          })
                        }
                      >
                        执行已授权任务
                      </button>
                    </>
                  )}
                  {["denied", "failed", "stale"].includes(t.status) && (
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => {
                        setFileId(t.resourceId);
                        if (t.status === "denied") {
                          setScopeId(t.scopeId);
                          setTab("files");
                        }
                        setNotice(
                          t.status === "denied"
                            ? "请在原应用创建不含秘密的样例材料，再点击本页“添加指定文件”纳入范围。原始凭据规则不放宽。"
                            : "请核对文件和规则后重新发起；旧任务不会自动重放。",
                        );
                      }}
                    >
                      查看继续方法
                    </button>
                  )}
                </div>
              </div>
            ))}
            {!tasks.length && (
              <div className="empty">
                <h3>还没有本地任务</h3>
                <p>选择文件发起一次操作，查看规则判断和实际结果。</p>
              </div>
            )}
          </section>
        </>
      )}
      {tab === "records" && (
        <>
          <section className="panel">
            <div className="fp-section-head">
              <div>
                <h2>单次授权</h2>
                <p>
                  绑定文件版本、策略版本和一个本地任务。15
                  分钟内一次；应用重启失效。
                </p>
              </div>
            </div>
            {grants.map((g) => (
              <div className="fp-task" key={g.id}>
                <div>
                  <strong>
                    请求 {g.taskId.slice(0, 8)} ·{" "}
                    {g.status === "active"
                      ? "待使用"
                      : g.status === "used"
                        ? "已消费"
                        : g.status === "expired"
                          ? "已到期"
                          : g.status === "revoked"
                            ? "已撤销"
                            : "条件变化失效"}
                  </strong>
                  <p>
                    有效至 {new Date(g.expiresAt).toLocaleString("zh-CN")} ·
                    仅本地，不授权钩子或模型外发
                  </p>
                </div>
                <button
                  className="secondary"
                  disabled={busy || g.status !== "active"}
                  onClick={() =>
                    setConfirmation({
                      title: "撤销这项授权？",
                      body: "未使用的本地许可立即失效；文件规则保持不变。",
                      run: () => {
                        setConfirmation(undefined);
                        void act(
                          () => api.revokeFileGrant(g.id),
                          "授权已撤销。",
                        );
                      },
                    })
                  }
                >
                  撤销
                </button>
              </div>
            ))}
            {!grants.length && <p className="empty">暂无单次授权。</p>}
          </section>
          <section className="panel">
            <div className="fp-section-head">
              <div>
                <h2>完整处理记录</h2>
                <p>
                  配置变更、任务请求、授权和回执分别记录；相同请求编号关联后续处理。
                </p>
              </div>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    setReport(
                      await api.previewFileAudit(scopeId || undefined, "json"),
                    );
                  })
                }
              >
                预览脱敏审计报告
              </button>
            </div>
            {events.map((e) => (
              <div className="fp-event" key={e.id}>
                <time>{new Date(e.at).toLocaleString("zh-CN")}</time>
                <div>
                  <strong>{e.title}</strong>
                  <p>{e.detail}</p>
                  {e.taskId && <small>关联请求 {e.taskId.slice(0, 8)}</small>}
                </div>
              </div>
            ))}
            {!events.length && <p className="empty">暂无本地工作流记录。</p>}
            <details>
              <summary>扫描与规则自检记录（不代表真实访问）</summary>
              {audit.events.map((e) => (
                <div className="fp-event" key={e.id}>
                  <time>{new Date(e.time).toLocaleString("zh-CN")}</time>
                  <div>
                    <strong>
                      {operationLabel[e.operation]} · {resultLabel[e.result]}
                    </strong>
                    <p>{e.detail}</p>
                    <small>
                      {e.source} · 序号 {e.seq}
                    </small>
                  </div>
                </div>
              ))}
              {audit.nextCursor && (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const next = await api.auditEvents({
                        scopeId: scopeId || undefined,
                        cursor: audit.nextCursor,
                      });
                      setAudit({
                        events: [...audit.events, ...next.events],
                        nextCursor: next.nextCursor,
                      });
                    })
                  }
                >
                  加载更早记录
                </button>
              )}
            </details>
          </section>
        </>
      )}
      {tab === "coverage" && (
        <>
          <div className="fp-coverage-grid">
            <section className="panel">
              <ShieldCheck />
              <h2>本地文本处理</h2>
              <Stamp tone="good">已接入受控入口</Stamp>
              <p>
                打开文件前按规则决定；通过句柄核对身份和版本；正文不写入审计。
              </p>
              <p>当前只支持文本预览及本地副本，不在此执行真实修改和删除。</p>
            </section>
            <section className="panel">
              <LockKeyhole />
              <h2>AI 文件钩子</h2>
              <Stamp
                tone={
                  workflow?.hook.state === "published" ? "info" : "attention"
                }
              >
                {workflow?.hook.state === "published"
                  ? "规则快照下发一致"
                  : "待处理下发"}
              </Stamp>
              <p>{workflow?.hook.detail || "网页演示未接入执行端。"}</p>
              <p>
                钩子中的“需确认”先阻断；本地授权不能放行工具。AI
                的实际加载状态和事件请查看安全中心“防护与规则 → 操作规则”和“事件分析 → 事件列表”。
              </p>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void act(
                    () => api.retryFileDeployment(),
                    "已重新检查文件规则快照，请核对状态。",
                  )
                }
              >
                重新下发并核验
              </button>
            </section>
            <section className="panel">
              <AlertTriangle />
              <h2>系统与模型出口</h2>
              <Stamp tone="attention">未接入</Stamp>
              <p>
                尚未安装 Windows 文件驱动或 macOS 系统扩展，未提供模型提交回执。
              </p>
              <p>
                其他应用、任意脚本、WSL、容器、远程执行和网络卷未验证，不显示为已保护。
              </p>
            </section>
          </div>
          <section className="panel">
            <h2>保护边界说明</h2>
            {workspace.coverage.gaps.map((g) => (
              <p key={g}>{g}</p>
            ))}
          </section>
        </>
      )}
      {confirmation && (
        <Modal
          title={confirmation.title}
          onClose={() => {
            if (!busy) setConfirmation(undefined);
          }}
        >
          <div className="modal-body">
            <p>{confirmation.body}</p>
          </div>
          <div className="modal-footer">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setConfirmation(undefined)}
            >
              取消
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={confirmation.run}
            >
              确认
            </button>
          </div>
        </Modal>
      )}
      {grantTask && (
        <Modal
          title="仅授权这一个本地任务"
          onClose={() => {
            if (!busy) setGrantTask(undefined);
          }}
        >
          <div className="modal-body">
            <p>
              <strong>{fileName(grantTask.resourceId)}</strong> · 本地
              {grantTask.kind === "preview" ? "文本预览" : "脱敏副本"}
            </p>
            <p>
              策略 v{grantTask.revision} · 15 分钟内一次 · 不允许 AI
              钩子操作或外发
            </p>
            <label className="fp-field">
              授权原因
              <textarea
                aria-label="授权原因"
                maxLength={200}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="说明本次处理的用途"
              />
            </label>
            {error && (
              <p role="alert" className="fp-warning">
                {error}
              </p>
            )}
          </div>
          <div className="modal-footer">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setGrantTask(undefined)}
            >
              取消
            </button>
            <button
              className="primary"
              disabled={busy || !reason.trim()}
              onClick={() =>
                void act(async () => {
                  const next = await api.grantFileTask(grantTask.id, reason);
                  setGrantTask(undefined);
                  return next;
                }, "授权已创建。请点击该任务的“执行已授权任务”继续。")
              }
            >
              确认单次授权
            </button>
          </div>
        </Modal>
      )}
      {preview && (
        <Modal
          title={
            preview.task.kind === "redact" ? "审阅本地脱敏副本" : "本地文本预览"
          }
          subtitle="原件未修改；内容仅在当前预览展示，不写入任务日志，也未向模型发送。"
          wide
          onClose={() => {
            if (!busy) setPreview(undefined);
          }}
        >
          <div className="modal-body">
            {preview.task.kind === "redact" && (
              <p className="notice amber">
                已处理 {preview.replacements || 0}{" "}
                处规则命中（密钥、邮箱、手机号等）。可能遗漏姓名、业务机密或复杂格式，请审阅仍保留的内容。副本并不等于可以公开。
              </p>
            )}
            <pre className="report-preview fp-text-preview">
              {preview.content}
            </pre>
            {preview.task.kind === "redact" && (
              <label className="fp-checkbox">
                <input
                  type="checkbox"
                  checked={copyConfirmed}
                  onChange={(e) => setCopyConfirmed(e.target.checked)}
                />
                我已审阅剩余内容，确认保存为本地副本
              </label>
            )}
            {error && (
              <p role="alert" className="fp-warning">
                {error}
              </p>
            )}
          </div>
          <div className="modal-footer">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setPreview(undefined)}
            >
              关闭预览并清除显示内容
            </button>
            {preview.task.kind === "redact" && (
              <button
                className="primary"
                disabled={busy || !copyConfirmed || !preview.digest}
                onClick={() =>
                  void act(async () => {
                    const r = await api.exportFileTaskCopy(
                      preview.task.id,
                      preview.digest!,
                    );
                    if (!r.cancelled) {
                      setNotice(`本地副本已保存：${r.path}；没有向模型发送。`);
                      setPreview(undefined);
                    }
                  })
                }
              >
                选择新位置保存副本
              </button>
            )}
          </div>
        </Modal>
      )}
      {report && (
        <Modal
          title="脱敏审计报告预览"
          subtitle="文件路径、正文和授权原因不进入导出的报告。"
          wide
          onClose={() => {
            if (!busy) setReport(undefined);
          }}
        >
          <div className="modal-body">
            <pre className="report-preview">{report.content}</pre>
            {error && <p role="alert">{error}</p>}
          </div>
          <div className="modal-footer">
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  setReport(
                    await api.previewFileAudit(scopeId || undefined, "json"),
                  );
                })
              }
            >
              刷新预览
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const r = await api.exportFileAudit(
                    scopeId || undefined,
                    report.digest,
                    report.format,
                  );
                  if (!r.cancelled) {
                    setNotice(`审计报告已保存：${r.path}`);
                    setReport(undefined);
                  }
                })
              }
            >
              选择位置并保存
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
