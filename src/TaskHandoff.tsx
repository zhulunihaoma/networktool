import { useEffect, useMemo, useState } from "react";
import { ArrowRight, CheckCircle2, Copy, FileUp, Folder, Loader2, RefreshCw, Search, ShieldCheck } from "lucide-react";
import type { DesktopAPI } from "./shared/types";
import type { HandoffImport } from "./shared/handoff";
import type { HandoffPreview, HandoffTarget, SourceTask } from "./shared/handoff-api";

const tools = ["OpenCode", "WisCode", "Codex", "WorkBuddy"] as const;
type SourceTool = typeof tools[number];
const unassigned = "\u0000unassigned";
function projectKey(directory: string) {
  const trimmed = directory.trim();
  return trimmed ? trimmed.replace(/[\\/]+$/, "") || trimmed : unassigned;
}
function projectName(directory: string) {
  return directory === unassigned ? "未关联项目" : directory.split(/[\\/]/).filter(Boolean).at(-1) || directory;
}

export default function TaskHandoff({ api, onError }: { api: DesktopAPI; onError: (text: string) => void }) {
  const [tasks, setTasks] = useState<SourceTask[]>([]);
  const [listed, setListed] = useState(false);
  const [listError, setListError] = useState("");
  const [activeTool, setActiveTool] = useState<SourceTool>("OpenCode");
  const [activeProject, setActiveProject] = useState("");
  const [query, setQuery] = useState("");
  const [listBusy, setListBusy] = useState(false);
  const [source, setSource] = useState<HandoffImport>();
  const [goal, setGoal] = useState("继续未完成任务；先核对当前文件和已完成操作，不重复未知结果的副作用。");
  const [target, setTarget] = useState<HandoffTarget>("WisCode");
  const [preview, setPreview] = useState<HandoffPreview>();
  const [busy, setBusy] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [workspace, setWorkspace] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [copied, setCopied] = useState(false);
  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    try { await action(); } catch (error) { onError((error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")); }
    finally { setBusy(false); }
  };
  const invalidate = () => { setPreview(undefined); setReviewed(false); setCopied(false); };
  const imported = (value: HandoffImport | undefined) => {
    if (!value) return;
    setSource(value); setActiveTool(value.source || "OpenCode"); setActiveProject(projectKey(value.directory)); invalidate(); setStopped(false); setWorkspace(false);
  };
  const loadTasks = async (cancelled?: () => boolean) => {
    setListBusy(true); setListError("");
    try {
      const list = await api.listSourceTasks(activeTool === "Codex" ? "Codex" : "OpenCode");
      if (cancelled?.()) return;
      if (activeTool === "Codex" && list.some(task => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(task.id))) {
        throw new Error("收到非 Codex 会话列表，请重启应用后刷新。");
      }
      setTasks(list); setListed(true);
      setActiveProject(current => current && list.some(task => projectKey(task.directory) === current) ? current : "");
    } catch (error) {
      if (!cancelled?.()) { setTasks([]); setListed(true); setListError((error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")); }
    } finally { if (!cancelled?.()) setListBusy(false); }
  };
  useEffect(() => { if (activeTool !== "OpenCode" && activeTool !== "Codex") return; let cancelled = false; setTasks([]); setListed(false); void loadTasks(() => cancelled); return () => { cancelled = true; }; }, [api, activeTool]);
  const projects = useMemo(() => {
    const groups = new Map<string, { directory: string; count: number; updated: number }>();
    for (const task of tasks) {
      const key = projectKey(task.directory);
      const group = groups.get(key) || { directory: key, count: 0, updated: 0 };
      group.count++; group.updated = Math.max(group.updated, task.updated);
      groups.set(key, group);
    }
    return [...groups.values()].sort((a, b) => b.updated - a.updated || a.directory.localeCompare(b.directory));
  }, [tasks]);
  const visibleTasks = useMemo(() => tasks.filter(task =>
    (!activeProject || projectKey(task.directory) === activeProject) &&
    (!query.trim() || `${task.title} ${task.directory} ${task.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  ).sort((a, b) => b.updated - a.updated), [tasks, activeProject, query]);
  const selectedTask = source?.source === activeTool || (!source?.source && activeTool === "OpenCode") ? tasks.find(task => task.id === source?.id) : undefined;
  return <div className="handoff-page">
    <div className="page-heading"><div><h1>任务接续</h1><p>按本机会话记录查找项目和请求，确认后交给另一个 AI 继续。</p></div><span className="handoff-badge"><ShieldCheck size={15} /> 本地预览 · 不自动发送</span></div>
    <div className="handoff-tool-tabs" role="tablist" aria-label="来源工具">
      {tools.map(tool => <button key={tool} type="button" role="tab" disabled={busy || listBusy} aria-selected={activeTool === tool} className={activeTool === tool ? "active" : ""} onClick={() => { if (tool === activeTool) return; setActiveTool(tool); setTasks([]); setListed(false); setListError(""); setActiveProject(""); setQuery(""); setSource(undefined); invalidate(); setStopped(false); setWorkspace(false); }}><strong>{tool}</strong><small>{tool === "OpenCode" || tool === "Codex" ? activeTool === tool ? (listBusy ? "读取中" : listError ? "读取失败" : `${tasks.length} 条对话 · 可读取`) : "本地会话" : "历史待接入"}</small></button>)}
    </div>
    <div className="notice amber"><ShieldCheck size={18} /><div><strong>这是语义交接，不是内部会话无损迁移</strong><p>不会共享账号额度、登录凭据、内部推理或运行进程。仅在选择来源时读取其本地历史，不自动执行来源命令。</p></div></div>
    <div className="handoff-grid">
      <section className="panel handoff-section handoff-browser">
        <div className="handoff-browser-head"><div><h2>1. 找到要接续的对话</h2><p>按工具、项目和单条对话定位来源；选择后才读取该对话的完整记录。</p></div>{(activeTool === "OpenCode" || activeTool === "Codex") && <button className="secondary" disabled={listBusy || busy} onClick={() => void loadTasks()}><RefreshCw size={15} /> 刷新</button>}</div>
        {activeTool === "OpenCode" || activeTool === "Codex" ? <>
          <div className="handoff-actions">{activeTool === "OpenCode" && <button className="secondary" aria-label="导入导出 JSON" disabled={busy || listBusy} onClick={() => void perform(async () => imported(await api.chooseHandoffFile()))}><FileUp size={16} /> 导入 OpenCode JSON</button>}<span>只读列出最近 30 条会话摘要 · 本地操作，不调用模型</span></div>
          {listBusy && <p role="status"><Loader2 className="spin" size={15} /> 正在读取 {activeTool} 会话摘要…</p>}
          {listError && <div className="notice amber" role="alert"><div><strong>无法读取本机 {activeTool} 列表</strong><p>{listError}。可重试{activeTool === "OpenCode" ? "或导入原生导出 JSON" : "；请检查本机会话文件是否可访问"}。</p></div></div>}
          {busy && <p role="status"><Loader2 className="spin" size={15} /> 正在导入所选对话…</p>}
          {listed && !listBusy && !listError && !tasks.length && <p className="handoff-empty">没有找到可读取的会话。{activeTool === "OpenCode" && <>可导入 <code>opencode export 会话ID --pure</code> 保存的 JSON。</>}</p>}
          {tasks.length > 0 && <div className="handoff-browser-grid"><nav className="handoff-projects" aria-label="项目分类"><button className={!activeProject ? "active" : ""} onClick={() => setActiveProject("")}><Folder size={16} /><span><strong>全部项目</strong><small>最近 30 条对话</small></span><em>{tasks.length}</em></button>{projects.map(project => <button key={project.directory} className={activeProject === project.directory ? "active" : ""} onClick={() => setActiveProject(project.directory)} title={project.directory === unassigned ? "来源未声明目录" : project.directory}><Folder size={16} /><span><strong>{projectName(project.directory)}</strong><small>{project.directory === unassigned ? "来源未声明目录" : project.directory}</small></span><em>{project.count}</em></button>)}</nav><div className="handoff-conversations"><label className="handoff-search"><Search size={16} /><input aria-label="搜索对话" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索标题、路径或会话 ID" /></label><div className="handoff-conversations-title"><strong>{activeProject ? projectName(activeProject) : "全部对话"}</strong><span>{visibleTasks.length} 条 · 最近更新优先</span></div>{visibleTasks.length ? <div className="handoff-task-list">{visibleTasks.map(task => <button className={`handoff-task ${source?.id === task.id && (source.source || "OpenCode") === activeTool ? "selected" : ""}`} key={task.id} disabled={busy || listBusy} onClick={() => void perform(async () => imported(await api.importSourceTask(task.id, activeTool === "Codex" ? "Codex" : "OpenCode")))}><strong>{task.title}</strong><small>{projectName(projectKey(task.directory))} · {task.updated ? new Date(task.updated).toLocaleString("zh-CN") : "时间未知"}</small><span>会话 {task.id} <ArrowRight size={14} /></span></button>)}</div> : <p className="handoff-empty">此项目没有匹配的对话，试试清除搜索条件。</p>}</div></div>}
          {source && (source.source || "OpenCode") === activeTool && <div className="handoff-selected"><CheckCircle2 size={17} /><div><strong>已选对话：{source.title}</strong><small>{selectedTask ? projectName(projectKey(selectedTask.directory)) : projectName(projectKey(source.directory))} · {source.messageCount} 条消息 · 点击右侧继续确认</small></div></div>}
        </> : <div className="handoff-source-empty"><Folder size={25} /><h3>{activeTool} 对话历史尚未接入</h3><p>{activeTool} 可作为交接目标，目前不读取其私人项目或会话；此处不会虚构任务。</p><button className="secondary" onClick={() => setActiveTool("OpenCode")}>查看 OpenCode 对话 <ArrowRight size={15} /></button></div>}
        <p className="handoff-muted">会话列表仅是来源摘要，不代表未完成状态；项目按来源声明的完整目录分组，未声明目录单列。直接读取不启动来源工具；超限会话不静默截断。</p>
      </section>
      <section className="panel handoff-section">
        <h2>2. 确认接续目标</h2>
        {!source ? <p className="handoff-empty">先选择一条{activeTool === "Codex" ? " Codex" : activeTool === "OpenCode" ? " OpenCode" : "来源"}对话{activeTool === "OpenCode" ? "，或导入 OpenCode 原生导出 JSON" : ""}。导入记录只在本次应用内存中保留。</p> : <>
          <div className="handoff-source"><strong>{source.title}</strong><p>来源工作区：<code>{source.directory}</code></p><small>{source.messageCount} 条消息 · {source.redactions} 处脱敏 · 会话 {source.id}</small></div>
          <label className="handoff-field">目标工具<select value={target} disabled={busy} onChange={e => { setTarget(e.target.value as HandoffTarget); invalidate(); }}>{["WisCode", "OpenCode", "Codex", "WorkBuddy"].map(name => <option key={name}>{name}</option>)}</select></label>
          <label className="handoff-field">本次继续做什么<textarea value={goal} maxLength={4000} disabled={busy} onChange={e => { setGoal(e.target.value); invalidate(); }} rows={4} /></label>
          <div className="handoff-warnings"><strong>完整性与安全提醒</strong><ul>{source.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul><p>脱敏仅覆盖已知格式，仍需检查自定义凭据和敏感业务内容。</p></div>
          <label className="handoff-check"><input type="checkbox" checked={stopped} disabled={busy} onChange={e => { setStopped(e.target.checked); invalidate(); }} /> 我确认原工具已停止，没有后台任务继续修改此项目</label>
          <label className="handoff-check"><input type="checkbox" checked={workspace} disabled={busy} onChange={e => { setWorkspace(e.target.checked); invalidate(); }} /> 我已在目标工具打开同一工作区，并核对当前文件</label>
          <button className="primary" disabled={busy || !stopped || !workspace || !goal.trim()} onClick={() => void perform(async () => { setPreview(await api.previewHandoff(goal, target)); setReviewed(false); setCopied(false); })}>生成交接预览 <ArrowRight size={16} /></button>
        </>}
      </section>
    </div>
    {preview && <section className="panel handoff-section handoff-preview"><h2>3. 预览并交给 {target}</h2><p>下面是实际复制的全部内容（{preview.content.length.toLocaleString()} 字符）。此处不会发送给任何 AI；预览十分钟内有效。</p><pre>{preview.content}</pre>
      <label className="handoff-check"><input type="checkbox" checked={reviewed} disabled={busy || copied} onChange={e => setReviewed(e.target.checked)} /> 我已检查全文和敏感信息，同意将这些内容复制到系统剪贴板</label>
      <div className="handoff-actions"><button className="primary" disabled={busy || !reviewed || !stopped || !workspace || copied} onClick={() => void perform(async () => { await api.copyHandoff(preview.token); setCopied(true); })}><Copy size={16} /> {copied ? "已复制，尚未发送" : "确认并复制交接内容"}</button><span>手动粘贴到 {target} 后再发送；粘贴前不要清空或覆盖原会话。</span></div>
      {copied && <div className="notice"><CheckCircle2 size={18} /><div><strong>已复制，尚未发送或开始执行</strong><p>切回 {target} 的同项目会话，粘贴并发送。先让它复核已做 / 待做 / 未知结果，再继续任务。剪贴板可能被其他应用读取，使用后可自行清空。</p></div></div>}
    </section>}
  </div>;
}
