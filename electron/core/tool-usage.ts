import type { ProcessInfo } from "../../src/shared/types";
import {
  applySample,
  parseToolUsage,
  runningProducts,
  type ToolUsage,
} from "../../src/shared/tool-usage";
import type { Store } from "./store";

const INTERVAL_MS = 25_000;
const STORE_KEY = "toolUsage";

/**
 * Samples running processes while the app is open and accumulates a per-tool "opened"
 * count. Only process names/image paths are read; no window titles, arguments or content.
 */
export class ToolUsageTracker {
  private usage: ToolUsage;
  private previous: Set<string> | null = null;
  private timer: NodeJS.Timeout | undefined;
  private sampling = false;

  constructor(
    private store: Store,
    private listProcesses: () => Promise<ProcessInfo[]>,
    private intervalMs: number = INTERVAL_MS,
  ) {
    this.usage = parseToolUsage(this.store.assistant<unknown>(STORE_KEY, null));
  }

  current(): ToolUsage {
    return this.usage;
  }

  async poll(): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    try {
      const processes = await this.listProcesses();
      const running = runningProducts(processes);
      const next = applySample(this.usage, this.previous, running, Date.now());
      this.previous = new Set(running);
      if (next !== this.usage) {
        this.usage = next;
        this.store.putAssistant(STORE_KEY, this.usage);
      }
    } catch {
      /* usage sampling is best-effort and must never affect the app */
    } finally {
      this.sampling = false;
    }
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
