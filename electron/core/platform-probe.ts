import { net, session } from "electron";
import { randomUUID } from "node:crypto";
import { classifyPlatform } from "./platforms";
import { runProbe } from "./probe";
import { normalizeProxy, normalizeTarget } from "./validation";
import type { AIPlatform, Evidence, PlatformProgress, Session } from "../../src/shared/types";

export async function probePlatform(platform: AIPlatform, parent: AbortSignal, onProgress: (value: PlatformProgress) => void = () => {}) {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  parent.addEventListener("abort", cancel, { once: true });
  if (parent.aborted) abort.abort();
  const timeout = setTimeout(cancel, 18000);
  const evidence: Evidence[] = [];
  let route = "系统网络（自动代理）";
  const started = Date.now();
  let progressCompleted = 0;
  const progress = (completed: number, label: string) => {
    progressCompleted = Math.max(progressCompleted, completed);
    onProgress({ label, completed: progressCompleted, total: 5, startedAt: started });
  };
  try {
    // Chromium applies system proxy/PAC and OS certificate handling. Never reuse app credentials.
    progress(0, "正在检查系统网络路径");
    try {
      const response = await net.fetch(platform.url, {
        method: "HEAD",
        credentials: "omit",
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(8000)]),
        headers: { "User-Agent": "NetworkLens/0.2 NetworkCheck" },
      });
      const status = response.status;
      evidence.push({
        id: `E-${randomUUID().slice(0, 8)}`,
        time: Date.now(),
        stage: "http",
        route: "system",
        status: "success",
        httpStatus: status,
        title: "平台入口已响应",
        detail: `HEAD ${platform.url} → HTTP ${status}；使用系统网络配置；不发送 Cookie 或授权头，不跟随重定向，不读取响应正文。`,
        duration: Date.now() - started,
        executor: "diagnostic_probe",
        source: "Chromium · system network",
      });
      await response.body?.cancel();
      progress(5, `系统路径收到 HTTP ${status}`);
      return classifyPlatform(platform.id, evidence, route, status);
    } catch (error) {
      if (parent.aborted) throw error;
      const message = String((error as Error).message);
      const code =
        message.match(/ERR_[A-Z_]+/)?.[0] ||
        (abort.signal.aborted || /timed?\s*out|timeout/i.test(message)
          ? "ERR_TIMED_OUT"
          : "ERR_FAILED");
      evidence.push({
        id: `E-${randomUUID().slice(0, 8)}`,
        time: Date.now(),
        stage: "http",
        route: "system",
        status: "failed",
        code,
        title: "系统网络入口检查未完成",
        detail: message,
        duration: Date.now() - started,
        executor: "diagnostic_probe",
        source: "Chromium · system network",
      });
    }
    // A separate short fallback enriches explanation; it never silently replaces the system path result.
    if (!abort.signal.aborted) {
      progress(1, "系统路径无 HTTP 响应，正在检查补充路径");
      let proxy: string | undefined;
      try {
        const resolved = await Promise.race([
          session.defaultSession.resolveProxy(platform.url),
          new Promise<string>((resolve) =>
            setTimeout(() => resolve("UNKNOWN"), 1000),
          ),
        ]);
        const first = resolved.split(";")[0].trim();
        const match = first.match(/^(PROXY|SOCKS5)\s+(.+)$/i);
        if (match) {
          proxy = normalizeProxy(
            `${match[1].toUpperCase() === "PROXY" ? "http" : "socks5"}://${match[2]}`,
          );
          route = "系统网络（检测到代理）";
        } else if (first === "DIRECT") route = "系统网络（直连）";
      } catch {
        /* Primary request already attempted the actual system path. */
      }
      const target = normalizeTarget(platform.url);
      const probeSession = { ...target, proxy } as Session;
      await runProbe(probeSession, abort.signal, (e) => {
        evidence.push(e);
        const completed = e.stage === "dns" ? 2 : e.stage === "tcp" ? 3 : e.stage === "proxy" || e.stage === "tls" ? 4 : e.stage === "http" ? 5 : 1;
        progress(completed, `${e.route === "direct" ? "直连" : "代理路径"} · ${e.stage.toUpperCase()} ${e.status === "success" ? "已完成" : e.status === "failed" ? "失败" : "未执行"}`);
      });
    }
    return classifyPlatform(platform.id, evidence, route);
  } finally {
    clearTimeout(timeout);
    parent.removeEventListener("abort", cancel);
  }
}
