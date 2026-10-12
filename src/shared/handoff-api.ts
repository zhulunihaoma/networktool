import type { HandoffImport } from "./handoff";

export type HandoffTarget = "WisCode" | "OpenCode" | "Codex" | "WorkBuddy";
export type HandoffSource = "OpenCode" | "Codex";
export interface SourceTask { id: string; title: string; directory: string; updated: number }
export interface HandoffPreview { token: string; content: string; expires: number }
export interface HandoffAPI {
  listSourceTasks(source?: HandoffSource): Promise<SourceTask[]>;
  importSourceTask(id: string, source?: HandoffSource): Promise<HandoffImport>;
  chooseHandoffFile(): Promise<HandoffImport | undefined>;
  previewHandoff(goal: string, target: HandoffTarget): Promise<HandoffPreview>;
  copyHandoff(token: string): Promise<void>;
}
