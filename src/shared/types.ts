import type { AssistantAPI as importAssistantAPI } from "./assistant";
import type { HandoffAPI } from "./handoff-api";
import type { SkillCopyResult, SkillScan, SkillCopyPreview, SkillDeletePreview, SkillDeleteResult, SkillTrashEntry } from "./skills";
import type { ToolDiagnosisReference, ToolDiagnosisContext } from "./assistant";
import type { ToolUsage } from "./tool-usage";
export type Stage =
  | "config"
  | "dns"
  | "tcp"
  | "proxy"
  | "tls"
  | "http"
  | "marker"
  | "verification";
export type ResultStatus = "success" | "failed" | "skipped" | "info";
export type SessionStatus =
  | "preparing"
  | "collecting"
  | "analyzing"
  | "completed"
  | "cancelled"
  | "interrupted"
  | "failed";
export interface ProcessInfo {
  key: string;
  pid: number;
  ppid: number;
  name: string;
  imagePath?: string;
  created: string;
  relation: "candidate" | "root";
}
export interface Flow {
  id: string;
  processKey: string;
  pid: number;
  process: string;
  local: string;
  remote: string;
  state: string;
  family: string;
  firstSeen: number;
  lastSeen: number;
  window: "baseline" | "task";
  source: string;
}
export interface Evidence {
  id: string;
  time: number;
  stage: Stage;
  route: string;
  status: ResultStatus;
  title: string;
  detail: string;
  code?: string;
  duration?: number;
  attemptId?: string;
  family?: number;
  httpStatus?: number;
  source: string;
  executor: string;
}
export interface Finding {
  id: string;
  ruleId: string;
  version: number;
  title: string;
  description: string;
  support: "limited" | "insufficient";
  evidenceIds: string[];
  missing: string[];
  nextCheck: string;
  severity: "warning" | "error" | "info";
}
export interface ConfigItem {
  name: string;
  value: string;
  source: string;
  state: "read" | "unavailable";
}
export interface Coverage {
  platform: string;
  collector: string;
  tcp: boolean;
  processes: boolean;
  limitations: string[];
  version: string;
}
export interface Session {
  toolContext?: ToolDiagnosisContext;
  id: string;
  name: string;
  target: string;
  host: string;
  port: number;
  status: SessionStatus;
  started: number;
  ended?: number;
  duration: number;
  deadline: number;
  process?: ProcessInfo;
  scope: ProcessInfo[];
  proxy?: string;
  mode: "diagnose" | "compare";
  phase: string;
  evidence: Evidence[];
  findings: Finding[];
  flows: Flow[];
  config: ConfigItem[];
  coverage: Coverage;
  baselineEnded?: number;
  markers: number[];
  dropped: number;
  verified?: "success" | "failed" | "unknown";
  error?: string;
  sequence: number;
}
export interface Settings {
  retentionDays: 1 | 7 | 30;
  redact: boolean;
}
export interface StartInput {
  tool?: ToolDiagnosisReference;
  name: string;
  target: string;
  duration: number;
  processKey?: string;
  scopeKeys: string[];
  proxy?: string;
  mode: "diagnose" | "compare";
  clientRequestId: string;
}
export interface Overview {
  coverage: Coverage;
  sessions: Session[];
  settings: Settings;
  activeId?: string;
}
export interface ExportPreview {
  digest: string;
  content: string;
  format: "md" | "json";
}
export interface DesktopAPI extends importAssistantAPI, HandoffAPI {
  skills(): Promise<SkillScan>;
  previewSkills(ids: string[], target: string): Promise<SkillCopyPreview>;
  copySkills(ids: string[], target: string, token: string, autoConvert: boolean): Promise<SkillCopyResult[]>;
  previewDeleteSkills(ids: string[]): Promise<SkillDeletePreview>;
  deleteSkills(ids: string[], token: string): Promise<SkillDeleteResult[]>;
  restoreSkill(id: string): Promise<SkillTrashEntry>;
  triage(): Promise<TriageRun>;
  startTriage(targetId: string): Promise<TriageRun>;
  stopTriage(): Promise<TriageRun>;
  triageAction(
    runId: string,
    action: TriageAction,
  ): Promise<{ message: string }>;
  observeTriage(runId: string): Promise<TriageRun>;
  markTriage(runId: string): Promise<TriageRun>;
  verifyTriage(
    runId: string,
    result: "restored" | "still_failed",
  ): Promise<TriageRun>;
  onTriage(callback: (run: TriageRun) => void): () => void;
  platforms(): Promise<PlatformScan>;
  scanPlatforms(id?: string): Promise<PlatformScan>;
  stopPlatforms(): Promise<PlatformScan>;
  copyPlatformResult(id: string): Promise<void>;
  onPlatforms(callback: (scan: PlatformScan) => void): () => void;
  providers(): Promise<ProviderScan>;
  scanProviders(id?: string): Promise<ProviderScan>;
  stopProviders(): Promise<ProviderScan>;
  copyProviderResult(id: string): Promise<void>;
  onProviders(callback: (scan: ProviderScan) => void): () => void;
  overview(): Promise<Overview>;
  processes(): Promise<ProcessInfo[]>;
  toolUsage(): Promise<ToolUsage>;
  connections(key?: string): Promise<{ flows: Flow[]; error?: string }>;
  start(input: StartInput): Promise<Session>;
  get(id: string): Promise<Session>;
  stop(id: string): Promise<Session>;
  finish(id: string): Promise<Session>;
  extend(id: string): Promise<Session>;
  mark(id: string): Promise<Session>;
  task(id: string): Promise<Session>;
  verify(
    id: string,
    result: "success" | "failed" | "unknown",
  ): Promise<Session>;
  remove(id: string): Promise<void>;
  settings(input: Settings): Promise<Settings>;
  preview(id: string, format: "md" | "json"): Promise<ExportPreview>;
  export(
    id: string,
    digest: string,
    format: "md" | "json",
  ): Promise<{ path?: string; cancelled?: boolean }>;
  onUpdate(callback: (session: Session) => void): () => void;
}
export interface AIPlatform {
  id: string;
  name: string;
  description: string;
  region: "国内" | "海外";
  category: "AI 助手" | "办公协作" | "开发工具";
  url: string;
  initials: string;
  color: string;
  processNames: string[];
  source: string;
}
export type PlatformStatus =
  | "pending"
  | "checking"
  | "reachable"
  | "auth_required"
  | "restricted"
  | "busy"
  | "network_error"
  | "check_failed"
  | "cancelled";
