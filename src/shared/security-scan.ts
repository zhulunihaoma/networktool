export type RiskLevel = "high" | "medium" | "low";

export interface RiskLine {
  /** 相对 Skill 根目录的路径（POSIX 分隔符） */
  file: string;
  /** 从 1 开始的行号 */
  line: number;
  /** 已脱敏、已截断的证据文本 */
  text: string;
  rule: string;
  label: string;
  level: RiskLevel;
  /** 与目标位置已有旧版本相比，这一行是新增的 */
  changed?: boolean;
}

export interface SkillRiskReport {
  level: RiskLevel | "none";
  findings: RiskLine[];
  urls: string[];
  commands: string[];
  scannedFiles: number;
  /** 文件数、大小或深度超出限额，部分内容未扫描 */
  truncated: boolean;
  /** 是否与旧版本做过对比 */
  compared?: boolean;
  /** 新增行中的 finding 数 */
  changedCount?: number;
}

export const RISK_RULES: Record<string, { label: string; level: RiskLevel; advice: string }> = {
  "pipe-to-shell": { label: "下载后直接执行脚本", level: "high", advice: "网上下载的脚本未经检查就运行，内容随时可能被替换。" },
  "decode-exec": { label: "解码隐藏内容后执行", level: "high", advice: "用 base64 等方式隐藏真实命令，常见于恶意脚本。" },
  "recursive-delete": { label: "强制删除目录", level: "high", advice: "rm -rf 一旦写错路径会删除大量文件，且无法恢复。" },
  "credential-access": { label: "读取凭据或密钥文件", level: "high", advice: "访问 SSH 密钥、.env、auth.json 等文件，可能导致账号或密钥泄露。" },
  "privilege": { label: "提权或放开权限", level: "medium", advice: "sudo 或 chmod 777 会扩大权限范围。" },
  "unpinned-launcher": { label: "启动未锁定版本的程序", level: "medium", advice: "npx -y、uvx --from git+ 每次可能拉取不同代码，建议锁定版本。" },
  "prompt-injection": { label: "疑似提示词注入", level: "medium", advice: "要求智能体忽略原有指令或隐藏行为，可能被用来绕过安全约束。" },
  "external-url": { label: "访问外部地址", level: "low", advice: "仅说明会联系这些地址，不代表一定外发数据。" },
};

export const RISK_LEVEL_LABELS: Record<SkillRiskReport["level"], string> = {
  high: "高风险",
  medium: "需注意",
  low: "发现外部地址",
  none: "未发现规则命中",
};
