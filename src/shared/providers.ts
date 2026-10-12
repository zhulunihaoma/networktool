import type {
  ModelProvider,
  ProviderEndpoint,
  ProviderResult,
  ProviderScan,
  PlatformPath,
} from "./types";

// Model API endpoints, not website entrances. Anonymous probe behavior verified 2026-10-04.
// Every endpoint must cite an official documentation source; never infer provider from a remote IP.
export const MODEL_PROVIDERS: ModelProvider[] = [
  {
    id: "openai",
    name: "OpenAI",
    region: "海外",
    initials: "O",
    color: "#159780",
    statusPage: "https://status.openai.com",
    endpoints: [
      {
        id: "openai-api",
        url: "https://api.openai.com",
        kind: "provider_api",
        probePath: "/v1/models",
        expectAnon: [401],
        source: "https://platform.openai.com/docs/api-reference",
      },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    region: "海外",
    initials: "A",
    color: "#c78059",
    statusPage: "https://status.anthropic.com",
    endpoints: [
      {
        id: "anthropic-api",
        url: "https://api.anthropic.com",
        kind: "provider_api",
        probePath: "/v1/models",
        expectAnon: [401],
        source: "https://docs.anthropic.com/en/api",
      },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    region: "国内",
    initials: "D",
    color: "#4d6bfe",
    endpoints: [
      {
        id: "deepseek-api",
        url: "https://api.deepseek.com",
        kind: "provider_api",
        probePath: "/v1/models",
        expectAnon: [401],
        source: "https://api-docs.deepseek.com/",
      },
    ],
  },
  {
    id: "moonshot",
    name: "Moonshot",
    region: "国内",
    initials: "M",
    color: "#242735",
    endpoints: [
      {
        id: "moonshot-api",
        url: "https://api.moonshot.cn",
        kind: "provider_api",
        probePath: "/v1/models",
        expectAnon: [401],
        source: "https://platform.moonshot.cn/docs",
      },
    ],
  },
  {
    id: "volcengine-ark",
    name: "火山方舟",
    region: "国内",
    initials: "火",
    color: "#d74a50",
    endpoints: [
      {
        id: "ark-api",
        url: "https://ark.cn-beijing.volces.com",
        kind: "provider_api",
        probePath: "/api/v3/models",
        expectAnon: [401],
        source: "https://www.volcengine.com/docs/82379",
      },
    ],
  },
  {
    id: "alibaba-dashscope",
    name: "阿里百炼",
    region: "国内",
    initials: "百",
    color: "#7658d6",
    endpoints: [
      {
        id: "dashscope-api",
        url: "https://dashscope.aliyuncs.com",
        kind: "provider_api",
        probePath: "/compatible-mode/v1/models",
        expectAnon: [401],
        source: "https://help.aliyun.com/zh/model-studio/",
      },
    ],
  },
  {
    id: "zhipu",
    name: "智谱",
    region: "国内",
    initials: "智",
    color: "#3370ff",
    endpoints: [
      {
        id: "bigmodel-api",
        url: "https://open.bigmodel.cn",
        kind: "provider_api",
        probePath: "/api/paas/v4/models",
        expectAnon: [401],
        source: "https://docs.bigmodel.cn/",
      },
    ],
  },
  {
    id: "google",
    name: "Google",
    region: "海外",
    initials: "G",
    color: "#5187e7",
    endpoints: [
      {
        id: "gemini-api",
        url: "https://generativelanguage.googleapis.com",
        kind: "provider_api",
        probePath: "/v1beta/models",
        expectAnon: [400, 401],
        source: "https://ai.google.dev/gemini-api/docs",
      },
    ],
  },
  {
    id: "xai",
    name: "xAI",
    region: "海外",
    initials: "X",
    color: "#353944",
    endpoints: [
      {
        id: "xai-api",
        url: "https://api.x.ai",
        kind: "provider_api",
        probePath: "/v1/models",
        expectAnon: [401],
        source: "https://docs.x.ai/docs",
      },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    region: "海外",
    initials: "OR",
    color: "#268b95",
    endpoints: [
      {
        id: "openrouter-api",
        url: "https://openrouter.ai",
        kind: "aggregator",
        probePath: "/api/v1/models",
        expectAnon: [200],
        source: "https://openrouter.ai/docs",
      },
    ],
  },
];

export const ALL_ENDPOINTS: {
  provider: ModelProvider;
  endpoint: ProviderEndpoint;
}[] = MODEL_PROVIDERS.flatMap((provider) =>
  provider.endpoints.map((endpoint) => ({ provider, endpoint })),
);

export const PROVIDER_KIND_LABELS = {
  provider_api: "官方 API",
  tool_backend: "工具后端",
  aggregator: "聚合中转",
} as const;

export function providerConnectionView(result?: ProviderResult): {
  label: string;
  tone: "green" | "amber" | "red" | "blue" | "muted";
  summary: string;
  pathNote?: string;
} {
  if (!result || result.status === "pending")
    return {
      label: "尚未检测",
      tone: "muted",
      summary: "点击单独测试，检查能否连到服务。",
    };
  if (result.status === "checking")
    return {
      label: "正在检测",
      tone: "blue",
      summary: "正在尝试网络路径，请等待最终结果。",
    };
  if (result.status === "cancelled")
    return {
      label: "检测已停止",
      tone: "muted",
      summary: "本次没有完整结论，可重新检测。",
    };
  if (result.status === "check_failed")
    return {
      label: "暂无法判断",
      tone: "muted",
      summary: "检测未完成，不能判断是否连通，请重新检测。",
    };

  const paths = result.paths || [];
  const responding = paths.filter(
    (path) =>
      path.httpStatus !== undefined &&
      path.httpStatus >= 200 &&
      path.httpStatus <= 599,
  );
  const direct = responding.some((path) => path.label.startsWith("直连"));
  const proxy = responding.some((path) => path.label === "代理路径");
  const proxyOnly = proxy && !direct;
  const connected = [
    "reachable",
    "auth_required",
    "restricted",
    "busy",
  ].includes(result.status);
  const pathNote =
    connected &&
    paths.some(
      (path) =>
        path.status === "unreachable" || path.status === "network_reachable",
    )
      ? "另有路径未通过，当前仍有可连通路径；差异见网络详情。"
      : undefined;
  const routeSummary = proxyOnly
    ? "可通过代理连到服务；原工具也需使用该代理。"
    : direct && proxy
      ? "直连和代理均已连到服务。"
      : direct
        ? "已通过直连连到服务。"
        : "已收到服务响应。";
  if (connected) {
    if (result.status === "restricted")
      return {
        label: proxyOnly ? "代理已连通 · 访问受限" : "已连通 · 访问受限",
        tone: "amber",
        summary: `${routeSummary}服务拒绝了本次访问，请核对访问限制。`,
        pathNote,
      };
    if (result.status === "busy")
      return {
        label: proxyOnly ? "代理已连通 · 服务异常" : "已连通 · 服务异常",
        tone: "amber",
        summary: `${routeSummary}${result.httpStatus === 429 ? "服务限制请求频率，请稍后重试。" : "服务返回异常响应，请稍后重试。"}`,
        pathNote,
      };
    return {
      label: proxyOnly ? "代理可连通" : "网络已连通",
      tone: "green",
      summary: `${routeSummary}${result.httpStatus === 401 ? "检查未携带密钥，服务要求认证。" : "密钥、权限和模型调用需在原工具中确认。"}`,
      pathNote,
    };
  }
  if (
    paths.some((path) => path.status === "network_reachable") ||
    result.evidence.some((e) => e.stage === "tls" && e.status === "success")
  )
    return {
      label: "已建连 · 响应未确认",
      tone: "amber",
      summary: "安全连接已建立，但没有收到有效服务响应，需重新检测。",
    };
  return {
    label: "本次未连通",
    tone: "red",
    summary: "本次未能连到服务，请重新检测或查看网络详情排查原因。",
  };
}

export function providerPathText(path: PlatformPath): string {
  if (path.status === "accessible")
    return path.httpStatus === 401
      ? "已连到服务 · 服务要求认证（HTTP 401）"
      : `已连到服务 · 收到 HTTP ${path.httpStatus}`;
  if (path.status === "restricted")
    return `已连到服务 · 访问被拒绝（HTTP ${path.httpStatus}）`;
  if (path.status === "network_reachable")
    return `安全连接已建立 · 未收到有效服务响应${path.code ? `（${path.code}）` : ""}`;
  if (path.status === "not_run") return "未执行，不据此判断通断";
  const reason =
    path.code === "ECONNRESET"
      ? "连接被提前关闭或重置"
      : /TIMEDOUT|TIMED_OUT/.test(path.code || "")
        ? "连接超时"
        : "连接尝试未成功";
  return `此路径未连通 · ${reason}${path.code ? `（${path.code}）` : ""}`;
}

export function providerHelpText(scan: ProviderScan, result: ProviderResult) {
  const provider = MODEL_PROVIDERS.find((p) => p.id === result.providerId);
  const endpoint = provider?.endpoints.find((e) => e.id === result.endpointId);
  return [
    `模型服务连通性检查：${provider?.name || result.providerId}`,
    `端点：${result.effectiveUrl}（${endpoint ? PROVIDER_KIND_LABELS[endpoint.kind] : "未知类型"}）`,
    `检查时间：${result.checkedAt ? new Date(result.checkedAt).toISOString() : "尚未完成"}`,
    `结果：${providerConnectionView(result).label}`,
    `说明：${result.summary}`,
    `网络路径：${result.route}`,
    ...(result.paths || []).map(
      (p) =>
        `路径结果：${p.label} · ${p.status === "accessible" ? `收到 HTTP ${p.httpStatus}，网络可达` : p.status === "restricted" ? `收到 HTTP ${p.httpStatus}，平台拒绝访问` : p.status === "network_reachable" ? "TLS 安全连接已建立，但没有 HTTP 响应" : p.status === "unreachable" ? `连接失败${p.code ? ` (${p.code})` : ""}` : "未执行"}`,
    ),
    `建议：${result.suggestion}`,
    ...result.evidence.map(
      (e) =>
        `${e.route === "direct" ? "直连" : "代理路径"} · ${e.stage}: ${e.status}${e.code ? ` (${e.code})` : ""}${e.httpStatus ? ` HTTP ${e.httpStatus}` : ""}`,
    ),
    "范围：无凭据探测只证明网络路径；未验证账号、密钥、对话生成或工具功能恢复。",
    scan.endpointIds && scan.endpointIds.length > 1
      ? `本次共检查 ${scan.endpointIds.length} 个端点。`
      : "本次仅检查该端点。",
  ].join("\n");
}
