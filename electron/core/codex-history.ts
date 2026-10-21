/** Codex history adapter: official API first, explicit read-only local fallback. */
import { bindAttachments, transferAttachments, contentAttachments, type AttachmentCandidate } from "./handoff-attachments";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { HANDOFF_LIMITS, sanitizer, type HandoffImport } from "../../src/shared/handoff";
import type { SourceProject, SourceTask, SourceTaskPage, SourceTaskQuery } from "../../src/shared/handoff-api";
import { connectCodexAppServer, CodexRpcError, type CodexClientFactory, type CodexReadClient } from "./codex-app-server";
import { catalogProjects, directoryKey, directoryProjectId, interactiveCodex, isObject, projectForThread, readCodexIndex, stringValue, type CodexIndex, type CodexProject, type IndexedCodexThread } from "./codex-local-index";
import { CodexRolloutHistory } from "./codex-rollout-history";

const defaultRoot = () => path.join(os.homedir(), ".codex", "sessions");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 50;
const ordinary = (s: string) => !!s.trim() && !/^\s*(?:<(?:environment_context|user_instructions|system_instructions|developer_instructions|assistant_instructions|agent_instructions|wiscode_runtime_instructions)\b|#\s+AGENTS\.md instructions\s*<INSTRUCTIONS>)/i.test(s);
type Listed = { task: SourceTask; file: string; historyMode: string; origin: SourceTaskPage["origin"] };
type Cursor = { scope: string; origin: SourceTaskPage["origin"]; value: string | number };
export interface CodexHistoryOptions {
  client?: CodexClientFactory | null;
  index?: () => Promise<CodexIndex>;
}
function metadata(value: unknown): { task: SourceTask; file: string; historyMode: string } {
  if (!isObject(value) || !uuid.test(stringValue(value.id)) || !interactiveCodex(value.source, value.threadSource) || value.archived === true) throw new Error("Codex 返回了无效或非用户聊天记录。");
  return { task: { id: value.id as string, title: stringValue(value.name) || stringValue(value.title) || stringValue(value.preview) || "无标题对话", directory: stringValue(value.cwd), updated: (Number(value.updatedAt) || Number(value.createdAt) || 0) * 1000, projectId: stringValue(value.projectId) || undefined }, file: stringValue(value.path), historyMode: stringValue(value.historyMode) };
}
function cleanTask(task: SourceTask): SourceTask {
  const clean = sanitizer();
  return { ...task, title: clean.clean(task.title).slice(0, 500), directory: clean.clean(task.directory) };
}
function cleanProjects(projects: CodexProject[]): SourceProject[] {
  const clean = sanitizer();
  return projects.map(({ aliases: _aliases, ...project }) => ({ ...project, name: clean.clean(project.name), directories: project.directories.map(clean.clean) }));
}

export class CodexHistory {
  private nativeHome: string;
  private rollout: CodexRolloutHistory;
  private client?: CodexClientFactory;
  private index: () => Promise<CodexIndex>;
  private listed = new Map<string, Listed>();
  private cursors = new Map<string, Cursor>();
  private projects: CodexProject[] = [];
  constructor(private sessionsRoot = defaultRoot(), options: CodexHistoryOptions = {}) {
    this.nativeHome = path.dirname(sessionsRoot);
    this.rollout = new CodexRolloutHistory(sessionsRoot);
    this.client = options.client === null ? undefined : options.client || (sessionsRoot === defaultRoot() ? () => connectCodexAppServer(this.nativeHome) : undefined);
    this.injectedClient = !!options.client;
    this.index = options.index || (() => readCodexIndex(this.nativeHome));
  }
  async list(): Promise<SourceTask[]> { return (await this.browse()).tasks; }
  async browse(query: SourceTaskQuery = {}): Promise<SourceTaskPage> {
    const scope = JSON.stringify([query.projectId || "", query.search || ""]);
    const continuation = query.cursor ? this.cursors.get(query.cursor) : undefined;
    if (query.cursor && (!continuation || continuation.scope !== scope)) throw new Error("会话分页已失效，请刷新当前项目。");
    if (!query.cursor) { this.listed.clear(); this.cursors.clear(); }
    const index = await this.index();
    const countsKnown = index.hasDatabase && !index.warnings.some(w => w.startsWith("本地 Codex"));
    const catalog = catalogProjects(index.projects, index.threads, countsKnown);
    // Keep unregistered directory choices from the previous API page while the
    // user switches projects. Registered projects always refresh from their store.
    for (const project of this.projects) if (!project.registered && !catalog.some(p => p.id === project.id)) catalog.push(project);
    let selected = query.projectId ? catalog.find(p => p.id === query.projectId) : undefined;
    const scopeRows = (tasks: SourceTask[]) => tasks.filter(task => (!selected || projectForThread(task, catalog)?.id === selected.id || (!selected.registered && directoryProjectId(task.directory) === selected.id)) && (!query.search?.trim() || `${task.title} ${task.directory} ${task.id}`.toLocaleLowerCase().includes(query.search.trim().toLocaleLowerCase())));
    const warnings = [...index.warnings];
    if (this.client && (index.hasDatabase || this.injectedClient)) {
      let client: CodexReadClient | undefined;
      try {
        if (query.projectId && !selected) throw new Error("项目登记已变更，请刷新列表。");
        client = await this.client();
        if (continuation && continuation.origin !== "codex-app-server") throw new Error("本地索引分页不能与官方接口分页混用，请刷新。");
        const directories = selected ? [...new Set([...selected.directories, ...index.threads.filter(task => projectForThread(task, catalog)?.id === selected!.id).map(task => task.directory)])] : undefined;
        const params: Record<string, unknown> = { limit: PAGE_SIZE, archived: false, sourceKinds: ["cli", "vscode"], sortKey: "updated_at", sortDirection: "desc", useStateDbOnly: true };
        if (directories?.length) params.cwd = directories.length === 1 ? directories[0] : directories;
        if (query.search?.trim()) params.searchTerm = query.search.trim();
        if (continuation) params.cursor = continuation.value;
        const result = await client.call("thread/list", params);
        if (!Array.isArray(result.data) || result.data.length > PAGE_SIZE) throw new Error("Codex 会话列表格式不兼容。");
        const unique = new Map<string, ReturnType<typeof metadata>>();
        for (const row of result.data) {
          if (isObject(row) && !interactiveCodex(row.source, row.threadSource)) continue;
          const entry = metadata(row);
          if (selected && !directories?.some(dir => directoryKey(dir) === directoryKey(entry.task.directory))) continue;
          const assigned = projectForThread(entry.task, catalog);
          if (selected && assigned && assigned.id !== selected.id) continue;
          unique.set(entry.task.id, entry);
        }
        for (const entry of unique.values()) {
          const project = projectForThread(entry.task, catalog);
          entry.task.projectId = project?.id || directoryProjectId(entry.task.directory);
          this.listed.set(entry.task.id, { ...entry, origin: "codex-app-server" });
        }
        if (this.listed.size > 5000) throw new Error("已达到 5000 条会话加载上限，请选择具体项目缩小范围。");
        const extras = catalogProjects([], [...unique.values()].map(e => e.task).filter(task => !catalog.some(p => p.id === task.projectId)), false).map(p => ({ ...p, count: undefined }));
        this.projects = [...catalog, ...extras];
        let nextCursor: string | undefined;
        if (typeof result.nextCursor === "string" && result.nextCursor) {
          if (result.nextCursor === continuation?.value || [...this.cursors.values()].some(value => value.origin === "codex-app-server" && value.value === result.nextCursor)) throw new Error("Codex 返回了重复分页游标，未继续读取。");
          nextCursor = this.saveCursor({ scope, origin: "codex-app-server", value: result.nextCursor });
        }
        if (selected && !query.search && !nextCursor) {
          const project = this.projects.find(p => p.id === selected!.id);
          if (project) project.count = this.listed.size;
        }
        // A legacy install can have rollout files but no indexed rows yet.
        if (unique.size || index.threads.length || query.projectId || query.cursor) return { tasks: [...unique.values()].map(e => cleanTask(e.task)), projects: cleanProjects(this.projects), nextCursor, total: selected && !query.search && !nextCursor ? this.listed.size : !query.search && countsKnown ? scopeRows(index.threads).length : undefined, origin: "codex-app-server", warnings };
      } catch (error) {
        if (continuation?.origin === "codex-app-server") throw new Error("官方会话分页读取中断，请刷新后重试，未拼接本地旧记录。");
        warnings.push("Codex 官方会话接口暂不可用，当前显示本地索引；客户端可见性未验证。");
      } finally { client?.close(); }
    }
    let all: SourceTask[] = index.threads;
    let origin: SourceTaskPage["origin"] = "codex-local-index";
    if (!index.hasDatabase || !index.threads.length && index.warnings.some(w => w.startsWith("本地 Codex"))) {
      all = await this.rollout.list(); origin = "codex-rollout";
      all = all.map(task => ({ ...task, title: index.titles?.[task.id] || task.title }));
      warnings.push("当前使用旧版日志索引：已按聊天 ID 去重并排除内部记录，客户端项目与标题可能不完整。");
    } else if (!warnings.some(w => w.includes("官方会话接口"))) warnings.push("当前显示本地 Codex 索引，客户端可见性未验证。");
    this.projects = catalogProjects(index.projects, all, true);
    selected = query.projectId ? this.projects.find(p => p.id === query.projectId) : undefined;
    if (query.projectId && !selected) throw new Error("项目登记已变更，请刷新列表。");
    const filtered = all.filter(task => (!selected || projectForThread(task, this.projects)?.id === selected.id || (!selected.registered && directoryProjectId(task.directory) === selected.id)) && (!query.search?.trim() || `${task.title} ${task.directory} ${task.id}`.toLocaleLowerCase().includes(query.search.trim().toLocaleLowerCase()))).sort((a, b) => b.updated - a.updated);
    const offset = continuation && typeof continuation.value === "number" ? continuation.value : 0;
    if (continuation && continuation.origin !== origin) throw new Error("会话来源已变更，请刷新分页。");
    const tasks = filtered.slice(offset, offset + PAGE_SIZE);
    for (const task of tasks) {
      const row = index.threads.find(row => row.id === task.id);
      this.listed.set(task.id, { task: { ...task, projectId: projectForThread(task, this.projects)?.id || directoryProjectId(task.directory) }, file: row?.file || "", historyMode: row?.historyMode || "", origin });
    }
    const nextCursor = offset + PAGE_SIZE < filtered.length ? this.saveCursor({ scope, origin, value: offset + PAGE_SIZE }) : undefined;
    return { tasks: tasks.map(task => cleanTask(this.listed.get(task.id)!.task)), projects: cleanProjects(this.projects), nextCursor, total: filtered.length, origin, warnings: [...new Set(warnings)] };
  }
  private injectedClient = false;
  private saveCursor(value: Cursor) { const token = randomUUID(); this.cursors.set(token, value); return token; }
  async importSession(id: string): Promise<HandoffImport> {
    const selected = this.listed.get(id);
    if (!selected || !uuid.test(id)) throw new Error("请从刚读取的 Codex 会话列表选择对话。");
    if (selected.origin === "codex-app-server" && this.client) {
      let client: CodexReadClient | undefined;
      try {
        client = await this.client();
        const response = await client.call("thread/read", { threadId: id, includeTurns: false });
        const entry = metadata(response.thread);
        if (entry.task.id !== id) throw new Error("Codex 会话身份已变更，请刷新列表。");
        try { return await this.readTurns(client, entry); }
        catch (error) {
          if (!(error instanceof CodexRpcError) || ![-32601, -32602].includes(error.code) || entry.historyMode === "paginated") throw error;
          return await this.readIndexedRollout(id, entry.file, entry.task, "当前客户端不支持历史分页，使用其索引指向的旧版日志正文。");
        }
      } finally { client?.close(); }
    }
    if (selected.origin === "codex-local-index") {
      const index = await this.index();
      const row = index.threads.find(row => row.id === id);
      if (!row) throw new Error("会话索引已变更或聊天已归档，请刷新列表。");
      if (row.historyMode === "paginated") throw new Error("该聊天使用分页历史，必须恢复 Codex 官方接口后读取，未用旧日志冒充完整正文。");
      return this.readIndexedRollout(id, row.file, row, "官方接口不可用；正文来自当前本地索引指向的日志，完整性未由客户端验证。");
    }
    const data = await this.rollout.importSession(id);
    data.title = (await this.index()).titles?.[id] || selected.task.title;
    data.warnings.unshift("旧版日志降级读取，客户端可见性与标题未验证。");
    return data;
  }
  private async readIndexedRollout(id: string, file: string, task: SourceTask, warning: string): Promise<HandoffImport> {
    const relative = path.relative(this.nativeHome, file);
    if (!file || !path.isAbsolute(file) || relative.startsWith("..") || path.isAbsolute(relative) || !relative.startsWith(`sessions${path.sep}`)) throw new Error("当前索引未指向可读取的活动会话日志。");
    const data = await this.rollout.importIndexed(id, file);
    const clean = cleanTask(task);
    return transferAttachments(data, { ...data, title: clean.title, directory: clean.directory, warnings: [warning, ...data.warnings] });
  }
  private async readTurns(client: CodexReadClient, entry: ReturnType<typeof metadata>): Promise<HandoffImport> {
    const clean = sanitizer(), entries: string[] = [], seen = new Set<string>(), cursors = new Set<string>();
    const candidates: AttachmentCandidate[] = [];
    let cursor: string | undefined, bytes = 0, length = 0, turns = 0;
    do {
      const page = await client.call("thread/turns/list", { threadId: entry.task.id, limit: 25, itemsView: "full", sortDirection: "asc", ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(page.data)) throw new Error("Codex 历史分页格式不兼容，未导入部分正文。");
      bytes += Buffer.byteLength(JSON.stringify(page.data));
      if (bytes > HANDOFF_LIMITS.bytes) throw new Error("Codex 来源历史超过 8 MB，未截断导入。");
      for (const turn of page.data) {
        if (++turns > 5000 || !isObject(turn) || !Array.isArray(turn.items)) throw new Error("Codex 历史分页不完整或超过 5000 轮，未截断导入。");
        for (const item of turn.items) {
          if (!isObject(item) || typeof item.id !== "string") throw new Error("Codex 历史消息结构不兼容。");
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          if (item.type === "userMessage") candidates.push(...contentAttachments(item.content,item.id));
          let text = "", user = false;
          if (item.type === "userMessage" && Array.isArray(item.content)) { text = item.content.filter(isObject).filter(part => part.type === "text").map(part => stringValue(part.text)).join("\n"); user = true; }
          else if (item.type === "agentMessage") text = stringValue(item.text);
          if (!text.trim() || user && !ordinary(text)) continue;
          const value = `${user ? "[用户历史]" : "[Codex 回复历史]"}\n${clean.clean(text)}`;
          length += value.length + 2;
          if (entries.length >= HANDOFF_LIMITS.messages || length > HANDOFF_LIMITS.text) throw new Error("Codex 交接正文超过 5000 条或 120000 字符，未截断导入。");
          entries.push(value);
        }
      }
      cursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : undefined;
      if (cursor && cursors.has(cursor)) throw new Error("Codex 历史分页游标重复，未导入部分正文。");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return bindAttachments({ source: "Codex", id: entry.task.id, title: clean.clean(entry.task.title), directory: clean.clean(entry.task.directory), transcript: entries.join("\n\n"), redactions: clean.count(), messageCount: entries.length, warnings: ["正文通过 Codex 官方历史分页读取，未恢复或启动原聊天。", "只携带用户请求和可见回复；内部推理、工具调用及子会话不会迁移；附件需单独确认打包。", "历史记录不代表任务已经完成；接续前核对文件与未知结果的副作用。"] },candidates);
  }
}
