import os from "node:os";
import net from "node:net";
import dns from "node:dns/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeProxy } from "./validation";
const execute = promisify(execFile);
export async function networkSnapshot() {
  const interfaces = Object.entries(os.networkInterfaces()).flatMap(
    ([name, values]) =>
      (values || [])
        .filter(
          (v) =>
            !v.internal &&
            !v.address.startsWith("169.254.") &&
            !v.address.startsWith("fe80:"),
        )
        .map((v) => ({ name, address: v.address })),
  );
  return {
    count: new Set(interfaces.map((i) => i.name)).size,
    signature: createHash("sha256")
      .update(
        JSON.stringify(
          interfaces.sort((a, b) =>
            `${a.name}${a.address}`.localeCompare(`${b.name}${b.address}`),
          ),
        ),
      )
      .digest("hex"),
  };
}
export function bounded<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timeout = 4000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, value?: T) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      error ? reject(error) : resolve(value as T);
    };
    const cancel = () => finish(new Error("检查已停止"));
    const timer = setTimeout(() => finish(new Error("检查超时")), timeout);
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener("abort", cancel, { once: true });
    promise.then(
      (v) => finish(undefined, v),
      (e) => finish(e),
    );
  });
}
export async function lookupEntrance(host: string, signal: AbortSignal) {
  const answers = await bounded(dns.lookup(host, { all: true }), signal);
  if (!answers.length) throw new Error("无可用地址");
  return {
    v4: answers.filter((a) => a.family === 4).length,
    v6: answers.filter((a) => a.family === 6).length,
  };
}
export async function inspectProxyEndpoint(input: string, signal: AbortSignal) {
  const proxy = new URL(normalizeProxy(input)!);
  const host = proxy.hostname.replace(/^\[|\]$/g, "");
  const port = Number(proxy.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("端口无效");
  const socket = net.connect({ host, port });
  try {
    await bounded(
      new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      }),
      signal,
      2500,
    );
  } finally {
    socket.destroy();
  }
  if (!["127.0.0.1", "::1", "localhost"].includes(host))
    return ["检测到远端代理；未查询本机端口占用。"];
  try {
    if (process.platform === "darwin") {
      const result = await execute(
        "/usr/sbin/lsof",
        ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"],
        { timeout: 2500, maxBuffer: 65536 },
      );
      const names = [
        ...new Set(
          result.stdout
            .split("\n")
            .filter((s) => s.startsWith("c"))
            .map((s) => s.slice(1, 81)),
        ),
      ];
      return names.length
        ? [`本机监听进程：${names.join("、")}；是否为期望客户端需人工核对。`]
        : ["连接端点成功，但监听进程未能归属；不判断端口冲突。"];
    }
    if (process.platform === "win32") {
      const result = await execute(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction Stop | ForEach-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName } | Sort-Object -Unique | ConvertTo-Json -Compress`,
        ],
        { timeout: 2500, maxBuffer: 65536, windowsHide: true },
      );
      const raw = JSON.parse(result.stdout || "[]");
      const names = (Array.isArray(raw) ? raw : [raw])
        .filter((n) => typeof n === "string")
        .map((n) => n.slice(0, 80));
      return names.length
        ? [`本机监听进程：${names.join("、")}；是否为期望客户端需人工核对。`]
        : ["连接端点成功，但监听进程未能归属；不判断端口冲突。"];
    }
  } catch {
    /* A successful endpoint connection still stands if ownership is inaccessible. */
  }
  return ["端点接受连接，但本机监听进程不可读取；不判断端口冲突。"];
}
