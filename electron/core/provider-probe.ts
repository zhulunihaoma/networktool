import { session } from "electron";
import { randomUUID } from "node:crypto";
import { runProbe } from "./probe";
import { normalizeProxy, normalizeTarget } from "./validation";
import type {
  Evidence,
  ModelProvider,
  PlatformPath,
  PlatformProgress,
  ProviderEndpoint,
  ProviderResult,
  Session,
} from "../../src/shared/types";

// Layered probe against a model API endpoint. Anonymous requests only: the goal is the
// network path, never account or key validation. 401 in expectAnon is a healthy signal here.
export function classifyProvider(
  provider: ModelProvider,
  endpoint: ProviderEndpoint,
  evidence: Evidence[],
  route: string,
): ProviderResult {
  const groups = new Map<string, Evidence[]>();
  for (const e of evidence.filter((e) =>
    ["tcp", "proxy", "tls", "http"].includes(e.stage),
  )) {
    const label =
      e.route === "direct"
        ? `直连${e.family === 4 ? "（IPv4）" : e.family === 6 ? "（IPv6）" : ""}`
        : "代理路径";
    groups.set(label, [...(groups.get(label) || []), e]);
  }
  const paths: PlatformPath[] = [];
  const valid = (n?: number) => n !== undefined && n >= 200 && n <= 599;
  const pathStatus = (n: number) =>
    !endpoint.expectAnon.includes(n) && (n === 403 || n === 451)
      ? ("restricted" as const)
      : ("accessible" as const);
  for (const [label, items] of groups) {
    const replies = items.filter(
      (e) => e.stage === "http" && e.status === "success" && valid(e.httpStatus),
    );
    const reply =
      replies.find((e) => endpoint.expectAnon.includes(e.httpStatus!)) ||
      replies[0];
    const failure = items.find((e) => e.status === "failed");
    const tlsConnected = items.some(
      (e) => e.stage === "tls" && e.status === "success",
    );
    paths.push({
      label,
      status: reply
        ? pathStatus(reply.httpStatus!)
        : tlsConnected
          ? "network_reachable"
          : failure
            ? "unreachable"
            : "not_run",
      httpStatus: reply?.httpStatus,
      code: failure?.code,
    });
  }
  const result: ProviderResult = {
    providerId: provider.id,
    endpointId: endpoint.id,
    status: "check_failed",
    effectiveUrl: endpoint.url,
    urlSource: "default",
    summary: "检测未完成：未能确定能否连接",
    suggestion: "请重新测试；此次检测执行没有完成，不能据此判断网络可达或不可达。",
    route,
    evidence,
    checkedAt: Date.now(),
    paths,
    progress: { label: "结果已生成", completed: 5, total: 5 },
  };
  const applyHttp = (n: number, pathLabel?: string) => {
    result.httpStatus = n;
    const prefix = pathLabel ? `${pathLabel}` : "";
    if (n >= 200 && n < 400) {
      result.status = "reachable";
      result.summary = `${prefix}端点已响应（HTTP ${n}）`;
      result.suggestion =
        "网络路径可达。可达不代表对话可用；如工具仍失败，请在工具中确认密钥与权限。";
    } else if (n === 403 || n === 451) {
      result.status = "restricted";
      result.summary = `${prefix}网络可达，但平台拒绝访问（HTTP ${n}）`;
      result.suggestion =
        "可能存在地区、企业网络或平台防护限制；请核对实际使用的网络出口，仍被拒绝时请联系 IT。";
    } else if (n === 429 || n >= 500) {
      result.status = "busy";
      result.summary =
        n === 429
          ? `${prefix}网络可达，服务限制请求频率`
          : `${prefix}网络可达，服务返回异常（HTTP ${n}）`;
      result.suggestion =
        "稍后再试，并查看官方服务状态页；这不能证明平台全球故障。";
    } else if (endpoint.expectAnon.includes(n)) {
      // 401 / 405 / 404 / 400 in expectAnon all mean the request reached the
      // service without valid credentials; the network path is therefore OK.
      result.status = "auth_required";
      result.summary = `${prefix}网络与 TLS 正常，服务要求认证（HTTP ${n}）`;
      result.suggestion =
        "对 API 端点，要求认证说明网络路径可达、服务在线。不证明你的密钥有效；在工具中复测后再判断功能是否恢复。";
    } else {
      result.status = "reachable";
      result.summary = `${prefix}服务已响应，返回未登记状态 HTTP ${n}`;
      result.suggestion =
        "网络路径可达，但响应不在该端点登记的预期集合内；原始状态已保留在证据中。";
    }
  };
  // Prefer a direct-path reply; a proxy-path reply is definite for its own path only.
  const direct = paths.find(
    (p) => p.label.startsWith("直连") && valid(p.httpStatus),
  );
  const proxyPath = paths.find(
    (p) => p.label === "代理路径" && valid(p.httpStatus),
  );
  const chosen = direct || proxyPath;
  if (chosen) {
    applyHttp(chosen.httpStatus!, proxyPath && !direct ? "代理路径可连接；" : "");
    if (proxyPath && !direct) {
      const directFailure = groups.get(
        [...groups.keys()].find((k) => k.startsWith("直连")) || "",
      );
      const code = directFailure?.find((e) => e.status === "failed")?.code;
      result.summary = `代理路径可连接（HTTP ${chosen.httpStatus}）；直连${code?.includes("TIMEDOUT") || code?.includes("ETIMEDOUT") ? "超时" : "未成功"}`;
      result.suggestion =
        "当前直连没有成功，代理路径可用。请核对该工具实际使用的网络路径；两者证据都已保留。";
    }
    return result;
  }
  const failure = evidence.find((e) => e.status === "failed");
  if (!failure) return result;
  result.status = "network_error";
  const code = failure.code || "";
  if (/ENOTFOUND|ENODATA|EAI_AGAIN/.test(code)) {
    result.summary = "连接失败：无法解析端点地址";
    result.suggestion =
      "确认其他网页能否打开，再重新连接网络；请 IT 检查域名解析。";
  } else if (/CERT|SSL|UNABLE_TO|SELF_SIGNED|DEPTH_ZERO/.test(code)) {
    result.summary = "连接失败：安全连接校验失败";
    result.suggestion =
      "检查电脑时间；如需公司证书，请联系 IT，勿关闭证书验证。";
  } else if (/PROXY|SOCKS/.test(code)) {
    result.summary = "连接失败：当前代理路径不可用";
    result.suggestion =
      "确认公司批准的网络工具运行正常，再请 IT 核对代理配置。";
  } else if (/ECONNREFUSED|ECONNRESET/.test(code)) {
    result.summary = "连接失败：端点拒绝或中断了连接";
    result.suggestion =
      "该端点在当前网络下无法建立连接；请把各条路径的检查结果发给 IT。";
  } else {
    result.summary = code.includes("TIMEDOUT")
      ? "连接失败：本次连接超时"
      : "连接失败：未收到端点响应";
    result.suggestion =
      "检查网络后重新测试。如果只有该端点失败，请把各条路径的检查结果发给 IT。";
  }
  if (evidence.some((e) => e.stage === "tls" && e.status === "success"))
    result.summary = "连接失败：安全连接已建立，但端点没有有效响应";
  return result;
}

