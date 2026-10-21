import { AttachmentSet, bindAttachments, openCodeAttachmentCandidates, attachmentZip } from "./handoff-attachments";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { cliDirectories } from "./tool-discovery";
import { HANDOFF_LIMITS, sanitizer, parseOpenCodeExport, buildHandoffPrompt, type HandoffImport, type HandoffOptions } from "../../src/shared/handoff";
import type { HandoffPreview, HandoffTarget, SourceTask, SourceTaskPage, SourceTaskQuery, SourceProject } from "../../src/shared/handoff-api";
import type { HandoffSource } from "../../src/shared/handoff-api";
import { CodexHistory } from "./codex-history";
import { ClaudeHistory } from "./claude-history";
import { captureHandoffExport } from "./handoff-cli";
import { directoryProjectId } from "./codex-local-index";
import { WorkBuddyHistory } from "./workbuddy-history";
import { ZCodeHistory } from "./zcode-history";
import { WisCodeHistory } from "./wiscode-history";
import { DshHistory } from "./dsh-history";
import { CopilotCodeHistory } from "./copilot-code-history";

const execute = promisify(execFile);
const LIMIT = 8 * 1024 * 1024;
export class HandoffManager {
  private imported?: HandoffImport;
  private digest?: string;
  private preview?: HandoffPreview;
  private attachmentSet?: AttachmentSet;
  private package?: ReturnType<AttachmentSet["selection"]>;
  private accept(data: HandoffImport) {
    data.attachmentSession = randomUUID();
    this.imported = data; this.digest = undefined; this.preview = undefined; this.package = undefined;
    this.attachmentSet = new AttachmentSet(data);
    return data;
  }
  private checkedSession(session: string) {
    if (this.busy || !this.imported || this.imported.attachmentSession !== session || !this.attachmentSet) throw new Error("来源会话已变更，请重新打开接力弹窗。");
    return this.attachmentSet;
  }
  async scanAttachments(session: string) {
    const set = this.checkedSession(session);
    return this.exclusive(async () => { this.preview = undefined; this.package = undefined; return set.inspect(); });
  }
  async addAttachments(session: string, choose: () => Promise<string[]>) {
    const set = this.checkedSession(session);
    return this.exclusive(async () => {
      const files = await choose(); if (!files.length) return undefined;
      this.preview = undefined; this.package = undefined; set.addFiles(files); return set.inspect();
    });
  }
  private ids = new Set<string>();
  private busy = false;
  private additional = { WorkBuddy: new WorkBuddyHistory(), ZCode: new ZCodeHistory(), WisCode: new WisCodeHistory(), DeepSeekHarness: new DshHistory(), CopilotCode: new CopilotCodeHistory() };
  constructor(private run = runOpenCode, private codex = new CodexHistory(), private claude = new ClaudeHistory()) {}
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("已有任务导入正在进行，请稍后重试。");
    this.busy = true;
    try { return await fn(); } finally { this.busy = false; }
  }
  async list(source: HandoffSource = "OpenCode"): Promise<SourceTask[]> {
    return this.exclusive(async () => {
      if (source === "Codex") return this.codex.list();
      if (source === "ClaudeCode") return this.claude.list();
      if (source in this.additional) return this.additional[source as keyof typeof this.additional].list();
      const raw: unknown = JSON.parse(await this.run(["session", "list", "--format", "json", "--max-count", "30", "--pure"]));
      if (!Array.isArray(raw) || raw.length > 30) throw new Error("OpenCode 会话列表格式不兼容，请使用导出 JSON 导入。");
      const tasks: SourceTask[] = raw.map((x) => {
        if (!x || typeof x.id !== "string" || !/^ses_[a-zA-Z0-9]+$/.test(x.id)) throw new Error("OpenCode 会话 ID 无效。");
        return { id: x.id, title: typeof x.title === "string" ? x.title.slice(0, 300) : x.id,
          directory: typeof x.directory === "string" ? x.directory.slice(0, 2000) : "", updated: Number(x.updated ?? x.time?.updated) || 0 };
      });
      this.ids = new Set(tasks.map((x) => x.id));
      return tasks;
    });
  }
  async browse(source: HandoffSource = "OpenCode", query: SourceTaskQuery = {}): Promise<SourceTaskPage> {
    if (source === "Codex") return this.exclusive(() => this.codex.browse(query));
    if (source in this.additional) return this.exclusive(() => this.additional[source as keyof typeof this.additional].browse(query));
    const all = await this.list(source);
    const projects = new Map<string, SourceProject>();
    for (const task of all) {
      const id = directoryProjectId(task.directory);
      task.projectId = id;
      const project = projects.get(id) || { id, name: path.basename(task.directory) || "未关联项目", directories: task.directory ? [task.directory] : [], registered: false, count: 0 };
      project.count!++; projects.set(id, project);
    }
    const tasks = all.filter(task => (!query.projectId || task.projectId === query.projectId) && (!query.search?.trim() || `${task.title} ${task.directory} ${task.id}`.toLocaleLowerCase().includes(query.search.trim().toLocaleLowerCase())));
    return { tasks, projects: [...projects.values()], total: tasks.length, origin: "native", warnings: [] };
  }
  async importSession(id: string, source: HandoffSource = "OpenCode") {
    const history = source === "Codex" ? this.codex : source === "ClaudeCode" ? this.claude : source in this.additional ? this.additional[source as keyof typeof this.additional] : undefined;
    if (history) return this.exclusive(async () => {
      const data = await history.importSession(id);
      return this.accept(data);
    });
    if (!this.ids.has(id)) throw new Error("请从刚读取的会话列表选择任务。");
    return this.exclusive(async () => this.importRaw(await this.run(["export", id, "--pure"]), id));
  }
  async importFile(file: string) {
    return this.exclusive(async () => {
      // File path comes only from the native dialog, never from renderer input.
      const selected = await fs.lstat(file);
      if (!selected.isFile() || selected.isSymbolicLink()) throw new Error("只能导入普通 JSON 文件，不接受符号链接或特殊文件。");
      const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NONBLOCK || 0) | (constants.O_NOFOLLOW || 0));
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > LIMIT) throw new Error("请选择不超过 8 MB 的 OpenCode 导出 JSON 文件。");
        const buffer = Buffer.alloc(LIMIT + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > LIMIT) throw new Error("导出文件超过 8 MB，未导入。");
        return this.importRaw(buffer.subarray(0, length).toString("utf8"));
      } finally { await handle.close(); }
    });
  }
  importRaw(raw: string, expectedId?: string) {
    if (Buffer.byteLength(raw) > LIMIT) throw new Error("导出内容超过 8 MB，未导入。");
    const data = bindAttachments(parseOpenCodeExport(raw), openCodeAttachmentCandidates(JSON.parse(raw)));
    if (expectedId && data.id !== expectedId) throw new Error("导出会话与所选任务不一致，未导入。");
    const digest = createHash("sha256").update(raw).digest("hex");
    if (this.digest === digest) data.warnings.push("与上次导入相同，已替换预览，不会累加上下文。");
    this.accept(data);
    this.digest = digest;
    return data;
  }
  prepare(goal: string, target: HandoffTarget, options?: HandoffOptions) {
    if (this.busy) throw new Error("导入尚未完成。");
    if (!this.imported) throw new Error("请先导入任务。");
    if (!goal.trim() || goal.length > 4000) throw new Error("请填写不超过 4000 字的接续目标。");
    // A changed selection always invalidates a previous confirmation token, even on validation failure.
    this.preview = undefined; this.package = undefined;
    let content = buildHandoffPrompt(this.imported, goal.trim(), target, options);
    if (options?.packAttachments) {
      if (!this.attachmentSet) throw new Error("请先识别会话附件。");
      this.package = this.attachmentSet.selection(options);
      const p = this.package;
      content += `\n\n附件交接：本次选择 ${p.files.length} 条附件记录（按内容去重保存），合计 ${p.summary.bytes} 字节；另有 ${p.summary.omitted} 条记录未携带。${p.summary.complete ? "" : "本次未携带全部附件，或来源附件未能全部确认。"}\n附件内容未经脱敏，可能是来源工具转换后的版本。请先解压接力包，再按清单读取；未携带或缺失内容不能推测。\n${p.files.map((f,i) => `${JSON.stringify(f.name)} · ${p.summary.entries[i].mime} · 消息 ${JSON.stringify(p.summary.entries[i].messageId)}`).join("\n")}`;
    } else content += "\n\n本次仅交接文字，未携带图片或文档附件。";
    if (content.length > HANDOFF_LIMITS.text) { this.package = undefined; throw new Error("交接说明与附件清单合计超过 120000 字符，请减少携带的历史内容后重试。"); }
    return this.preview = { token: randomUUID(), content, expires: Date.now() + 10 * 60_000, ...(this.package ? {attachments:this.package.summary} : {}) };
  }
  private checkedPreview(token: string) {
    if (this.busy || !this.preview || this.preview.token !== token || this.preview.expires < Date.now()) throw new Error("预览已变更或过期，请重新生成后确认。");
    return this.preview;
  }
  async copy(token: string, write: (content: string) => Promise<void>) {
    const preview = this.checkedPreview(token);
    if (preview.attachments && !preview.exportedPath) throw new Error("请先导出附件接力包，再复制说明与包路径。");
    return this.exclusive(async () => {
      // Electron's clipboard write is async. Keep the token on failure and
      // report success only after the operating system accepted the content.
      await write(preview.content);
      this.preview = undefined;
    });
  }
  async exportPackage(token: string, choose: () => Promise<string | undefined>) {
    const preview = this.checkedPreview(token), pack = this.package;
    if (!pack || !preview.attachments || preview.exportedPath) throw new Error("请重新生成附件接力预览。");
    return this.exclusive(async () => {
      const folder = await choose(); if (!folder) return undefined;
      if (preview.expires < Date.now()) throw new Error("预览已过期，请重新生成。");
      const base = await fs.realpath(folder), stat = await fs.stat(base);
      if (!stat.isDirectory()) throw new Error("请选择导出目录。");
      const file = path.join(base, `handoff-${new Date().toISOString().replace(/[:.]/g,"-")}-${randomUUID().slice(0,8)}.zip`);
      const byHash = new Map<string,string>();
      const unique: {name:string;bytes:Buffer}[] = [];
      const manifest = pack.files.map((f,i) => {
        const metadata = pack.summary.entries[i], existing = byHash.get(metadata.sha256!);
        if (!existing) { byHash.set(metadata.sha256!,f.name); unique.push(f); }
        return {...metadata, path:existing || f.name};
      });
      // The portable instructions refer to the same filenames as the manifest, including duplicates.
      let portable = preview.content;
      pack.files.forEach((f,i) => { portable = portable.replace(JSON.stringify(f.name), JSON.stringify(manifest[i].path)); });
      const clean = sanitizer();
      const archive = attachmentZip([
        {name:"handoff.md",bytes:Buffer.from(portable)},
        {name:"manifest.json",bytes:Buffer.from(JSON.stringify({version:1,source:this.imported?.source || "OpenCode",session:clean.clean(this.imported?.id || ""),createdAt:new Date().toISOString(),complete:pack.summary.complete,omitted:pack.summary.omitted,omittedAttachments:pack.omittedEntries.map(e => ({...e,reason:e.status === "ready" ? "未选择携带" : e.note})),warnings:pack.warnings,attachments:manifest},null,2))},
        ...unique,
      ]);
      const handle = await fs.open(file,"wx",0o600);
      try { await handle.writeFile(archive); await handle.sync(); }
      catch { await handle.close(); await fs.unlink(file).catch(() => {}); throw new Error("附件包写入失败，未完成导出，请重试。"); }
      await handle.close();
      this.preview = {...preview, token:randomUUID(),expires:Date.now()+10*60_000,exportedPath:file,content:`${portable}\n\n已导出的本地附件包：${JSON.stringify(file)}\n请由用户在目标工具中选择或解压此附件包；仅粘贴这段文字不会上传附件。`};
      return {path:file,preview:this.preview};
    });
  }
  consume(token: string, write?: (content: string) => void) {
    const selected = this.checkedPreview(token);
    if (selected.attachments && !selected.exportedPath) throw new Error("请先导出附件包。");
    const content = selected.content;
    if (write) write(content);
    this.preview = undefined;
    return content;
  }
}
async function runOpenCode(args: string[]): Promise<string> {
  if (process.platform === "win32") throw new Error("当前直接读取支持 macOS/Linux；Windows 请导入 OpenCode 导出 JSON。");
  let binary: string | undefined;
  for (const dir of await cliDirectories()) {
    const candidate = path.join(dir, "opencode");
    try { await fs.access(candidate, constants.X_OK); if ((await fs.stat(candidate)).isFile()) { binary = candidate; break; } } catch {}
  }
  if (!binary) throw new Error("未找到 OpenCode CLI，请导入已导出的 JSON 文件。");
  try {
    const env = { ...process.env, PATH: `${path.dirname(binary)}${path.delimiter}${process.env.PATH || ""}` };
    if (args[0] === "export") return await captureHandoffExport(binary, args, { env });
    const { stdout } = await execute(binary, args, { timeout: 30_000, maxBuffer: LIMIT,
      env, encoding: "utf8", windowsHide: true });
    return stdout;
  } catch {
    // stderr may include transcript, paths or credentials. Never forward it to renderer.
    throw new Error("OpenCode 读取未完成（版本不兼容、超时或输出超限）。未调用模型，请用 opencode export 导出的 JSON 重试。");
  }
}
