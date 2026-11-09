import os from "node:os";
import tls from "node:tls";
import dns from "node:dns/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { networkSnapshot, bounded } from "./triage-probe";
import {
  ipv6RepairPlan,
  ipRepairSnapshotCurrent,
  type IPPathAttempt,
  type IPPathReport,
  type IPv6Service,
} from "../../src/shared/ip-path";

const execute = promisify(execFile);

function accessNetworkKey() {
  // Compare the access network across an IPv6 change without exporting local IPs.
  const addresses = Object.entries(os.networkInterfaces()).flatMap(
    ([name, values]) =>
      /^(utun|tun|tap|wg|lo)/.test(name)
        ? []
        : (values || [])
            .filter(
              (a) =>
                a.family === "IPv4" &&
                !a.internal &&
                !a.address.startsWith("169.254."),
            )
            .map((a) => `${name}:${a.address}`),
  );
  return createHash("sha256").update(addresses.sort().join("\n")).digest("hex");
}

export function parseRouteInterface(output: string): string | undefined {
  return output.match(/^\s*interface:\s*([a-zA-Z0-9_.-]+)\s*$/m)?.[1];
}

async function route(address: string, family: number, signal: AbortSignal) {
  try {
    const result = await execute(
      "/sbin/route",
      ["-n", "get", ...(family === 6 ? ["-inet6"] : []), address],
      { timeout: 2000, maxBuffer: 16384, signal },
    );
    return parseRouteInterface(result.stdout);
  } catch {
    return undefined;
  }
}

export function parseIPv6Service(
  json: string,
  device: string,
): IPv6Service | undefined {
  const services = JSON.parse(json) as Record<
    string,
    {
      UserDefinedName?: string;
      Interface?: {
        DeviceName?: string;
        Type?: string;
        Hardware?: string;
        SubType?: string;
      };
      IPv6?: { ConfigMethod?: string };
      __INACTIVE__?: number;
    }
  >;
  const matches = Object.entries(services).filter(
    ([, s]) =>
      s.Interface?.DeviceName === device &&
      (s.Interface?.Type === "IEEE80211" ||
        s.Interface?.Hardware === "AirPort" ||
        s.Interface?.SubType === "IEEE80211") &&
      !s.__INACTIVE__,
  );
  if (matches.length !== 1) return;
  const [id, s] = matches[0];
  if (!s.UserDefinedName || /[\r\n\0]/.test(s.UserDefinedName)) return;
  const method = s.IPv6?.ConfigMethod;
  return {
    id,
    name: s.UserDefinedName,
    device,
    method: ["Automatic", "LinkLocal", "Off", "Manual"].includes(method || "")
      ? (method as IPv6Service["method"])
      : "unknown",
  };
}

export async function serviceFor(device: string, signal: AbortSignal) {
  try {
    const result = await execute(
      "/usr/bin/plutil",
      [
        "-extract",
        "NetworkServices",
        "json",
        "-o",
        "-",
        "/Library/Preferences/SystemConfiguration/preferences.plist",
      ],
      { timeout: 2000, maxBuffer: 512 * 1024, signal },
    );
    return parseIPv6Service(result.stdout, device);
  } catch {
    return undefined;
  }
}

