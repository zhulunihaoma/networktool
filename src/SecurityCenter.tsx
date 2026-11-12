import { useCallback, useEffect, useRef, useState } from "react";
import {
  ShieldCheck,
  ShieldBan,
  ScanLine,
  Radar,
  LoaderCircle,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  History,
} from "lucide-react";
import type { DesktopAPI } from "./shared/types";
import {
  INSTALL_LABELS,
  RULES,
  SCORE_RULE_TEXT,
  SCORE_BASE,
  CATEGORY_LABELS,
  TOOL_NAMES,
  type ActionPreview,
  type DoctorReport,
  type Finding,
  type SecurityEvent,
  type SecurityOverview,
  type SecurityProgress,
  type SecurityTool,
} from "./shared/security";
import { FindingList, type FindingHandlers } from "./SecurityFindings";
import SecurityEvents from "./SecurityEvents";
import SecurityChainView from "./SecurityChain";
import SecurityForward from "./SecurityForward";
import SecurityRetro from "./SecurityRetro";
import SecurityReport from "./SecurityReport";
import FileProtection from "./FileProtection";
import Modal from "./Modal";
import { BarList, ScoreLine, TrendChart, useCountUp } from "./security-charts";
import {
  PolicyEditor,
  InstallationCheck,
  InventoryPanel,
} from "./SecurityWorkflows";
import "./styles-security.css";
import { GROUPS, groupOf, type SecurityView as View } from "./shared/security-nav";
const CHART_RULE_DATA: Record<string, string> = {
  credential_read: "密钥与登录凭据",
  credential_write: "密钥与登录凭据",
  protected_branch: "发布分支",
  destructive: "项目与主目录文件",
  remote_exec: "本机执行环境",
  privilege: "管理员权限",
  protected_path_write: "Git 钩子与配置",
  dns_exfil: "可能外发的数据",
  infra_destroy: "基础设施与云资源",
  db_destroy: "数据库与数据表",
  cloud_delete: "云资源与集群",
  prod_write: "生产环境数据",
  obfuscated_exec: "本机执行环境",
};

