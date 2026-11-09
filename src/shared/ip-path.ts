export interface IPPathAttempt {
  family: 4 | 6;
  interface?: string;
  tcp: boolean;
  tls: boolean;
  httpStatus?: number;
  code?: string;
  duration: number;
}

export interface IPv6Service {
  id: string;
  name: string;
  device: string;
  method: "Automatic" | "LinkLocal" | "Off" | "Manual" | "unknown";
}

export interface IPv6RepairPlan {
  service: IPv6Service;
  originalMethod: "Automatic";
  command: string;
  restoreCommand: string;
}

export interface IPPathReport {
  host: string;
  checkedAt: number;
  networkKey: string;
  accessNetworkKey?: string;
  networkChanged: boolean;
  hasPublicIPv6: boolean;
  attempts: IPPathAttempt[];
  service?: IPv6Service;
  dnsError?: string;
  unavailable?: string;
  repair?: IPv6RepairPlan;
}

export const isTunnelInterface = (name?: string) =>
  !!name && /^(utun\d+|tun\d*|tap\d*|wg\d*)$/.test(name);

export function ipv6PathMismatch(report: IPPathReport): boolean {
  const v4 = report.attempts.filter((a) => a.family === 4);
  const v6 = report.attempts.filter((a) => a.family === 6);
  return (
    !report.unavailable &&
    !report.dnsError &&
    !report.networkChanged &&
    report.hasPublicIPv6 &&
    v4.some((a) => a.tls && isTunnelInterface(a.interface)) &&
    v6.length > 0 &&
    v6.every((a) => !a.tls && !!a.interface && !isTunnelInterface(a.interface))
  );
}

const shellQuote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;

export function ipv6RepairPlan(
  report: IPPathReport,
): IPv6RepairPlan | undefined {
  const s = report.service;
  const v6 = report.attempts.filter((a) => a.family === 6);
  if (
    !ipv6PathMismatch(report) ||
    !s ||
    s.method !== "Automatic" ||
    !s.name ||
    /[\r\n\0]/.test(s.name) ||
    !v6.every((a) => a.interface === s.device)
  )
    return;
  return {
    service: s,
    originalMethod: "Automatic",
    command: `sudo /usr/sbin/networksetup -setv6linklocal ${shellQuote(s.name)}`,
    restoreCommand: `sudo /usr/sbin/networksetup -setv6automatic ${shellQuote(s.name)}`,
  };
}

export function ipPathSummary(report: IPPathReport): string {
  if (report.networkChanged)
    return "检查期间网络发生变化，本次 IPv4/IPv6 对照无效，请保持故障网络后重测。";
  if (report.unavailable) return report.unavailable;
  if (report.dnsError)
    return "系统域名解析未完成，尚不能比较 IPv4 与 IPv6 路径。";
  if (ipv6PathMismatch(report))
    return "IPv4 经隧道完成 TLS，已测 IPv6 经其他接口建连失败；存在 IPv6 路径不一致，需用可恢复设置验证。";
  if (!report.attempts.some((a) => a.tls))
    return "已测地址均未完成 TLS；仅限制 IPv6 不能视为完整修复，请继续检查 VPN 数据通道。";
  if (!report.hasPublicIPv6)
    return "本机未发现公网 IPv6 地址；当前不应把故障归因于公网 IPv6 绕行。";
  return "未取得足以推荐 IPv6 规避设置的证据；请结合应用实际连接复测。";
}

export function ipPathEvidence(report: IPPathReport): string[] {
  return [
    `检查对象：${report.host}；时间：${new Date(report.checkedAt).toISOString()}；每个地址族最多检测两个系统解析地址。`,
    ...report.attempts.map(
      (a) =>
        `IPv${a.family} · 路由接口 ${a.interface || "未取得"} · TCP ${a.tcp ? "已连接" : "未完成"} · TLS ${a.tls ? "已完成" : "未完成"}${a.httpStatus ? ` · HTTP ${a.httpStatus}` : ""}${a.code ? ` · ${a.code}` : ""} · ${a.duration} ms`,
    ),
    ...(report.service
      ? [
          `网络服务：${report.service.name}；IPv6 配置：${report.service.method}。`,
        ]
      : []),
    "这是不带账号凭证的补充直连探测，遵循系统 IP 路由，不采用应用 HTTP/SOCKS 代理。HTTP 401/403 仅表示服务响应，不证明账号、WebSocket 或模型任务正常。路由接口名称不能证明所属 VPN 品牌。",
  ];
}

export function ipv6RepairText(plan: IPv6RepairPlan): string {
  return [
    `# 网络服务：${plan.service.name}；原 IPv6 配置：自动。请保存恢复命令。`,
    "# 仅在故障网络下验证。设置持续影响此网络服务连接的所有 Wi-Fi，可能影响需要公网 IPv6 的服务。",
    "# 在本机终端执行，管理员密码只在系统终端输入：",
    plan.command,
    "# 重新连接获批 VPN，确认仍在同一故障网络，重新检查并在原工具连续测试消息。",
    "# 若无改善或需要恢复原配置，单独执行下面这条命令（不要与修复命令一起运行）：",
    `# ${plan.restoreCommand}`,
  ].join("\n");
}

export function ipRepairSnapshotCurrent(
  report: IPPathReport,
  networkKey: string,
  service: IPv6Service | undefined,
  restore = false,
  now = Date.now(),
): boolean {
  return (
    now >= report.checkedAt &&
    now - report.checkedAt <= 10 * 60_000 &&
    networkKey === report.networkKey &&
    !!service &&
    service.id === report.service?.id &&
    service.name === report.service.name &&
    service.method === (restore ? "LinkLocal" : "Automatic")
  );
}
