/** Trust only our guard using hashes and config writes supplied by Codex itself. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { CodexAppServer } from "../core/codex-app-server";
import { cliDirectories } from "../core/tool-discovery";
import type { AdapterContext } from "./adapters";
export const CODEX_GUARD_MATCHER = "^Bash$|^apply_patch$|^Edit$|^Write$|^mcp__.*";

export interface TrustHook {
  key: string;
  currentHash: string;
  command: string;
  sourcePath: string;
  eventName: string;
  source: string;
  matcher?: string;
  handlerType?: string;
  trustStatus: string;
  enabled: boolean;
}
export interface TrustRpc {
  callTrust(method: "hooks/list" | "config/read" | "config/batchWrite", params: Record<string, unknown>): Promise<Record<string, any>>;
  close(): void;
}
export class CodexTrustClient extends CodexAppServer implements TrustRpc {
  callTrust(method: "hooks/list" | "config/read" | "config/batchWrite", params: Record<string, unknown>) {
    if (!["hooks/list", "config/read", "config/batchWrite"].includes(method))
      return Promise.reject(new Error("不支持此信任操作。"));
    return this.request(method, params);
  }
}
export async function connectTrustClient(home: string): Promise<TrustRpc> {
  const candidates = [
    ...(process.platform === "darwin" ? [
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
    ] : []),
    ...(await cliDirectories(home)).map(dir => path.join(dir, process.platform === "win32" ? "codex.exe" : "codex")),
  ];
  for (const binary of [...new Set(candidates)]) {
    try { fs.accessSync(binary, fs.constants.X_OK); if (!fs.statSync(binary).isFile()) continue; } catch { continue; }
    const client = new CodexTrustClient(binary, path.join(home, ".codex"), ["app-server"], 12000);
    try { await client.initialize(); return client; }
    catch { client.close(); throw new Error("Codex 本地信任接口启动失败，请检查客户端版本后重试。"); }
  }
  throw new Error("未找到 Codex 客户端，无法保存信任。请先安装或更新 Codex。");
}
function safeRead(file: string, optional = false): Buffer {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024)
      throw new Error("配置或守卫不是普通文件，已停止信任。");
    return fs.readFileSync(file);
  } catch (e) {
    if (optional && (e as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0);
    throw e;
  }
}
const digest = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
function fingerprint(ctx: AdapterContext): string {
  return digest(JSON.stringify([
    digest(safeRead(path.join(ctx.home, ".codex/hooks.json"))),
    digest(safeRead(path.join(ctx.home, ".codex/config.toml"), true)),
    digest(safeRead(ctx.guard.script)),
    fs.realpathSync(ctx.guard.runtime),
  ]));
}
function definitionFingerprint(ctx: AdapterContext): string {
  return digest(JSON.stringify([
    digest(safeRead(path.join(ctx.home, ".codex/hooks.json"))),
    digest(safeRead(ctx.guard.script)),
    fs.realpathSync(ctx.guard.runtime),
  ]));
}
const receiptFile = (ctx: AdapterContext) => path.join(ctx.guard.dataDir, "codex-trust.json");
/** Read the single trust entry Codex persists for one hook, ignoring unrelated settings. */
function trustedHashInConfig(ctx: AdapterContext, key: string): string | undefined {
  const file = path.join(ctx.home, ".codex/config.toml");
  let text: string;
  try { text = safeRead(file, true).toString("utf8"); } catch { return undefined; }
  const target = `[hooks.state.${JSON.stringify(key)}]`;
  let inside = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) { inside = line === target; continue; }
    if (!inside) continue;
    const match = /^trusted_hash\s*=\s*"([^"]*)"/.exec(line);
    if (match) return match[1];
  }
  return undefined;
}
/** A receipt is invalidated when the guard definition or its saved trust changes. It is not runtime evidence. */
export function hasCurrentCodexTrust(ctx: AdapterContext): boolean {
  try {
    const receipt = JSON.parse(safeRead(receiptFile(ctx)).toString("utf8"));
    if (receipt.version !== 2 || typeof receipt.key !== "string" || typeof receipt.trustedHash !== "string")
      return false;
    return receipt.definition === definitionFingerprint(ctx) &&
      trustedHashInConfig(ctx, receipt.key) === receipt.trustedHash;
  } catch { return false; }
}

