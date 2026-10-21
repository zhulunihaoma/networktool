import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverKnownTools, type DiscoveredTool } from "./tool-registry";
import { HANDOFF_SOURCES, handoffToolLabel, type HandoffTarget, type HandoffTool } from "../../src/shared/handoff-api";

export const copilotRoots = (home: string) => [
  path.join(home, ".roo-cline/globalStorage/ultra-ai.copilotcodepro/tasks"),
  path.join(home, "Library/Application Support/Code/User/globalStorage/geelib-copilot-code.copilotcodepro/tasks"),
];
const products: Record<HandoffTarget, string[]> = {
  OpenCode: ["opencode"], Codex: ["codex", "chatgpt"], ClaudeCode: ["claude-code"], WorkBuddy: ["workbuddy"],
  ZCode: ["zcode"], WisCode: ["wiscode"], DeepSeekHarness: ["deepseek-harness", "dsh-desktop"],
  CopilotCode: [], VSCode: ["vscode"], GeminiCLI: ["gemini-cli"], Cursor: ["cursor"], Windsurf: ["windsurf"], Trae: ["trae"],
};
async function exists(file: string) { try { const s = await fs.lstat(file); return !s.isSymbolicLink() && (s.isFile() || s.isDirectory()); } catch { return false; } }
async function populated(directory: string) {
  try { return (await fs.readdir(directory, { withFileTypes: true })).some(e => !e.isSymbolicLink() && !e.name.startsWith(".")); } catch { return false; }
}
export async function discoverHandoffTools(home = os.homedir(), discover: () => Promise<{ tools: DiscoveredTool[] }> = discoverKnownTools): Promise<HandoffTool[]> {
  // Reuse installation identities; no model request, application launch or credentials.
  const { tools } = await discover();
  const histories: Partial<Record<HandoffTarget, boolean>> = {
    OpenCode: await exists(path.join(home, ".local/share/opencode/opencode.db")) || await populated(path.join(home, ".local/share/opencode/storage/session")),
    Codex: await populated(path.join(home, ".codex/sessions")), ClaudeCode: await populated(path.join(home, ".claude/projects")),
    WorkBuddy: await exists(path.join(home, ".workbuddy/workbuddy.db")), ZCode: await exists(path.join(home, ".zcode/cli/db/db.sqlite")),
    WisCode: await populated(path.join(home, ".wiscode/claude-agents/projects")) || await populated(path.join(home, ".wiscode/claude/projects")) || await exists(path.join(home, ".wiscode/codex-agents/state_5.sqlite")),
    DeepSeekHarness: await populated(path.join(home, ".dsh/sessions")), CopilotCode: (await Promise.all(copilotRoots(home).map(populated))).some(Boolean),
    GeminiCLI: await populated(path.join(home, ".gemini/sessions")) || await populated(path.join(home, ".gemini/tmp")),
    VSCode: await populated(path.join(home, "Library/Application Support/Code/User/workspaceStorage")),
    Cursor: await exists(path.join(home, "Library/Application Support/Cursor/User/globalStorage/state.vscdb")),
    Windsurf: await populated(path.join(home, "Library/Application Support/Windsurf/User")),
    Trae: await populated(path.join(home, "Library/Application Support/Trae/User")),
  };
  const out: HandoffTool[] = [];
  for (const id of Object.keys(products) as HandoffTarget[]) {
    const installed = tools.some(t => products[id].includes(t.productId) && t.confirmed) || id === "CopilotCode" && tools.some(t => t.extensions?.some(e => e.extensionId === "geelib-copilot-code.copilotcodepro"));
    const historyFound = !!histories[id];
    const configured = id === "GeminiCLI" && await exists(path.join(home, ".gemini"));
    if (!installed && !historyFound && !configured && !["OpenCode", "Codex", "ClaudeCode"].includes(id)) continue;
    const readable = (HANDOFF_SOURCES as readonly string[]).includes(id);
    out.push({ id, name: handoffToolLabel(id), installed, historyFound, readable,
      detail: !readable ? installed || historyFound ? "暂不支持读取此工具的原生聊天，可作为粘贴接力的目标。" : "仅发现配置，未确认安装或可读取的聊天。" : historyFound ? "已发现本地会话；选定后只读获取正文。" : installed ? "已安装，尚未发现本地会话；使用后可刷新。" : "尚未发现安装或会话记录。" });
  }
  return out;
}
