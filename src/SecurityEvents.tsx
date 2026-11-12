import { useCallback, useEffect, useRef, useState } from "react";
import {
  DATA_LEVEL_LABELS,
  HIT_LABELS,
  KIND_LABELS,
  RULES,
  RULE_TITLES,
  TOOL_NAMES,
  VERB_LABELS,
  type EvidenceSource,
  type SecurityAPI,
  type SecurityEvent,
  type SecurityTool,
  type TimelinePage,
  type ToolStatus,
} from "./shared/security";
import { ago } from "./security-format";
import {
  EVENT_VIEWS as VIEWS,
  eventViewCount as viewCount,
  type EventView as View,
} from "./shared/security-nav";

/**
 * Event view. One row = one attempt by an AI tool to run a command or touch a
 * file, reported by the pre-execution hook ("probe") installed in that tool.
 * Sensitive data appears as a second dimension: which rule protected what.
 */
const PAGE_SIZE = 50;
const RULE_DATA: Record<string, string> = {
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
  input_limit: "超长操作",
};
const ACTIVE = ["enabled", "verified", "needs_restart"];

function name(tool: string) {
  return TOOL_NAMES[tool as SecurityTool] ?? tool;
}
function base(project: string) {
  return project ? (project.split(/[\\/]/).filter(Boolean).pop() ?? project) : "";
}
const factKinds = (kinds: string[]) =>
  kinds.map((k) => KIND_LABELS[k] ?? k).join("、");
const factVerbs = (verbs: string[]) =>
  verbs.map((v) => VERB_LABELS[v] ?? v).join("、");
const factHits = (hits: string[]) =>
  hits.map((h) => HIT_LABELS[h] ?? h).join("；");
function describe(e: SecurityEvent) {
  const who = name(e.tool);
  const where = base(e.project);
  if (e.source === "real_block")
    return {
      tone: "block",
      tag: "已拦截",
      text: `${who}${where ? ` 在「${where}」` : ""}想执行 ${e.operation}`,
      result: `没有执行。${e.ruleId ? `命中“${RULE_TITLES[e.ruleId] ?? e.ruleId}”：` : ""}${e.reason ?? ""}`,
    };
  if (e.source === "real_allow")
    return {
      tone: "allow",
      tag: "已放行",
      text: `${who}${where ? ` 在「${where}」` : ""}执行 ${e.operation}`,
      result: e.reason ?? "检查通过，未命中任何规则，已正常执行。",
    };
  if (e.source === "error")
    return {
      tone: "error",
      tag: "检查出错",
      text: `${who} 的检查程序出错`,
      result: `${e.reason ?? ""}（为不影响工作已放行，请查看防护状态）`,
    };
  if (e.source === "session")
    return {
      tone: "block",
      tag: "回溯发现",
      text: `${who} 的历史会话：${e.operation}`,
      result: e.reason ?? "来自回溯扫描，只读检查。",
    };
  if (e.source === "action")
    return {
      tone: "info",
      tag: "处理动作",
      text: `${e.tool === "app" ? "安全中心" : name(e.tool)}：${e.operation}`,
      result: e.reason ?? "",
    };
  return {
    tone: "info",
    tag:
      e.source === "self_check"
        ? "自检/设置"
        : e.source === "scan"
          ? "体检"
          : "配置变化",
    text: `${e.tool === "app" ? "安全中心" : name(e.tool)}：${e.operation}`,
    result: e.reason ?? "",
  };
}

