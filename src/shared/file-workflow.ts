import type { FileDecision, FileOperation, FilePolicy } from "./assistant";
export type FileDraft = Omit<FilePolicy, "revision" | "activeRevision">;
export interface FileTrial {
  id: string;
  scopeId: string;
  resourceId: string;
  identity: string;
  expectedRevision: number;
  expiresAt: number;
  draft: FileDraft;
  checks: {
    operation: FileOperation;
    before: FileDecision;
    after: FileDecision;
  }[];
}
export interface FileTask {
  id: string;
  scopeId: string;
  resourceId: string;
  kind: "preview" | "redact";
  revision: number;
  identity: string;
  policyFingerprint?: string;
  createdAt: number;
  status:
    | "awaiting_approval"
    | "denied"
    | "ready"
    | "running"
    | "completed"
    | "failed"
    | "stale";
  detail: string;
  parentId?: string;
  bytes?: number;
}
export interface FileGrant {
  id: string;
  taskId: string;
  expiresAt: number;
  status: "active" | "used" | "revoked" | "expired" | "invalid";
  reason: string;
}
export interface FileWorkflowEvent {
  id: string;
  at: number;
  kind: "discovery" | "publication" | "task" | "approval" | "rollback";
  title: string;
  detail: string;
  scopeId: string;
  resourceId?: string;
  taskId?: string;
}
export interface FileWorkflowData {
  tasks: FileTask[];
  grants: FileGrant[];
  events: FileWorkflowEvent[];
  history: {
    scopeId: string;
    resourceId: string;
    previous?: FilePolicy;
    publishedRevision: number;
  }[];
}
export interface FileWorkflowView extends FileWorkflowData {
  hook: { state: "published" | "error" | "unavailable"; detail: string };
}
export interface FileTaskResult {
  task: FileTask;
  content?: string;
  replacements?: number;
  digest?: string;
}
export interface FileWorkflowAPI {
  trialFilePolicy(
    scopeId: string,
    draft: FileDraft,
    expectedRevision: number,
  ): Promise<FileTrial>;
  publishFilePolicy(
    trialId: string,
  ): Promise<import("./assistant").FileWorkspace>;
  rollbackFilePolicy(
    scopeId: string,
    resourceId: string,
    expectedRevision: number,
  ): Promise<import("./assistant").FileWorkspace>;
  reconfirmFileCandidate(
    scopeId: string,
    resourceId: string,
  ): Promise<import("./assistant").FileWorkspace>;
  reviewFileCandidate(
    scopeId: string,
    resourceId: string,
    deferred: boolean,
  ): Promise<import("./assistant").FileWorkspace>;
  startFileTask(
    scopeId: string,
    resourceId: string,
    kind: FileTask["kind"],
  ): Promise<FileTaskResult>;
  grantFileTask(
    taskId: string,
    reason: string,
  ): Promise<import("./assistant").FileWorkspace>;
  runFileTask(taskId: string): Promise<FileTaskResult>;
  revokeFileGrant(
    grantId: string,
  ): Promise<import("./assistant").FileWorkspace>;
  exportFileTaskCopy(
    taskId: string,
    digest: string,
  ): Promise<{ cancelled: boolean; path?: string }>;
  retryFileDeployment(): Promise<import("./assistant").FileWorkspace>;
}
export const FILE_OPERATIONS: FileOperation[] = [
  "read",
  "write",
  "delete",
  "disclose",
];
export const fileDecision = (
  policy: FilePolicy | FileDraft | undefined,
  op: FileOperation,
): FileDecision => (policy?.enabled ? policy[op] || "deny" : "ask");
