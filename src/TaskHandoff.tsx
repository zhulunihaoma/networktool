import HandoffAttachments from "./HandoffAttachments";
import HistoryContext from "./HistoryContext";
import type { HistoryKind, HistoryVerification } from "./shared/history";
import { attachmentSize } from "./shared/handoff-attachments";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ArrowUpRight, CheckCircle2, Copy, FileText, FileUp, Folder, Loader2, RefreshCw, Search, ShieldCheck, X } from "lucide-react";
import type { DesktopAPI } from "./shared/types";
import type { HandoffImport, HandoffOptions } from "./shared/handoff";
import type { HandoffPreview, HandoffTarget, SourceTask, SourceTaskPage, HandoffTool, HandoffSource } from "./shared/handoff-api";
import { handoffToolLabel as toolLabel } from "./shared/handoff-api";

const baseTools: HandoffSource[] = ["OpenCode", "Codex", "ClaudeCode"];
type SourceTool = HandoffSource;
type DialogView = "read" | "configure" | "preview";
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unassigned = "\u0000unassigned";
function projectKey(directory: string) {
  const trimmed = directory.trim();
  return trimmed ? trimmed.replace(/[\\/]+$/, "") || trimmed : unassigned;
}
function projectName(directory: string) {
  return directory === unassigned ? "未关联项目" : directory.split(/[\\/]/).filter(Boolean).at(-1) || directory;
}

