import { useEffect, useRef, useState } from "react";
import { ArrowRightLeft, CheckCircle2, Loader2, RefreshCw, RotateCcw, Trash2, TriangleAlert, Wand2 } from "lucide-react";
import Modal from "./Modal";
import type { DesktopAPI } from "./shared/types";
import type { SkillScan, SkillTidyAction, SkillTidyKind, SkillTidyReport, SkillTidyResult, SkillTidyScenario, SkillTidyVersion } from "./shared/skills";

const BUTTON: Record<SkillTidyKind, string> = {
  "wiscode-shadow": "移走旧副本",
  "nested-duplicate": "移走独立副本",
  "legacy-codex": "迁移到共享目录",
  "version-drift": "用最近版本更新",
  managed: "",
};
const CONFIRM: Record<SkillTidyKind, string> = {
  "wiscode-shadow": "我已了解：这些目录将移入回收区，WisCode 将改用 ~/.wiscode/skills 中的版本",
  "nested-duplicate": "我已了解：这些独立副本将移入回收区，之后通过父包使用",
  "legacy-codex": "我已了解：这些 Skill 将迁移到 ~/.agents/skills，并会在 Codex 中确认可见",
  "version-drift": "",
  managed: "",
};

const shortPath = (value: string) => value.replace(/^\/(?:Users|home)\/[^/]+/, "~");
const sizeText = (bytes?: number) => bytes === undefined ? "" : bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const dateText = (value?: string) => value ? new Date(value).toLocaleDateString("zh-CN") : "未知";

function Versions({ versions }: { versions?: SkillTidyVersion[] }) {
  if (!versions?.length) return null;
  return <details className="skill-tidy-versions"><summary>各版本对照（{versions.length}）</summary>
    {versions.map(row => <div key={row.path} className={row.newest ? "newest" : ""}>
      <strong>{row.source}{row.newest ? " · 最近修改" : ""}</strong>
      <span className="skill-path">{shortPath(row.path)}</span>
      <small>{row.digest ? `内容指纹 ${row.digest} · ${row.files ?? 0} 个文件 · ${sizeText(row.bytes)} · 最近修改 ${dateText(row.modifiedAt)}` : "内容比对未完成"}</small>
    </div>)}
  </details>;
}

function ActionRow({ action }: { action: SkillTidyAction }) {
  const operation = action.operation === "move" ? `迁移到 ${shortPath(action.destination ?? "")}`
    : action.operation === "trash" ? "移入回收区"
      : action.operation === "sync" ? `由 ${shortPath(action.keep ?? "")} 更新` : "仅说明";
  return <div className={`skill-tidy-action ${action.status}`}>
    <div className="skill-tidy-action-head">
      <strong>{action.name}</strong>
      {action.contentMatches === true && <span className="skill-insight-tag">内容一致</span>}
      {action.contentMatches === false && <span className="skill-insight-tag medium">内容不同</span>}
      {action.status === "blocked" ? <span className="skill-insight-tag medium">暂不可处理</span> : <span className="skill-insight-tag">{operation}</span>}
    </div>
    <span className="skill-path">{shortPath(action.path)}</span>
    {action.keep && action.operation !== "sync" && <small>处理后生效：{shortPath(action.keep)}</small>}
    {action.reason && <p className="skill-tidy-reason">{action.reason}</p>}
    {action.evidence.map(text => <small key={text}>依据：{text}</small>)}
    {action.warnings.map(text => <p key={text} className="skill-tidy-warning"><TriangleAlert size={12} />{text}</p>)}
    <Versions versions={action.versions} />
  </div>;
}

interface Props {
  api: DesktopAPI;
  scan: SkillScan;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onScan: (scan: SkillScan) => void;
  onCopy: (id: string, target?: string) => void;
}