export async function probeEndpoint(
  provider: ModelProvider,
  endpoint: ProviderEndpoint,
  parent: AbortSignal,
  onProgress: (value: PlatformProgress) => void = () => {},
): Promise<ProviderResult> {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  parent.addEventListener("abort", cancel, { once: true });
  if (parent.aborted) abort.abort();
  const timeout = setTimeout(cancel, 18000);
  const evidence: Evidence[] = [];
  const started = Date.now();
  let progressCompleted = 0;
  const progress = (completed: number, label: string) => {
    progressCompleted = Math.max(progressCompleted, completed);
    onProgress({
      label,
      completed: progressCompleted,
      total: 5,
      startedAt: started,
    });
  };
  let route = "系统网络（直连）";
  try {
    progress(0, "正在解析系统网络路径");
    let proxy: string | undefined;
    try {
      const resolved = await Promise.race([
        session.defaultSession.resolveProxy(endpoint.url + endpoint.probePath),
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
      }
    } catch {
      /* Proxy detection only enriches routes; the direct path is always probed. */
    }
    const target = normalizeTarget(endpoint.url);
    const probeSession = { ...target, proxy } as Session;
    progress(1, "正在分层探测端点");
    await runProbe(
      probeSession,
      abort.signal,
      (e) => {
        evidence.push(e);
        const completed =
          e.stage === "dns"
            ? 2
            : e.stage === "tcp"
              ? 3
              : e.stage === "proxy" || e.stage === "tls"
                ? 4
                : e.stage === "http"
                  ? 5
                  : progressCompleted;
        progress(
          completed,
          `${e.route === "direct" ? "直连" : "代理路径"} · ${e.stage.toUpperCase()} ${e.status === "success" ? "已完成" : e.status === "failed" ? "失败" : "未执行"}`,
        );
      },
      {},
      { httpMethod: "GET", httpPath: endpoint.probePath },
    );
    const result = classifyProvider(provider, endpoint, evidence, route);
    result.duration = Date.now() - started;
    result.progress = { label: "测试完成", completed: 5, total: 5, startedAt: started };
    return result;
  } finally {
    clearTimeout(timeout);
    parent.removeEventListener("abort", cancel);
  }
}
