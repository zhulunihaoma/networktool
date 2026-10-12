import { ALL_ENDPOINTS } from "./providers";
import { TRIAGE_TARGETS } from "./triage";

// Public entrance reference only, never the application's configured model API.
export function suggestedTriageTarget(productId?: string) {
  const aliases: Record<string, string> = {
    "claude-code": "claude",
    "claude-desktop": "claude",
    "deepseek-harness": "deepseek",
  };
  const id = aliases[productId || ""] || productId;
  return TRIAGE_TARGETS.some((target) => target.id === id) ? id : undefined;
}

// Suggestions only: never infer the tool's actual configuration or start a probe.
export function suggestedEndpoints(productId?: string) {
  const ids: Record<string, string[]> = {
    codex: ["openai-api"],
    chatgpt: ["openai-api"],
    "claude-code": ["anthropic-api"],
    "claude-desktop": ["anthropic-api"],
    "deepseek-harness": ["deepseek-api"],
  };
  return ALL_ENDPOINTS.filter(({ endpoint }) =>
    (ids[productId || ""] || []).includes(endpoint.id),
  );
}
