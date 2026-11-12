import { ALL_ENDPOINTS } from "./providers";
import { TRIAGE_TARGETS } from "./triage";

// Component kinds decide which proxy configuration scope actually applies to a
// product. They classify configuration behavior, not provider choice:
// - desktop-host: Electron/Chromium host follows the system proxy and the OS
//   certificate trust store.
// - cli-agent: the process reads proxy environment variables (HTTPS_PROXY,
//   ALL_PROXY, …) at start; the system proxy setting may not apply at all.
export type ToolNetworkKind = "desktop-host" | "cli-agent";

export interface ToolNetworkProfile {
  kinds: readonly ToolNetworkKind[];
  // Public entrance reference inside TRIAGE_TARGETS. Absent means the product
  // has no reviewed public entrance; never fall back to a guess.
  triageTarget?: string;
  // Official API endpoint suggestions. Empty means the product is
  // multi-provider and its real endpoint must not be inferred.
  endpointIds: readonly string[];
}

// Suggestions only: never infer the tool's actual configuration or start a probe.
export const TOOL_NETWORK_PROFILES: Record<string, ToolNetworkProfile> = {
  codex: { kinds: ["desktop-host", "cli-agent"], triageTarget: "codex", endpointIds: ["openai-api"] },
  chatgpt: { kinds: ["desktop-host"], triageTarget: "chatgpt", endpointIds: ["openai-api"] },
  cursor: { kinds: ["desktop-host"], triageTarget: "cursor", endpointIds: [] },
  "claude-code": { kinds: ["cli-agent"], triageTarget: "claude", endpointIds: ["anthropic-api"] },
  "claude-desktop": { kinds: ["desktop-host"], triageTarget: "claude", endpointIds: ["anthropic-api"] },
  vscode: { kinds: ["desktop-host"], endpointIds: [] },
  opencode: { kinds: ["desktop-host", "cli-agent"], endpointIds: [] },
  workbuddy: { kinds: ["desktop-host"], endpointIds: [] },
  zcode: { kinds: ["desktop-host", "cli-agent"], endpointIds: [] },
  wiscode: { kinds: ["desktop-host"], endpointIds: [] },
  "dsh-desktop": { kinds: ["desktop-host"], triageTarget: "deepseek", endpointIds: ["deepseek-api"] },
  "deepseek-harness": { kinds: ["desktop-host"], triageTarget: "deepseek", endpointIds: ["deepseek-api"] },
  "cc-switch": { kinds: ["desktop-host"], endpointIds: [] },
  namiai: { kinds: ["desktop-host"], endpointIds: [] },
  windsurf: { kinds: ["desktop-host"], endpointIds: [] },
  trae: { kinds: ["desktop-host"], endpointIds: [] },
  kiro: { kinds: ["desktop-host", "cli-agent"], endpointIds: [] },
  zed: { kinds: ["desktop-host"], endpointIds: [] },
  "gemini-cli": { kinds: ["cli-agent"], triageTarget: "gemini", endpointIds: ["gemini-api"] },
  "qwen-code": { kinds: ["cli-agent"], triageTarget: "qianwen", endpointIds: ["dashscope-api"] },
  openclaw: { kinds: ["cli-agent"], endpointIds: [] },
  "codebuddy-cli": { kinds: ["cli-agent"], endpointIds: [] },
};

export const TOOL_KIND_LABELS: Record<ToolNetworkKind, string> = {
  "desktop-host": "桌面宿主",
  "cli-agent": "CLI 命令行",
};

// Config-scope notes surfaced next to results. They describe where the product
// reads its proxy config from; they never claim the current config itself.
export const TOOL_KIND_NOTES: Record<ToolNetworkKind, string> = {
  "desktop-host":
    "桌面宿主通常遵循系统代理与系统证书信任库；此处结果只代表公开入口路径。",
  "cli-agent":
    "CLI 在启动时读取环境变量（如 HTTPS_PROXY、ALL_PROXY）；系统代理设置可能不生效，需在启动它的终端环境或工具自身配置中设置，并新开会话复测。",
};

export function toolNetworkProfile(productId?: string) {
  if (!productId) return undefined;
  return TOOL_NETWORK_PROFILES[productId];
}

// Public entrance reference only, never the application's configured model API.
export function suggestedTriageTarget(productId?: string) {
  const id = toolNetworkProfile(productId)?.triageTarget;
  return id && TRIAGE_TARGETS.some((target) => target.id === id) ? id : undefined;
}

// Card entrance checks run against AI_PLATFORMS scan ids, where the Codex
// product is covered by the ChatGPT public entrance.
export function suggestedPlatformId(productId?: string) {
  const id = suggestedTriageTarget(productId);
  return id === "codex" ? "chatgpt" : id;
}

// Suggestions only: never infer the tool's actual configuration or start a probe.
export function suggestedEndpoints(productId?: string) {
  const ids = toolNetworkProfile(productId)?.endpointIds || [];
  return ALL_ENDPOINTS.filter(({ endpoint }) => ids.includes(endpoint.id));
}
