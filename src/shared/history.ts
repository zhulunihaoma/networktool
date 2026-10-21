import type { HandoffSource, SourceProject, SourceTask } from "./handoff-api";

export type HistoryKind =
  | "conversation"
  | "archived"
  | "subagent"
  | "automation"
  | "draft"
  | "deleted"
  | "orphan";
export type HistoryState =
  "complete" | "partial" | "unavailable" | "not-checked";
export interface HistoryCoverage {
  indexedAt: number;
  projects: HistoryState;
  sessions: HistoryState;
  context: HistoryState;
  attachments: HistoryState;
  sourceRecords: number;
  indexedRecords: number;
  gaps: string[];
}
export interface ContextArchive {
  id: string;
  bytes: number;
  records: number;
  sha256: string;
  complete: boolean;
  warnings: string[];
  attachmentsComplete?: boolean;
  attachmentCount?: number;
  missingAttachments?: number;
}
export interface ContextPage {
  text: string;
  offset: number;
  nextOffset?: number;
  bytes: number;
}
export interface ContextExport {
  path: string;
  bytes: number;
  sha256: string;
  warnings: string[];
}
export interface HistoryVerification {
  source: HandoffSource;
  checked: number;
  total: number;
  bytes: number;
  complete: boolean;
  failures: { id: string; reason: string }[];
  coverage?: HistoryCoverage;
}
export interface HistoryRecord extends SourceTask {
  nativeId: string;
  instance: string;
  kind: HistoryKind;
  parentId?: string;
  available: boolean;
  locator: HistoryLocator;
}
export interface HistoryLocator {
  files?: { path: string; root: string; format?: "zstd" | "raw" }[];
  database?: string;
  table?: string;
  idColumn?: string;
  historyDatabase?: string;
  related?: string[];
  engine?: string;
  recordKey?: string;
  paginated?: boolean;
  metadataDatabase?: string;
  metadataId?: string;
  metadataTables?: string[];
  metadata?: Record<string, unknown>;
}
export interface HistoryScan {
  tasks: HistoryRecord[];
  projects: SourceProject[];
  coverage: HistoryCoverage;
}
