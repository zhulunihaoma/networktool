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
}
export interface SkillUsage {
  status: "observed-read" | "unknown";
  lastObservedAt?: string;
  evidence: string;
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
}
export interface SkillScan {
  items: SkillItem[];
  trash: SkillTrashEntry[];
  trashError?: string;
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
  items: { id: string; name: string; status: "ready" | "update" | "convert" | "blocked" | "skipped"; changes: string[]; warnings: string[]; reason?: string; verification?: SkillVerification }[];
}
