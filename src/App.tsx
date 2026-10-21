import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Code2,
  Copy,
  Cpu,
  Download,
  FileText,
  GitCompareArrows,
  Globe2,
  History,
  House,
  Info,
  Layers3,
  Loader2,
  LockKeyhole,
  Network,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  TriangleAlert,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import type {
  DesktopAPI,
  Evidence,
  ExportPreview,
  Flow,
  Overview,
  ProcessInfo,
  Session,
  Settings,
  StartInput,
} from "./shared/types";
import { createDemoAPI } from "./demo";
import ToolHome from "./ToolHome";
import ProvidersBoard from "./ProvidersBoard";
import Modal from "./Modal";
import FileProtection from "./FileProtection";
import SkillCenter from "./SkillCenter";
import TaskHandoff from "./TaskHandoff";
import MemoryWorkbench from "./MemoryWorkbench";
import AppUpdates from "./AppUpdates";
import { version as projectVersion } from "../package.json";
import { suggestedEndpoints } from "./shared/tool-network";
import {
  FEATURE_LABELS,
  type ToolInstall,
  type ToolFeature,
} from "./shared/assistant";
declare global {
  interface Window {
    networkLens?: DesktopAPI;
  }
}
type Page =
  | "home"
  | "providers"
  | "workspace"
  | "apps"
  | "compare"
  | "history"
  | "settings"
  | "files"
  | "skills"
  | "memory"
  | "handoff";
const statusText: Record<string, string> = {
  preparing: "准备中",
  collecting: "观察中",
  analyzing: "探测中",
  completed: "已完成",
  cancelled: "已取消",
  interrupted: "运行中断",
  failed: "失败",
};
const stageText: Record<string, string> = {
  config: "配置",
  dns: "DNS",
  tcp: "TCP",
  proxy: "代理",
  tls: "TLS",
  http: "HTTP",
  marker: "错误标记",
  verification: "用户复测",
};
const date = (t: number) =>
  new Date(t).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
const running = (s?: Session) =>
  !!s && ["preparing", "collecting", "analyzing"].includes(s.status);
