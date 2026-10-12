import { randomUUID } from "node:crypto";
import type {
  Session,
  StartInput,
  Settings,
  ProcessInfo,
  Evidence,
} from "../../src/shared/types";
import {
  capabilities,
  listProcesses,
  collectConnections,
  readConfig,
} from "./collector";
import {
  normalizeTarget,
  normalizeProxy,
  startSchema,
  settingsSchema,
} from "./validation";
import { runProbe } from "./probe";
import { evaluate } from "./rules";
import { Store } from "./store";
import type {
  ToolDiagnosisReference,
  ToolDiagnosisContext,
} from "../../src/shared/assistant";
export class Manager {
  sessions = new Map<string, Session>();
  private requests = new Map<string, string>();
  private jobs = new Map<
    string,
    {
      abort: AbortController;
      timer?: NodeJS.Timeout;
      busy: boolean;
      lastSave: number;
      present: Map<string, string>;
    }
  >();
  private processCache: ProcessInfo[] = [];
  constructor(
    private store: Store,
    private update: (s: Session) => void,
    private resolveTool?: (
      reference: ToolDiagnosisReference,
    ) => ToolDiagnosisContext,
  ) {}
  init() {
    for (const s of this.store.all()) {
      if (["collecting", "preparing", "analyzing"].includes(s.status)) {
        s.status = "interrupted";
        s.phase = "上次运行中断，已有证据已保留";
        s.ended = Date.now();
        this.store.put(s);
      }
      this.sessions.set(s.id, s);
    }
    this.cleanup();
  }
  overview() {
    return {
      coverage: capabilities(),
      sessions: [...this.sessions.values()].sort(
        (a, b) => b.started - a.started,
      ),
      settings: this.store.settings(),
      activeId: [...this.jobs.keys()][0],
    };
  }
  get(id: string) {
    const s = this.sessions.get(id);
    if (!s) throw new Error("会话不存在或已删除。");
    return s;
  }
  publish(s: Session, persist = false) {
    s.sequence++;
    if (persist) this.store.put(s);
    this.update(s);
  }
  async start(raw: StartInput) {
    const input = startSchema.parse(raw);
    const existing = this.requests.get(input.clientRequestId);
    if (existing && this.sessions.has(existing)) return this.get(existing);
    if (this.jobs.size) throw new Error("已有诊断运行中，请先完成或取消。");
    const target = normalizeTarget(input.target),
      proxy = normalizeProxy(input.proxy);
    this.processCache = await listProcesses().catch(() => []);
    const repeated = this.requests.get(input.clientRequestId);
    if (repeated && this.sessions.has(repeated)) return this.get(repeated);
    if (this.jobs.size) throw new Error("已有诊断运行中，请先完成或取消。");
    const root = this.processCache.find((p) => p.key === input.processKey);
    if (input.processKey && !root)
      throw new Error("所选进程已退出或重启，请重新选择当前实例。");
    if (input.mode === "compare" && !root)
      throw new Error("联网对比需要选择目标应用实例。");
    const selected = new Set([input.processKey, ...input.scopeKeys]);
    const scope = this.processCache.filter((p) => selected.has(p.key));
    const now = Date.now();
    if (input.tool && !this.resolveTool)
      throw new Error("工具诊断身份解析器不可用。");
    const s: Session = {
      id: randomUUID(),
      toolContext: input.tool ? this.resolveTool!(input.tool) : undefined,
      name:
        input.name ||
        `${root?.name || target.host} 的${input.mode === "compare" ? "联网对比" : "连接诊断"}`,
      ...target,
      proxy,
      process: root,
      scope,
      mode: input.mode,
      duration: input.duration,
      deadline: now + input.duration * 1000,
      started: now,
      status: "preparing",
      phase: "正在保存网络配置基线",
      evidence: [],
      findings: [],
      flows: [],
      config: [],
      coverage: capabilities(),
      markers: [],
      dropped: 0,
      sequence: 0,
    };
    this.sessions.set(s.id, s);
    this.requests.set(input.clientRequestId, s.id);
    const job = {
      abort: new AbortController(),
      busy: false,
      lastSave: now,
      present: new Map<string, string>(),
    };
    this.jobs.set(s.id, job);
    this.publish(s, true);
    void this.prepare(s).catch((e) => this.fail(s, e));
    return s;
  }
  private async prepare(s: Session) {
    s.config = await readConfig();
    if (!this.jobs.has(s.id)) return;
    s.evidence.push({
      id: `E-${randomUUID().slice(0, 8)}`,
      time: Date.now(),
      stage: "config",
      route: "local",
      status: "info",
      title: "网络配置快照已保存",
      detail: "来源为诊断器当前用户与环境，不代表目标应用继承配置。",
      source: "local configuration",
      executor: "collector",
    });
    s.status = "collecting";
    s.phase =
      s.mode === "compare"
        ? "正在记录空闲基线，请暂不启动任务"
        : "请在目标软件中复现连接问题";
    this.publish(s, true);
    const job = this.jobs.get(s.id);
    if (job)
      job.timer = setInterval(
        () => void this.tick(s).catch((e) => this.fail(s, e)),
        1000,
      );
    await this.tick(s);
  }
  private async tick(s: Session) {
    const job = this.jobs.get(s.id);
    if (!job || job.busy || s.status !== "collecting") return;
    if (Date.now() >= s.deadline) {
      if (s.mode === "compare" && !s.baselineEnded) {
        s.phase = "空闲基线已记录，请点击“开始任务窗口”";
        s.deadline = 0;
        this.publish(s);
        return;
      }
      if (s.deadline === 0) return;
      await this.finish(s.id);
      return;
    }
    job.busy = true;
    try {
      if (!s.process) return;
      const currentProcesses = await listProcesses();
      const result = await collectConnections(
        currentProcesses,
        s.baselineEnded ? "task" : "baseline",
      );
      if (!this.jobs.has(s.id) || s.status !== "collecting") return;
      if (!currentProcesses.some((p) => p.key === s.process!.key))
        s.phase = "所选进程实例已退出；已有证据保留，不自动跟踪同名新实例";
      if (result.error) {
        s.coverage = {
          ...s.coverage,
          tcp: false,
          limitations: [...new Set([...s.coverage.limitations, result.error])],
        };
        return;
      }
      const keys = new Set(s.scope.map((p) => p.key));
      const present = new Map<string, string>();
      for (const flow of result.flows.filter((f) => keys.has(f.processKey))) {
        const key = `${flow.processKey}|${flow.family}|${flow.local}|${flow.remote}|${flow.window}`;
        const id = job.present.get(key);
        const existing = id ? s.flows.find((f) => f.id === id) : undefined;
        if (existing) {
          existing.lastSeen = flow.lastSeen;
          existing.state = flow.state;
          present.set(key, existing.id);
        } else if (s.flows.length < 2000) {
          s.flows.push(flow);
          present.set(key, flow.id);
        } else s.dropped++;
      }
      job.present = present;
    } finally {
      job.busy = false;
      const persist = Date.now() - job.lastSave >= 5000;
      if (persist) job.lastSave = Date.now();
      this.publish(s, persist);
    }
  }
  async finish(id: string) {
    const s = this.get(id),
      job = this.jobs.get(id);
    if (!job || s.status === "analyzing") return s;
    if (s.mode === "compare" && !s.baselineEnded)
      throw new Error("请先开始任务窗口，再完成对比。");
    clearInterval(job.timer);
    s.status = "analyzing";
    s.phase =
      s.mode === "compare"
        ? "正在比较两个观察窗口"
        : "正在执行分层探测，请稍候";
    this.publish(s, true);
    void this.analyze(s, job.abort).catch((e) => this.fail(s, e));
    return s;
  }
  private async analyze(s: Session, abort: AbortController) {
    if (s.mode === "diagnose") {
      const timeout = setTimeout(() => abort.abort(), 30000);
      try {
        await runProbe(s, abort.signal, (e) => {
          if (this.jobs.has(s.id)) {
            s.evidence.push(e);
            s.phase = `正在分析 ${e.stage.toUpperCase()} · ${e.route === "direct" ? "直连" : "指定代理"}`;
            this.publish(s);
          }
        });
      } finally {
        clearTimeout(timeout);
      }
    }
    if (!this.jobs.has(s.id)) return;
    s.findings = evaluate(s);
    if (s.mode === "compare") {
      const baseline = new Set(
        s.flows.filter((f) => f.window === "baseline").map((f) => f.remote),
      );
      const added = [
        ...new Set(
          s.flows.filter((f) => f.window === "task").map((f) => f.remote),
        ),
      ].filter((r) => !baseline.has(r));
      s.findings = [
        {
          id: `${s.id}-R10`,
          ruleId: "R10",
          version: 1,
          title: `任务窗口新增观察到 ${added.length} 个 TCP 目标`,
          description:
            "按 IP 与端口比较两个窗口；CDN 地址变化和后台任务也可能产生差异。此结果不构成泄露或恶意判断。",
          support: "limited",
          evidenceIds: [],
          missing: [
            "域名归因、请求正文与任务因果关系。",
            "基线与任务窗口时长可能不同；快照可能漏掉短连接。",
          ],
          nextCheck:
            "在应用联网页面核对新增目标与所属进程，并排除已知后台行为。",
          severity: "info",
        },
      ];
    }
    s.status = "completed";
    s.phase = "诊断完成，请查看证据并验证建议";
    s.ended = Date.now();
    this.jobs.delete(s.id);
    this.publish(s, true);
    this.cleanup();
  }
  async stop(id: string) {
    const s = this.get(id),
      job = this.jobs.get(id);
    if (!job) return s;
    clearInterval(job.timer);
    job.abort.abort();
    this.jobs.delete(id);
    s.status = "cancelled";
    s.ended = Date.now();
    s.phase = "诊断已取消，已记录证据保留";
    s.findings = evaluate(s);
    this.publish(s, true);
    return s;
  }
  extend(id: string) {
    const s = this.get(id);
    if (s.status !== "collecting") throw new Error("只能延长观察阶段。");
    const max = s.started + 300000;
    if (s.deadline === 0) s.deadline = Date.now() + 60000;
    else s.deadline = Math.min(Math.max(s.deadline, Date.now()) + 60000, max);
    s.duration = Math.min(300, Math.round((s.deadline - s.started) / 1000));
    this.publish(s, true);
    return s;
  }
  mark(id: string) {
    const s = this.get(id);
    if (s.status !== "collecting") throw new Error("当前不在复现阶段。");
    s.markers.push(Date.now());
    s.evidence.push({
      id: `E-${randomUUID().slice(0, 8)}`,
      time: Date.now(),
      stage: "marker",
      route: "local",
      status: "info",
      title: "用户标记错误发生时刻",
      detail: "用户声明的时刻，用于定位附近快照；不等同于应用日志。",
      source: "user_marker",
      executor: "user",
    });
    this.publish(s, true);
    return s;
  }
  task(id: string) {
    const s = this.get(id);
    if (s.mode !== "compare" || s.status !== "collecting" || s.baselineEnded)
      throw new Error("当前不能开始任务窗口。");
    s.baselineEnded = Date.now();
    s.deadline = Date.now() + s.duration * 1000;
    s.phase = "请开始 AI 或开发任务，完成后点击“完成观察”";
    this.publish(s, true);
    return s;
  }
  verify(id: string, result: Session["verified"]) {
    const s = this.get(id);
    if (this.jobs.has(id)) throw new Error("请等待诊断完成后复测。");
    s.verified = result;
    s.evidence.push({
      id: `E-${randomUUID().slice(0, 8)}`,
      time: Date.now(),
      stage: "verification",
      route: "target_context",
      status: "info",
      title: `用户复测：${result === "success" ? "成功" : result === "failed" ? "仍失败" : "暂不确定"}`,
      detail: "仅为用户手动声明，不提升为目标程序 HTTP 成功证据。",
      source: "user_declaration",
      executor: "user",
    });
    this.publish(s, true);
    return s;
  }
  remove(id: string) {
    if (this.jobs.has(id)) throw new Error("请先停止正在运行的会话。");
    this.store.delete(id);
    this.sessions.delete(id);
  }
  setSettings(input: Settings) {
    const s = settingsSchema.parse(input);
    this.store.setSettings(s);
    this.cleanup();
    return s;
  }
  private cleanup() {
    const cutoff = Date.now() - this.store.settings().retentionDays * 86400000;
    for (const s of this.sessions.values())
      if (s.started < cutoff && !this.jobs.has(s.id)) {
        this.store.delete(s.id);
        this.sessions.delete(s.id);
      }
  }
  private fail(s: Session, error: unknown) {
    const job = this.jobs.get(s.id);
    clearInterval(job?.timer);
    job?.abort.abort();
    this.jobs.delete(s.id);
    s.status = "failed";
    s.ended = Date.now();
    s.error = (error as Error).message;
    s.phase = "诊断中断，已记录证据保留";
    try {
      this.publish(s, true);
    } catch {
      this.update(s);
    }
  }
  shutdown() {
    for (const id of [...this.jobs.keys()]) void this.stop(id);
  }
}
