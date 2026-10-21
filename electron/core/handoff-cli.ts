import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HANDOFF_LIMITS } from "../../src/shared/handoff";

/** A regular stdout file avoids CLI exit() dropping the tail of large piped JSON.
 * Private scratch data is bounded, read only after process completion, and removed.
 */
export async function captureHandoffExport(binary: string, args: string[], options: {
  env?: NodeJS.ProcessEnv;
  maxBytes?: number;
  timeoutMs?: number;
} = {}): Promise<string> {
  const maximum = options.maxBytes ?? HANDOFF_LIMITS.bytes;
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "network-lens-export-"));
  const file = path.join(temporary, "export.json");
  const handle = await fs.open(file, "wx+", 0o600);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, args, { env: options.env, stdio: ["ignore", handle.fd, "ignore"], windowsHide: true });
      let failure: Error | undefined;
      const stop = (reason: string) => { failure ||= new Error(reason); child.kill("SIGKILL"); };
      const deadline = setTimeout(() => stop("OpenCode 导出超时。"), options.timeoutMs ?? 30000);
      const budget = setInterval(() => {
        void handle.stat().then(stat => { if (stat.size > maximum) stop("OpenCode 导出超过大小限制。"); }, () => stop("无法核对导出大小。"));
      }, 50);
      const clean = () => { clearTimeout(deadline); clearInterval(budget); };
      child.once("error", () => { clean(); reject(new Error("无法启动 OpenCode 导出。")); });
      child.once("close", code => { clean(); if (failure) reject(failure); else if (code !== 0) reject(new Error("OpenCode 导出未正常完成。")); else resolve(); });
    });
    const stat = await handle.stat();
    if (stat.size > maximum) throw new Error("OpenCode 导出超过大小限制。");
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maximum) throw new Error("OpenCode 导出超过大小限制。");
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    await handle.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
