/** Local read-only JSON-RPC client. Never starts/resumes a thread or a model turn. */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { cliDirectories } from "./tool-discovery";
import { HANDOFF_LIMITS } from "../../src/shared/handoff";
import { isObject } from "./codex-local-index";

export type CodexReadMethod = "thread/list" | "thread/read" | "thread/turns/list";
export interface CodexReadClient { call(method: CodexReadMethod, params: Record<string, unknown>): Promise<Record<string, unknown>>; close(): void }
export type CodexClientFactory = () => Promise<CodexReadClient>;
export class CodexRpcError extends Error {
  constructor(readonly code: number, readonly method: string) { super(`Codex ${method} 接口不可用（${code}），请检查本机客户端版本。`); }
}
const execute = promisify(execFile);
const checkedProtocols = new Map<string, Promise<void>>();
async function checkReadonlyProtocol(binary: string, nativeHome: string) {
  const stat = await fs.stat(binary);
  const key = `${binary}:${stat.mtimeMs}:${stat.size}`;
  let pending = checkedProtocols.get(key);
  if (!pending) {
    pending = (async () => {
      const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "network-codex-schema-"));
      try {
        const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: nativeHome };
        delete env.ELECTRON_RUN_AS_NODE;
        await execute(binary, ["app-server", "generate-json-schema", "--out", temporary], { env, timeout: 5000, maxBuffer: 128 * 1024, windowsHide: true });
        const schema = JSON.parse(await fs.readFile(path.join(temporary, "v2", "ThreadListParams.json"), "utf8"));
        // Some old versions ignore unknown fields. Do not assume that passing
        // useStateDbOnly actually disables their scan-and-repair behavior.
        if (!schema.properties?.useStateDbOnly || !schema.properties?.sourceKinds) throw new Error("不支持只读会话列表协议");
      } finally { await fs.rm(temporary, { recursive: true, force: true }); }
    })();
    checkedProtocols.set(key, pending);
    void pending.catch(() => checkedProtocols.delete(key));
  }
  return pending;
}
export class CodexAppServer implements CodexReadClient {
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; method: string }>();
  private buffer = Buffer.alloc(0);
  private closed = false;
  private child: ChildProcessWithoutNullStreams;
  constructor(binary: string, nativeHome: string, args = ["app-server", "--stdio"], private timeoutMs = 12000) {
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: nativeHome, PATH: `${path.dirname(binary)}${path.delimiter}${process.env.PATH || ""}` };
    delete env.ELECTRON_RUN_AS_NODE;
    this.child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"], env, windowsHide: true });
    this.child.stderr.on("data", () => {}); // Never expose stderr (may contain local metadata).
    this.child.stdin.on("error", () => this.fail(new Error("Codex 本地接口连接已关闭。")));
    this.child.on("error", () => this.fail(new Error("无法启动 Codex 本地会话接口。")));
    this.child.on("close", () => this.fail(new Error("Codex 本地会话接口已退出。")));
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      let end: number;
      while ((end = this.buffer.indexOf(10)) >= 0) {
        const line = this.buffer.subarray(0, end); this.buffer = this.buffer.subarray(end + 1);
        if (line.length > HANDOFF_LIMITS.bytes) { this.fail(new Error("Codex 接口返回内容超过 8 MB，未截断读取。")); return; }
        let message: unknown;
        try { message = JSON.parse(line.toString("utf8")); } catch { this.fail(new Error("Codex 接口返回了无效 JSON。")); return; }
        if (!isObject(message) || typeof message.id !== "number") continue;
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (isObject(message.error)) pending.reject(new CodexRpcError(Number(message.error.code), pending.method));
        else if (isObject(message.result)) pending.resolve(message.result);
        else pending.reject(new Error("Codex 接口响应格式不兼容。"));
      }
      if (this.buffer.length > HANDOFF_LIMITS.bytes) this.fail(new Error("Codex 接口返回内容超过 8 MB，未截断读取。"));
    });
  }
  async initialize() {
    await this.request("initialize", { clientInfo: { name: "network_lens_history", title: "360AI盒子 · 本地会话读取", version: "0.3.0" } });
    this.child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
  }
  call(method: CodexReadMethod, params: Record<string, unknown>) {
    if (!["thread/list", "thread/read", "thread/turns/list"].includes(method)) return Promise.reject(new Error("仅允许只读 Codex 会话方法。"));
    return this.request(method, params);
  }
  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error("Codex 会话接口已关闭。"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error("Codex 本地会话接口超时，请刷新重试。")), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  private fail(error: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.child.kill();
  }
  close() { this.fail(new Error("Codex 本地读取已结束。")); }
}
export async function connectCodexAppServer(nativeHome: string): Promise<CodexReadClient> {
  const candidates = [
    path.join(path.dirname(nativeHome), ".local/bin", process.platform === "win32" ? "codex.exe" : "codex"),
    ...(process.platform === "darwin" ? ["/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex", "/Applications/Codex.app/Contents/Resources/codex"] : []),
    ...(await cliDirectories(path.dirname(nativeHome))).map(dir => path.join(dir, process.platform === "win32" ? "codex.exe" : "codex")),
  ];
  for (const binary of [...new Set(candidates)]) {
    try { await fs.access(binary, constants.X_OK); if (!(await fs.stat(binary)).isFile()) continue; } catch { continue; }
    try { await checkReadonlyProtocol(binary, nativeHome); }
    catch { throw new Error("当前 Codex 版本无法确认只读列表协议，使用本地索引兼容读取。"); }
    const client = new CodexAppServer(binary, nativeHome);
    try { await client.initialize(); return client; } catch { client.close(); }
    // An installed but incompatible client should not cause a dozen slow retries.
    throw new Error("本机 Codex 会话接口初始化失败。可升级客户端后重试，当前使用本地索引。 ");
  }
  throw new Error("未找到 Codex 客户端，当前使用本地索引。");
}
