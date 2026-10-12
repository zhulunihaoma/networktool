import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { cliDirectories } from "./tool-discovery";
import { parseOpenCodeExport, buildHandoffPrompt, type HandoffImport } from "../../src/shared/handoff";
import type { HandoffPreview, HandoffTarget, SourceTask } from "../../src/shared/handoff-api";
import type { HandoffSource } from "../../src/shared/handoff-api";
import { CodexHistory } from "./codex-history";

const execute = promisify(execFile);
const LIMIT = 8 * 1024 * 1024;
export class HandoffManager {
  private imported?: HandoffImport;
  private digest?: string;
  private preview?: HandoffPreview;
  private ids = new Set<string>();
  private busy = false;
  constructor(private run = runOpenCode, private codex = new CodexHistory()) {}
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("已有任务导入正在进行，请稍后重试。");
    this.busy = true;
    try { return await fn(); } finally { this.busy = false; }
  }
  async list(source: HandoffSource = "OpenCode"): Promise<SourceTask[]> {
    return this.exclusive(async () => {
      if (source === "Codex") return this.codex.list();
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
  async importSession(id: string, source: HandoffSource = "OpenCode") {
    if (source === "Codex") return this.exclusive(async () => {
      const data = await this.codex.importSession(id);
      this.imported = data; this.digest = undefined; this.preview = undefined;
      return data;
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
    const data = parseOpenCodeExport(raw);
    if (expectedId && data.id !== expectedId) throw new Error("导出会话与所选任务不一致，未导入。");
    const digest = createHash("sha256").update(raw).digest("hex");
    if (this.digest === digest) data.warnings.push("与上次导入相同，已替换预览，不会累加上下文。");
    this.imported = data;
    this.digest = digest;
    this.preview = undefined;
    return data;
  }
  prepare(goal: string, target: HandoffTarget) {
    if (this.busy) throw new Error("导入尚未完成。");
    if (!this.imported) throw new Error("请先导入任务。");
    if (!goal.trim() || goal.length > 4000) throw new Error("请填写不超过 4000 字的接续目标。");
    const content = buildHandoffPrompt(this.imported, goal.trim(), target);
    return this.preview = { token: randomUUID(), content, expires: Date.now() + 10 * 60_000 };
  }
  consume(token: string, write?: (content: string) => void) {
    if (this.busy || !this.preview || this.preview.token !== token || this.preview.expires < Date.now()) throw new Error("预览已变更或过期，请重新生成后确认。");
    const content = this.preview.content;
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
    const { stdout } = await execute(binary, args, { timeout: 30_000, maxBuffer: LIMIT,
      env: { ...process.env, PATH: `${path.dirname(binary)}${path.delimiter}${process.env.PATH || ""}` }, encoding: "utf8", windowsHide: true });
    return stdout;
  } catch {
    // stderr may include transcript, paths or credentials. Never forward it to renderer.
    throw new Error("OpenCode 读取未完成（版本不兼容、超时或输出超限）。未调用模型，请用 opencode export 导出的 JSON 重试。");
  }
}
