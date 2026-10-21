export type IdentityStatus =
  | "installed_confirmed"
  | "running_confirmed"
  | "candidate"
  | "stale"
  | "absent";
export type ToolFeature = "login" | "model" | "update" | "mcp" | "other";
export const FEATURE_LABELS: Record<ToolFeature, string> = {
  login: "登录",
  model: "模型调用",
  update: "更新",
  mcp: "MCP 连接",
  other: "其他功能",
};
export interface ToolDiagnosisReference {
  installId: string;
  componentId: string;
  feature: ToolFeature;
}
export interface ToolDiagnosisContext extends ToolDiagnosisReference {
  productId: string;
  toolName: string;
  componentName: string;
  version?: string;
  runtime: "local" | "unknown";
  adapterStatus: "unknown";
  source?: string;
  identityStatus: IdentityStatus;
}
export const AGENT_EXTENSIONS: Record<string, string> = {
  "openai.chatgpt": "Codex 扩展",
  "anthropic.claude-code": "Claude Code 扩展",
  "continue.continue": "Continue",
  "github.copilot": "GitHub Copilot",
  "github.copilot-chat": "GitHub Copilot Chat",
  "saoudrizwan.claude-dev": "Cline",
  "rooveterinaryinc.roo-cline": "Roo Code",
  "kilocode.kilo-code": "Kilo Code",
  "google.geminicodeassist": "Gemini Code Assist",
  "qwenlm.qwen-code": "Qwen Code",
  "sourcegraph.cody-ai": "Cody",
  "geelib-copilot-code.copilotcodepro": "极库 Copilot Code",
};
export interface ToolComponent {
  id: string;
  name: string;
  role: "host" | "cli" | "extension";
  extensionId?: string;
  targetPlatform?: string;
  update?: ToolUpdate;
  version?: string;
  runtime: "local" | "unknown";
  adapterStatus: "unknown";
  source?: string;
  features: { name: string; status: "not_tested"; targetSource: string }[];
}
export interface ToolInstall {
  id: string;
  productId: string;
  name: string;
  location: string;
  version?: string;
  identityStatus: IdentityStatus;
  sources: string[];
  components: ToolComponent[];
  processKeys: string[];
  lastSeen: number;
  pinned: boolean;
  update?: ToolUpdate;
  channel?: string;
}
export interface ToolInventory {
  installs: ToolInstall[];
  checkedAt?: number;
  scanning: boolean;
  checkingUpdates?: boolean;
  limitations: string[];
}
export interface ToolProduct {
  id: string;
  name: string;
  apps: readonly string[];
  cli: readonly string[];
  packageName: string;
  bundleIds: readonly string[];
}
export const TOOL_PRODUCTS: readonly ToolProduct[] = [
  {
    id: "codex",
    name: "Codex",
    apps: ["Codex"],
    cli: ["codex"],
    packageName: "@openai/codex",
    bundleIds: ["com.openai.codex"],
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    apps: ["ChatGPT"],
    cli: [],
    packageName: "",
    bundleIds: ["com.openai.chat"],
  },
  {
    id: "cursor",
    name: "Cursor",
    apps: ["Cursor"],
    cli: [],
    packageName: "",
    bundleIds: ["com.todesktop.230313mzl4w4u92"],
  },
  {
    id: "claude-code",
    name: "Claude Code",
    apps: [],
    cli: ["claude"],
    packageName: "@anthropic-ai/claude-code",
    bundleIds: [],
  },
  {
    id: "claude-desktop",
    name: "Claude",
    apps: ["Claude"],
    cli: [],
    packageName: "",
    bundleIds: ["com.anthropic.claudefordesktop"],
  },
  {
    id: "vscode",
    name: "Visual Studio Code",
    apps: ["Visual Studio Code", "Code"],
    cli: [],
    packageName: "",
    bundleIds: ["com.microsoft.VSCode"],
  },
  {
    id: "opencode",
    name: "OpenCode",
    apps: ["OpenCode"],
    cli: ["opencode"],
    packageName: "opencode-ai",
    bundleIds: ["ai.opencode.desktop"],
  },
  {
    id: "workbuddy",
    name: "WorkBuddy",
    apps: ["WorkBuddy"],
    cli: [],
    packageName: "",
    bundleIds: ["com.workbuddy.workbuddy", "com.tencent.workbuddy.mac"],
  },
  {
    id: "zcode",
    name: "ZCode",
    apps: ["ZCode"],
    cli: ["zcode"],
    packageName: "",
    bundleIds: ["dev.zcode.app"],
  },
  {
    id: "wiscode",
    name: "WisCode",
    apps: ["WisCode"],
    cli: [],
    packageName: "",
    bundleIds: ["com.qihoo.coding.wiscode"],
  },
  {
    id: "dsh-desktop",
    name: "DSH Desktop",
    apps: ["DSH Desktop"],
    cli: [],
    packageName: "",
    bundleIds: ["ai.deepseek.dsh.desktop"],
  },
  {
    id: "deepseek-harness",
    name: "DeepSeek Harness",
    apps: ["DeepSeek Harness"],
    cli: [],
    packageName: "",
    bundleIds: ["com.deepseek.dsh"],
  },
  {
    id: "cc-switch",
    name: "CC Switch",
    apps: ["CC Switch"],
    cli: [],
    packageName: "",
    bundleIds: ["com.ccswitch.desktop"],
  },
  {
    id: "namiai",
    name: "纳米 AI",
    apps: ["NAMIAI", "纳米AI"],
    cli: [],
    packageName: "",
    bundleIds: ["net.qihoo.namiai"],
  },
  {
    id: "windsurf",
    name: "Windsurf",
    apps: ["Windsurf"],
    cli: [],
    packageName: "",
    bundleIds: ["com.exafunction.windsurf"],
  },
  {
    id: "trae",
    name: "Trae",
    apps: ["Trae", "Trae CN"],
    cli: [],
    packageName: "",
    bundleIds: ["com.trae.app", "com.trae.app.cn"],
  },
  {
    id: "kiro",
    name: "Kiro",
    apps: ["Kiro"],
    cli: ["kiro-cli"],
    packageName: "",
    bundleIds: ["dev.kiro.desktop"],
  },
  {
    id: "zed",
    name: "Zed",
    apps: ["Zed"],
    cli: [],
    packageName: "",
    bundleIds: ["dev.zed.Zed"],
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    apps: [],
    cli: ["gemini"],
    packageName: "@google/gemini-cli",
    bundleIds: [],
  },
  {
    id: "qwen-code",
    name: "Qwen Code",
    apps: [],
    cli: ["qwen"],
    packageName: "@qwen-code/qwen-code",
    bundleIds: [],
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    apps: [],
    cli: ["openclaw"],
    packageName: "openclaw",
    bundleIds: [],
  },
  {
    id: "codebuddy-cli",
    name: "CodeBuddy CLI",
    apps: [],
    cli: ["codebuddy"],
    packageName: "@tencent-ai/codebuddy-code",
    bundleIds: [],
  },
];
export interface ToolUpdate {
  status:
    | "not_checked"
    | "available"
    | "current"
    | "installed_newer"
    | "unknown"
    | "manual"
    | "error";
  installedVersion?: string;
  latestVersion?: string;
  checkedAt?: number;
  source?: string;
  sourceUrl?: string;
  channel?: string;
  message: string;
}
export const UPDATE_LABELS: Record<ToolUpdate["status"], string> = {
  not_checked: "更新未检查",
  available: "有新版本",
  current: "与发布源版本一致",
  installed_newer: "本机版本较新 / 渠道不同",
  unknown: "更新状态未确认",
  manual: "需在工具内检查更新",
  error: "更新查询失败",
};
export const IDENTITY_LABELS: Record<IdentityStatus, string> = {
  installed_confirmed: "已确认安装",
  running_confirmed: "确认运行中",
  candidate: "识别待确认",
  stale: "历史记录 · 当前未发现",
  absent: "本次未发现",
};
export function installed(tool: ToolInstall) {
  return ["installed_confirmed", "running_confirmed"].includes(
    tool.identityStatus,
  );
}
export function sortTools(tools: ToolInstall[], issueProducts: string[] = []) {
  return [...tools].sort(
    (a, b) =>
      Number(installed(b)) - Number(installed(a)) ||
      Number(b.pinned) - Number(a.pinned) ||
      Number(issueProducts.includes(b.productId)) -
        Number(issueProducts.includes(a.productId)) ||
      Number(b.processKeys.length > 0) - Number(a.processKeys.length > 0) ||
      a.name.localeCompare(b.name, "zh-CN") ||
      a.location.localeCompare(b.location),
  );
}
export type FileDecision = "allow" | "ask" | "deny";
export type FileOperation = "read" | "write" | "disclose";
export interface FileCandidate {
  id: string;
  relativePath: string;
  reason: string;
  size: number;
  identity: string;
  unsupported: boolean;
}
export interface FilePolicy {
  resourceId: string;
  revision: number;
  read: FileDecision;
  write: FileDecision;
  disclose: FileDecision;
  enabled: boolean;
  activeRevision: number;
}
export interface FileScope {
  id: string;
  name: string;
  // Scope roots never leave the main process. Paths below are local UI metadata only.
  candidates: FileCandidate[];
  policies: FilePolicy[];
  scannedAt: number;
  examined: number;
  skipped: number;
  truncated: boolean;
  warnings: string[];
}
export interface FileCoverage {
  mode: "policy_validation_only";
  ruleEnabled: boolean;
  eventCollection: "assistant_only";
  canBlockToolAccess: false;
  gaps: string[];
}
export interface AuditEvent {
  id: string;
  seq: number;
  time: number;
  scopeId: string;
  resourceId?: string;
  operation: "enumerate" | "policy_update" | FileOperation;
  result:
    | "metadata_only"
    | "policy_saved"
    | "denied"
    | "confirmation_required"
    | "allowed_evaluation";
  source: "scanner_actor" | "policy_validation" | "user_policy";
  policyRevision?: number;
  // No file contents, secret values or model payloads are recorded.
  detail: string;
}
export interface FileAlert {
  id: string;
  ruleId: "F01" | "F03" | "F05" | "F06";
  scopeId: string;
  resourceId: string;
  operation: FileOperation;
  state: "open" | "acknowledged";
  first: number;
  last: number;
  count: number;
  evidenceIds: string[];
}
export interface FileWorkspace {
  scopes: FileScope[];
  alerts: FileAlert[];
  coverage: FileCoverage;
  scanning: boolean;
}
export interface AuditPage {
  events: AuditEvent[];
  nextCursor?: number;
}
export interface AssistantAPI {
  tools(): Promise<ToolInventory>;
  discoverTools(): Promise<ToolInventory>;
  checkToolUpdates(id?: string): Promise<ToolInventory>;
  pinTool(id: string, pinned: boolean): Promise<ToolInventory>;
  chooseToolPath(productId: string): Promise<ToolInventory | undefined>;
  fileWorkspace(): Promise<FileWorkspace>;
  chooseFileScope(): Promise<FileWorkspace | undefined>;
  cancelFileScan(): Promise<void>;
  rescanFileScope(id: string): Promise<FileWorkspace>;
  chooseSensitiveFile(scopeId: string): Promise<FileWorkspace | undefined>;
  saveFilePolicy(
    scopeId: string,
    policy: Omit<FilePolicy, "revision" | "activeRevision">,
    expectedRevision: number,
  ): Promise<FileWorkspace>;
  evaluateFilePolicy(
    scopeId: string,
    resourceId: string,
    operation: FileOperation,
  ): Promise<{ decision: FileDecision; workspace: FileWorkspace }>;
  auditEvents(filter: {
    scopeId?: string;
    operation?: AuditEvent["operation"];
    cursor?: number;
  }): Promise<AuditPage>;
  acknowledgeFileAlert(id: string): Promise<FileWorkspace>;
  previewFileAudit(
    scopeId: string | undefined,
    format: "md" | "json",
  ): Promise<import("./types").ExportPreview>;
  exportFileAudit(
    scopeId: string | undefined,
    digest: string,
    format: "md" | "json",
  ): Promise<{ path?: string; cancelled?: boolean }>;
}