export interface PlatformResult {
  platformId: string;
  status: PlatformStatus;
  summary: string;
  suggestion: string;
  checkedAt?: number;
  duration?: number;
  httpStatus?: number;
  route: string;
  evidence: Evidence[];
  runningApps: string[];
  progress?: PlatformProgress;
  paths?: PlatformPath[];
}
export interface PlatformProgress {
  label: string;
  completed: number;
  total: number;
  startedAt?: number;
}
export interface PlatformPath {
  label: string;
  status:
    | "accessible"
    | "restricted"
    | "network_reachable"
    | "unreachable"
    | "not_run";
  httpStatus?: number;
  code?: string;
}
export interface ProviderEndpoint {
  id: string;
  url: string;
  kind: "provider_api" | "tool_backend" | "aggregator";
  probePath: string;
  expectAnon: number[];
  source: string;
}
export interface ModelProvider {
  id: string;
  name: string;
  region: "国内" | "海外";
  endpoints: ProviderEndpoint[];
  statusPage?: string;
  initials: string;
  color: string;
}
export interface ProviderResult {
  providerId: string;
  endpointId: string;
  status: PlatformStatus;
  effectiveUrl: string;
  urlSource: "default" | "tool_config" | "user";
  summary: string;
  suggestion: string;
  checkedAt?: number;
  duration?: number;
  httpStatus?: number;
  route: string;
  evidence: Evidence[];
  progress?: PlatformProgress;
  paths?: PlatformPath[];
}
export interface ProviderScan {
  id: string;
  status: "idle" | "running" | "completed" | "cancelled";
  results: ProviderResult[];
  started?: number;
  ended?: number;
  endpointIds?: string[];
}
export interface PlatformScan {
  id: string;
  status: "idle" | "running" | "completed" | "cancelled";
  results: PlatformResult[];
  started?: number;
  ended?: number;
  detectionError?: string;
  platformIds?: string[];
}
export type TriageAction =
  | "retry"
  | "network_settings"
  | "proxy_settings"
  | "date_settings"
  | "open_platform"
  | "service_status"
  | "reset_probe"
  | "observe"
  | "copy_report";
export type TriageStepStatus =
  | "pending"
  | "checking"
  | "pass"
  | "attention"
  | "unverified"
  | "error"
  | "skipped";
export interface TriageStep {
  id: "network" | "proxy" | "dns" | "entry" | "stability";
  title: string;
  status: TriageStepStatus;
  summary: string;
  suggestion: string;
  evidence: string[];
  actions: TriageAction[];
  support: "observed" | "limited" | "none";
}
export interface TriageObservation {
  status: "idle" | "running" | "completed" | "cancelled";
  started?: number;
  ended?: number;
  duration: number;
  samples: number;
  processCount: number;
  maxConnections: number;
  networkChanges: number;
  proxyChanges: number;
  missingProcesses: number;
  errors: number;
  markers: number[];
  events: { time: number; message: string }[];
}
export interface TriageRun {
  id: string;
  targetId: string;
  status: "idle" | "running" | "completed" | "cancelled";
  started?: number;
  ended?: number;
  steps: TriageStep[];
  priorityIds: TriageStep["id"][];
  summary: string;
  observation: TriageObservation;
  verification: "unknown" | "restored" | "still_failed";
  comparison?: string;
}
