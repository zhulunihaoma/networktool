import { randomUUID } from "node:crypto";
import { newTriage, TRIAGE_TARGETS } from "../../src/shared/triage";
import type {
  AIPlatform,
  Flow,
  PlatformResult,
  ProcessInfo,
  TriageAction,
  TriageRun,
  TriageStep,
} from "../../src/shared/types";
import { detectRunningApps } from "./platforms";

export interface TriageDependencies {
  network(): Promise<{ count: number; signature: string }>;
  proxy(url: string): Promise<string>;
  proxyEndpoint(proxy: string, signal: AbortSignal): Promise<string[]>;
  dns(host: string, signal: AbortSignal): Promise<{ v4: number; v6: number }>;
  probe(target: AIPlatform, signal: AbortSignal): Promise<PlatformResult>;
  processes(): Promise<ProcessInfo[]>;
  connections(
    processes: ProcessInfo[],
  ): Promise<{ flows: Flow[]; error?: string }>;
}
export function prioritize(run: TriageRun) {
  const issues = run.steps.filter(
    (s) => s.status === "attention" || s.status === "error",
  );
  // Local DNS failure alone does not explain a successful system/proxy entrance request.
  issues.sort((a, b) => {
    const weight = (s: TriageStep) =>
      s.id === "dns" &&
      run.steps.find((s) => s.id === "entry")?.status === "pass"
        ? 5
        : run.steps.indexOf(s);
    return weight(a) - weight(b);
  });
  run.priorityIds = issues.map((s) => s.id);
  run.summary = issues.length
    ? `建议先处理“${issues[0].title}”：${issues[0].summary}`
    : "本次未发现明确的入口连接异常；反复重连仍需在原工具中复现观察。";
  if (
    issues.length === 1 &&
    issues[0].id === "dns" &&
    run.steps.find((s) => s.id === "entry")?.status === "pass"
  ) {
    run.priorityIds = ["stability", "dns"];
    run.summary =
      "公开入口已响应；本机解析失败未证明应用故障原因，建议先观察重连并核对实际解析路径。";
  }
}