export default function SkillTidy({ api, scan, busy, onBusy, onScan, onCopy }: Props) {
  const [report, setReport] = useState<SkillTidyReport>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<SkillTidyScenario>();
  const [selected, setSelected] = useState<string[]>([]);
  const [ack, setAck] = useState(false);
  const [results, setResults] = useState<SkillTidyResult[]>();
  const [message, setMessage] = useState("");
  const ticket = useRef(0);
  const supported = typeof api.skillTidy === "function";

  const load = async () => {
    if (!supported) return;
    const current = ++ticket.current;
    setLoading(true);
    setError("");
    try {
      const next = await api.skillTidy!();
      if (current === ticket.current) setReport(next);
    } catch (e) {
      if (current === ticket.current) setError((e as Error).message);
    } finally {
      if (current === ticket.current) setLoading(false);
    }
  };
  // 每次扫描结果更新后重新分析；分析期间不允许执行
  useEffect(() => { void load(); }, [scan]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!supported) return null;
  const ready = (scenario: SkillTidyScenario) => scenario.actions.filter(action => action.status === "ready");
  const open = (scenario: SkillTidyScenario) => {
    setConfirm(scenario);
    setSelected(ready(scenario).map(action => action.id));
    setAck(false);
    setResults(undefined);
    setError("");
  };
  const closeConfirm = async () => {
    if (busy) return;
    const changed = results?.some(row => row.status === "done");
    setConfirm(undefined);
    setResults(undefined);
    if (changed) {
      onBusy(true);
      try { onScan(await api.skills()); } catch (e) { setError((e as Error).message); } finally { onBusy(false); }
    }
  };
  const execute = async () => {
    if (!report || !confirm || !selected.length || !ack) return;
    onBusy(true);
    setError("");
    try {
      setResults(await api.applySkillTidy!(selected, report.token));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      onBusy(false);
    }
  };
  const revert = async (id: string) => {
    if (!api.revertSkillMove) return;
    onBusy(true);
    setError("");
    try {
      const record = await api.revertSkillMove(id);
      setMessage(`已撤销迁移：${record.name} 回到 ${shortPath(record.from)}`);
      onScan(await api.skills());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      onBusy(false);
    }
  };
  const startSync = (action: SkillTidyAction) => {
    if (!action.sourceItemId) return;
    onCopy(action.sourceItemId, action.targetId);
  };

  const actionable = report?.scenarios.reduce((sum, row) => sum + ready(row).length, 0) ?? 0;
  const chosen = confirm?.actions.filter(action => selected.includes(action.id)) ?? [];
  const differing = chosen.filter(action => action.contentMatches === false || action.warnings.length);

  return <section className="skill-tidy" aria-label="整理建议">
    <div className="skill-management-heading">
      <div>
        <h3>整理建议 {report && <span className="skill-insight-tag">{actionable} 项可处理</span>}</h3>
        <p>只针对有本机证据的场景。各工具需要各自的副本，跨工具副本默认保留；移动的项目可在回收区恢复，迁移可在本页撤销。</p>
      </div>
      <button className="secondary" type="button" disabled={busy || loading} onClick={() => void load()}>
        {loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}重新分析
      </button>
    </div>
    {error && !confirm && <div className="notice amber" role="alert">{error}</div>}
    {message && <div className="notice green" role="status">{message}</div>}
    {report?.notes.map(note => <div className="notice amber" key={note}>{note}</div>)}
    {loading && !report && <p className="skill-tidy-empty">正在分析…</p>}
    {report && !report.scenarios.length && <p className="skill-tidy-empty"><CheckCircle2 size={14} />没有需要整理的场景。</p>}
    {report?.scenarios.map(scenario => {
      const count = ready(scenario).length;
      return <div className={`skill-tidy-card ${scenario.kind}`} key={scenario.kind}>
        <div className="skill-tidy-card-head">
          <div>
            <h4>{scenario.title} <small>{scenario.actions.length} 项</small></h4>
            <p>{scenario.summary}</p>
          </div>
          {scenario.kind !== "managed" && scenario.kind !== "version-drift" && <button
            type="button" className="skill-tidy-button" disabled={busy || loading || !count} onClick={() => open(scenario)}
          >
            {scenario.kind === "legacy-codex" ? <ArrowRightLeft size={14} /> : <Trash2 size={14} />}
            {BUTTON[scenario.kind]}（{count}）
          </button>}
        </div>
        <div className="skill-tidy-actions">
          {scenario.actions.map(action => <div key={action.id} className="skill-tidy-action-wrap">
            <ActionRow action={action} />
            {scenario.kind === "version-drift" && <button
              type="button" className="secondary" disabled={busy || loading || action.status !== "ready"} onClick={() => startSync(action)}
            ><Wand2 size={13} />{BUTTON[scenario.kind]}</button>}
          </div>)}
        </div>
      </div>;
    })}
    {!!report?.moves.length && <details className="skill-tidy-moves">
      <summary>迁移记录（{report.moves.length}）· 可撤销</summary>
      {report.moves.map(move => <div className="skill-trash-row" key={move.id}>
        <div><strong>{move.name}</strong><small>{new Date(move.movedAt).toLocaleString()}</small><span className="skill-path">{shortPath(move.from)} → {shortPath(move.to)}</span></div>
        <button className="secondary" type="button" disabled={busy} onClick={() => void revert(move.id)}><RotateCcw size={14} />撤销迁移</button>
      </div>)}
    </details>}

    {confirm && <Modal title={`确认：${BUTTON[confirm.kind]}`} subtitle={confirm.title} onClose={() => void closeConfirm()} wide>
      <div className="modal-body skill-tidy-confirm">
        {!results ? <>
          <p>{confirm.summary}</p>
          <ul className="skill-tidy-impact">{confirm.impact.map(text => <li key={text}>{text}</li>)}</ul>
          <div className="skill-tidy-select">
            <strong>将处理以下 {selected.length} 项（可取消勾选）</strong>
            {confirm.actions.map(action => <label key={action.id} className={`skill-tidy-check ${action.status}`}>
              <input
                type="checkbox" disabled={busy || action.status !== "ready"} checked={selected.includes(action.id)}
                onChange={e => { setAck(false); setSelected(old => e.target.checked ? [...old, action.id] : old.filter(id => id !== action.id)); }}
              />
              <ActionRow action={action} />
            </label>)}
          </div>
          {differing.length > 0 && <div className="notice amber"><TriangleAlert size={15} /><div>
            其中 {differing.length} 项与保留版本内容不同或存在提示，请逐项查看上方的提示和版本对照后再确认。
          </div></div>}
          <label className="skill-confirm-check">
            <input type="checkbox" checked={ack} disabled={busy || !selected.length} onChange={e => setAck(e.target.checked)} />
            {CONFIRM[confirm.kind]}
          </label>
          <p className="skill-tidy-note">执行前会再次核对每个目录；如内容在此期间有变化，该项会跳过并提示重新分析。</p>
          {error && <div className="notice amber" role="alert">{error}</div>}
        </> : <div role="status" className="skill-tidy-results">
          <p>完成 {results.filter(row => row.status === "done").length} 项，跳过 {results.filter(row => row.status === "skipped").length} 项，失败 {results.filter(row => row.status === "failed").length} 项。</p>
          {results.map(row => <div key={row.id} className={`skill-tidy-result ${row.status}`}>
            <strong>{row.name}</strong>
            <span className={`badge ${row.status === "done" ? "green" : "amber"}`}>{row.status === "done" ? "已完成" : row.status === "skipped" ? "已跳过" : "失败"}</span>
            <span className="skill-path">{shortPath(row.path)}{row.destination ? ` → ${shortPath(row.destination)}` : ""}</span>
            <small>{row.message}</small>
          </div>)}
          <p className="skill-tidy-note">移入回收区的项目可在页面底部“回收区”恢复；迁移可在“迁移记录”中撤销。</p>
        </div>}
      </div>
      <div className="modal-footer">
        <button className="secondary" type="button" disabled={busy} onClick={() => void closeConfirm()}>{results ? "完成并刷新" : "取消"}</button>
        {!results && <button className="danger skill-tidy-submit" type="button" disabled={busy || !ack || !selected.length || loading} onClick={() => void execute()}>
          {busy ? <Loader2 size={14} className="spin" /> : confirm.kind === "legacy-codex" ? <ArrowRightLeft size={14} /> : <Trash2 size={14} />}
          确认{BUTTON[confirm.kind]}（{selected.length}）
        </button>}
      </div>
    </Modal>}
  </section>;
}