// No credentials, redirects, proxy environment variables or TLS verification bypasses.
export function probeIPTLS(
  host: string,
  address: string,
  family: 4 | 6,
  signal: AbortSignal,
  timeout = 6000,
): Promise<IPPathAttempt> {
  return new Promise((resolve) => {
    const started = Date.now();
    const result: IPPathAttempt = {
      family,
      tcp: false,
      tls: false,
      duration: 0,
    };
    let socket: tls.TLSSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false,
      response = "";
    const finish = (code?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      socket?.destroy();
      resolve({
        ...result,
        ...(code ? { code } : {}),
        duration: Date.now() - started,
      });
    };
    const cancel = () => finish("ABORTED");
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => finish("TIMEOUT"), timeout);
    try {
      socket = tls.connect({
        host: address,
        port: 443,
        servername: host,
        rejectUnauthorized: true,
        ALPNProtocols: ["http/1.1"],
      });
      socket.once("connect", () => {
        result.tcp = true;
      });
      socket.once("secureConnect", () => {
        result.tls = true;
        socket!.write(
          `HEAD / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
        );
      });
      socket.on("data", (data: Buffer) => {
        response += data.toString("ascii");
        const match = response.match(/^HTTP\/1\.[01] (\d{3})\b/);
        if (match) {
          result.httpStatus = Number(match[1]);
          finish();
        } else if (response.length > 8192) finish("INVALID_HTTP_RESPONSE");
      });
      socket.once("error", (error: NodeJS.ErrnoException) =>
        finish(
          error.code?.replace(/[^A-Z0-9_]/gi, "").slice(0, 80) ||
            "CONNECTION_FAILED",
        ),
      );
      socket.once("close", () => finish("CONNECTION_CLOSED"));
    } catch {
      finish("CONNECTION_FAILED");
    }
  });
}

export async function inspectIPPaths(
  host: string,
  signal: AbortSignal,
): Promise<IPPathReport> {
  const before = await networkSnapshot();
  const report: IPPathReport = {
    host,
    checkedAt: Date.now(),
    networkKey: before.signature,
    accessNetworkKey: accessNetworkKey(),
    networkChanged: false,
    attempts: [],
    hasPublicIPv6: Object.values(os.networkInterfaces())
      .flat()
      .some(
        (a) => a?.family === "IPv6" && !a.internal && /^[23]/i.test(a.address),
      ),
  };
  if (process.platform !== "darwin") {
    report.unavailable =
      "IPv4/IPv6 隧道路由对照目前仅支持 macOS；其他系统请交由 IT 检查，不生成 macOS 修复命令。";
    return report;
  }
  try {
    const addresses = await bounded(dns.lookup(host, { all: true }), signal);
    const selected = ([4, 6] as const).flatMap((family) =>
      addresses
        .filter((a) => a.family === family)
        .filter(
          (a, i, all) => all.findIndex((b) => b.address === a.address) === i,
        )
        .slice(0, 2),
    );
    if (!selected.length) {
      report.dnsError = "NO_ADDRESSES";
      return report;
    }
    const routes = await Promise.all(
      selected.map((a) => route(a.address, a.family, signal)),
    );
    report.attempts = await Promise.all(
      selected.map(async (a, i) => ({
        ...(await probeIPTLS(host, a.address, a.family as 4 | 6, signal)),
        interface: routes[i],
      })),
    );
    const afterRoutes = await Promise.all(
      selected.map((a) => route(a.address, a.family, signal)),
    );
    const activePhysical = Object.entries(os.networkInterfaces()).filter(
      ([name, values]) =>
        /^en\d+$/.test(name) &&
        values?.some(
          (a) =>
            a.family === "IPv4" &&
            !a.internal &&
            !a.address.startsWith("169.254."),
        ),
    );
    const physical =
      report.attempts.find(
        (a) =>
          a.family === 6 &&
          a.interface &&
          !/^(utun|tun|tap|wg)/.test(a.interface),
      )?.interface ||
      (activePhysical.length === 1 ? activePhysical[0][0] : undefined);
    if (physical) report.service = await serviceFor(physical, signal);
    const after = await networkSnapshot();
    report.networkChanged =
      before.signature !== after.signature ||
      routes.some((r, i) => r !== afterRoutes[i]);
    if (signal.aborted) report.unavailable = "检查已停止，不生成修复建议。";
    report.repair = ipv6RepairPlan(report);
  } catch {
    report.dnsError = signal.aborted ? "ABORTED" : "DNS_LOOKUP_FAILED";
  }
  return report;
}

export async function validateIPRepair(report: IPPathReport, restore = false) {
  if (process.platform !== "darwin" || !report.service)
    throw new Error("未取得可恢复的 macOS 网络服务配置，请重新检查。");
  const signal = AbortSignal.timeout(4000);
  const [network, service] = await Promise.all([
    networkSnapshot(),
    serviceFor(report.service.device, signal),
  ]);
  if (!ipRepairSnapshotCurrent(report, network.signature, service, restore))
    throw new Error(
      "网络或 IPv6 配置已变化，或结果已过期。请在故障网络下重新检查，再复制方案。",
    );
}
