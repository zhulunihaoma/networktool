import { randomUUID } from "node:crypto";
import { ALL_ENDPOINTS } from "../../src/shared/providers";
import type {
  ModelProvider,
  PlatformProgress,
  ProviderEndpoint,
  ProviderResult,
  ProviderScan,
} from "../../src/shared/types";

interface Dependencies {
  probe(
    provider: ModelProvider,
    endpoint: ProviderEndpoint,
    signal: AbortSignal,
    progress: (value: PlatformProgress) => void,
  ): Promise<ProviderResult>;
}
const pending = (providerId: string, endpointId: string): ProviderResult => ({
  providerId,
  endpointId,
  status: "pending",
  effectiveUrl:
    ALL_ENDPOINTS.find((x) => x.endpoint.id === endpointId)?.endpoint.url || "",
  urlSource: "default",
  summary: "尚未测试",
  suggestion: "",
  route: "系统网络",
  evidence: [],
  progress: { label: "排队等待", completed: 0, total: 5 },
});
interface Batch {
  abort: AbortController;
  queue: { provider: ModelProvider; endpoint: ProviderEndpoint }[];
}
// Supports the initial automatic scan and manual retries: 30s per-endpoint rate limit,
// bounded concurrency, stop discards late results.
export class ProviderDoctor {
  private scan: ProviderScan = {
    id: "initial",
    status: "idle",
    results: ALL_ENDPOINTS.map((x) => pending(x.provider.id, x.endpoint.id)),
  };
  private batch?: Batch;
  private lastStarted = new Map<string, number>();
  constructor(
    private dependencies: Dependencies,
    private publish: (scan: ProviderScan) => void,
  ) {}
  current() {
    return structuredClone(this.scan);
  }
  start(id?: string) {
    const item = id
      ? ALL_ENDPOINTS.find((x) => x.endpoint.id === id)
      : undefined;
    if (id && !item) throw new Error("不支持的端点。");
    const now = Date.now();
    if (this.scan.status === "running" && this.batch) {
      if (!item) return this.current();
      const row = this.scan.results.find((r) => r.endpointId === id)!;
      if (row.status === "checking") return this.current();
      const index = this.batch.queue.findIndex((x) => x.endpoint.id === id);
      if (index >= 0) {
        this.batch.queue.splice(index, 1);
        this.batch.queue.unshift(item);
        row.summary = "已优先安排单端点测试";
        this.emit();
        return this.current();
      }
      this.checkFrequency(item.endpoint.id, now);
      this.lastStarted.set(item.endpoint.id, now);
      this.batch.queue.unshift(item);
      this.scan.endpointIds = [
        ...new Set([...(this.scan.endpointIds || []), item.endpoint.id]),
      ];
      this.reset(item);
      this.emit();
      return this.current();
    }
    const requested = ALL_ENDPOINTS.filter((x) => !id || x.endpoint.id === id);
    const selected = requested.filter(
      (x) => now - (this.lastStarted.get(x.endpoint.id) || 0) >= 30000,
    );
    if (!selected.length)
      throw new Error("刚刚已测试过，请等待 30 秒后再试。");
    const batch: Batch = {
      abort: new AbortController(),
      queue: [...selected],
    };
    this.batch = batch;
    this.scan = {
      ...this.scan,
      id: randomUUID(),
      status: "running",
      started: now,
      ended: undefined,
      endpointIds: selected.map((x) => x.endpoint.id),
    };
    selected.forEach((x) => {
      this.lastStarted.set(x.endpoint.id, now);
      this.reset(x);
    });
    this.emit();
    void this.run(batch, selected.length);
    return this.current();
  }
  private checkFrequency(id: string, now: number) {
    if (now - (this.lastStarted.get(id) || 0) < 30000)
      throw new Error("刚刚已测试过，请等待 30 秒后再试。");
  }
  private reset(item: { provider: ModelProvider; endpoint: ProviderEndpoint }) {
    this.scan.results = this.scan.results.map((r) =>
      r.endpointId === item.endpoint.id
        ? pending(item.provider.id, item.endpoint.id)
        : r,
    );
  }
  stop() {
    if (this.scan.status !== "running") return this.current();
    this.batch?.abort.abort();
    if (this.batch) this.batch.queue = [];
    this.scan.status = "cancelled";
    this.scan.ended = Date.now();
    this.scan.results = this.scan.results.map((r) =>
      (this.scan.endpointIds || []).includes(r.endpointId) &&
      ["pending", "checking"].includes(r.status)
        ? {
            ...r,
            status: "cancelled",
            summary: "本次测试已停止",
            suggestion: "可以稍后重新测试。",
            progress: {
              label: "已停止",
              completed: r.progress?.completed || 0,
              total: 5,
            },
          }
        : r,
    );
    this.emit();
    return this.current();
  }
  private emit() {
    this.publish(this.current());
  }
  private async run(batch: Batch, initialCount: number) {
    const worker = async () => {
      while (batch.queue.length && !batch.abort.signal.aborted) {
        const item = batch.queue.shift()!;
        const started = Date.now();
        const row = this.scan.results.find(
          (r) => r.endpointId === item.endpoint.id,
        )!;
        row.status = "checking";
        row.summary = "正在测试端点";
        row.progress = {
          label: "连接端点",
          completed: 0,
          total: 5,
          startedAt: started,
        };
        this.emit();
        let result: ProviderResult;
        try {
          result = await this.dependencies.probe(
            item.provider,
            item.endpoint,
            batch.abort.signal,
            (value) => {
              if (batch.abort.signal.aborted) return;
              const current = this.scan.results.find(
                (r) => r.endpointId === item.endpoint.id,
              )!;
              current.progress = value;
              current.summary = value.label;
              this.emit();
            },
          );
        } catch {
          result = {
            ...pending(item.provider.id, item.endpoint.id),
            status: "check_failed",
            summary: "检测执行失败，请重新测试",
            suggestion:
              "此次检测没有完成，不将执行错误判定为网络不可达。",
            checkedAt: Date.now(),
          };
        }
        if (batch.abort.signal.aborted) return;
        result.duration = result.duration ?? Date.now() - started;
        result.progress = {
          label: "测试完成",
          completed: 5,
          total: 5,
          startedAt: started,
        };
        this.scan.results = this.scan.results.map((r) =>
          r.endpointId === item.endpoint.id ? result : r,
        );
        this.emit();
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(4, initialCount) }, worker),
    );
    if (batch.abort.signal.aborted) return;
    this.scan.status = "completed";
    this.scan.ended = Date.now();
    this.emit();
  }
}