export default function TaskHandoff({ api }: { api: DesktopAPI; onError: (text: string) => void }) {
  const [detected, setDetected] = useState<HandoffTool[]>([]);
  const [detectBusy, setDetectBusy] = useState(false);
  const [detectError, setDetectError] = useState("");
  const detectionRequest = useRef<Promise<HandoffTool[]> | undefined>(undefined);
  const tools: HandoffSource[] = [...new Set([...baseTools, ...detected.filter(t => t.readable && (t.installed || t.historyFound)).map(t => t.id as HandoffSource)])];
  const targets: HandoffTarget[] = [...new Set([...baseTools, ...detected.filter(t => t.installed || t.historyFound).map(t => t.id)])];
  const discover = async () => {
    if (!api.discoverHandoffTools) { setDetectError("请重启应用以加载本机工具识别接口。"); return; }
    setDetectBusy(true); setDetectError("");
    const request = detectionRequest.current || (detectionRequest.current = api.discoverHandoffTools());
    try { setDetected(await request); } catch (error) { setDetectError(errorText(error)); }
    finally { if (detectionRequest.current === request) detectionRequest.current = undefined; setDetectBusy(false); }
  };
  useEffect(() => { void discover(); }, [api]);
  const [tasks, setTasks] = useState<SourceTask[]>([]);
  const [catalog, setCatalog] = useState<SourceTaskPage>();
  const [listed, setListed] = useState(false);
  const [listError, setListError] = useState("");
  const [activeTool, setActiveTool] = useState<SourceTool>("OpenCode");
  const [activeProject, setActiveProject] = useState("");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<HistoryKind | "">("");
  const [contextExported, setContextExported] = useState("");
  const [verification, setVerification] = useState<HistoryVerification>();
  const [verifying, setVerifying] = useState(false);
  useEffect(() => {
    if (!verifying || !api.getHandoffVerification) return;
    let active = true, pending = false;
    const timer = setInterval(() => {
      if (pending) return;
      pending = true;
      void api.getHandoffVerification!().then(value => {
        if (active && value?.source === activeTool) setVerification(value);
      }).catch(() => {}).finally(() => { pending = false; });
    }, 1000);
    return () => { active = false; clearInterval(timer); };
  }, [api, verifying, activeTool]);
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [listBusy, setListBusy] = useState(false);
  const [source, setSource] = useState<HandoffImport>();
  const [goal, setGoal] = useState("继续未完成任务；先核对当前文件和已完成操作，不重复未知结果的副作用。");
  const [target, setTarget] = useState<HandoffTarget>("Codex");
  const [options, setOptions] = useState<HandoffOptions>({ includeTranscript: true, includeWorkspace: true });
  const [preview, setPreview] = useState<HandoffPreview>();
  const [view, setView] = useState<DialogView | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const [stopped, setStopped] = useState(false);
  const [workspace, setWorkspace] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [attachmentValid, setAttachmentValid] = useState(true);
  const [attachmentsReviewed, setAttachmentsReviewed] = useState(false);
  const [copied, setCopied] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const dialogBody = useRef<HTMLDivElement>(null);
  useEffect(() => { if (dialogBody.current) dialogBody.current.scrollTop = 0; }, [view, source?.attachmentSession]);
  const actionLock = useRef(false);
  const listSequence = useRef(0);
  // Share pending reads: StrictMode replays mount effects, while IPC imports are exclusive.
  const pendingLists = useRef(new Map<string, Promise<SourceTaskPage | undefined>>());
  const readQueue = useRef<Promise<unknown>>(Promise.resolve());
  const activeReadKey = useRef("");
  const returnFocus = useRef<HTMLButtonElement | null>(null);

  const invalidate = () => { setAttachmentsReviewed(false); setPreview(undefined); setReviewed(false); setCopied(false); setDialogError(""); };
  const perform = async (action: () => Promise<void>) => {
    if (actionLock.current) return;
    actionLock.current = true; setBusy(true); setDialogError("");
    try { await action(); } catch (error) { setDialogError(errorText(error)); }
    finally { actionLock.current = false; setBusy(false); }
  };
  const imported = (value: HandoffImport) => {
    setContextExported("");
    setSource(value); setAttachmentValid(true); invalidate(); setStopped(false); setWorkspace(false);
    setOptions({ includeTranscript: true, includeWorkspace: true });
    setTarget(value.source === "Codex" ? "ClaudeCode" : "Codex");
  };
  const loadTasks = async (tool: SourceTool, cursor?: string) => {
    const sequence = ++listSequence.current;
    const key = JSON.stringify([tool, activeProject, debouncedQuery, kind, cursor || ""]);
    activeReadKey.current = key;
    setListBusy(true); setListError("");
    if (!cursor) setTasks([]);
    let request = pendingLists.current.get(key);
    if (!request) {
      request = readQueue.current.catch(() => {}).then(() => {
        if (activeReadKey.current !== key) return undefined;
        if (!api.browseSourceTasks) throw new Error("请重启应用以加载新版会话接口。");
        return api.browseSourceTasks(tool, { ...(activeProject ? { projectId: activeProject } : {}), ...(debouncedQuery ? { search: debouncedQuery } : {}), ...(kind ? { kind } : {}), ...(cursor ? { cursor } : {}) });
      });
      readQueue.current = request;
      pendingLists.current.set(key, request);
      void request.then(() => pendingLists.current.delete(key), () => pendingLists.current.delete(key));
    }
    try {
      const page = await request;
      if (sequence !== listSequence.current || !page) return;
      if (page.origin !== "history-index" && (tool === "Codex" || tool === "ClaudeCode") && page.tasks.some(task => !sessionIdPattern.test(task.id))) throw new Error(`收到非 ${toolLabel(tool)} 会话列表，请重启应用后刷新。`);
      setTasks(previous => [...new Map((cursor ? [...previous, ...page.tasks] : page.tasks).map(task => [task.id, task])).values()]);
      setCatalog(page); setListed(true);
    } catch (error) {
      if (sequence === listSequence.current) { if (!cursor) setTasks([]); setListed(true); setListError(errorText(error)); }
    } finally { if (sequence === listSequence.current) setListBusy(false); }
  };
  useEffect(() => { const timer = setTimeout(() => setDebouncedQuery(query), 300); return () => clearTimeout(timer); }, [query]);
  useEffect(() => {
    setListed(false); void loadTasks(activeTool);
    return () => { listSequence.current++; };
  }, [api, activeTool, activeProject, debouncedQuery, kind]);
  const readBusy = listBusy || query !== debouncedQuery;
  const isOpen = view !== null;
  useEffect(() => {
    const element = dialog.current;
    if (isOpen && !element?.open) element?.showModal();
    if (!isOpen && element?.open) { element.close(); returnFocus.current?.focus(); }
  }, [isOpen]);
  const close = () => { if (!actionLock.current) { setView(null); setDialogError(""); } };
  const openTask = (task: SourceTask, nextView: DialogView, trigger: HTMLButtonElement) => {
    if (actionLock.current || readBusy) return;
    returnFocus.current = trigger; setView(nextView); setSource(undefined); invalidate();
    void perform(async () => imported(await api.importSourceTask(task.id, activeTool)));
  };
  const projects = catalog?.projects || [];
  const visibleTasks = tasks;
  const currentProject = projects.find(project => project.id === activeProject);
  const taskProjectName = (task: SourceTask) => projects.find(project => project.id === task.projectId)?.name || projectName(projectKey(task.directory));
  const sourceTool = source?.source || activeTool;
  const paginated = catalog?.origin === "history-index" || activeTool !== "OpenCode" && activeTool !== "ClaudeCode";
  const otherDetected = detected.filter(t => !t.readable);

  return <div className="handoff-page">
    <div className="page-heading"><div><h1>任务接续</h1><p>找到一条会话，把需要的上下文交给另一个 AI。</p></div><span className="handoff-badge"><ShieldCheck size={15} /> 本地读取 · 确认后复制</span></div>
    <div className="handoff-tool-tabs" role="tablist" aria-label="来源工具">
      {tools.map(tool => <button key={tool} type="button" role="tab" disabled={busy || readBusy || verifying} aria-selected={activeTool === tool} className={activeTool === tool ? "active" : ""} onClick={() => { if (tool === activeTool) return; setActiveTool(tool); setActiveProject(""); setKind(""); setVerification(undefined); setQuery(""); setDebouncedQuery(""); setCatalog(undefined); setSource(undefined); invalidate(); }}><strong>{toolLabel(tool)}</strong>{activeTool === tool && <small>{listBusy ? "读取中…" : listError ? "读取失败" : `已加载 ${tasks.length} 条`}</small>}</button>)}
    </div>
    <section className="handoff-browser" aria-label="会话浏览">
      <div className="handoff-browser-head"><div><h2>选择要接力的会话</h2><p>按项目浏览；点击“接力”后选择目标和携带内容。</p></div><div className="handoff-actions"><button className="secondary" disabled={detectBusy || busy || readBusy || verifying} onClick={() => void discover()}><RefreshCw size={15} className={detectBusy ? "spin" : ""} />{detectBusy ? "识别中…" : "识别本机工具"}</button>{activeTool === "OpenCode" && <button className="secondary" disabled={busy || readBusy || verifying} onClick={event => {
        returnFocus.current = event.currentTarget;
        void perform(async () => { const value = await api.chooseHandoffFile(); if (value) { imported(value); setView("configure"); } });
      }}><FileUp size={15} /> 导入 JSON</button>}<button className="secondary" disabled={readBusy || busy || verifying} onClick={() => void loadTasks(activeTool)}><RefreshCw size={15} className={listBusy ? "spin" : ""} /> 刷新</button></div></div>
      {detectError && <div className="notice amber" role="alert">工具识别未完成：{detectError}</div>}
      {detected.length > 0 && <div className="handoff-discovery"><span>已发现 {detected.filter(t => t.installed || t.historyFound).length} 种工具 · {detected.filter(t => t.readable && (t.installed || t.historyFound)).length} 种可读取来源</span>{otherDetected.length > 0 && <details><summary>其他已识别工具（{otherDetected.length}）</summary>{otherDetected.map(t => <p key={t.id}><strong>{t.name}</strong> · {t.installed ? "已安装" : t.historyFound ? "发现历史记录" : "发现配置"}；{t.detail}</p>)}</details>}</div>}
      {listBusy && <p className="handoff-loading" role="status"><Loader2 className="spin" size={17} /> 正在读取 {toolLabel(activeTool)} 会话摘要…</p>}
      {listError && <div className="notice amber" role="alert"><div><strong>无法读取本机 {toolLabel(activeTool)} 会话</strong><p>{listError}</p><p>点击刷新重试{activeTool === "OpenCode" ? "，或导入原生导出 JSON。" : "；请检查本机会话文件是否可访问。"}</p></div></div>}
      {dialogError && !isOpen && <div className="notice amber" role="alert">{dialogError}</div>}
      {listed && !readBusy && !listError && !tasks.length && !projects.length && <div className="handoff-empty"><FileText size={25} /><h3>还没有可读取的会话</h3><p>在 {toolLabel(activeTool)} 中创建会话后刷新。{activeTool === "OpenCode" && <>也可导入 <code>opencode export 会话ID --pure</code> 保存的 JSON。</>}</p></div>}
      {catalog && <div className="handoff-origin"><span>{catalog.origin === "history-index" ? `${toolLabel(activeTool)} 全量本地索引` : activeTool === "Codex" ? (catalog.origin === "codex-app-server" ? "Codex 客户端会话" : "兼容读取 · 客户端可见性未验证") : `${toolLabel(activeTool)} 本地历史${activeTool === "WisCode" ? " · Claude / Codex 引擎" : activeTool === "CopilotCode" ? " · 标题取首条请求，项目待确认" : ""}`}</span>{catalog.warnings.length > 0 && <details><summary>读取说明</summary>{catalog.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>}</div>}
      {api.addHandoffSourceDirectory && <div className="handoff-actions"><button className="secondary" disabled={readBusy||verifying||busy} onClick={()=>void perform(async()=>{const page=await api.addHandoffSourceDirectory?.(activeTool);if(page){setCatalog(page);setTasks(page.tasks);setActiveProject("");}})}>添加来源数据目录</button></div>}
      {catalog?.coverage && <div className="handoff-discovery"><span>已索引 {catalog.coverage.indexedRecords.toLocaleString()} 条来源记录 · 项目 {catalog.coverage.projects === "complete" ? "已核对" : "待核验"} · 正文 {catalog.coverage.context === "complete" ? "已读取" : catalog.coverage.context === "partial" ? "有缺口" : "待核验"} · 附件 {catalog.coverage.attachments === "complete" ? "已核验" : catalog.coverage.attachments === "partial" ? "有缺口" : "待核验"}</span><label>会话类别 <select aria-label="会话类别" value={kind} disabled={readBusy||verifying} onChange={e=>setKind(e.target.value as HistoryKind|"")}><option value="">全部类别</option>{Object.entries({conversation:"主会话",archived:"归档",subagent:"子会话",automation:"自动化",draft:"草稿与空白",deleted:"已删除标记",orphan:"独立或残留记录"}).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label><button className="secondary" disabled={readBusy||verifying} onClick={()=>{setVerifying(true);setVerification(undefined);void api.verifyHandoffHistory?.(activeTool).then(result => { setVerification(result); if(result.coverage) setCatalog(current => current ? {...current, coverage:result.coverage!} : current); },e=>setListError(errorText(e))).finally(()=>setVerifying(false));}}>{verifying?"正在逐个核验上下文…":"校验全部上下文"}</button>{verifying&&<button className="secondary" onClick={()=>void api.cancelHandoffVerification?.()}>取消核验</button>}{verification&&<p role="status">已检查 {verification.checked}/{verification.total} 条，读取 {(verification.bytes/1024/1024).toFixed(2)} MB；{verification.failures.length} 条有缺口。{verifying?"正在继续核验…":verification.complete?"全部维度核验通过。":"正文、附件或来源登记存在缺口，详见读取说明。"}</p>}{verification && !verifying && verification.failures.length > 0 && <details><summary>查看上下文缺口（{verification.failures.length}）</summary>{verification.failures.map((failure,index)=><p key={index}>{failure.id}：{failure.reason}</p>)}</details>}</div>}
      {catalog && (projects.length > 0 || tasks.length > 0) && <div className="handoff-browser-grid"><nav className="handoff-projects" aria-label="项目分类"><span className="handoff-project-label">项目</span><button disabled={busy || readBusy || verifying} className={!activeProject ? "active" : ""} onClick={() => setActiveProject("")}><Folder size={16} /><span><strong>全部项目</strong><small>{paginated ? "项目与历史目录" : "最近 30 条会话范围"}</small></span><em>{projects.length}</em></button>{projects.map(project => <button key={project.id} disabled={busy || readBusy || verifying} className={activeProject === project.id ? "active" : ""} onClick={() => setActiveProject(project.id)} title={project.directories.join("\n") || "来源未声明目录"}><Folder size={16} /><span><strong>{project.name}</strong><small>{project.registered ? "已登记 · " : ""}{project.directories.join("、") || "来源未声明目录"}</small></span>{project.count !== undefined && <em>{project.count}</em>}</button>)}</nav>
        <div className="handoff-conversations"><label className="handoff-search"><Search size={17} /><input aria-label="搜索对话" value={query} maxLength={500} onChange={event => setQuery(event.target.value)} placeholder={paginated ? "搜索全部会话（包含未加载的分页）" : "搜索会话标题、项目路径或会话 ID"} />{query && <button className="handoff-icon-button" aria-label="清除搜索" onClick={() => setQuery("")}><X size={15} /></button>}</label><div className="handoff-conversations-title"><strong>{currentProject?.name || "全部会话"}</strong><span>{visibleTasks.length} 条{catalog.nextCursor ? "已加载 · 还有更多" : " · 已全部加载"}</span></div>
          {visibleTasks.length ? <div className="handoff-task-list">{visibleTasks.map(task => <article className="handoff-task" key={task.id}>
            <button className="handoff-task-title" title={task.title} disabled={busy || readBusy || verifying} onClick={event => openTask(task, "read", event.currentTarget)}>{task.title}</button>
            <div className="handoff-task-meta"><span className="handoff-project-tag" title={task.directory}>{taskProjectName(task)}</span><span>{toolLabel(activeTool)}</span><time>{task.updated ? new Date(task.updated).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "时间未知"}</time><span className="handoff-session-id" title={task.id}>{task.nativeId || task.id}</span>{task.kind && <span>{({conversation:"主会话",archived:"归档",subagent:"子会话",automation:"自动化",draft:"草稿",deleted:"已删除",orphan:"独立记录"})[task.kind]}</span>}</div>
            <div className="handoff-task-actions"><button className="handoff-read" disabled={busy || readBusy || verifying} onClick={event => openTask(task, "read", event.currentTarget)}><FileText size={14} /> 预览记录</button><button className="handoff-relay" disabled={busy || readBusy || verifying} onClick={event => openTask(task, "configure", event.currentTarget)}>接力 <ArrowUpRight size={15} /></button></div>
          </article>)}</div> : <div className="handoff-empty"><p>{query ? "没有匹配的会话，试试其他关键词。" : "这个项目还没有可读取的聊天。"}</p>{query && <button className="secondary" onClick={() => setQuery("")}>清除搜索</button>}</div>}
          {catalog.nextCursor && <button className="secondary handoff-load-more" disabled={busy || readBusy || verifying} onClick={() => void loadTasks(activeTool, catalog.nextCursor)}>{readBusy ? <Loader2 size={15} className="spin" /> : null}加载更多会话</button>}
          <p className="handoff-muted">{paginated ? "按当前项目独立查询，可继续加载历史；选定后只读获取正文。" : "只读列出最近 30 条摘要，选定后读取正文。"}会话记录不代表当前任务状态。</p>
        </div></div>}
    </section>
    <dialog className={`handoff-dialog${view === "configure" ? " handoff-dialog-configure" : ""}`} ref={dialog} aria-labelledby="handoff-dialog-title" onCancel={event => { event.preventDefault(); close(); }}>
      <div className="handoff-dialog-head"><div><h2 id="handoff-dialog-title">{view === "read" ? "会话预览" : view === "preview" ? (copied ? "已复制接力内容" : preview?.exportedPath ? "附件包已导出" : "检查接力内容") : "接力这条会话"}</h2><p>{view === "read" ? "本地读取 · 已脱敏 · 只读核对" : view === "preview" ? `${toolLabel(sourceTool)} → ${toolLabel(target)}` : "选择目标 AI，以及本次要携带的内容。"}</p></div><button className="handoff-icon-button" disabled={busy} onClick={close} aria-label="关闭接力弹窗"><X size={20} /></button></div>
      <div className="handoff-dialog-body" ref={dialogBody} aria-busy={busy}>
        {busy && !source && <p className="handoff-loading" role="status"><Loader2 className="spin" size={18} /> 正在读取所选会话…</p>}
        {dialogError && <div className="notice amber" role="alert">{dialogError}</div>}
        {source && <>
          <div className="handoff-source"><small>{toolLabel(sourceTool)} · {projectName(projectKey(source.directory))} · {source.messageCount} 条{source.context ? "原始记录" : "消息"}</small><strong title={source.title}>{source.title}</strong><details><summary>查看来源信息</summary><p>工作区：<code>{source.directory || "未声明"}</code></p><p>会话：<code>{source.id}</code></p><p>{source.redactions} 处已知敏感信息已脱敏。</p></details></div>
          {source.context && view !== "preview" ? <HistoryContext key={source.context.id} api={api} archive={source.context} busy={busy} exported={contextExported} onExport={()=>void perform(async()=>{const result=await api.exportHandoffContext?.(source.context!.id);if(result){setContextExported(result.path);invalidate();}})}/> : view === "read" && <div className="handoff-transcript"><h3>会话正文</h3>{source.transcript.trim() ? <pre>{source.transcript}</pre> : <p>该会话没有可展示的用户或回复文本。</p>}</div>}
          {source.attachmentSession && !source.context && <div hidden={view !== "configure"}><HandoffAttachments key={source.attachmentSession} api={api} session={source.attachmentSession} active={view === "configure"} busy={busy} options={options} run={perform} onValidityChange={setAttachmentValid} onChange={value => { setOptions(previous => ({...previous,...value})); invalidate(); }} /></div>}
          {view === "configure" && <>
            <fieldset className="handoff-targets"><legend>交给哪个 AI</legend>{targets.filter(tool => tool !== sourceTool).map(tool => <button type="button" key={tool} disabled={busy} aria-pressed={target === tool} className={target === tool ? "active" : ""} onClick={() => { setTarget(tool); setWorkspace(false); invalidate(); }}>{toolLabel(tool)}{target === tool && <CheckCircle2 size={16} />}</button>)}</fieldset>
            <fieldset className="handoff-includes"><legend>本次携带的内容</legend><label><input type="checkbox" checked disabled /><span>本次接力目标<small>始终携带，由你填写</small></span></label><label><input type="checkbox" checked={options.includeTranscript} disabled={busy} onChange={e => { setOptions({ ...options, includeTranscript: e.target.checked }); invalidate(); }} /><span>会话历史<small>已脱敏的用户请求与来源记录</small></span></label><label><input type="checkbox" checked={options.includeWorkspace} disabled={busy} onChange={e => { setOptions({ ...options, includeWorkspace: e.target.checked }); invalidate(); }} /><span>来源工作区<small>项目目录，供目标工具核对</small></span></label></fieldset>
            <label className="handoff-field">本次继续做什么<textarea value={goal} maxLength={4000} disabled={busy} onChange={e => { setGoal(e.target.value); invalidate(); }} rows={3} placeholder="说明要继续的任务、需要保留的约束和下一步。" /></label>
            <details className="handoff-warnings"><summary>来源完整性与注意事项{source.warnings.length ? `（${source.warnings.length}）` : ""}</summary><ul>{source.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul><p>仅交接语义上下文；内部推理、登录状态和运行进程不会迁移。脱敏仍需人工检查。</p></details>
          </>}
          {view === "preview" && preview && <>
            {preview.attachments && <div className="handoff-package-summary"><strong>附件接力包 · 已选 {preview.attachments.entries.length} 条 · {attachmentSize(preview.attachments.bytes)}</strong><p>包含交接说明、附件与消息对应清单。{preview.attachments.omitted > 0 ? `另有 ${preview.attachments.omitted} 条记录未携带。` : ""}{!preview.attachments.complete ? "本次仅导出选定部分，未保证全部附件完整。" : ""}</p>{preview.exportedPath ? <p role="status">已保存到：<code>{preview.exportedPath}</code>。请在目标工具中选择附件包或解压后读取；复制说明不会上传文件。</p> : <p>确认后选择保存目录；取消保存不会导出或复制。</p>}</div>}
            <div className="handoff-preview-meta"><span>以下是实际复制的全部内容</span><span>{preview.content.length.toLocaleString()} 字符 · 10 分钟内有效</span></div><pre className="handoff-prompt">{preview.content}</pre>
            {copied ? <div className="handoff-success" role="status"><CheckCircle2 size={20} /><div><strong>已复制，接下来粘贴到 {toolLabel(target)}</strong><p>{preview.attachments ? "接下来在目标工具中选择附件包，或解压后让它读取附件。仅粘贴说明不会上传文件；请确认目标工具能访问这些文件。" : "在目标工具中打开正确工作区，粘贴并发送后开始接力。本应用尚未发送或启动任务。"}</p></div></div> : <fieldset className="handoff-confirmations"><legend>接力前确认</legend><label className="handoff-check"><input type="checkbox" checked={stopped} disabled={busy} onChange={e => setStopped(e.target.checked)} /> 原任务已停止修改此项目</label><label className="handoff-check"><input type="checkbox" checked={workspace} disabled={busy} onChange={e => setWorkspace(e.target.checked)} /> 已确认目标工具使用正确的工作区</label><label className="handoff-check"><input type="checkbox" checked={reviewed} disabled={busy} onChange={e => setReviewed(e.target.checked)} /> 已检查全文与敏感信息，同意复制到系统剪贴板</label>{preview.attachments && <label className="handoff-check"><input type="checkbox" checked={attachmentsReviewed} disabled={busy} onChange={e=>setAttachmentsReviewed(e.target.checked)} /> 已检查所选附件原内容（未经脱敏），同意导出</label>}</fieldset>}
          </>}
        </>}
      </div>
      <div className="handoff-dialog-footer">
        {view === "read" ? <><span>历史记录仅供核对，不自动执行。</span><button className="primary" disabled={busy || !source} onClick={() => { setView("configure"); setDialogError(""); }}>接力此会话 <ArrowRight size={16} /></button></> : view === "configure" ? <><span>{!attachmentValid ? "请选择附件并确认未携带的内容。" : "生成预览前先导出要携带的完整上下文；也可取消携带会话历史。"}</span><button className="primary" disabled={busy || !source || !goal.trim() || !attachmentValid || !!source?.context && options.includeTranscript && !contextExported} onClick={() => void perform(async () => { const next = await api.previewHandoff(goal, target, options); setPreview(next); setReviewed(false); setCopied(false); setView("preview"); })}>{busy ? <Loader2 size={16} className="spin" /> : null}生成接力预览 <ArrowRight size={16} /></button></> : <><button className="secondary" disabled={busy} onClick={() => { invalidate(); setView("configure"); }}><ArrowLeft size={15} /> 调整内容</button>{copied ? <button className="primary" onClick={close}>完成</button> : preview?.attachments && !preview.exportedPath ? <button className="primary" disabled={busy || !reviewed || !stopped || !workspace || !attachmentsReviewed} onClick={() => void perform(async () => { const result = await api.exportHandoffPackage(preview.token); if (result) setPreview(result.preview); })}>{busy ? <Loader2 className="spin" size={16} /> : <FileUp size={16} />}确认并导出附件接力包</button> : <button className="primary" disabled={busy || !preview || !reviewed || !stopped || !workspace} onClick={() => void perform(async () => { await api.copyHandoff(preview!.token); setCopied(true); })}>{busy ? <Loader2 className="spin" size={16} /> : <Copy size={16} />}{preview?.exportedPath ? "复制说明与附件包路径" : "确认并复制接力内容"}</button>}</>}
      </div>
    </dialog>
  </div>;
}