export default function SecurityCenter({
  api,
  onError,
  onSkills,
}: {
  api: DesktopAPI;
  onError: (text: string) => void;
  onSkills?: () => void;
}) {
  const service = api.security;
  const [tab, setTabState] = useState<View>("overview");
  const [lastInGroup, setLastInGroup] = useState<Record<string, View>>({});
  const setTab = (view: View) => {
    setTabState(view);
    setLastInGroup((m) => ({ ...m, [groupOf(view).name]: view }));
  };
  const group = groupOf(tab);
  const [overview, setOverview] = useState<SecurityOverview>();
  const [report, setReport] = useState<DoctorReport>();
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<ActionPreview>();
  const [message, setMessage] = useState("");
  const [showBasis, setShowBasis] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  /** In-place checkup: live progress from the backend, or "done" with a summary. */
  const [checkup, setCheckup] = useState<
    Omit<SecurityProgress, "done"> | { done: string }
  >();
  const checkingRef = useRef(false);
  const [exception, setException] = useState<{
    id: string;
    project: string;
    ruleId: string;
  }>();
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const scoreShown = useCountUp(overview?.score);
  const refresh = useCallback(async () => {
    if (!service) return;
    const [o, r] = await Promise.all([
      service.securityOverview(),
      service.securityLastDoctor(),
    ]);
    setOverview(o);
    setReport(r);
  }, [service]);
  useEffect(() => {
    void refresh().catch((e) => errorRef.current(String(e)));
  }, [refresh]);
  useEffect(
    () =>
      service?.onSecurity(() => {
        void refresh().catch(() => {});
      }),
    [service, refresh],
  );
  // Real step reports from the backend while a checkup/retro scan runs.
  useEffect(
    () =>
      service?.onSecurityProgress((p) => {
        if (p.kind !== "doctor" || !checkingRef.current || p.done) return;
        const { done: _done, ...progress } = p;
        setCheckup({ ...progress, step: Math.min(p.step, p.steps - 1) });
      }),
    [service],
  );
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  if (!service)
    return (
      <div className="panel security-box">
        <h1>安全中心</h1>
        <p>请在桌面本地模式使用，浏览器演示不读取或修改本机安全配置。</p>
      </div>
    );
  const previewAction = (
    kind: "enable" | "disable" | "fix" | "fix_all",
    target?: string,
  ) => run(async () => setPreview(await service.securityPreview(kind, target)));
  const check = (tool: SecurityTool) =>
    run(async () => {
      const result = await service.securitySelfCheck(tool);
      setMessage(
        `规则自检${result.pass ? "通过" : "未通过"}：${result.cases.map((c) => `${c.name} ${c.actual === c.expect ? "✓" : "未符合预期"}`).join("；")}。自检不代表工具已经加载钩子。`,
      );
    });
  const trustCodex = () =>
    run(async () => {
      const result = await service.securityTrustCodex();
      setOverview(result.overview);
      setMessage(result.message);
    });
  const handlers: FindingHandlers = {
    busy,
    act: (f: Finding) => {
      const action = f.action;
      if (!action) return;
      if (action.kind === "auto_fix") return void previewAction("fix", f.id);
      if (action.kind === "trust_codex") return void trustCodex();
      if (action.kind === "enable_tool")
        return void previewAction("enable", action.tool);
      if (action.kind === "reveal")
        return void run(async () => {
          await service.securityRevealFinding(f.id);
          setMessage(
            "已在访达中显示该文件。按“详情”里的步骤修改后，回来点“重新体检”。",
          );
        });
      void runCheckup();
    },
    ignore: (f, ignored) =>
      run(async () => {
        setReport(await service.securityIgnoreFinding(f.id, ignored));
        setMessage(
          ignored
            ? `已暂不处理“${f.title}”，不再扣分；可在问题列表底部恢复。`
            : `已恢复提醒“${f.title}”。`,
        );
      }),
  };
  const DOCTOR_STEPS = [
    "检查各工具的密钥与登录凭据文件",
    "检查 Codex 审批、沙箱与 MCP 配置",
    "检查 OpenCode、Claude、ZCode、DeepSeek 配置",
    "检查常见凭据位置（.ssh、.npmrc、.netrc 等）",
  ];
  /** Live checkup steps: backend reports each group as it completes. */
  const doctorSteps = (p: SecurityProgress) =>
    Array.from({ length: p.steps }, (_, i) => ({
      title: DOCTOR_STEPS[i] ?? `检查项 ${i + 1}`,
      done: i < p.step,
      doing: i === p.step,
      found: i < p.step ? undefined : i === p.step ? p.found : undefined,
    }));
  /** Run the checkup on the overview page with real backend progress and an in-place result. */
  const runCheckup = () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    return run(async () => {
      const before = overview?.score;
      setCheckup({
        kind: "doctor",
        step: 0,
        steps: 4,
        title: "开始体检",
        found: 0,
      });
      // Start the minimum display time alongside the real check; slow checks stay visible.
      const minimumDuration = new Promise<void>((resolve) =>
        setTimeout(resolve, 2000),
      );
      try {
        const result = await service.securityDoctor();
        const next = await service.securityOverview();
        await minimumDuration;
        setReport(result);
        setOverview(next);
        const files = result.scanned.reduce((n, x) => n + x.files, 0);
        setCheckup({
          done: `体检完成：读取 ${files} 个配置文件，${
            next.findings.length
              ? `发现 ${next.findings.length} 个待处理问题`
              : "未发现待处理问题"
          }${before !== undefined && before !== next.score ? `，评分 ${before} → ${next.score}` : ""}。`,
        });
      } catch (error) {
        await minimumDuration;
        setCheckup(undefined);
        throw error;
      } finally {
        checkingRef.current = false;
      }
    });
  };
  const checking = !!checkup && !("done" in checkup);

  return (
    <div className="security-center">
      <div className="page-heading">
        <div>
          <h1>安全中心</h1>
          <p>为本地 AI 工具添加一条可查看、可关闭的安全检查线</p>
        </div>
      </div>
      <div className="security-tabs" role="tablist" aria-label="安全中心功能">
        {GROUPS.map((g) => (
          <button
            key={g.name}
            role="tab"
            aria-selected={group === g}
            className={group === g ? "active" : ""}
            onClick={() => setTab(lastInGroup[g.name] ?? g.views[0].id)}
          >
            {g.name}
          </button>
        ))}
      </div>
      {group.views.length > 1 && (
        <div
          className="security-subtabs"
          role="tablist"
          aria-label={`${group.name}子页面`}
        >
          {group.views.map((v) => (
            <button
              key={v.id}
              role="tab"
              aria-selected={tab === v.id}
              className={tab === v.id ? "active" : ""}
              onClick={() => setTab(v.id)}
            >
              {v.label}
            </button>
          ))}
        </div>
      )}
      {message && (
        <div className="notice" role="status">
          {message}
        </div>
      )}
      {tab === "overview" && overview && (
        <>
          <div className={`security-hero panel hero-${overview.level}`}>
            <div
              className={`security-score score-${overview.level}${checking ? " is-checking" : ""}`}
              aria-busy={checking}
            >
              <ShieldCheck size={30} />
              <strong>{scoreShown}</strong>
              <span>{checking ? "体检中…" : "参考评分"}</span>
            </div>
            <div className="hero-body">
              <h2>{overview.headline}</h2>
              <p>
                {overview.doctorAt
                  ? `上次体检：${new Date(overview.doctorAt).toLocaleString("zh-CN")}`
                  : "体检只读取本机配置，不上传任何内容"}
                {" · "}
                <button
                  className="link-button"
                  aria-expanded={showBasis}
                  aria-controls="score-basis"
                  onClick={() => setShowBasis(!showBasis)}
                >
                  评分依据
                  {showBasis ? (
                    <ChevronUp size={14} />
                  ) : (
                    <ChevronDown size={14} />
                  )}
                </button>
              </p>
              <div className="hero-actions">
                <button
                  className="primary checkup-button"
                  disabled={busy}
                  onClick={() => void runCheckup()}
                >
                  {checking && (
                    <LoaderCircle
                      size={16}
                      className="checkup-spinner"
                      aria-hidden="true"
                    />
                  )}
                  {checking
                    ? "体检中…"
                    : overview.doctorAt
                      ? "重新体检"
                      : "立即体检"}
                </button>
                {overview.findings.length > 0 && (
                  <button
                    className="secondary"
                    onClick={() =>
                      document
                        .getElementById("overview-problems")
                        ?.scrollIntoView({ behavior: "smooth" })
                    }
                  >
                    查看 {overview.findings.length} 个问题
                  </button>
                )}
                <button
                  className="secondary action-history-button"
                  aria-haspopup="dialog"
                  aria-expanded={showHistory}
                  onClick={() => setShowHistory(true)}
                >
                  <History size={16} aria-hidden="true" />
                  处理记录（{overview.stats.actions.length}）
                </button>
              </div>
            </div>
          </div>
          {showBasis && (
            <section
              className="panel security-box score-basis"
              id="score-basis"
              aria-labelledby="score-basis-title"
            >
              <h3 id="score-basis-title">评分是怎么算的</h3>
              <ul>
                {SCORE_RULE_TEXT.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
              <table>
                <thead>
                  <tr>
                    <th>评分项</th>
                    <th>原因</th>
                    <th>分值</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>基础分</td>
                    <td />
                    <td>{SCORE_BASE}</td>
                  </tr>
                  {overview.scoreItems.map((item) => (
                    <tr key={item.id}>
                      <td>
                        {item.findingId ? (
                          <a
                            href={`#finding-${item.findingId}`}
                            onClick={(e) => {
                              e.preventDefault();
                              document
                                .getElementById(`finding-${item.findingId}`)
                                ?.scrollIntoView({ behavior: "smooth" });
                            }}
                          >
                            {item.title}
                          </a>
                        ) : (
                          item.title
                        )}
                      </td>
                      <td>{item.reason}</td>
                      <td>{item.bonus !== undefined ? `+${item.bonus}` : `−${item.deduction}`}</td>
                    </tr>
                  ))}
                  <tr className="total">
                    <td>参考评分</td>
                    <td>
                      {overview.ignoredFindings.length > 0 &&
                        `另有 ${overview.ignoredFindings.length} 项已暂不处理，不扣分`}
                    </td>
                    <td>{overview.score}</td>
                  </tr>
                </tbody>
              </table>
              <p className="hint">
                评分只反映本工具检查过的配置，不代表系统整体安全。
                评分规则已更新，趋势仅展示本版规则下的体检记录。
              </p>
            </section>
          )}
          {checkup && (
            <div className="panel security-box checkup" role="status">
              {"done" in checkup ? (
                <div className="checkup-done">
                  <b>{checkup.done}</b>
                  <button
                    className="link-button"
                    onClick={() => setCheckup(undefined)}
                  >
                    知道了
                  </button>
                </div>
              ) : (
                <>
                  <p className="checkup-title">{checkup.title}…</p>
                  <ol className="checkup-steps">
                    {doctorSteps(checkup).map((s) => (
                      <li
                        key={s.title}
                        className={s.done ? "done" : s.doing ? "doing" : ""}
                      >
                        {s.title}
                        {s.done ? " ✓" : s.doing ? " …" : ""}
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </div>
          )}
          <section className="panel security-box overview-checks" aria-labelledby="overview-checks-title">
            <h3 id="overview-checks-title">检查项与覆盖范围</h3>
            <p className="hint">当前配置与历史线索分别展示。未检查不视为通过；配置结果来自上次体检，修改后请重新体检。</p>
            <div className="security-grid">
              <button className="security-card" onClick={() => setTab("doctor")}>
                <b>当前配置检查</b>
                <span>{overview.doctorAt ? `发现 ${overview.findings.filter(f => !f.id.startsWith("guard:")).length} 个当前问题` : "尚未体检"}</span>
                <small>凭据文件权限、审批与沙箱、MCP / 插件版本和配置可读性 →</small>
              </button>
              <button className="security-card" onClick={() => setTab("protect")}>
                <b>执行前防护检查</b>
                <span>{overview.tools.some(t => t.installed && t.canToggle) ? `${overview.findings.filter(f => f.id.startsWith("guard:")).length} 个接入问题` : "未发现支持的工具"}</span>
                <small>实时检查关闭、待信任、损坏状态；已开启的工具不重复要求开启 →</small>
              </button>
              <button className="security-card" onClick={() => setTab("retro")}>
                <b>历史会话复核</b>
                <span>{overview.retroScan ? `${overview.retroScan.hits.length} 条历史线索 · 不扣分` : "尚未扫描 · 不扣分"}</span>
                <small>核对凭据、脚本和文件变更的实际影响；开启防护无法撤销过去的操作 →</small>
              </button>
            </div>
            {overview.doctorAt && <p className="hint">
              当前问题按类别汇总：{Object.entries(CATEGORY_LABELS).map(([key, label]) => `${label} ${overview.findings.filter(f => f.category === key).length} 项`).join("；")}。
              {report?.scanned.filter(s => s.files > 0).length ? ` 已读取 ${report.scanned.reduce((n, s) => n + s.files, 0)} 个配置文件。` : " 未读取到配置文件，无法确认检查覆盖。"}
            </p>}
          </section>
          {overview.skillSummary && <section className="panel security-box">
            <h3>Skill 安全检查</h3>
            <p>最近扫描 {overview.skillSummary.installed} 个安装项：{overview.skillSummary.high} 项高风险、{overview.skillSummary.medium} 项需注意、{overview.skillSummary.incomplete} 项未完整检查。</p>
            <p className="hint">{new Date(overview.skillSummary.checkedAt).toLocaleString()} · {overview.skillSummary.ignored} 项暂不处理。复用 Skill 中心检查结果；静态发现不计入真实拦截，Skill 风险数量不参与配置评分。</p>
            {onSkills && <button className="secondary" type="button" onClick={onSkills}>前往 Skill 中心处理</button>}
          </section>}
          {/* 防护数据看板：所有数字来自事件链聚合，无手工数据 */}
          <div
            className="panel security-box stats-hero"
            aria-label="防护数据总览"
          >
            <div className="stat-cells">
              <div className="stat-cell">
                <span className="stat-icon stat-icon-shield" aria-hidden="true">
                  <ShieldCheck size={25} />
                </span>
                <b>
                  {overview.stats.firstEventAt
                    ? Math.max(
                        1,
                        Math.ceil(
                          (Date.now() - overview.stats.firstEventAt) / 86400000,
                        ),
                      )
                    : "—"}
                </b>
                <span>持续防护（天）</span>
                <small>
                  {overview.stats.firstEventAt
                    ? `自 ${new Date(overview.stats.firstEventAt).toLocaleDateString("zh-CN")}`
                    : "开启防护并使用后开始累计"}
                </small>
              </div>
              <div className="stat-cell">
                <span className="stat-icon stat-icon-scan" aria-hidden="true">
                  <ScanLine size={25} />
                </span>
                <b>{overview.stats.totalChecked}</b>
                <span>累计检查 AI 操作</span>
                <small>由各工具执行前钩子实时判定</small>
              </div>
              <div className="stat-cell">
                <span className="stat-icon stat-icon-block" aria-hidden="true">
                  <ShieldBan size={25} />
                </span>
                <b>{overview.stats.totalBlocked}</b>
                <span>累计拦截</span>
                <small>命中保护规则的被拦下的操作</small>
              </div>
              <div className="stat-cell">
                <span className="stat-icon stat-icon-radar" aria-hidden="true">
                  <Radar size={25} />
                </span>
                <b>{overview.todayBlocked}</b>
                <span>今日拦截</span>
                <small>
                  {overview.stats.toolsWithEvents
                    ? `${overview.stats.toolsWithEvents} 个工具有过真实上报`
                    : "还没有工具真实上报"}
                </small>
              </div>
            </div>
          </div>
          <div className="dash-grid">
            <div className="panel security-box">
              <h3>近 30 天检查与拦截</h3>
              <TrendChart days={overview.stats.byDay} />
            </div>
            <div className="panel security-box">
              <h3>评分趋势</h3>
              <ScoreLine history={overview.scoreHistory} />
            </div>
            <div className="panel security-box">
              <h3>拦截了什么</h3>
              <BarList
                items={Object.entries(overview.stats.byRule)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 6)
                  .map(([id, n]) => ({
                    label: CHART_RULE_DATA[id] ?? id,
                    sub: RULES.find((r) => r.id === id)?.title ?? id,
                    value: n,
                  }))}
                emptyText="还没有拦截记录。开启防护后，命中规则的操作会在这里按类别累计。"
              />
            </div>
            <div className="panel security-box">
              <h3>哪个工具被拦得最多</h3>
              <BarList
                items={Object.entries(overview.stats.byTool)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 6)
                  .map(([id, n]) => ({
                    label: TOOL_NAMES[id as SecurityTool] ?? id,
                    value: n,
                  }))}
                emptyText="还没有按工具的拦截记录。"
              />
            </div>
          </div>
          {showHistory && (
            <Modal
              title="处理记录"
              subtitle={`你在安全中心做过的操作，按时间倒序。共 ${overview.stats.actions.length} 条。`}
              drawer
              drawerSide="right"
              onClose={() => setShowHistory(false)}
            >
              <div className="modal-body security-action-history">
                {overview.stats.actions.length ? (
                  <ul className="action-feed">
                    {overview.stats.actions.map((a, i) => (
                      <li key={`${a.at}-${a.operation}-${i}`}>
                        <time dateTime={new Date(a.at).toISOString()}>
                          {new Date(a.at).toLocaleString("zh-CN")}
                        </time>
                        <b>{a.operation}</b>
                        {a.reason && <small>{a.reason}</small>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="action-history-empty">
                    <History size={32} aria-hidden="true" />
                    <b>暂无处理记录</b>
                    <p>完成体检、开启防护或处理问题后，可在这里查看记录。</p>
                  </div>
                )}
              </div>
            </Modal>
          )}
          <div className="panel security-box" id="overview-problems">
            <div className="security-title">
              <div>
                <h3>
                  {overview.doctorAt || overview.findings.length
                    ? `待处理问题（${overview.findings.length}）`
                    : "待处理问题"}
                </h3>
                <p className="hint">
                  按风险从高到低排列。每项都有处理按钮；点“详情”看原因和步骤。
                </p>
              </div>
            </div>
            {!overview.doctorAt && overview.findings.length === 0 ? (
              <div className="finding-empty">
                <b>还没有体检</b>
                <p>点上方“立即体检”，通常需 2 秒左右，结果会直接显示在这里。</p>
              </div>
            ) : (
              <FindingList
                findings={overview.findings}
                ignored={overview.ignoredFindings}
                handlers={handlers}
                fixAll={() => void previewAction("fix_all")}
                expandFirst
              />
            )}
          </div>
          <details className="panel security-box limits">
            <summary>这个工具能做什么、不能做什么</summary>
            <ul>
              {overview.limitations.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </details>
        </>
      )}
      {(tab === "overview" || tab === "report") && !overview && (
        <div className="panel security-box">正在读取本机状态…</div>
      )}
      {tab === "protect" && (
        <>
          <div className="panel security-box">
            <h2>让 AI 操作先经过检查</h2>
            <p>
              开启前会展示配置变更并备份原文件；只覆盖工具调用钩子的操作，不是系统级拦截。
            </p>
            <div className="security-row">
              <div>
                <b>默认开启已安装工具的防护</b>
                <p>
                  每次启动时自动为已安装且支持拦截的工具写入防护；已有配置只合并本应用条目，原文件会备份。
                  手动关闭过的工具不会被重新打开。
                </p>
                <small>
                  {overview?.policy.autoProtect
                    ? "当前：默认开启"
                    : "当前：默认关闭，只保留你手动开启的工具"}
                </small>
              </div>
              <div>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const next = !overview?.policy.autoProtect;
                      setOverview(await service.securitySetAutoProtect(next));
                      setMessage(
                        next
                          ? "已开启默认防护，下次启动自动执行；也可立即开启"
                          : "已关闭默认防护，已有防护配置保持不变",
                      );
                    })
                  }
                >
                  {overview?.policy.autoProtect
                    ? "关闭默认开启"
                    : "开启默认开启"}
                </button>
                <button
                  className="primary"
                  disabled={busy || !overview?.policy.autoProtect}
                  onClick={() =>
                    run(async () => {
                      const result = await service.securityRunAutoProtect();
                      setMessage(
                        result.skipped
                          ? "默认防护未执行：请先开启默认防护并确认检查程序可用"
                          : `已自动开启：${
                              result.enabled.length
                                ? result.enabled
                                    .map(
                                      (t) => TOOL_NAMES[t as SecurityTool] ?? t,
                                    )
                                    .join("、")
                                : "无新增"
                            }；已是最新 ${result.unchanged.length} 个；跳过 ${result.skippedTools.length} 个；失败 ${result.failed.length} 个`,
                      );
                    })
                  }
                >
                  立即执行
                </button>
              </div>
            </div>
            {overview?.tools.map((t) => (
              <div className="security-row" key={t.tool}>
                <div>
                  <b>{t.name}</b>
                  <p>{t.mechanism}</p>
                  <small>{t.note}</small>
                </div>
                <div>
                  <span className="badge">{INSTALL_LABELS[t.state]}</span>
                  {t.autoProtect === "off" && (
                    <span className="badge">默认不自动开启</span>
                  )}
                  {t.canToggle && (
                    <>
                      {t.tool === "codex" && t.state === "needs_trust" && (
                        <button
                          className="primary"
                          disabled={busy}
                          title="只信任本工具的安全钩子，保留其他钩子的信任设置"
                          onClick={trustCodex}
                        >
                          {busy ? "处理中…" : "信任此防护"}
                        </button>
                      )}
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() =>
                          previewAction(
                            ["enabled", "verified", "needs_trust"].includes(
                              t.state,
                            )
                              ? "disable"
                              : "enable",
                            t.tool,
                          )
                        }
                      >
                        {["enabled", "verified", "needs_trust"].includes(
                          t.state,
                        )
                          ? "关闭"
                          : t.state === "broken"
                            ? "修复"
                            : "开启"}
                      </button>
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => check(t.tool)}
                      >
                        规则自检
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="panel security-box">
            <h3>默认防护规则</h3>
            {RULES.map((r) => (
              <div className="security-row" key={r.id}>
                <div>
                  <b>{r.title}</b>
                  <p>{r.detail}</p>
                </div>
                <span className="badge">
                  {overview?.policy.rules.find((x) => x.id === r.id)?.enabled
                    ? "已启用"
                    : "已关闭"}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
      {tab === "doctor" && (
        <div className="panel security-box">
          <div className="security-title">
            <div>
              <h2>配置体检</h2>
              <p>
                只读取各 AI
                工具的已知本地配置，不显示密钥内容。未检查项不代表安全。
              </p>
            </div>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void runCheckup()}
            >
              <RefreshCw size={15} />{" "}
              {busy ? "检查中" : report ? "重新体检" : "开始体检"}
            </button>
          </div>
          {!report ? (
            <p>尚未体检，点击“开始体检”。</p>
          ) : (
            <>
              <p>
                上次检查：{new Date(report.at).toLocaleString("zh-CN")}；读取{" "}
                {report.scanned.reduce((n, s) => n + s.files, 0)} 个文件（
                {report.scanned
                  .filter((x) => x.files)
                  .map((x) => TOOL_NAMES[x.tool as SecurityTool] ?? x.tool)
                  .join("、") || "无"}
                ）
              </p>
              {overview && (
                <FindingList
                  findings={overview.findings}
                  ignored={overview.ignoredFindings}
                  handlers={handlers}
                  fixAll={() => void previewAction("fix_all")}
                />
              )}
            </>
          )}
        </div>
      )}
      {tab === "retro" && (
        <SecurityRetro
          service={service}
          report={overview?.retroScan}
          busy={busy}
          notify={setMessage}
          onError={onError}
          onDone={refresh}
        />
      )}
      {tab === "report" && overview && (
        <SecurityReport
          overview={overview}
          busy={busy}
          onExport={() =>
            void run(async () => {
              const r = await service.securityExport("md");
              if (r.path) setMessage(`已导出到 ${r.path}，用户目录已替换为 ~`);
            })
          }
        />
      )}
      {tab === "events" && overview && (
        <SecurityEvents
          service={service}
          tools={overview.tools}
          busy={busy}
          run={run}
          notify={setMessage}
          addException={(e: SecurityEvent) =>
            setException({ id: e.id, project: e.project, ruleId: e.ruleId! })
          }
          goProtect={() => setTab("protect")}
          goRules={() => setTab("rules")}
          enabledRules={overview.policy.rules.filter((r) => r.enabled).length}
        />
      )}
      {tab === "chain" && (
        <SecurityChainView
          service={service}
          run={run}
          notify={setMessage}
          addException={setException}
          openEvents={() => setTab("events")}
        />
      )}
      {tab === "forward" && (
        <SecurityForward
          service={service}
          notify={(text, error) => (error ? onError(text) : setMessage(text))}
        />
      )}
      {overview && (
        <div hidden={tab !== "rules"}>
          <PolicyEditor
            service={service}
            policy={overview.policy}
            saved={refresh}
            notify={(text, error) => (error ? onError(text) : setMessage(text))}
          />
        </div>
      )}
      <div hidden={tab !== "install"}>
        <InstallationCheck
          service={service}
          notify={(text, error) => (error ? onError(text) : setMessage(text))}
        />
      </div>
      <div hidden={tab !== "inventory"}>
        <InventoryPanel
          service={service}
          lastResult={overview?.inventory}
          saved={refresh}
          notify={(text, error) => (error ? onError(text) : setMessage(text))}
        />
      </div>
      <div hidden={tab !== "files"}>
        <FileProtection api={api} onError={onError} />
      </div>
      {preview && (
        <Modal
          title={preview.title}
          onClose={() => {
            if (!busy) setPreview(undefined);
          }}
        >
          <div className="modal-body">
            <p>{preview.summary}</p>
            <h3>即将修改</h3>
            <ul>
              {preview.changes.map((c) => (
                <li key={c.path}>
                  {c.path}：{c.detail}
                </li>
              ))}
            </ul>
            {preview.warnings.map((w) => (
              <p className="error-text" key={w}>
                {w}
              </p>
            ))}
            {preview.nextSteps.map((w) => (
              <p key={w}>{w}</p>
            ))}
            <div className="security-actions">
              <button
                className="secondary"
                onClick={() => setPreview(undefined)}
              >
                取消
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const result = await service.securityApply(preview.token);
                    setPreview(undefined);
                    setMessage(result.message);
                  })
                }
              >
                确认执行
              </button>
            </div>
          </div>
        </Modal>
      )}
      {exception && (
        <Modal title="设置项目例外" onClose={() => setException(undefined)}>
          <div className="modal-body">
            <p>
              以后 AI 在项目 {exception.project} 中执行同类操作时，不再按“
              {RULES.find((r) => r.id === exception.ruleId)?.title ??
                exception.ruleId}
              ”拦截。只影响这个项目目录，其他项目和其他规则继续生效。可在“操作规则”中随时恢复。
            </p>
            <div className="security-actions">
              <button
                className="secondary"
                onClick={() => setException(undefined)}
              >
                取消
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await service.securityAddException(exception.id);
                    setException(undefined);
                    setMessage("例外已保存，可在操作规则中恢复拦截");
                  })
                }
              >
                确认添加例外
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
