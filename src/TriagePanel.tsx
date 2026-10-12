import { useEffect, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  ListChecks,
  RefreshCw,
  Square,
  TriangleAlert,
} from "lucide-react";
import { newTriage, TRIAGE_TARGETS, TRIAGE_ACTIONS } from "./shared/triage";
import type {
  DesktopAPI,
  TriageAction,
  TriageRun,
  TriageStepStatus,
} from "./shared/types";
const LABELS: Record<TriageStepStatus, string> = {
  pending: "等待检查",
  checking: "检查中",
  pass: "本项通过",
  attention: "需要处理",
  unverified: "需要确认",
  error: "检测未完成",
  skipped: "未执行",
};
export default function TriagePanel({
  api,
  platformChecking,
  onError,
  initialTarget = "codex",
  expandRequested = 0,
}: {
  api: DesktopAPI;
  platformChecking: boolean;
  onError: (text: string) => void;
  initialTarget?: string;
  expandRequested?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (expandRequested) setExpanded(true);
  }, [expandRequested]);
  const [run, setRun] = useState<TriageRun>(() => newTriage(initialTarget || "codex"));
  const [target, setTarget] = useState(initialTarget);
  const [working, setWorking] = useState<string>();
  const [message, setMessage] = useState("");
  const [now, setNow] = useState(Date.now());
  const observing = run.observation.status === "running";
  const scanning = run.status === "running";
  useEffect(() => {
    let active = true;
    const unsubscribe = api.onTriage((value) => {
      if (active) setRun(value);
    });
    void api
      .triage()
      .then((value) => {
        if (active) {
          setRun(value);
          setTarget(value.status === "idle" ? initialTarget : value.targetId);
        }
      })
      .catch((e) => {
        if (active) onError(e.message);
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api, initialTarget]);
  useEffect(() => {
    if (!observing) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [observing]);
  const invoke = async (key: string, operation: () => Promise<void>) => {
    if (working) return;
    setWorking(key);
    setMessage("");
    try {
      await operation();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setWorking(undefined);
    }
  };
  const start = (id = target) =>
    void invoke("start", async () => {
      setExpanded(true);
      setTarget(id);
      setRun(await api.startTriage(id));
    });
  const act = (action: TriageAction) =>
    void invoke(action, async () => {
      if (action === "retry") {
        setTarget(run.targetId);
        setRun(await api.startTriage(run.targetId));
      } else if (action === "observe") {
        setNow(Date.now());
        setRun(await api.observeTriage(run.id));
      } else setMessage((await api.triageAction(run.id, action)).message);
    });
  const chosen = TRIAGE_TARGETS.find((p) => p.id === run.targetId)!;
  const done = run.steps.filter(
    (s) => !["pending", "checking"].includes(s.status),
  ).length;
  const elapsed = run.observation.started
    ? Math.min(
        60,
        Math.max(0, Math.floor((now - run.observation.started) / 1000)),
      )
    : 0;
  const disabled = !!working || scanning || observing || platformChecking;
  return (
    <section className="triage-panel" aria-label="按顺序排查和修复建议">
      <div className="triage-heading">
        <button
          className="triage-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <ListChecks size={21} />
          <span>
            <strong>连接异常，或经常重连？</strong>
            <small>按顺序找原因，并给出下一步处理操作</small>
          </span>
          {expanded ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
        </button>
        <div className="triage-controls">
          <select
            aria-label="选择要排查的工具"
            value={target}
            disabled={!!working || scanning || observing}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="" disabled>请选择公开入口参考对象</option>
            {TRIAGE_TARGETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {scanning || observing ? (
            <button
              className="secondary"
              onClick={() =>
                void invoke("stop", async () => {
                  setRun(await api.stopTriage());
                })
              }
              disabled={!!working}
            >
              <Square size={13} />
              停止{observing ? "观察" : "排查"}
            </button>
          ) : (
            <button
              className="primary"
              disabled={disabled || !target}
              onClick={() => start()}
            >
              <ListChecks size={14} />
              按顺序排查
            </button>
          )}
        </div>
      </div>
      {!expanded && platformChecking && (
        <p className="triage-note">平台体检完成或停止后，即可开始顺序排查。</p>
      )}
      {expanded && (
        <div className="triage-body">
          <p className="triage-note">
            此处独立检查所选公开入口与本机连接，不代表应用实际 API 配置；已有结果属于下方标注的对象。按本次证据推荐处理项目，处理后请在原工具复测。
          </p>
          {run.status === "idle" ? (
            <p className="triage-empty">
              选择工具并开始排查。先确认基础网络，再检查代理、解析和入口，最后观察重连。
            </p>
          ) : (
            <>
              <div className="triage-summary" aria-live="polite">
                <strong>
                  {chosen.name} ·{" "}
                  {scanning
                    ? `检查进度 ${done}/5`
                    : run.status === "cancelled"
                      ? "已停止排查"
                      : "排查结果"}
                </strong>
                <p>{run.summary}</p>
                {run.comparison && <p>{run.comparison}</p>}
                {run.targetId === "codex" && (
                  <small>
                    Codex 此项检查公开入口与本机连接；模型、登录和持续任务需在
                    Codex 中确认。
                  </small>
                )}
              </div>
              <ol className="triage-steps">
                {run.steps.map((step, index) => (
                  <li key={step.id} className={`triage-step ${step.status}`}>
                    <div className="triage-step-title">
                      <span className="triage-number">{index + 1}</span>
                      <h3>{step.title}</h3>
                      <span
                        className={`badge ${step.status === "pass" ? "green" : ["attention", "error"].includes(step.status) ? "amber" : "muted"}`}
                      >
                        {step.status === "checking" ? (
                          <Loader2 size={12} className="spin" />
                        ) : step.status === "pass" ? (
                          <CheckCircle2 size={12} />
                        ) : step.status === "attention" ? (
                          <TriangleAlert size={12} />
                        ) : null}
                        {LABELS[step.status]}
                      </span>
                      {run.priorityIds[0] === step.id && (
                        <span className="triage-first">建议先处理</span>
                      )}
                    </div>
                    <p>{step.summary}</p>
                    {step.suggestion && (
                      <p className="triage-advice">{step.suggestion}</p>
                    )}
                    {step.evidence.length > 0 && (
                      <details className="triage-evidence">
                        <summary>查看本项检查依据</summary>
                        <ul>
                          {step.evidence.map((item, i) => (
                            <li key={i}>{item}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {step.actions.length > 0 && run.status === "completed" && (
                      <div className="triage-step-actions">
                        {step.actions.map((action) => (
                          <button
                            key={action}
                            className={
                              action === "observe" ||
                              (run.priorityIds[0] === step.id &&
                                action !== "copy_report" &&
                                action !== "retry")
                                ? "secondary"
                                : "text-button"
                            }
                            disabled={disabled}
                            onClick={() => act(action)}
                          >
                            {working === action && (
                              <Loader2 size={12} className="spin" />
                            )}
                            {TRIAGE_ACTIONS[action]}
                          </button>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ol>
              {(observing || run.observation.started) && (
                <div className="triage-observation" aria-live="polite">
                  <strong>
                    {observing
                      ? `观察中 · ${elapsed}/60 秒`
                      : run.observation.status === "cancelled"
                        ? "观察已停止"
                        : "观察记录"}
                  </strong>
                  <p>
                    {run.observation.samples} 次采样 · 起始识别{" "}
                    {run.observation.processCount} 个进程 · 最多{" "}
                    {run.observation.maxConnections} 条 TCP 连接 · 标记{" "}
                    {run.observation.markers.length} 次
                  </p>
                  {observing && (
                    <>
                      <progress
                        max={60}
                        value={elapsed}
                        aria-label="重连观察进度"
                      />
                      <button
                        className="secondary"
                        disabled={!!working}
                        onClick={() =>
                          void invoke("mark", async () => {
                            setRun(await api.markTriage(run.id));
                          })
                        }
                      >
                        现在出现重连，标记时刻
                      </button>
                    </>
                  )}
                  <small>
                    进程与连接数量不能确认正在使用哪个账号或会话，也不能证明持续响应稳定。
                  </small>
                </div>
              )}
              {run.status === "completed" && (
                <div className="triage-verification">
                  <button
                    className="primary"
                    disabled={disabled}
                    onClick={() => start(run.targetId)}
                  >
                    <RefreshCw size={14} />
                    处理后重新检查
                  </button>
                  <button
                    className="secondary"
                    disabled={disabled}
                    onClick={() =>
                      void invoke("restored", async () => {
                        setRun(await api.verifyTriage(run.id, "restored"));
                      })
                    }
                  >
                    我在原工具确认已恢复
                  </button>
                  <button
                    className="text-button"
                    disabled={disabled}
                    onClick={() =>
                      void invoke("still_failed", async () => {
                        setRun(await api.verifyTriage(run.id, "still_failed"));
                      })
                    }
                  >
                    原工具仍有问题
                  </button>
                  {run.verification !== "unknown" && (
                    <p>
                      用户复测记录：
                      {run.verification === "restored"
                        ? "已在原工具确认恢复"
                        : "原工具仍有问题，需要继续排查"}
                      。此记录来自你的确认。
                    </p>
                  )}
                </div>
              )}
            </>
          )}
          {message && (
            <p className="triage-action-message" role="status">
              {message}
            </p>
          )}
          <small className="triage-footnote">
            不自动改
            VPN、DNS、证书或系统路由，不结束占用端口的进程。“重建检测连接”只处理
            360AI盒子 自身缓存与连接。
          </small>
        </div>
      )}
    </section>
  );
}