function Badge({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
function Empty({
  icon: Icon = Layers3,
  title,
  description,
  action,
}: {
  icon?: typeof Layers3;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon size={25} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
export default function App() {
  const [demo, setDemo] = useState(!window.networkLens);
  const api = useMemo(
    () => (demo ? createDemoAPI() : window.networkLens!),
    [demo],
  );
  const [overview, setOverview] = useState<Overview>();
  const [page, setPage] = useState<Page>("providers");
  const [providerTool, setProviderTool] = useState<ToolInstall>();
  const [triageRequested, setTriageRequested] = useState(false);
  const [selected, setSelected] = useState<Session>();
  const [wizard, setWizard] = useState<"diagnose" | "compare">();
  const [wizardTool, setWizardTool] = useState<{
    install: ToolInstall;
    componentId: string;
    feature: ToolFeature;
  }>();
  const [toast, setToast] = useState<{ text: string; error?: boolean }>();
  const [errorMessage, setErrorMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [evidence, setEvidence] = useState<Evidence>();
  const [report, setReport] = useState<ExportPreview>();
  const [deleteId, setDeleteId] = useState<string>();
  const notify = (text: string, error = false) => {
    if (error) setErrorMessage(text);
    else setToast({ text });
  };
  const refresh = async () => setOverview(await api.overview());
  const perform = async <T,>(
    fn: () => Promise<T>,
    success?: string,
  ): Promise<T | undefined> => {
    setBusy(true);
    try {
      const result = await fn();
      if (success) notify(success);
      return result;
    } catch (e) {
      notify(
        (e as Error).message.replace(
          /^Error invoking remote method '[^']+': (Error: )?/,
          "",
        ),
        true,
      );
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    setSelected(undefined);
    setPage("providers");
    void api
      .overview()
      .then(setOverview)
      .catch((e) => notify(e.message, true));
    return api.onUpdate((s) => {
      setSelected((old) => (old?.id === s.id ? s : old));
      setOverview((old) =>
        old
          ? {
              ...old,
              sessions: [s, ...old.sessions.filter((x) => x.id !== s.id)],
              activeId: running(s) ? s.id : undefined,
            }
          : old,
      );
    });
  }, [api]);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(undefined), 6000);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [page]);
  const open = (s: Session, dest: Page = "workspace") => {
    setSelected(s);
    setPage(dest);
  };
  const act = async (
    method: "finish" | "stop" | "mark" | "extend" | "task",
  ) => {
    if (!selected) return;
    const s = await perform(
      () => api[method](selected.id),
      method === "mark" ? "已标记错误发生时刻" : undefined,
    );
    if (s) {
      setSelected(s);
      await refresh();
    }
  };
  const start = async (input: StartInput) => {
    const s = await perform(() => api.start(input));
    if (s) {
      setWizard(undefined);
      setWizardTool(undefined);
      open(s);
      await refresh();
    }
  };
  const nav = [
    { id: "providers", label: "网络检查", icon: Globe2 },
    { id: "home", label: "本机应用", icon: House },
    { id: "workspace", label: "诊断工作区", icon: Activity },
    { id: "apps", label: "应用联网", icon: Network },
    { id: "compare", label: "会话对比", icon: GitCompareArrows },
    { id: "history", label: "诊断历史", icon: History },
  ] as const;
  if (!overview)
    return (
      <div className="loading">
        <Loader2 className="spin" size={26} />
        <p>正在加载本地诊断环境…</p>
        {errorMessage && (
          <>
            <p className="error-text" role="alert">
              {errorMessage}
            </p>
            <button
              className="secondary"
              onClick={() =>
                void refresh()
                  .then(() => setErrorMessage(""))
                  .catch((e) => notify(e.message, true))
              }
            >
              重试加载
            </button>
          </>
        )}
      </div>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="window-space" />
        <div className="brand">
          <div className="brand-mark">
            <Network size={23} />
          </div>
          <div>
            360AI盒子<small>AI 工具网络助手</small>
          </div>
        </div>
        <div className="sidebar-label">工作空间</div>
        <nav>
          {[
            nav[0],
            nav[1],
            { id: "handoff" as const, label: "任务接续", icon: ArrowRight },
            {
              id: "files" as const,
              label: "文件策略与审计",
              icon: ShieldCheck,
            },
            {
              id: "skills" as const,
              label: "Skill 中心",
              icon: Sparkles,
            },
            { id: "memory" as const, label: "记忆工作台", icon: Layers3 },
            nav[5],
          ].map((item) => (
            <button
              key={item.id}
              className={`nav-item ${page === item.id ? "active" : ""}`}
              onClick={() => setPage(item.id)}
            >
              <item.icon size={19} />
              <span>{item.label}</span>
            </button>
          ))}
          <details
            className="nav-advanced"
            open={["workspace", "apps", "compare"].includes(page)}
          >
            <summary>
              高级排查 <ChevronDown size={14} />
            </summary>
            {nav.slice(2, 5).map((item) => (
              <button
                key={item.id}
                className={`nav-item ${page === item.id ? "active" : ""}`}
                onClick={() => setPage(item.id)}
              >
                <item.icon size={19} />
                <span>{item.label}</span>
                {item.id === "workspace" && overview.activeId && (
                  <span className="nav-dot" />
                )}
              </button>
            ))}
          </details>
        </nav>
        <div className="sidebar-bottom">
          <div className="local-card">
            <ShieldCheck size={19} />
            <div>
              本地预览优先<small>任务内容经确认后交接</small>
            </div>
            <span className="status-dot" />
          </div>
          <button
            className={`nav-item ${page === "settings" ? "active" : ""}`}
            onClick={() => setPage("settings")}
          >
            <Settings2 size={19} />
            <span>偏好设置</span>
          </button>
          <div className="sidebar-foot">
            <span>360AI盒子</span>
            <span>v{projectVersion}</span>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            工作空间 <ChevronRight size={13} />
            <span>
              {page === "settings"
                ? "偏好设置"
                : page === "files"
                  ? "文件策略与审计"
                  : page === "skills"
                    ? "Skill 中心"
                  : page === "memory" ? "记忆工作台"
                  : page === "handoff" ? "任务接续" : nav.find((n) => n.id === page)?.label}
            </span>
          </div>
          <div className="topbar-right">
            <span className="status-dot" />
            <span>{demo ? "交互演示" : "本地模式"}</span>
            <span className="divider" />
            <button
              className="icon-button"
              aria-label="查看采集能力"
              onClick={() => setPage("settings")}
            >
              <CircleHelp size={19} />
            </button>
            <span className="avatar">N</span>
          </div>
        </header>
        {demo && (
          <div className="demo-banner">
            <Info size={15} />
            <span>交互演示：页面中的网络结果均为示例，不代表本机诊断。</span>
            {window.networkLens && (
              <button onClick={() => setDemo(false)}>
                返回真实诊断 <ArrowRight size={14} />
              </button>
            )}
          </div>
        )}
        <main className={page === "handoff" ? "handoff-main" : undefined}>
          {errorMessage && (
            <div className="notice amber persistent-error" role="alert">
              <TriangleAlert size={18} />
              <div>
                <strong>操作未完成</strong>
                <p>{errorMessage}</p>
                <span>请检查后重试刚才的操作；此提示不会自动消失。</span>
              </div>
              <button
                className="icon-button"
                aria-label="关闭错误提示"
                onClick={() => setErrorMessage("")}
              >
                <X size={15} />
              </button>
            </div>
          )}
          {page === "providers" && (
            <ProvidersBoard
              api={api}
              onError={(text) => notify(text, true)}
              onAdvanced={() => setWizard("diagnose")}
              tool={providerTool}
              triageRequested={triageRequested}
              onClearTool={() => setProviderTool(undefined)}
              onBack={() => setPage("home")}
            />
          )}
          {page === "home" && (
            <ToolHome
              api={api}
              onError={(text) => notify(text, true)}
              onFiles={() => setPage("files")}
              onProviders={(tool) => {
                setProviderTool(tool);
                setTriageRequested(false);
                setPage("providers");
              }}
              onToolDiagnosis={(install, componentId, feature) => {
                setWizardTool({ install, componentId, feature });
                setWizard("diagnose");
              }}
            />
          )}
          {page === "files" && (
            <FileProtection api={api} onError={(text) => notify(text, true)} />
          )}
          {page === "skills" && (
            <SkillCenter api={api} onError={(text) => notify(text, true)} />
          )}
          {page === "memory" && <MemoryWorkbench api={api} />}
          <div hidden={page !== "handoff"} key={demo ? "demo-handoff" : "local-handoff"}>
            <TaskHandoff api={api} onError={(text) => notify(text, true)} />
          </div>
          {page === "workspace" &&
            (selected ? (
              <Workspace
                session={selected}
                busy={busy}
                onAction={act}
                onEvidence={setEvidence}
                onReport={async () => {
                  const r = await perform(() => api.preview(selected.id, "md"));
                  if (r) setReport(r);
                }}
                onVerify={async (result) => {
                  const s = await perform(
                    () => api.verify(selected.id, result),
                    "复测结果已保存，并标注为用户声明",
                  );
                  if (s) {
                    setSelected(s);
                    await refresh();
                  }
                }}
                onNew={() => setWizard("diagnose")}
                onApps={() => setPage("apps")}
              />
            ) : (
              <>
                <PageHeading
                  title="诊断工作区"
                  description="从复现到验证，让每一步都有证据。"
                />
                <section className="panel">
                  <Empty
                    icon={Activity}
                    title="尚未选择诊断会话"
                    description="开始一次新诊断，或从历史记录中打开已有会话。"
                    action={
                      <button
                        className="primary"
                        onClick={() => setWizard("diagnose")}
                      >
                        <Plus size={16} /> 开始诊断
                      </button>
                    }
                  />
                </section>
              </>
            ))}
          {page === "apps" && (
            <Connections
              api={api}
              selected={selected}
              onClear={() => setSelected(undefined)}
              notify={notify}
            />
          )}
          {page === "compare" && (
            <Compare
              session={selected?.mode === "compare" ? selected : undefined}
              onStart={() => setWizard("compare")}
              onOpen={() => setPage("workspace")}
            />
          )}
          {page === "history" && (
            <HistoryPage
              sessions={overview.sessions}
              onOpen={(s) => open(s)}
              onDelete={setDeleteId}
              onNew={() => setWizard("diagnose")}
            />
          )}
          {page === "settings" && (
            <SettingsPage
              api={api}
              overview={overview}
              busy={busy}
              demo={demo}
              onSave={async (s) => {
                await perform(() => api.settings(s), "偏好设置已保存");
                await refresh();
              }}
            />
          )}
        </main>
        <footer className="main-footer">
          <span>
            <LockKeyhole size={12} /> 本地证据，透明诊断
          </span>
          <span>诊断不采集请求正文 · 任务仅主动导入 · 不自动发送</span>
        </footer>
      </div>
      {wizard && (
        <Wizard
          mode={wizard}
          api={api}
          busy={busy}
          tool={wizardTool}
          onClose={() => {
            setWizard(undefined);
            setWizardTool(undefined);
          }}
          onStart={start}
        />
      )}
      {evidence && (
        <Modal
          title={`证据 ${evidence.id}`}
          subtitle="原始来源与诊断上下文"
          onClose={() => setEvidence(undefined)}
        >
          <div className="modal-body">
            <div className="evidence-heading">
              <Badge tone={evidence.status === "failed" ? "red" : "green"}>
                {evidence.status === "failed"
                  ? "失败"
                  : evidence.status === "success"
                    ? "完成"
                    : "记录"}
              </Badge>
              <h3>{evidence.title}</h3>
            </div>
            <dl className="detail-grid">
              <dt>执行者</dt>
              <dd>
                {evidence.executor === "diagnostic_probe"
                  ? "诊断器主动探测"
                  : evidence.executor}
              </dd>
              <dt>来源</dt>
              <dd>{evidence.source}</dd>
              <dt>阶段 / 路径</dt>
              <dd>
                {stageText[evidence.stage]} / {evidence.route}
              </dd>
              <dt>时间</dt>
              <dd>{new Date(evidence.time).toLocaleString()}</dd>
              <dt>耗时</dt>
              <dd>{evidence.duration ?? "—"} ms</dd>
              <dt>原始错误码</dt>
              <dd>{evidence.code || evidence.httpStatus || "无"}</dd>
            </dl>
            <pre>{evidence.detail}</pre>
            <div className="notice">
              <Info size={16} />{" "}
              诊断器探测结果仅代表此次路径，不能代替目标应用实际请求。
            </div>
          </div>
        </Modal>
      )}
      {report && selected && (
        <Modal
          title="导出前预览"
          subtitle="请核对将要保存的实际内容，导出后报告无法撤回。"
          wide
          onClose={() => setReport(undefined)}
        >
          <div className="modal-body">
            <div className="report-toolbar">
              <div className="segmented">
                {(["md", "json"] as const).map((f) => (
                  <button
                    key={f}
                    className={report.format === f ? "active" : ""}
                    onClick={async () => {
                      const r = await perform(() =>
                        api.preview(selected.id, f),
                      );
                      if (r) setReport(r);
                    }}
                  >
                    {f === "md" ? "Markdown 报告" : "JSON 证据包"}
                  </button>
                ))}
              </div>
              <Badge tone={overview.settings.redact ? "green" : "amber"}>
                {overview.settings.redact
                  ? "默认脱敏开启"
                  : "包含网络地址与配置"}
              </Badge>
            </div>
            <pre className="report-preview">{report.content}</pre>
          </div>
          <div className="modal-footer">
            <button className="secondary" onClick={() => setReport(undefined)}>
              返回
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={async () => {
                const r = await perform(() =>
                  api.export(selected.id, report.digest, report.format),
                );
                if (r?.path) {
                  notify(`报告已保存：${r.path}`);
                  setReport(undefined);
                }
              }}
            >
              <Download size={16} /> 选择位置并保存
            </button>
          </div>
        </Modal>
      )}
      {deleteId && (
        <Modal title="删除本地诊断记录" onClose={() => setDeleteId(undefined)}>
          <div className="modal-body">
            <p>该会话及其证据将从本地记录中删除。已导出的报告不会被删除。</p>
          </div>
          <div className="modal-footer">
            <button
              className="secondary"
              onClick={() => setDeleteId(undefined)}
            >
              取消
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={async () => {
                const removed = await perform(async () => {
                  await api.remove(deleteId);
                  return true;
                }, "诊断记录已删除");
                if (!removed) return;
                if (selected?.id === deleteId) setSelected(undefined);
                setDeleteId(undefined);
                await refresh();
              }}
            >
              删除记录
            </button>
          </div>
        </Modal>
      )}
      {toast && (
        <div role="status" className={`toast ${toast.error ? "error" : ""}`}>
          {toast.error ? (
            <TriangleAlert size={18} />
          ) : (
            <CheckCircle2 size={18} />
          )}
          <span>{toast.text}</span>
          <button
            className="icon-button"
            onClick={() => setToast(undefined)}
            aria-label="关闭提示"
          >
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
function PageHeading({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading compact">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
function SessionRows({
  sessions,
  onOpen,
  onDelete,
}: {
  sessions: Session[];
  onOpen: (s: Session) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="session-rows">
      {sessions.map((s) => (
        <div className="session-row" key={s.id}>
          <button className="session-main" onClick={() => onOpen(s)}>
            <div
              className={`session-icon ${s.findings.some((f) => f.severity === "warning" || f.severity === "error") ? "amber" : "blue"}`}
            >
              {s.mode === "compare" ? (
                <GitCompareArrows size={20} />
              ) : (
                <Terminal size={20} />
              )}
            </div>
            <div>
              <h3>{s.name}</h3>
              <p>
                {s.target} <span>·</span> {s.process?.name || "仅目标探测"}
              </p>
            </div>
          </button>
          <Badge
            tone={
              running(s) ? "blue" : s.status === "completed" ? "green" : "muted"
            }
          >
            {statusText[s.status]}
          </Badge>
          <span className="row-date">{date(s.started)}</span>
          <button
            className="icon-button"
            aria-label={`删除 ${s.name}`}
            disabled={running(s)}
            onClick={() => onDelete(s.id)}
          >
            <Trash2 size={15} />
          </button>
          <button
            className="icon-button"
            aria-label={`打开 ${s.name}`}
            onClick={() => onOpen(s)}
          >
            <ChevronRight size={17} />
          </button>
        </div>
      ))}
    </div>
  );
}
function Wizard({
  mode,
  api,
  busy,
  onClose,
  onStart,
  tool,
}: {
  mode: "diagnose" | "compare";
  api: DesktopAPI;
  busy: boolean;
  onClose: () => void;
  onStart: (input: StartInput) => void;
  tool?: { install: ToolInstall; componentId: string; feature: ToolFeature };
}) {
  const [step, setStep] = useState(1),
    [processes, setProcesses] = useState<ProcessInfo[]>([]),
    [loadError, setLoadError] = useState(""),
    [loading, setLoading] = useState(true),
    [search, setSearch] = useState(""),
    [processKey, setProcessKey] = useState(
      tool?.install.identityStatus === "running_confirmed" &&
        tool.install.components.find((c) => c.id === tool.componentId)?.role ===
          "host" &&
        tool.install.processKeys.length === 1
        ? tool.install.processKeys[0]
        : "",
    ),
    [scope, setScope] = useState<string[]>([]),
    [target, setTarget] = useState(""),
    [name, setName] = useState(
      tool ? `${tool.install.name} · ${FEATURE_LABELS[tool.feature]}诊断` : "",
    ),
    [duration, setDuration] = useState(60),
    [useProxy, setUseProxy] = useState(false),
    [proxy, setProxy] = useState("");
  useEffect(() => {
    void api
      .processes()
      .then(setProcesses)
      .catch((e) => setLoadError(e.message))
      .finally(() => setLoading(false));
  }, [api]);
  const root = processes.find((p) => p.key === processKey);
  const children = root ? processes.filter((p) => p.ppid === root.pid) : [];
  const filtered = processes
    .filter((p) =>
      `${p.name} ${p.pid}`.toLowerCase().includes(search.toLowerCase()),
    )
    .slice(0, 80);
  let normalized = "";
  try {
    const u = new URL(target.includes("://") ? target : `https://${target}`);
    if (u.protocol === "https:" && !u.username && !u.password)
      normalized = `${u.origin}/`;
  } catch {}
  return (
    <Modal
      title={mode === "compare" ? "新建 AI 工具联网对比" : "开始一次网络诊断"}
      subtitle="确认观察范围和探测目标，每一步都由你掌控。"
      wide
      onClose={onClose}
    >
      <div className="wizard-steps">
        <span className={step === 1 ? "current" : "done"}>
          <b>{step > 1 ? <Check size={13} /> : 1}</b>选择目标
        </span>
        <div />
        <span className={step === 2 ? "current" : ""}>
          <b>2</b>确认诊断计划
        </span>
      </div>
      <div className="modal-body wizard-body">
        {tool && (
          <div className="notice">
            <Info size={17} />
            <div>
              {tool.install.name} ·{" "}
              {
                tool.install.components.find((c) => c.id === tool.componentId)
                  ?.name
              }{" "}
              · {FEATURE_LABELS[tool.feature]}
              <br />
              组件版本{" "}
              {tool.install.components.find((c) => c.id === tool.componentId)
                ?.version || "未知"}
              （宿主版本 {tool.install.version || "未知"}）
              ；计划在开始时从本机记录冻结。适配未验证，请输入经你确认的端点。本次结果只证明诊断器路径，真实功能需在工具中复测。
            </div>
          </div>
        )}
        {step === 1 ? (
          <>
            <label>
              诊断名称 <span>可选</span>
              <input
                placeholder={
                  mode === "compare"
                    ? "例如：一次代码生成任务的联网变化"
                    : "例如：CLI 客户端连接超时"
                }
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
              />
            </label>
            <label>
              目标域名或 HTTPS URL <em>*</em>
              <input
                autoFocus
                placeholder="例如：api.openai.com 或 https://github.com"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                maxLength={2048}
              />
            </label>
            <p className="field-help">
              仅探测你明确选择的目标，默认使用 HEAD
              /，移除路径、查询参数和片段。
              {normalized && <> 实际探测地址：{normalized}</>}
            </p>
            {tool &&
              suggestedEndpoints(tool.install.productId).map(
                ({ provider, endpoint }) => (
                  <button
                    key={endpoint.id}
                    className="text-button"
                    onClick={() => setTarget(endpoint.url)}
                  >
                    使用 {provider.name} 官方域名（建议，非应用配置）
                  </button>
                ),
              )}
            <div className="field-heading">
              <strong>选择目标应用 {mode === "compare" && <em>*</em>}</strong>
              <span>
                {mode === "diagnose"
                  ? "也可只做域名探测"
                  : "用于限定基线与任务观察范围"}
              </span>
            </div>
            <div className="search-field">
              <Search size={16} />
              <input
                placeholder="搜索应用名或 PID"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="process-picker">
              {loading ? (
                <div className="inline-loading">
                  <Loader2 size={17} className="spin" />
                  读取当前进程…
                </div>
              ) : loadError ? (
                <div className="notice amber">
                  <TriangleAlert size={16} />
                  无法读取进程：{loadError}
                </div>
              ) : (
                filtered.map((p) => (
                  <button
                    key={p.key}
                    className={`process-option ${processKey === p.key ? "selected" : ""}`}
                    onClick={() => {
                      setProcessKey(processKey === p.key ? "" : p.key);
                      setScope([]);
                    }}
                  >
                    <div className="process-symbol">
                      <Code2 size={17} />
                    </div>
                    <span>
                      {p.name}
                      <small>
                        PID {p.pid} · {p.created}
                      </small>
                    </span>
                    {processKey === p.key ? (
                      <CheckCircle2 size={18} />
                    ) : (
                      <span className="radio-empty" />
                    )}
                  </button>
                ))
              )}
            </div>
            {root && children.length > 0 && (
              <div className="child-processes">
                <div className="field-heading">
                  <strong>候选子进程</strong>
                  <span>请确认哪些进程属于本次任务</span>
                </div>
                {children.slice(0, 25).map((p) => (
                  <label key={p.key} className="check-line">
                    <input
                      type="checkbox"
                      checked={scope.includes(p.key)}
                      onChange={(e) =>
                        setScope(
                          e.target.checked
                            ? [...scope, p.key]
                            : scope.filter((k) => k !== p.key),
                        )
                      }
                    />
                    {p.name}
                    <span>PID {p.pid} · 用户确认范围</span>
                  </label>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="plan-card">
              <div className="plan-icon">
                <Globe2 size={24} />
              </div>
              <div>
                <small>已批准探测目标</small>
                <h3>{normalized || target}</h3>
                <p>
                  {root
                    ? `${root.name} · PID ${root.pid} · ${scope.length} 个已确认子进程`
                    : "仅诊断器主动探测，不采集其他应用的连接"}
                </p>
              </div>
            </div>
            <label>
              观察时长
              <div className="duration-options">
                {[30, 60, 120].map((v) => (
                  <button
                    key={v}
                    className={duration === v ? "selected" : ""}
                    onClick={() => setDuration(v)}
                  >
                    {v} 秒 {v === 60 && <small>推荐</small>}
                  </button>
                ))}
              </div>
            </label>
            {mode === "compare" ? (
              <div className="notice">
                <Info size={17} />
                <div>
                  先记录空闲基线，再手动开始任务窗口。两个窗口仅比较 TCP
                  目标，不判断请求内容或数据泄露。
                </div>
              </div>
            ) : (
              <>
                <label className="check-line route-check">
                  <input
                    type="checkbox"
                    checked={useProxy}
                    onChange={(e) => setUseProxy(e.target.checked)}
                  />
                  <span>
                    同时比较指定代理路径
                    <small>直连与代理独立探测，不修改系统设置</small>
                  </span>
                </label>
                {useProxy && (
                  <label>
                    代理地址
                    <input
                      value={proxy}
                      onChange={(e) => setProxy(e.target.value)}
                      placeholder="http://127.0.0.1:7897"
                    />
                    <span className="field-help">
                      支持无认证 HTTP CONNECT / SOCKS5；不执行 PAC 脚本。
                    </span>
                  </label>
                )}
                <div className="probe-plan">
                  {["保存配置", "观察复现", "DNS", "TCP", "TLS", "HTTP"].map(
                    (v, i) => (
                      <span key={v}>
                        {i > 0 && <ChevronRight size={12} />}
                        <span>{v}</span>
                      </span>
                    ),
                  )}
                </div>
              </>
            )}
            <div className="notice">
              <ShieldCheck size={17} />
              <div>
                探测由诊断器执行，目标软件的网络栈可能不同。不会发送应用令牌、读取请求正文或自动修改网络配置。
              </div>
            </div>
          </>
        )}
      </div>
      <div className="modal-footer">
        <span className="footer-hint">
          <LockKeyhole size={13} /> 证据仅保存在本机
        </span>
        {step === 1 ? (
          <>
            <button className="secondary" onClick={onClose}>
              取消
            </button>
            <button
              className="primary"
              disabled={!normalized || (mode === "compare" && !root)}
              onClick={() => setStep(2)}
            >
              下一步 <ArrowRight size={15} />
            </button>
          </>
        ) : (
          <>
            <button className="secondary" onClick={() => setStep(1)}>
              <ArrowLeft size={15} /> 上一步
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                onStart({
                  tool: tool
                    ? {
                        installId: tool.install.id,
                        componentId: tool.componentId,
                        feature: tool.feature,
                      }
                    : undefined,
                  name,
                  target,
                  duration,
                  processKey: processKey || undefined,
                  scopeKeys: scope,
                  mode,
                  proxy: useProxy ? proxy : undefined,
                  clientRequestId: crypto.randomUUID(),
                })
              }
            >
              {busy ? (
                <Loader2 size={16} className="spin" />
              ) : (
                <Radio size={16} />
              )}{" "}
              开始观察
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
function Workspace({
  session: s,
  busy,
  onAction,
  onEvidence,
  onReport,
  onVerify,
  onNew,
  onApps,
}: {
  session: Session;
  busy: boolean;
  onAction: (method: "finish" | "stop" | "mark" | "extend" | "task") => void;
  onEvidence: (e: Evidence) => void;
  onReport: () => void;
  onVerify: (result: "success" | "failed" | "unknown") => void;
  onNew: () => void;
  onApps: () => void;
}) {
  const [tab, setTab] = useState("result"),
    [filter, setFilter] = useState("all"),
    [tick, setTick] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const active = running(s),
    remaining = s.deadline
      ? Math.max(0, Math.ceil((s.deadline - tick) / 1000))
      : 0;
  const stages = ["配置基线", "观察复现", "分层探测", "诊断结论"];
  const current =
    s.status === "preparing"
      ? 0
      : s.status === "collecting"
        ? 1
        : s.status === "analyzing"
          ? 2
          : 3;
  const evidence = s.evidence.filter(
    (e) =>
      filter === "all" ||
      e.route === filter ||
      (filter === "failed" && e.status === "failed"),
  );
  return (
    <>
      <PageHeading
        title={s.name}
        description={`${s.process?.name || "诊断器"} · ${s.target} · ${date(s.started)}`}
        action={
          <>
            <Badge
              tone={
                active ? "blue" : s.status === "completed" ? "green" : "muted"
              }
            >
              {active && <span className="status-dot pulse" />}
              {statusText[s.status]}
            </Badge>
            <button
              className="secondary"
              onClick={onReport}
              disabled={busy || active}
            >
              <ArrowDownToLine size={16} /> 导出报告
            </button>
          </>
        }
      />
      {s.toolContext && (
        <div className="notice">
          <Info size={17} />
          <div>
            冻结的工具范围：{s.toolContext.toolName} ·{" "}
            {s.toolContext.componentName} ·{" "}
            {FEATURE_LABELS[s.toolContext.feature]} · 版本{" "}
            {s.toolContext.version || "未知"} ·{" "}
            {s.toolContext.runtime === "local" ? "本机" : "运行位置未知"}
            <br />
            适配未验证；本次探测不证明工具功能恢复。目标功能复测记录仍属于用户声明。
          </div>
        </div>
      )}
      <section className="panel progress-panel">
        <div className="stage-progress">
          {stages.map((stage, i) => (
            <div
              className={`progress-stage ${i < current ? "done" : i === current ? "current" : ""}`}
              key={stage}
            >
              <span className="stage-circle">
                {i < current ? <Check size={14} /> : i + 1}
              </span>
              <span>
                {s.mode === "compare" && i === 2 ? "窗口对比" : stage}
              </span>
              {i < 3 && <div className="stage-line" />}
            </div>
          ))}
        </div>
        {active ? (
          <div className="collecting-area">
            <div className="collecting-status">
              <div className="collecting-icon">
                <Radio size={23} />
              </div>
              <div>
                <h3>{s.phase}</h3>
                <p>
                  {s.status === "collecting"
                    ? s.mode === "compare" && !s.baselineEnded
                      ? "暂时保持应用空闲，准备好后开始任务窗口。"
                      : "现在切换到目标软件复现问题，出现错误时回来标记。"
                    : "任务在本地核心运行，切换页面不会重新开始。"}
                </p>
              </div>
              <div className="countdown">
                <strong>{s.status === "collecting" ? remaining : "…"}</strong>
                <small>
                  {s.status === "collecting" ? "秒剩余" : "分层探测中"}
                </small>
              </div>
            </div>
            <div className="collecting-actions">
              <div>
                <button
                  className="secondary"
                  disabled={busy || s.status !== "collecting"}
                  onClick={() => onAction("mark")}
                >
                  <Zap size={15} /> 标记错误时刻{" "}
                  {s.markers.length > 0 && <Badge>{s.markers.length}</Badge>}
                </button>
                <button
                  className="text-button"
                  disabled={busy || s.status !== "collecting"}
                  onClick={() => onAction("extend")}
                >
                  <Clock3 size={15} /> 延长 60 秒
                </button>
              </div>
              <div>
                <button
                  className="text-button muted-button"
                  disabled={busy}
                  onClick={() => onAction("stop")}
                >
                  <Square size={12} /> 取消诊断
                </button>
                {s.mode === "compare" && !s.baselineEnded ? (
                  <button
                    className="primary"
                    disabled={busy || s.status !== "collecting"}
                    onClick={() => onAction("task")}
                  >
                    开始任务窗口 <ArrowRight size={15} />
                  </button>
                ) : (
                  <button
                    className="primary"
                    disabled={busy || s.status !== "collecting"}
                    onClick={() => onAction("finish")}
                  >
                    完成观察 <ArrowRight size={15} />
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="completed-strip">
            <CheckCircle2 size={17} />
            <span>{s.phase}</span>
            <span>
              {s.evidence.length} 条证据 <span>·</span> {s.flows.length}{" "}
              条连接观察
            </span>
          </div>
        )}
      </section>
      {s.error && (
        <div className="notice amber">
          <TriangleAlert size={17} />
          {s.error}
        </div>
      )}
      <div className="workspace-tabs">
        {[
          { id: "result", name: "诊断结论", count: s.findings.length },
          { id: "evidence", name: "分层探测证据", count: s.evidence.length },
          { id: "connections", name: "应用连接", count: s.flows.length },
          { id: "config", name: "网络配置", count: s.config.length },
        ].map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "active" : ""}
            onClick={() => setTab(t.id)}
          >
            {t.name}
            <span>{t.count}</span>
          </button>
        ))}
      </div>
      {tab === "result" && (
        <div className="results-layout">
          <div className="findings-column">
            {s.findings.length ? (
              s.findings.map((f, i) => (
                <section className={`panel finding ${f.severity}`} key={f.id}>
                  <div className="finding-top">
                    <div className="finding-icon">
                      {f.severity === "info" ? (
                        <Info size={21} />
                      ) : (
                        <TriangleAlert size={21} />
                      )}
                    </div>
                    <span>
                      {i === 0 ? "优先查看" : "补充观察"}{" "}
                      <span className="rule-id">
                        {f.ruleId} · v{f.version}
                      </span>
                    </span>
                    <Badge tone={f.support === "limited" ? "amber" : "muted"}>
                      {f.support === "limited" ? "支持有限" : "不足以判断"}
                    </Badge>
                  </div>
                  <h2>{f.title}</h2>
                  <p className="finding-description">{f.description}</p>
                  <div className="supporting-evidence">
                    <small>支持证据</small>
                    <div>
                      {f.evidenceIds.length ? (
                        f.evidenceIds.map((id) => {
                          const e = s.evidence.find((e) => e.id === id);
                          return (
                            <button key={id} onClick={() => e && onEvidence(e)}>
                              <FileText size={14} />
                              <strong>{id}</strong>
                              <span>{e?.title}</span>
                              <ChevronRight size={14} />
                            </button>
                          );
                        })
                      ) : (
                        <span className="muted">暂无可引用的分层探测证据</span>
                      )}
                    </div>
                  </div>
                  <div className="finding-next">
                    <span className="next-number">→</span>
                    <div>
                      <strong>下一步验证</strong>
                      <p>{f.nextCheck}</p>
                    </div>
                  </div>
                  <div className="finding-bottom">
                    <button
                      className="text-button"
                      onClick={() => setTab("evidence")}
                    >
                      查看完整依据 <ArrowRight size={14} />
                    </button>
                    <span>结论来自本地确定性规则</span>
                  </div>
                </section>
              ))
            ) : (
              <section className="panel">
                <Empty
                  icon={active ? Radio : CircleHelp}
                  title={
                    active
                      ? "证据记录中，结论将在探测后生成"
                      : "当前没有诊断结论"
                  }
                  description={
                    active
                      ? "请先复现问题，完成观察后会运行本地规则。"
                      : "可打开已记录证据，或开始新的诊断。"
                  }
                />
              </section>
            )}
            {!active && s.findings.length > 0 && (
              <section className="panel verification">
                <div className="section-heading">
                  <div>
                    <h2>建议是否帮助你解决了问题？</h2>
                    <p>请在目标软件中手动复测，再记录结果。</p>
                  </div>
                  <CheckCircle2 size={21} />
                </div>
                <div className="verify-options">
                  {[
                    { id: "success", label: "复测成功", icon: CheckCircle2 },
                    { id: "failed", label: "仍然失败", icon: XCircle },
                    { id: "unknown", label: "暂不确定", icon: CircleHelp },
                  ].map((v) => (
                    <button
                      key={v.id}
                      className={`secondary ${s.verified === v.id ? "selected" : ""}`}
                      disabled={busy}
                      onClick={() =>
                        onVerify(v.id as "success" | "failed" | "unknown")
                      }
                    >
                      <v.icon size={16} />
                      {v.label}
                    </button>
                  ))}
                </div>
                <small>
                  此项记录为用户声明，不会替代目标应用的实际请求证据。
                </small>
              </section>
            )}
          </div>
          <aside className="result-sidebar">
            <section className="panel limitations">
              <div className="section-heading">
                <h3>
                  <CircleHelp size={17} /> 尚未确认
                </h3>
              </div>
              <ul>
                {[...new Set(s.findings.flatMap((f) => f.missing))].map((v) => (
                  <li key={v}>{v}</li>
                ))}
              </ul>
              {!s.findings.length && <p>诊断完成后显示规则缺口。</p>}
              <div className="side-divider" />
              <h3>观察范围</h3>
              <dl>
                <dt>目标应用</dt>
                <dd>{s.process?.name || "未选择"}</dd>
                <dt>确认进程</dt>
                <dd>{s.scope.length} 个实例</dd>
                <dt>采集来源</dt>
                <dd>TCP 快照</dd>
                <dt>丢失 / 截断</dt>
                <dd>{s.dropped}</dd>
              </dl>
              <button className="text-button" onClick={onApps}>
                查看应用联网 <ArrowRight size={13} />
              </button>
            </section>
            <section className="panel explanation">
              <div className="quick-icon purple">
                <Sparkles size={19} />
              </div>
              <h3>本地解释已就绪</h3>
              <p>
                规则结论不依赖模型。当前版本没有开启云端
                AI，诊断证据不会发送给模型服务。
              </p>
              <Badge>本地规则 · 无外发</Badge>
            </section>
          </aside>
        </div>
      )}
      {tab === "evidence" && (
        <section className="panel evidence-panel">
          <div className="section-heading">
            <div>
              <h2>可追溯的分层证据</h2>
              <p>所有主动探测均由 diagnostic_probe 执行。</p>
            </div>
            <select
              aria-label="筛选证据"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="all">全部路径与结果</option>
              <option value="direct">仅直连</option>
              <option value="failed">仅失败</option>
              {s.proxy && <option value={s.proxy}>仅指定代理</option>}
            </select>
          </div>
          {evidence.length ? (
            <div className="evidence-list">
              {evidence.map((e) => (
                <button
                  className="evidence-row"
                  key={e.id}
                  onClick={() => onEvidence(e)}
                >
                  <div className={`evidence-status ${e.status}`}>
                    {e.status === "success" ? (
                      <Check size={15} />
                    ) : e.status === "failed" ? (
                      <X size={15} />
                    ) : (
                      <Info size={15} />
                    )}
                  </div>
                  <span className="evidence-id">{e.id}</span>
                  <Badge>{stageText[e.stage]}</Badge>
                  <div className="evidence-label">
                    <strong>{e.title}</strong>
                    <small>
                      {e.route === "direct"
                        ? "直连"
                        : e.route === "local"
                          ? "本地记录"
                          : e.route}
                    </small>
                  </div>
                  <span className="mono muted">
                    {e.duration === undefined ? "—" : `${e.duration} ms`}
                  </span>
                  <ChevronRight size={15} />
                </button>
              ))}
            </div>
          ) : (
            <Empty
              title="当前筛选下没有证据"
              description="观察或探测完成后，阶段结果会保存在这里。"
            />
          )}
        </section>
      )}
      {tab === "connections" && (
        <section className="panel">
          <div className="section-heading">
            <div>
              <h2>本会话连接观察</h2>
              <p>限定到用户确认的进程实例；远端 IP 不能确认请求域名。</p>
            </div>
            <Badge>{s.flows.length} 条记录</Badge>
          </div>
          <FlowTable flows={s.flows} />
        </section>
      )}
      {tab === "config" && (
        <section className="panel">
          <div className="section-heading">
            <div>
              <h2>网络配置快照</h2>
              <p>各配置属于独立来源，不合并成目标应用的“有效代理”。</p>
            </div>
          </div>
          <div className="config-list">
            {s.config.map((c) => (
              <div key={c.name}>
                <div>
                  <strong>{c.name}</strong>
                  <small>{c.source}</small>
                </div>
                <pre>{c.value || "空"}</pre>
                <Badge tone={c.state === "read" ? "green" : "amber"}>
                  {c.state === "read" ? "已读取" : "无法读取"}
                </Badge>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
function FlowTable({ flows }: { flows: Flow[] }) {
  return flows.length ? (
    <div className="table-wrap">
      <table className="flow-table">
        <thead>
          <tr>
            <th>进程 / PID</th>
            <th>远端地址</th>
            <th>连接状态</th>
            <th>地址族</th>
            <th>首次 / 末次观察</th>
          </tr>
        </thead>
        <tbody>
          {flows.slice(0, 500).map((f) => (
            <tr key={f.id}>
              <td>
                <div className="process-cell">
                  <span className="tiny-icon">
                    <Code2 size={14} />
                  </span>
                  <span>
                    <strong>{f.process}</strong>
                    <small>PID {f.pid}</small>
                  </span>
                </div>
              </td>
              <td>
                <span className="mono">{f.remote}</span>
                <small>仅 IP 与端口 · 域名未确认</small>
              </td>
              <td>
                <Badge tone={/SYN|TIME/.test(f.state) ? "amber" : "green"}>
                  {f.state}
                </Badge>
              </td>
              <td>{f.family}</td>
              <td>
                <span className="mono small">
                  {new Date(f.firstSeen).toLocaleTimeString("zh-CN", {
                    hour12: false,
                  })}{" "}
                  /{" "}
                  {new Date(f.lastSeen).toLocaleTimeString("zh-CN", {
                    hour12: false,
                  })}
                </span>
                <small>
                  {f.window === "task" ? "任务窗口" : "基线 / 观察窗口"}
                </small>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {flows.length > 500 && (
        <p className="table-note">
          当前显示前 500 条连接，请限定进程范围查看。
        </p>
      )}
    </div>
  ) : (
    <Empty
      icon={Network}
      title="尚未观察到连接"
      description="未观察到不代表没有联网；快照可能漏掉短连接或受限进程。"
    />
  );
}
function Connections({
  api,
  selected,
  onClear,
  notify,
}: {
  api: DesktopAPI;
  selected?: Session;
  onClear: () => void;
  notify: (text: string, error?: boolean) => void;
}) {
  const [processes, setProcesses] = useState<ProcessInfo[]>([]),
    [key, setKey] = useState(""),
    [flows, setFlows] = useState<Flow[]>([]),
    [loading, setLoading] = useState(false),
    [search, setSearch] = useState(""),
    [error, setError] = useState(""),
    [time, setTime] = useState<number>();
  const load = async () => {
    setLoading(true);
    try {
      const ps = await api.processes();
      setProcesses(ps);
      const result = await api.connections(key || undefined);
      setFlows(result.flows);
      setError(result.error || "");
      setTime(Date.now());
    } catch (e) {
      setError((e as Error).message);
      notify((e as Error).message, true);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (!selected) void load();
  }, [api, selected?.id, key]);
  const shown = (selected ? selected.flows : flows).filter((f) =>
    `${f.process} ${f.remote} ${f.pid} ${f.state}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <>
      <PageHeading
        title="应用联网"
        description="查看进程的 TCP 连接，核对每条记录的实际来源。"
        action={
          selected ? (
            <button className="secondary" onClick={onClear}>
              <RefreshCw size={15} /> 查看当前快照
            </button>
          ) : (
            <button className="secondary" disabled={loading} onClick={load}>
              <RefreshCw size={15} className={loading ? "spin" : ""} /> 刷新快照
            </button>
          )
        }
      />
      <div className="notice">
        <Info size={17} />
        {selected
          ? `正在查看会话「${selected.name}」的连接观察。`
          : "手动刷新本机连接快照，不在后台持续监控。"}{" "}
        只读采集可能存在权限限制和短连接盲区。
      </div>
      <div className="metric-grid">
        <div className="panel metric">
          <small>观察到的连接</small>
          <strong>
            {shown.length}
            <span>TCP</span>
          </strong>
        </div>
        <div className="panel metric">
          <small>关联进程实例</small>
          <strong>
            {new Set(shown.map((f) => f.processKey)).size}
            <span>个</span>
          </strong>
        </div>
        <div className="panel metric">
          <small>远端目标</small>
          <strong>
            {new Set(shown.map((f) => f.remote)).size}
            <span>IP : 端口</span>
          </strong>
        </div>
      </div>
      <section className="panel">
        <div className="connection-toolbar">
          <div className="search-field">
            <Search size={16} />
            <input
              placeholder="筛选进程、地址或状态"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {!selected && (
            <select
              aria-label="选择联网进程"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            >
              <option value="">全部可读进程</option>
              {processes.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name} · {p.pid}
                </option>
              ))}
            </select>
          )}
          <span className="muted small">
            {selected
              ? "会话证据"
              : time
                ? `快照 ${new Date(time).toLocaleTimeString()}`
                : "等待刷新"}
          </span>
        </div>
        {error && (
          <div className="notice amber">
            <TriangleAlert size={16} />
            {error}
          </div>
        )}
        {loading ? (
          <div className="inline-loading">
            <Loader2 className="spin" size={19} />
            正在读取进程和 TCP 连接…
          </div>
        ) : (
          <FlowTable flows={shown} />
        )}
      </section>
      <div className="footnote">
        <Info size={14} /> 列表不包含 UDP / QUIC
        的远端流，不提供上传字节数，也不推断请求内容。
      </div>
    </>
  );
}
function Compare({
  session: s,
  onStart,
  onOpen,
}: {
  session?: Session;
  onStart: () => void;
  onOpen: () => void;
}) {
  const [onlyNew, setOnlyNew] = useState(true);
  const baseline = new Set(
    s?.flows.filter((f) => f.window === "baseline").map((f) => f.remote) || [],
  );
  const task = s?.flows.filter((f) => f.window === "task") || [];
  const added = task.filter((f) => !baseline.has(f.remote));
  return (
    <>
      <PageHeading
        title="AI 工具联网对比"
        description="先记录空闲基线，再观察一次任务期间新增的联网目标。"
        action={
          <button className="primary" onClick={onStart}>
            <Plus size={16} /> 新建对比
          </button>
        }
      />
      {!s ? (
        <>
          <div className="compare-intro panel">
            <div className="compare-illustration">
              <div>
                <Clock3 size={26} />
                <span>空闲基线</span>
                <small>保持应用空闲</small>
              </div>
              <ArrowRight size={25} />
              <div>
                <Terminal size={26} />
                <span>任务窗口</span>
                <small>手动开始任务</small>
              </div>
              <ArrowRight size={25} />
              <div>
                <GitCompareArrows size={26} />
                <span>目标变化</span>
                <small>核对进程与来源</small>
              </div>
            </div>
            <h2>了解一次任务的联网变化</h2>
            <p>
              适用于 IDE、Agent 和用户确认的子进程。新增目标是观察结果，
              <br />
              需要结合后台任务、CDN 切换和采集覆盖进行判断。
            </p>
            <button className="primary" onClick={onStart}>
              <Plus size={16} /> 选择应用，建立基线
            </button>
          </div>
          <div className="notice">
            <ShieldCheck size={17} />{" "}
            不读取提示词、仓库源码、聊天正文或剪贴板。联网变化不能用于推断敏感数据外传。
          </div>
        </>
      ) : (
        <>
          <div className="notice">
            <Info size={17} />
            {s.name} · {statusText[s.status]}
            <button className="text-button" onClick={onOpen}>
              打开工作区 <ArrowRight size={14} />
            </button>
          </div>
          <div className="metric-grid">
            <div className="panel metric">
              <small>基线目标</small>
              <strong>
                {baseline.size}
                <span>个</span>
              </strong>
            </div>
            <div className="panel metric">
              <small>任务目标</small>
              <strong>
                {new Set(task.map((f) => f.remote)).size}
                <span>个</span>
              </strong>
            </div>
            <div className="panel metric">
              <small>新增目标</small>
              <strong>
                {new Set(added.map((f) => f.remote)).size}
                <span>个 · 待核对</span>
              </strong>
            </div>
          </div>
          <section className="panel">
            <div className="section-heading">
              <div>
                <h2>任务窗口的联网观察</h2>
                <p>目标按 IP 与端口比较，域名未确认。</p>
              </div>
              <label className="check-line">
                <input
                  type="checkbox"
                  checked={onlyNew}
                  onChange={(e) => setOnlyNew(e.target.checked)}
                />
                只看新增目标
              </label>
            </div>
            <FlowTable flows={onlyNew ? added : task} />
          </section>
          <div className="notice amber">
            <TriangleAlert size={17} /> 两个窗口的观察时长与覆盖可能不同，新增
            IP 可能来自 CDN 或后台行为。
          </div>
        </>
      )}
    </>
  );
}
function HistoryPage({
  sessions,
  onOpen,
  onDelete,
  onNew,
}: {
  sessions: Session[];
  onOpen: (s: Session) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
}) {
  const [search, setSearch] = useState(""),
    [filter, setFilter] = useState("all");
  const shown = sessions.filter(
    (s) =>
      `${s.name} ${s.target} ${s.process?.name || ""}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (filter === "all" || s.status === filter),
  );
  return (
    <>
      <PageHeading
        title="诊断历史"
        description="保留每次诊断的现场、结论和用户复测，方便回看。"
        action={
          <button className="primary" onClick={onNew}>
            <Plus size={16} /> 开始新诊断
          </button>
        }
      />
      <section className="panel">
        <div className="connection-toolbar">
          <div className="search-field">
            <Search size={16} />
            <input
              placeholder="搜索诊断名称、目标或应用"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="history-status-select">
            <select
              aria-label="筛选历史状态"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="all">全部状态</option>
              {Object.entries(statusText).map(([k, v]) => (
                <option value={k} key={k}>
                  {v}
                </option>
              ))}
            </select>
            <ChevronDown size={17} aria-hidden="true" />
          </div>
          <span className="muted small">{shown.length} 条记录</span>
        </div>
        {shown.length ? (
          <SessionRows sessions={shown} onOpen={onOpen} onDelete={onDelete} />
        ) : (
          <Empty
            icon={History}
            title="没有匹配的诊断记录"
            description="调整搜索条件，或开始一次新的诊断。"
          />
        )}
      </section>
    </>
  );
}
function SettingsPage({
  api,
  overview,
  busy,
  demo,
  onSave,
}: {
  api: DesktopAPI;
  overview: Overview;
  busy: boolean;
  demo: boolean;
  onSave: (s: Settings) => void;
}) {
  const [settings, setSettings] = useState(overview.settings);
  return (
    <>
      <PageHeading
        title="偏好设置"
        description="控制记录保留、报告脱敏与诊断能力。"
      />
      <div className="settings-layout">
        <AppUpdates api={api} demo={demo} />
        <section className="panel settings-panel">
          <div className="section-heading">
            <div>
              <h2>
                <LockKeyhole size={19} /> 数据与隐私
              </h2>
              <p>本地记录不包含请求正文、认证头或模型密钥。</p>
            </div>
          </div>
          <div className="setting-row">
            <div>
              <h3>诊断记录保留时间</h3>
              <p>启动与会话完成时清理超过保留期的记录。</p>
            </div>
            <select
              aria-label="记录保留天数"
              value={settings.retentionDays}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  retentionDays: Number(e.target.value) as 1 | 7 | 30,
                })
              }
            >
              <option value={1}>1 天</option>
              <option value={7}>7 天 · 默认</option>
              <option value={30}>30 天</option>
            </select>
          </div>
          <div className="setting-row">
            <div>
              <h3>导出时默认脱敏</h3>
              <p>隐藏目标、地址、进程标识与配置值；保存前可预览。</p>
            </div>
            <button
              role="switch"
              aria-checked={settings.redact}
              aria-label="导出默认脱敏"
              className={`toggle ${settings.redact ? "on" : ""}`}
              onClick={() =>
                setSettings({ ...settings, redact: !settings.redact })
              }
            >
              <span />
            </button>
          </div>
          <div className="setting-save">
            <span>本地数据库依赖系统磁盘保护，未完整加密。</span>
            <button
              className="primary"
              disabled={busy}
              onClick={() => onSave(settings)}
            >
              <Check size={15} /> 保存设置
            </button>
          </div>
        </section>
        <section className="panel settings-panel">
          <div className="section-heading">
            <div>
              <h2>
                <Cpu size={19} /> 当前环境与采集能力
              </h2>
              <p>只展示当前实现提供的能力，缺失不视为安全。</p>
            </div>
            <Badge tone={demo ? "amber" : "green"}>
              {demo ? "示例环境" : "普通权限"}
            </Badge>
          </div>
          <dl className="capability-grid">
            <dt>运行平台</dt>
            <dd>{overview.coverage.platform}</dd>
            <dt>采集来源</dt>
            <dd>{overview.coverage.collector}</dd>
            <dt>主动探测</dt>
            <dd>
              <Badge tone="green">
                DNS / TCP / CONNECT / SOCKS5 / TLS / HTTP
              </Badge>
            </dd>
            <dt>原生增强采集</dt>
            <dd>
              <Badge>未实现 ETW / Network Extension</Badge>
            </dd>
            <dt>云端 AI 解释</dt>
            <dd>
              <Badge>未接入 · 本地规则可独立使用</Badge>
            </dd>
            <dt>诊断规则</dt>
            <dd>本地规则 v1</dd>
          </dl>
          <div className="limits-list">
            <h3>明确的观察盲区</h3>
            {overview.coverage.limitations.map((v) => (
              <p key={v}>
                <Info size={14} />
                {v}
              </p>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