export default function SecurityEvents({
  service,
  tools,
  busy,
  run,
  notify,
  addException,
  goProtect,
  goRules,
  enabledRules,
}: {
  service: SecurityAPI;
  tools: ToolStatus[];
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  notify: (text: string) => void;
  addException: (e: SecurityEvent) => void;
  goProtect: () => void;
  goRules: () => void;
  enabledRules: number;
}) {
  const [view, setView] = useState<View>("attention");
  const [ruleId, setRuleId] = useState<string>();
  const [tool, setTool] = useState("");
  const [page, setPage] = useState<TimelinePage>();
  const [open, setOpen] = useState<string>();
  const [helpOpen, setHelpOpen] = useState(false);
  const [pageNum, setPageNum] = useState(0);
  const [fromDay, setFromDay] = useState("");
  const [notifyOn, setNotifyOn] = useState(() => {
    try {
      return localStorage.getItem("nl-security-notify") !== "0";
    } catch {
      return false;
    }
  });
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  useEffect(() => {
    try {
      localStorage.setItem("nl-security-notify", notifyOn ? "1" : "0");
    } catch {}
  }, [notifyOn]);
  const load = useCallback(async () => {
    setPage(
      await service.securityTimeline({
        sources: ruleId ? ["real_block"] : VIEWS[view].sources,
        ruleId,
        tool: tool || undefined,
        limit: PAGE_SIZE,
        offset: pageNum * PAGE_SIZE,
        from: fromDay
          ? new Date(`${fromDay}T00:00:00`).getTime() || undefined
          : undefined,
      }),
    );
  }, [service, view, ruleId, tool, pageNum, fromDay]);
  // Desktop notification for real blocks, opt-in via the switch above.
  const firstLoad = useRef(true);
  useEffect(
    () =>
      service.onSecurity((e) => {
        void load().catch(() => {});
        if (!firstLoad.current && notifyOn && e.source === "real_block") {
          try {
            new Notification("360AI盒子 拦截了一次 AI 操作", {
              body: `${name(e.tool)}：${e.operation}\n${
                e.ruleId ? `命中“${RULE_TITLES[e.ruleId] ?? e.ruleId}”` : ""
              }`,
            });
          } catch {}
        }
      }),
    [service, load, notifyOn],
  );
  useEffect(() => {
    firstLoad.current = false;
  }, []);
  useEffect(() => {
    void load().catch((e) => notifyRef.current(String(e)));
  }, [load]);
  const installed = tools.filter((t) => t.installed);
  const probeTarget = installed.find(
    (t) => t.canToggle && ACTIVE.concat("needs_trust").includes(t.state),
  );
  const counts = page?.counts;
  const ruleEntries = Object.entries(page?.byRule ?? {}).sort(
    (a, b) => b[1] - a[1],
  );
  const simulate = () =>
    run(async () => {
      if (!probeTarget) return;
      const result = await service.securitySelfCheck(probeTarget.tool);
      setRuleId(undefined);
      setView("app");
      notify(
        `已用 ${probeTarget.name} 的真实检查程序跑了 ${result.cases.length} 个样例：${result.cases
          .map(
            (c) =>
              `${c.name}→${c.actual === "deny" ? "拦截" : c.actual === "allow" ? "放行" : "出错"}`,
          )
          .join("，")}。结果记在“安全中心记录”，不计入真实拦截。`,
      );
    });
  return (
    <div className="security-events">
      <div className="panel security-box">
        <div className="security-title">
          <div>
            <h2>AI 操作记录</h2>
            <p>
              每一行是 AI 工具的<b>一次操作尝试</b>
              （执行命令或读写文件），由装在该工具里的“执行前检查”实时上报。
            </p>
          </div>
          <div className="title-actions">
            <button className="link-button" onClick={() => setHelpOpen(!helpOpen)}>
              {helpOpen ? "收起说明" : "这些记录怎么来的？"}
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const r = await service.securityExport("md");
                  if (r.path) notify(`已导出到 ${r.path}，用户目录已替换为 ~`);
                })
              }
            >
              导出报告
            </button>
          </div>
        </div>
        {helpOpen && (
          <div className="events-help">
            <p>
              <b>探针在哪里：</b>
              开启防护时，安全中心会在 Codex、Claude Code、OpenCode 等工具的配置里注册一个
              “执行前钩子”。AI 每次要执行命令、改文件前，工具会先把这次操作交给本机的检查程序，
              检查程序按规则判定“拦截”或“放行”，并写入这份记录。所以它就是内置在各工具里的探针，
              不需要另外安装。
            </p>
            <p>
              <b>为什么不做系统级探针：</b>
              系统级监控需要管理员权限和内核扩展，误报多、影响性能，也会看到与 AI 无关的操作。
              钩子只在 AI 工具调用时运行，能准确知道是哪个工具、哪个项目、想做什么。
              代价是：工具未接入、关闭钩子或绕过工具直接运行的程序不会出现在这里。
            </p>
            <p>
              <b>以什么为维度：</b>
              列表以“操作”为单位；右侧“保护了哪些数据”按规则汇总，点一下即可只看保护该类数据的拦截。
            </p>
          </div>
        )}
        <div className="probe-strip" aria-label="探针接入状态">
          {installed.length === 0 && <span>本机未发现支持的 AI 工具</span>}
          {installed.map((t) => {
            const live = ACTIVE.includes(t.state) || t.state === "needs_trust";
            const status =
              t.state === "unsupported"
                ? { cls: "off", text: "不支持接入" }
                : !live
                  ? { cls: "off", text: "未接入" }
                  : t.state === "needs_trust"
                    ? { cls: "wait", text: "待确认信任" }
                    : t.lastRealAt
                      ? { cls: "on", text: `${ago(t.lastRealAt)}有上报` }
                      : { cls: "wait", text: "已接入，重开工具后开始上报" };
            return (
              <span key={t.tool} className={`probe probe-${status.cls}`}>
                <i />
                {t.name}：{status.text}
              </span>
            );
          })}
          {installed.some(
            (t) => t.canToggle && !ACTIVE.includes(t.state),
          ) && (
            <button className="link-button" onClick={goProtect}>
              去接入 →
            </button>
          )}
        </div>
      </div>
      <div className="events-layout">
        <div className="panel security-box events-main">
          <div className="event-views" role="tablist" aria-label="记录分类">
            {(Object.keys(VIEWS) as View[]).map((v) => (
              <button
                key={v}
                role="tab"
                aria-selected={!ruleId && view === v}
                className={!ruleId && view === v ? "active" : ""}
                onClick={() => {
                  setRuleId(undefined);
                  setView(v);
                  setPageNum(0);
                }}
              >
                {VIEWS[v].label}
                <em>{counts ? viewCount(v, counts) : 0}</em>
              </button>
            ))}
            <select
              aria-label="按工具筛选"
              value={tool}
              onChange={(e) => {
                setTool(e.target.value);
                setPageNum(0);
              }}
            >
              <option value="">全部工具</option>
              {installed.map((t) => (
                <option key={t.tool} value={t.tool}>
                  {t.name}
                </option>
              ))}
              {(view === "app" || view === "history") && (
                <option value="app">安全中心</option>
              )}
            </select>
            <input
              type="date"
              aria-label="只看该日期之后"
              className="date-filter"
              value={fromDay}
              max={new Date().toISOString().slice(0, 10)}
              onChange={(e) => {
                setFromDay(e.target.value);
                setPageNum(0);
              }}
            />
            {fromDay && (
              <button
                className="link-button"
                onClick={() => {
                  setFromDay("");
                  setPageNum(0);
                }}
              >
                清除日期
              </button>
            )}
            <label className="notify-toggle" title="真实拦截发生时弹出系统通知">
              <input
                type="checkbox"
                checked={notifyOn}
                onChange={(e) => setNotifyOn(e.target.checked)}
              />
              拦截通知
            </label>
          </div>
          {ruleId && (
            <div className="rule-filter">
              只看保护“{RULE_DATA[ruleId] ?? ruleId}”的拦截
              <button className="link-button" onClick={() => setRuleId(undefined)}>
                清除
              </button>
            </div>
          )}
          {view === "app" && !ruleId && (
            <p className="hint">
              体检、规则自检、防护设置和配置变化记录，由安全中心自己产生，不是 AI 的操作。
              配置变化只说明配置文件变了，不能据此认定有数据外发。
            </p>
          )}
          {view === "history" && !ruleId && (
            <p className="hint">
              回溯扫描从 AI 工具的历史会话文件里找到的线索。它们是 AI 过去做过的操作，
              但只能证明文本里出现过，不代表执行成功或当前仍有风险，不计入评分。
            </p>
          )}
          {page?.events.length ? (
            <ul className="event-list">
              {page.events.map((e) => {
                const d = describe(e);
                const key = e.id + e.at;
                return (
                  <li key={key} className={`event event-${d.tone}`}>
                    <button
                      className="event-head"
                      aria-expanded={open === key}
                      title={open === key ? "收起详情" : "展开详情"}
                      onClick={() => setOpen(open === key ? undefined : key)}
                    >
                      <span className={`event-tag tag-${d.tone}`}>{d.tag}</span>
                      <span className="event-text">
                        <b>{d.text}</b>
                        <small>{d.result}</small>
                      </span>
                      <time>{ago(e.at)}</time>
                      <span className="event-caret" aria-hidden="true" />
                    </button>
                    {open === key && (
                      <div className="event-detail">
                        <dl>
                          <dt>时间</dt>
                          <dd>{new Date(e.at).toLocaleString("zh-CN")}</dd>
                          <dt>AI 工具</dt>
                          <dd>{e.tool === "app" ? "安全中心" : name(e.tool)}</dd>
                          {e.toolName && (
                            <>
                              <dt>调用方式</dt>
                              <dd>{e.toolName}</dd>
                            </>
                          )}
                          {e.project && (
                            <>
                              <dt>项目目录</dt>
                              <dd>{e.project}</dd>
                            </>
                          )}
                          {e.ruleId && (
                            <>
                              <dt>命中规则</dt>
                              <dd>
                                {RULE_TITLES[e.ruleId] ?? e.ruleId}（保护
                                {RULE_DATA[e.ruleId] ?? "相关资源"}）
                              </dd>
                            </>
                          )}
                          <dt>结果</dt>
                          <dd>
                            {e.source === "real_block"
                              ? "执行前已拒绝，操作没有发生"
                              : e.source === "real_allow"
                                ? "已放行，由 AI 工具继续执行"
                                : e.source === "error"
                                  ? "检查出错，已放行"
                                  : e.source === "session"
                                    ? "历史会话中的文本线索，当时未经过执行前检查"
                                    : "仅记录，不涉及 AI 操作"}
                          </dd>
                          {e.facts && (
                            <>
                              <dt>数据分级</dt>
                              <dd>
                                {e.facts.level} ·{" "}
                                {DATA_LEVEL_LABELS[e.facts.level]}
                                {e.facts.env === "prod" ? " · 生产环境" : ""}
                              </dd>
                              {e.facts.kinds.length > 0 && (
                                <>
                                  <dt>涉及资源</dt>
                                  <dd>{factKinds(e.facts.kinds)}</dd>
                                </>
                              )}
                              {e.facts.verbs.length > 0 && (
                                <>
                                  <dt>操作</dt>
                                  <dd>{factVerbs(e.facts.verbs)}</dd>
                                </>
                              )}
                              {e.facts.hosts?.length ? (
                                <>
                                  <dt>外连主机</dt>
                                  <dd>{e.facts.hosts.join("、")}</dd>
                                </>
                              ) : null}
                              {e.facts.hits.length > 0 && (
                                <>
                                  <dt>分级依据</dt>
                                  <dd>{factHits(e.facts.hits)}</dd>
                                </>
                              )}
                            </>
                          )}
                        </dl>
                        {e.source === "real_block" && e.ruleId && e.project && (
                          <div className="event-actions">
                            <span>这是你需要的正常操作？</span>
                            <button
                              className="secondary"
                              disabled={busy}
                              onClick={() => addException(e)}
                            >
                              以后在这个项目允许
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="events-empty">
              {view === "attention" && !ruleId ? (
                <>
                  <b>没有敏感事件</b>
                  <p>
                    {counts?.real_allow
                      ? `探针已检查 ${counts.real_allow} 次 AI 操作，均未命中拦截规则。可在“全部 AI 操作”查看。`
                      : "还没有收到 AI 操作上报。确认上方工具已接入后，重新打开该工具并让它执行一条命令。"}
                  </p>
                </>
              ) : (
                <b>暂无符合条件的记录</b>
              )}
              {probeTarget && (
                <button className="secondary" disabled={busy} onClick={simulate}>
                  模拟一次拦截，看看效果
                </button>
              )}
            </div>
          )}
          {page && page.total > PAGE_SIZE && (
            <div className="events-pager">
              <span className="hint">
                共 {page.total} 条 · 第 {pageNum + 1} /{" "}
                {Math.ceil(page.total / PAGE_SIZE)} 页
              </span>
              <button
                className="secondary"
                disabled={pageNum === 0 || busy}
                onClick={() => setPageNum(Math.max(0, pageNum - 1))}
              >
                上一页
              </button>
              <button
                className="secondary"
                disabled={!page.hasMore || busy}
                onClick={() => setPageNum(pageNum + 1)}
              >
                下一页
              </button>
            </div>
          )}
        </div>
        <aside className="panel security-box events-side">
          <h3>保护了哪些数据</h3>
          <p className="hint">按拦截规则汇总，点一项筛选</p>
          {ruleEntries.length === 0 ? (
            <p className="hint">还没有拦截记录。</p>
          ) : (
            ruleEntries.map(([id, n]) => (
              <button
                key={id}
                className={`rule-stat${ruleId === id ? " active" : ""}`}
                onClick={() => {
                  setRuleId(ruleId === id ? undefined : id);
                  setPageNum(0);
                }}
              >
                <span>
                  {RULE_DATA[id] ?? id}
                  <small>{RULE_TITLES[id] ?? id}</small>
                </span>
                <b>{n} 次</b>
              </button>
            ))
          )}
          <h3>记录可信度</h3>
          <p className="hint">
            {page?.chain.status === "ok"
              ? `已校验 ${page.chain.checked} 条，未发现被改动`
              : page?.chain.status === "empty"
                ? "暂无记录"
                : "校验异常：记录可能被改动或部分丢失"}
          </p>
          {probeTarget && (
            <>
              <h3>想看看拦截效果？</h3>
              <p className="hint">
                用装在工具里的真实检查程序跑一组典型场景（推送 main、读取 .env、下载即执行等），
                只做判定，不会真的执行，结果标注为“自检”。
              </p>
              <button className="secondary" disabled={busy} onClick={simulate}>
                模拟一次拦截
              </button>
            </>
          )}
          <h3>当前启用的规则</h3>
          <p className="hint">
            已启用 {enabledRules}/{RULES.length} 条{" "}
            <button className="link-button" onClick={goRules}>
              调整规则
            </button>
          </p>
        </aside>
      </div>
    </div>
  );
}