export class TriageDoctor {
  private run = newTriage("codex");
  private abort?: AbortController;
  private timer?: ReturnType<typeof setInterval>;
  private observationBusy = false;
  private lastStarted = new Map<string, number>();
  constructor(
    private d: TriageDependencies,
    private publish: (run: TriageRun) => void,
  ) {}
  current() {
    return structuredClone(this.run);
  }
  busy() {
    return (
      this.run.status === "running" || this.run.observation.status === "running"
    );
  }
  private emit() {
    this.publish(this.current());
  }
  start(targetId: string) {
    if (this.busy()) throw new Error("排查或观察正在进行，请先停止。 ");
    const target = TRIAGE_TARGETS.find((p) => p.id === targetId);
    if (!target) throw new Error("不支持的排查目标。");
    const now = Date.now(),
      host = new URL(target.url).hostname;
    if (now - (this.lastStarted.get(host) || 0) < 30000)
      throw new Error("刚刚检查过这个入口，请等待 30 秒后复测。");
    this.lastStarted.set(host, now);
    const previous =
      this.run.status === "completed" && this.run.targetId === targetId
        ? this.current()
        : undefined;
    this.run = {
      ...newTriage(targetId, randomUUID()),
      status: "running",
      started: now,
    };
    const abort = new AbortController();
    this.abort = abort;
    this.emit();
    void this.inspect(target, abort.signal, previous);
    return this.current();
  }
  stop() {
    this.abort?.abort();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.run.observation.status === "running") {
      this.run.observation.status = "cancelled";
      this.run.observation.ended = Date.now();
      this.set("stability", {
        status: "unverified",
        summary: "观察已停止，已采集的记录保留",
        support: "limited",
      });
    }
    if (this.run.status === "running") {
      this.run.status = "cancelled";
      this.run.ended = Date.now();
      this.run.summary = "排查已停止；未执行的项目不能视为通过。";
      this.run.steps.forEach((s) => {
        if (["pending", "checking"].includes(s.status)) {
          s.status = "skipped";
          s.summary = "本次排查已停止";
        }
      });
    }
    this.emit();
    return this.current();
  }
  private set(id: TriageStep["id"], value: Partial<TriageStep>) {
    Object.assign(
      this.run.steps.find((s) => s.id === id)!,
      value,
    );
    this.emit();
  }
  private async step(
    id: TriageStep["id"],
    signal: AbortSignal,
    fn: () => Promise<Partial<TriageStep>>,
  ) {
    if (signal.aborted) return;
    this.set(id, { status: "checking", summary: "正在检查…" });
    try {
      const result = await fn();
      if (!signal.aborted) this.set(id, result);
    } catch {
      if (!signal.aborted)
        this.set(id, {
          status: "error",
          summary: "检查未完成，不能判定正常或异常",
          suggestion: "稍后重试，或复制记录交给 IT。",
          actions: ["retry", "copy_report"],
          support: "none",
        });
    }
  }
  private async inspect(
    target: AIPlatform,
    signal: AbortSignal,
    previous?: TriageRun,
  ) {
    let noNetwork = false;
    await this.step("network", signal, async () => {
      const network = await this.d.network();
      noNetwork = network.count === 0;
      return {
        status: noNetwork ? "attention" : "pass",
        summary: noNetwork
          ? "未发现具有可用地址的非回环网络接口"
          : "系统报告有可用网络地址",
        evidence: [
          `发现 ${network.count} 个有可用地址的接口；这不是互联网连通性证明。`,
        ],
        suggestion: noNetwork
          ? "在网络设置中确认 Wi-Fi 或有线网络已连接。处理后重新检查。"
          : "继续检查实际目标与网络路径。",
        support: "observed",
        actions: noNetwork ? ["network_settings", "retry"] : [],
      };
    });
    if (noNetwork && !signal.aborted) {
      for (const id of ["proxy", "dns", "entry"] as const)
        this.set(id, {
          status: "skipped",
          summary: "先恢复基础网络后再检查",
          suggestion: "打开网络设置，确认连接后复测。",
          actions: ["network_settings", "retry"],
        });
    } else {
      await this.step("proxy", signal, async () => {
        const routes = await this.d.proxy(target.url);
        const first = routes.split(";")[0].trim();
        if (first === "DIRECT")
          return {
            status: "unverified",
            summary: "系统选择直连；VPN 隧道是否接管流量未确认",
            evidence: [
              "当前目标的系统代理解析结果为 DIRECT。VPN 的 TUN 或分流不能由此推断。",
            ],
            suggestion:
              "如果公司要求通过 VPN 访问，请在获批客户端确认连接与分流规则；不要仅因 DIRECT 判断没有 VPN。",
            actions: ["proxy_settings"],
            support: "limited",
          };
        const match = first.match(/^(PROXY|SOCKS5)\s+(.+)$/i);
        if (!match)
          return {
            status: "unverified",
            summary: "当前系统代理路径无法由此检查验证",
            evidence: ["代理类型未受此检查支持，或系统未给出可用路径。"],
            suggestion: "请在系统和获批网络客户端核对代理设置。",
            actions: ["proxy_settings", "copy_report"],
            support: "none",
          };
        const proxy = `${match[1].toUpperCase() === "PROXY" ? "http" : "socks5"}://${match[2]}`;
        try {
          const details = await this.d.proxyEndpoint(proxy, signal);
          return {
            status: "pass",
            summary: "系统选中的代理端点接受了 TCP 连接",
            evidence: [
              "未发送账号凭据；端点连通不代表隧道认证或目标路由正常。",
              ...details,
            ],
            suggestion:
              "如果仍失败，继续查看平台响应；本机监听不等于 VPN 配置正确。",
            actions: [],
            support: "observed",
          };
        } catch {
          return {
            status: "attention",
            summary: "无法连接系统选中的代理端点",
            evidence: [
              "对当前系统代理端点的 TCP 尝试未成功；不是对平台服务的失败证明。",
            ],
            suggestion:
              "确认获批 VPN/代理客户端已启动，并核对其本地端口与系统设置是否一致。端口被谁监听需核对，不能自动认定端口冲突。",
            actions: ["proxy_settings", "retry", "copy_report"],
            support: "observed",
          };
        }
      });
      await this.step("dns", signal, async () => {
        try {
          const answer = await this.d.dns(new URL(target.url).hostname, signal);
          return {
            status: "pass",
            summary: "系统解析器返回了入口地址",
            evidence: [
              `IPv4 地址 ${answer.v4} 个；IPv6 地址 ${answer.v6} 个。未验证各条地址的实际路由。`,
            ],
            suggestion: "解析成功后仍需检查安全连接与 HTTP 响应。",
            actions: [],
            support: "observed",
          };
        } catch {
          return {
            status: "attention",
            summary: "本机系统解析器未返回可用入口地址",
            evidence: [
              "本次系统 DNS 检查失败；代理远端解析可能仍然正常，应独立看入口结果。",
            ],
            suggestion:
              "先重新连接获批网络或联系 IT 检查 DNS；处理后复测，不自动替换公司 DNS。",
            actions: ["network_settings", "retry", "copy_report"],
            support: "observed",
          };
        }
      });
      await this.step("entry", signal, async () => {
        const result = await this.d.probe(target, signal);
        const systemFailed = result.paths?.some(
          (p) => p.label === "系统路径" && p.status === "unreachable",
        );
        const cert = result.evidence.some(
          (e) =>
            e.status === "failed" &&
            /CERT|SSL|SELF_SIGNED|ISSUER|VERIFY/i.test(e.code || ""),
        );
        const healthy =
          ["reachable", "auth_required"].includes(result.status) &&
          !systemFailed;
        const actions: TriageAction[] = healthy
          ? ["open_platform"]
          : cert
            ? ["date_settings", "copy_report", "retry"]
            : result.status === "check_failed"
              ? ["reset_probe", "retry"]
              : ["open_platform", "retry", "copy_report"];
        if (
          result.status === "busy" &&
          ["codex", "chatgpt"].includes(target.id)
        )
          actions.unshift("service_status");
        return {
          status:
            result.status === "check_failed"
              ? "error"
              : healthy
                ? "pass"
                : "attention",
          summary: result.summary,
          evidence: result.evidence.map(
            (e) =>
              `${e.source === "Chromium · system network" ? "系统路径" : e.route === "direct" ? "补充直连" : "补充代理"} · ${e.stage.toUpperCase()}：${e.status}${e.httpStatus ? ` HTTP ${e.httpStatus}` : ""}${e.code ? ` ${e.code}` : ""}`,
          ),
          suggestion: `${result.suggestion}${target.id === "codex" ? " 此处仅测 ChatGPT 公开入口，不证明 Codex 模型、认证或任务连接正常。" : ""}`,
          actions,
          support: result.status === "check_failed" ? "none" : "limited",
        };
      });
    }
    if (signal.aborted) return;
    this.set("stability", {
      status: "unverified",
      summary: "持续会话尚未验证，需要复现观察",
      evidence: ["短时公开入口检查不验证流式响应、WebSocket 会话或账号状态。"],
      suggestion:
        "点击观察，在原工具中复现；出现 Reconnecting 时标记一次。程序只记录本机变化与 TCP 快照，需结合应用日志确认根因。",
      actions: ["observe", "copy_report"],
      support: "none",
    });
    this.run.status = "completed";
    this.run.ended = Date.now();
    prioritize(this.run);
    if (previous) {
      const before = previous.steps
        .filter((s) => ["attention", "error"].includes(s.status))
        .map((s) => s.id);
      const fixed = before.filter(
        (id) => this.run.steps.find((s) => s.id === id)?.status === "pass",
      );
      this.run.comparison = fixed.length
        ? `${fixed.length} 项先前异常现已通过本次检查；请在原工具确认是否恢复。`
        : "本次没有证明先前异常已恢复；入口结果不等于应用修复结果。";
    }
    this.emit();
  }
  authorize(id: string, action: TriageAction) {
    if (id !== this.run.id || this.run.status !== "completed")
      throw new Error("排查结果已过期或尚未完成，请重新检查。");
    if (
      !["retry", "copy_report"].includes(action) &&
      !this.run.steps.some((s) => s.actions.includes(action))
    )
      throw new Error("该操作不适用于当前排查结果。");
  }
  verify(id: string, result: "restored" | "still_failed") {
    this.authorize(id, "copy_report");
    this.run.verification = result;
    this.emit();
    return this.current();
  }
  mark(id: string) {
    this.authorize(id, "observe");
    if (this.run.observation.status !== "running")
      throw new Error("请先开始观察，再标记错误时刻。");
    if (this.run.observation.markers.length >= 30)
      throw new Error("本次标记已达到上限。");
    this.run.observation.markers.push(Date.now());
    this.emit();
    return this.current();
  }
  async observe(id: string) {
    this.authorize(id, "observe");
    if (this.busy()) throw new Error("已有排查或观察正在进行。");
    const target = TRIAGE_TARGETS.find((p) => p.id === this.run.targetId)!;
    const abort = new AbortController();
    this.abort = abort;
    // Reserve before async preparation so two clicks cannot create two sampling loops.
    this.run.observation = {
      ...newTriage(target.id).observation,
      status: "running",
      started: Date.now(),
    };
    this.emit();
    let initial: ProcessInfo[],
      network: { count: number; signature: string },
      proxy: string;
    try {
      [initial, network, proxy] = await Promise.all([
        this.d.processes(),
        this.d.network(),
        this.d.proxy(target.url),
      ]);
    } catch {
      if (!abort.signal.aborted) {
        this.run.observation.status = "cancelled";
        this.set("stability", {
          status: "error",
          summary: "无法准备观察，未获得稳定性结论",
          actions: ["observe", "copy_report"],
        });
      }
      return this.current();
    }
    if (abort.signal.aborted) return this.current();
    const matches = new Set(detectRunningApps(target, initial));
    const selected = initial.filter((p) => matches.has(p.name));
    const keys = new Set(selected.map((p) => p.key));
    this.run.observation.processCount = selected.length;
    this.set("stability", {
      status: "checking",
      summary: selected.length
        ? `正在观察 ${selected.length} 个已识别进程实例，请复现问题`
        : "未识别到已知客户端进程，正在观察网络配置",
      support: "limited",
    });
    let signature = network.signature,
      proxyRoute = proxy,
      ticks = 0;
    const event = (message: string) => {
      if (this.run.observation.events.length < 120)
        this.run.observation.events.push({ time: Date.now(), message });
    };
    const finish = () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      const o = this.run.observation;
      o.status = "completed";
      o.ended = Date.now();
      const changed = o.networkChanges + o.proxyChanges + o.missingProcesses;
      this.set("stability", {
        status: changed || o.errors ? "attention" : "unverified",
        summary: changed
          ? "观察到网络路径或进程变化，需要核对与重连的时间关系"
          : o.errors
            ? "部分连接快照未能采集，稳定性尚未验证"
            : "本次未观察到配置变化；持续会话仍未验证",
        evidence: [
          `采样 ${o.samples} 次；已识别 ${o.processCount} 个进程；最多 ${o.maxConnections} 条 TCP 连接；错误标记 ${o.markers.length} 次。`,
          ...o.events.map(
            (e) =>
              `${new Date(e.time).toLocaleTimeString("zh-CN")} ${e.message}`,
          ),
        ],
        suggestion:
          "TCP 连接存在或消失不能证明应用会话成功或中断。请结合标记时刻与应用日志，将记录交给 IT；不要自动推断 VPN 掉线。",
        actions: ["observe", "copy_report", "network_settings"],
        support: "limited",
      });
      prioritize(this.run);
      this.emit();
    };
    const tick = async () => {
      if (abort.signal.aborted || this.observationBusy) return;
      if (Date.now() - this.run.observation.started! >= 60000) {
        finish();
        return;
      }
      this.observationBusy = true;
      try {
        const [ps, currentNetwork] = await Promise.all([
          this.d.processes(),
          this.d.network(),
        ]);
        const connections = await this.d.connections(ps);
        const currentProxy =
          ticks % 10 === 0 ? await this.d.proxy(target.url) : proxyRoute;
        if (abort.signal.aborted) return;
        const o = this.run.observation;
        o.samples++;
        ticks++;
        if (connections.error) {
          o.errors++;
          event("TCP 快照读取失败，不能当作没有连接。");
        } else
          o.maxConnections = Math.max(
            o.maxConnections,
            connections.flows.filter((f) => keys.has(f.processKey)).length,
          );
        const missing = selected.filter(
          (p) => !ps.some((now) => now.key === p.key),
        ).length;
        if (missing > o.missingProcesses)
          event("起始进程实例已退出或无法读取，不自动归属同名新进程。");
        o.missingProcesses = Math.max(o.missingProcesses, missing);
        if (currentNetwork.signature !== signature) {
          o.networkChanges++;
          signature = currentNetwork.signature;
          event("本机网络接口或地址发生变化。");
        }
        if (currentProxy !== proxyRoute) {
          o.proxyChanges++;
          proxyRoute = currentProxy;
          event("目标的系统代理路径发生变化。");
        }
        this.emit();
      } catch {
        if (!abort.signal.aborted) {
          this.run.observation.errors++;
          event("采集未完成，本次样本无稳定性结论。");
          this.emit();
        }
      } finally {
        this.observationBusy = false;
      }
    };
    this.timer = setInterval(() => void tick(), 1000);
    void tick();
    return this.current();
  }
}
