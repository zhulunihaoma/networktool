import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import packageInfo from "../../package.json";
import type {
  ConfigItem,
  Coverage,
  Flow,
  ProcessInfo,
} from "../../src/shared/types";
const execute = promisify(execFile);
const boot = Math.round(Date.now() - os.uptime() * 1000);
const limited = [
  "TCP 每 1 秒快照可能漏掉短连接；不提供精确连接开始或关闭时间。",
  "UDP / QUIC、请求正文与逐进程字节计数未采集。",
  "域名不从远端 IP 猜测；未读取目标应用实际环境。",
  "父子关系仅为候选，需用户确认；共享代理外部连接无法逐一归属。",
  "ETW、容器与虚拟机命名空间未适配。",
];
export function capabilities(): Coverage {
  return {
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    collector:
      process.platform === "darwin"
        ? "lsof / ps · 普通权限"
        : process.platform === "win32"
          ? "Windows CIM / NetTCPConnection · 普通权限"
          : "主动探测 · 无连接采集",
    tcp: ["darwin", "win32"].includes(process.platform),
    processes: true,
    limitations: limited,
    version: packageInfo.version,
  };
}
async function run(file: string, args: string[]) {
  return (
    await execute(file, args, {
      timeout: 3000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    })
  ).stdout;
}
export async function listProcesses(): Promise<ProcessInfo[]> {
  if (process.platform === "win32") {
    const raw = await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CreationDate,ExecutablePath | ConvertTo-Json -Compress",
    ]);
    const data = JSON.parse(raw);
    return (Array.isArray(data) ? data : [data]).map((p) => ({
      pid: p.ProcessId,
      ppid: p.ParentProcessId,
      name: p.Name,
      imagePath:
        typeof p.ExecutablePath === "string" ? p.ExecutablePath : undefined,
      created: p.CreationDate || "",
      key: `${boot}:${p.ProcessId}:${p.CreationDate || "unknown"}`,
      relation: "candidate",
    }));
  }
  const raw = await run("/bin/ps", ["-axo", "pid=,ppid=,lstart=,comm="]);
  return raw
    .split("\n")
    .flatMap((line) => {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/);
      if (!m) return [];
      return [
        {
          pid: Number(m[1]),
          ppid: Number(m[2]),
          created: m[3],
          name: path.basename(m[4]),
          imagePath: path.isAbsolute(m[4]) ? m[4] : undefined,
          key: `${boot}:${m[1]}:${m[3]}`,
          relation: "candidate" as const,
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
export function parseLsof(
  raw: string,
  processes: ProcessInfo[],
  window: "baseline" | "task" = "baseline",
): Flow[] {
  const result: Flow[] = [];
  let pid = 0,
    name = "",
    family = "",
    remote = "",
    state = "",
    local = "";
  const commit = () => {
    if (!remote) return;
    const p = processes.find((p) => p.pid === pid);
    result.push({
      id: randomUUID(),
      pid,
      process: name,
      processKey: p?.key || `unreadable:${pid}`,
      family,
      local,
      remote,
      state: state || "UNKNOWN",
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      window,
      source: "lsof TCP snapshot",
    });
    remote = "";
    state = "";
    local = "";
  };
  for (const line of raw.split("\n")) {
    const type = line[0],
      value = line.slice(1);
    if (type === "p") {
      commit();
      pid = Number(value);
    }
    if (type === "c") name = value;
    if (type === "f") commit();
    if (type === "t") family = value;
    if (type === "n") {
      const parts = value.split("->");
      local = parts[0];
      remote = parts[1] || "";
    }
    if (type === "T" && value.startsWith("ST=")) state = value.slice(3);
  }
  commit();
  return result;
}
export async function collectConnections(
  processes: ProcessInfo[],
  window: "baseline" | "task" = "baseline",
): Promise<{ flows: Flow[]; error?: string }> {
  try {
    if (process.platform === "darwin") {
      let raw = "";
      try {
        raw = await run("/usr/sbin/lsof", ["-nP", "-iTCP", "-FpcftnT"]);
      } catch (e) {
        const error = e as { code?: number; stdout?: string };
        if (error.code === 1 && error.stdout !== undefined) raw = error.stdout;
        else throw e;
      }
      return { flows: parseLsof(raw, processes, window) };
    }
    if (process.platform === "win32") {
      const raw = await run("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-NetTCPConnection -ErrorAction Stop | Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort,State,OwningProcess | ConvertTo-Json -Compress",
      ]);
      const data = JSON.parse(raw || "[]");
      return {
        flows: (Array.isArray(data) ? data : [data])
          .filter((r) => r.RemotePort)
          .map((r) => {
            const p = processes.find((p) => p.pid === r.OwningProcess);
            return {
              id: randomUUID(),
              pid: r.OwningProcess,
              process: p?.name || "不可读",
              processKey: p?.key || `unreadable:${r.OwningProcess}`,
              family: r.RemoteAddress.includes(":") ? "IPv6" : "IPv4",
              local: `${r.LocalAddress}:${r.LocalPort}`,
              remote: `${r.RemoteAddress}:${r.RemotePort}`,
              state: r.State,
              firstSeen: Date.now(),
              lastSeen: Date.now(),
              window,
              source: "Get-NetTCPConnection",
            };
          }),
      };
    }
    return {
      flows: [],
      error: "此版本 Linux 连接采集尚未实现，仍可进行主动探测。",
    };
  } catch (e) {
    return {
      flows: [],
      error: `连接快照读取失败：${(e as Error).message.slice(0, 300)}`,
    };
  }
}
function safeProxy(value: string) {
  try {
    const u = new URL(value);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return value.replace(/\/\/[^/@]+@/g, "//[已隐藏]@").slice(0, 512);
  }
}
export async function readConfig(): Promise<ConfigItem[]> {
  const items: ConfigItem[] = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
  ].map((name) => ({
    name,
    value:
      name === "NO_PROXY"
        ? process.env[name] || process.env[name.toLowerCase()] || "未设置"
        : safeProxy(
            process.env[name] || process.env[name.toLowerCase()] || "未设置",
          ),
    source: "诊断器进程环境 · 不代表目标应用",
    state: "read",
  }));
  items.push(
    {
      name: "DNS",
      value: (await import("node:dns")).getServers().join(", ") || "系统解析器",
      source: "Node DNS 配置 · 不代表目标应用",
      state: "read",
    },
    {
      name: "系统时间",
      value: new Date().toISOString(),
      source: "本机时钟 · 未校验时钟偏差",
      state: "read",
    },
    {
      name: "网络接口",
      value: Object.entries(os.networkInterfaces())
        .filter(([, v]) => v?.some((a) => !a.internal))
        .map(
          ([k, v]) =>
            `${k}: ${v
              ?.filter((a) => !a.internal)
              .map((a) => a.address)
              .join(", ")}`,
        )
        .join("\n"),
      source: "os.networkInterfaces",
      state: "read",
    },
  );
  const calls =
    process.platform === "darwin"
      ? [
          { name: "系统代理", file: "/usr/sbin/scutil", args: ["--proxy"] },
          { name: "系统 DNS", file: "/usr/sbin/scutil", args: ["--dns"] },
          {
            name: "默认路由",
            file: "/sbin/route",
            args: ["-n", "get", "default"],
          },
        ]
      : process.platform === "win32"
        ? [
            {
              name: "WinHTTP 静态代理",
              file: "netsh.exe",
              args: ["winhttp", "show", "proxy"],
            },
            {
              name: "当前账户代理",
              file: "powershell.exe",
              args: [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' | Select-Object ProxyEnable,ProxyServer,AutoConfigURL | ConvertTo-Json -Compress",
              ],
            },
          ]
        : [];
  const results = await Promise.all(
    calls.map(async (c) => {
      try {
        return {
          name: c.name,
          value: (await run(c.file, c.args)).slice(0, 6000),
          source: c.file,
          state: "read" as const,
        };
      } catch {
        return {
          name: c.name,
          value: "无法读取；不视为未配置",
          source: c.file,
          state: "unavailable" as const,
        };
      }
    }),
  );
  return [...items, ...results];
}
