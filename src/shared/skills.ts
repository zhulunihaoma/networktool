import type { SkillRiskReport } from "./security-scan";

export interface SkillItem {
  id: string;
  name: string;
  description: string;
  features: string[];
  source: string;
  scope: string;
  path: string;
  warnings: string[];
  kind?: "skill" | "broken-link" | "linked-skill" | "empty-directory" | "unreadable-skill";
  linkTarget?: string;
  cleanup?: SkillCleanupAdvice;
  usage?: SkillUsage;
  insight?: SkillInsight;
}
export interface SkillInsight {
  identity?: string;
  realPath?: string;
  dependencies?: string[];
  hash?: string;
  checkError?: string;
  risk?: SkillRiskReport;
  riskError?: string;
  checkedAt: string;
  change: "new" | "changed" | "unchanged";
  firstSeenAt: string;
  changedAt: string;
  preserved: boolean;
  riskIgnored: boolean;
  mcp: { file: string; report: import("./security").McpCheckReport }[];
}
export interface SkillDuplicateGroup {
  id: string;
  name: string;
  itemIds: string[];
  kind: "same-location" | "identical" | "different";
}
export interface SkillComparison {
  left: string;
  right: string;
  files: { path: string; status: "added" | "removed" | "changed"; left?: string; right?: string; note?: string }[];
  truncated: boolean;
}
export interface SkillUsage {
  status: "observed-read" | "unknown";
  lastObservedAt?: string;
  evidence: string;
  confirmed?: boolean;
  sessions30?: number;
  eligibleSessions30?: number;
  observationDays?: number;
  coverage?: "recorded" | "partial" | "unsupported";
  recommendation?: "observe" | "low" | "consider" | "cleanup" | "protected";
  reasons?: string[];
}
export interface SkillCleanupAdvice {
  level: "cleanup" | "consider" | "repair" | "keep" | "unknown";
  title: string;
  reasons: string[];
  impact: string[];
  deletable: boolean;
}
export interface SkillTrashEntry {
  id: string;
  name: string;
  originalPath: string;
  deletedAt: string;
  source: string;
  kind: "directory" | "link";
  /** 由“整理建议”从工具管理目录移出；恢复时允许写回该目录 */
  protectedRoot?: boolean;
}
/** 整理建议的场景类型 */
export type SkillTidyKind = "wiscode-shadow" | "nested-duplicate" | "legacy-codex" | "version-drift" | "managed";
export interface SkillTidyVersion {
  path: string;
  source: string;
  digest?: string;
  modifiedAt?: string;
  files?: number;
  bytes?: number;
  newest?: boolean;
}
export interface SkillTidyAction {
  id: string;
  kind: SkillTidyKind;
  name: string;
  /** 会被移动、或需要更新的路径 */
  path: string;
  /** trash=移入可恢复回收区；move=移动到 destination；sync=用 sourceItemId 经复制流程更新；none=仅说明 */
  operation: "trash" | "move" | "sync" | "none";
  destination?: string;
  /** 处理后继续生效的路径 */
  keep?: string;
  /** 与保留版本的文件内容是否一致（忽略权限位）；undefined 表示无可比对象 */
  contentMatches?: boolean;
  status: "ready" | "blocked";
  reason?: string;
  evidence: string[];
  warnings: string[];
  versions?: SkillTidyVersion[];
  /** sync：作为来源的最新版本扫描项 id，与目标工具 id */
  sourceItemId?: string;
  targetId?: string;
}
export interface SkillTidyScenario {
  kind: SkillTidyKind;
  title: string;
  summary: string;
  impact: string[];
  actions: SkillTidyAction[];
}
export interface SkillMoveRecord {
  id: string;
  name: string;
  from: string;
  to: string;
  movedAt: string;
}
export interface SkillTidyReport {
  token: string;
  checkedAt: string;
  scenarios: SkillTidyScenario[];
  moves: SkillMoveRecord[];
  notes: string[];
}
export interface SkillTidyResult {
  id: string;
  name: string;
  kind: SkillTidyKind;
  path: string;
  destination?: string;
  status: "done" | "skipped" | "failed";
  message: string;
  trashId?: string;
  moveId?: string;
}
export interface SkillScan {
  items: SkillItem[];
  trash: SkillTrashEntry[];
  trashError?: string;
  groups?: SkillDuplicateGroup[];
  checkedAt?: string;
  catalogError?: string;
  roots: { path: string; source: string; status: "scanned" | "missing" | "error"; message?: string }[];
  targets: {
    id: string; label: string; path: string; installed: boolean;
    directoryExists?: boolean;
    copySupported?: boolean;
    blockedReason?: string;
    activationHint?: string;
    directorySource?: { label: string; url: string };
    directoryCheckedAt?: string;
  }[];
}
export interface SkillDeletePreview {
  token: string;
  retained?: { id: string; name: string; path: string };
  items: {
    id: string;
    name: string;
    path: string;
    status: "ready" | "blocked";
    reason?: string;
    cleanup: SkillCleanupAdvice;
    usage: SkillUsage;
  }[];
}
export interface SkillDeleteResult {
  id: string;
  name: string;
  status: "trashed" | "skipped" | "failed";
  message: string;
  trashId?: string;
  originalPath?: string;
}
export interface SkillCheck {
  label: string;
  state: "passed" | "warning" | "failed" | "unverified";
  detail: string;
}
export interface SkillVerification {
  checkedAt: string;
  rulesDate: string;
  ruleSource?: { label: string; url: string };
  sourceHash?: string;
  expectedHash?: string;
  destinationHash?: string;
  checks: SkillCheck[];
}
export interface SkillCopyResult {
  name: string;
  status: "copied" | "skipped" | "failed";
  message: string;
  destination?: string;
  backup?: string;
  activationHint?: string;
  verification?: SkillVerification;
}
export interface SkillCopyPreview {
  token: string;
  target: string;
  path: string;
  items: {
    id: string;
    name: string;
    status: "ready" | "update" | "convert" | "blocked" | "skipped";
    changes: string[];
    warnings: string[];
    reason?: string;
    verification?: SkillVerification;
    /** 安装前安全检查结果；缺失表示未完成检查（旧主进程或读取失败） */
    risk?: SkillRiskReport;
    /** 该项存在高风险，复制时必须显式确认 */
    riskAckRequired?: boolean;
  }[];
  /** 整批最高风险等级，便于界面一眼给出结论 */
  riskLevel?: "high" | "medium" | "low" | "none";
  /** 本批次需要用户勾选确认的 Skill 数量 */
  riskAckCount?: number;
}
