import type { HandoffAttachmentScan, HandoffPackageSummary } from "./handoff-attachments";
import type { HandoffImport, HandoffOptions } from "./handoff";
import type { ContextPage, ContextExport, HistoryCoverage, HistoryKind, HistoryVerification } from "./history";

export const HANDOFF_SOURCES = ["OpenCode", "Codex", "ClaudeCode", "WorkBuddy", "ZCode", "WisCode", "DeepSeekHarness", "CopilotCode", "VSCode", "GeminiCLI", "Cursor", "Windsurf", "Trae"] as const;
export type HandoffSource = typeof HANDOFF_SOURCES[number];
export const HANDOFF_TARGETS = [...HANDOFF_SOURCES] as const;
export type HandoffTarget = typeof HANDOFF_TARGETS[number];
export const handoffToolLabel = (tool: HandoffTarget) => ({ ClaudeCode: "Claude Code", DeepSeekHarness: "DeepSeek Harness", CopilotCode: "极库 Copilot Code", VSCode: "VS Code / Copilot", GeminiCLI: "Gemini CLI" } as Partial<Record<HandoffTarget, string>>)[tool] || tool;
export interface HandoffTool {
  id: HandoffTarget;
  name: string;
  installed: boolean;
  historyFound: boolean;
  readable: boolean;
  detail: string;
}
export interface SourceTask { id: string; title: string; directory: string; updated: number; projectId?: string; kind?: HistoryKind; nativeId?: string; instance?: string; parentId?: string; available?: boolean }
export interface SourceProject { id: string; name: string; directories: string[]; registered: boolean; count?: number; nativeIds?: string[]; instance?: string }
export interface SourceTaskQuery { projectId?: string; cursor?: string; search?: string; kind?: HistoryKind }
export interface SourceTaskPage {
  tasks: SourceTask[];
  projects: SourceProject[];
  nextCursor?: string;
  total?: number;
  origin: "codex-app-server" | "codex-local-index" | "codex-rollout" | "native" | "history-index";
  warnings: string[];
  coverage?: HistoryCoverage;
}
export interface HandoffPreview { token: string; content: string; expires: number; attachments?: HandoffPackageSummary; exportedPath?: string }
export interface HandoffExportResult { path: string; preview: HandoffPreview }
export interface HandoffAPI {
  discoverHandoffTools(): Promise<HandoffTool[]>;
  listSourceTasks(source?: HandoffSource): Promise<SourceTask[]>;
  browseSourceTasks(source?: HandoffSource, query?: SourceTaskQuery): Promise<SourceTaskPage>;
  importSourceTask(id: string, source?: HandoffSource): Promise<HandoffImport>;
  chooseHandoffFile(): Promise<HandoffImport | undefined>;
  previewHandoff(goal: string, target: HandoffTarget, options?: HandoffOptions): Promise<HandoffPreview>;
  scanHandoffAttachments(session: string): Promise<HandoffAttachmentScan>;
  addHandoffAttachments(session: string): Promise<HandoffAttachmentScan | undefined>;
  exportHandoffPackage(token: string): Promise<HandoffExportResult | undefined>;
  copyHandoff(token: string): Promise<void>;
  readHandoffContext?(id: string, offset?: number): Promise<ContextPage>;
  exportHandoffContext?(id: string): Promise<ContextExport | undefined>;
  verifyHandoffHistory?(source: HandoffSource): Promise<HistoryVerification>;
  cancelHandoffVerification?(): Promise<void>;
  getHandoffVerification?(): Promise<HistoryVerification | undefined>;
  addHandoffSourceDirectory?(source: HandoffSource): Promise<SourceTaskPage | undefined>;
}