function selectHook(result: Record<string, any>, ctx: AdapterContext, command: string): TrustHook {
  if (!Array.isArray(result.data)) throw new Error("Codex 版本不支持钩子信任查询，请更新后重试。");
  const source = fs.realpathSync(path.join(ctx.home, ".codex/hooks.json"));
  const hooks: TrustHook[] = result.data.flatMap((entry: any) => {
    if (!Array.isArray(entry.hooks) || entry.errors?.length)
      throw new Error("Codex 无法完整读取钩子配置，已停止信任。");
    return entry.hooks;
  });
  const ours = hooks.filter(h => h.source === "user" && h.eventName === "preToolUse" &&
    h.sourcePath === source && h.handlerType === "command" && h.command === command && h.matcher === CODEX_GUARD_MATCHER);
  if (ours.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(ours[0].currentHash) ||
    !ours[0].key.startsWith(`${source}:pre_tool_use:`))
    throw new Error("未找到唯一且匹配的安全钩子，请先修复防护配置后重试。");
  return ours[0];
}

export async function trustCodexGuard(ctx: AdapterContext, command: string,
  connect: (home: string) => Promise<TrustRpc> = connectTrustClient): Promise<void> {
  const before = fingerprint(ctx);
  const definition = definitionFingerprint(ctx);
  const client = await connect(ctx.home);
  try {
    const params = { cwds: [ctx.guard.dataDir] };
    const hook = selectHook(await client.callTrust("hooks/list", params), ctx, command);
    if (fingerprint(ctx) !== before) throw new Error("配置在检查期间发生变化，请重新点击信任。");
    if (!hook.enabled) throw new Error("Codex 中该钩子已被关闭，请先修复防护配置后重试。");
    if (hook.trustStatus !== "trusted") {
      const config = await client.callTrust("config/read", { includeLayers: true });
      const file = path.join(ctx.home, ".codex/config.toml");
      const canonical = fs.realpathSync(path.join(ctx.home, ".codex"));
      const layer = config.layers?.find((l: any) => l.name?.type === "user" && l.name.file === path.join(canonical, "config.toml"));
      if (!layer || typeof layer.version !== "string")
        throw new Error("Codex 无法提供用户配置版本，未修改信任配置。请更新客户端后重试。");
      if (fingerprint(ctx) !== before) throw new Error("配置已变化，请重新点击信任。");
      const content = safeRead(file, true);
      fs.mkdirSync(ctx.backupDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(ctx.backupDir, `codex-trust-${Date.now()}-${randomUUID()}.toml`), content, { mode: 0o600, flag: "wx" });
      await client.callTrust("config/batchWrite", {
        filePath: path.join(canonical, "config.toml"), expectedVersion: layer.version,
        edits: [{ keyPath: `hooks.state.${JSON.stringify(hook.key)}.trusted_hash`, value: hook.currentHash, mergeStrategy: "replace" }],
      });
    }
    const confirmed = selectHook(await client.callTrust("hooks/list", params), ctx, command);
    if (!confirmed.enabled || confirmed.trustStatus !== "trusted" || confirmed.currentHash !== hook.currentHash)
      throw new Error("Codex 未确认此钩子已信任，请刷新并重试。");
    if (definitionFingerprint(ctx) !== definition)
      throw new Error("守卫或钩子在保存期间发生变化，请重新点击信任。");
    // Record the confirmed hash only; unrelated Codex settings may change later.
    const receipt = { version: 2, definition: definitionFingerprint(ctx), key: hook.key, trustedHash: hook.currentHash, at: Date.now() };
    fs.mkdirSync(ctx.guard.dataDir, { recursive: true, mode: 0o700 });
    const temp = `${receiptFile(ctx)}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(receipt), { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, receiptFile(ctx));
  } finally { client.close(); }
}
