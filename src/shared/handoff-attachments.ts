/** Public metadata only. Binary data and source paths stay in the main process. */
export interface HandoffAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  status: "ready" | "missing" | "unsupported" | "error" | "blocked";
  note: string;
  messageId: string;
  origin: "stored" | "local-image" | "reference" | "manual";
  sha256?: string;
  /** Secrets masked inside a text attachment before packaging. */
  redactions?: number;
}
export interface HandoffAttachmentScan {
  token: string;
  entries: HandoffAttachment[];
  complete: boolean;
  warnings: string[];
  security?: HandoffAttachmentSecurity;
}
export interface HandoffAttachmentSelection {
  packAttachments?: boolean;
  attachmentIds?: string[];
  attachmentScanToken?: string;
  allowPartialAttachments?: boolean;
}
export interface HandoffPackageSummary {
  entries: HandoffAttachment[];
  bytes: number;
  omitted: number;
  complete: boolean;
}
export interface HandoffAttachmentSecurity {
  blocked: { name: string; reason: string }[];
  redacted: { name: string; hits: number }[];
}
/** Reported to the security timeline by whoever owns the HandoffManager. */
export interface HandoffSecurityEvent {
  operation: string;
  decision: "deny" | "allow";
  ruleId?: string;
  reason?: string;
  project?: string;
}
const CREDENTIAL_RULES: { id: string; test: RegExp; reason: string }[] = [
  { id: "env", test: /(^|\/)\.env(\.[^/]*)?$|[^/]\.env$/i, reason: "环境变量文件（.env）通常保存密钥和口令" },
  { id: "private-key", test: /\.(pem|key|p12|pfx|jks|keystore|ppk|p8)$/i, reason: "私钥或证书文件" },
  { id: "ssh", test: /(^|\/)(\.ssh\/|id_(rsa|dsa|ecdsa|ed25519)$)/i, reason: "SSH 登录密钥" },
  { id: "cloud", test: /(^|\/)\.aws\/(credentials|config)$/i, reason: "云服务访问凭据" },
  { id: "auth", test: /(^|\/)auth\.json$/i, reason: "登录凭据文件（auth.json）" },
  { id: "credentials", test: /(^|\/)\.?credentials?$|(^|[\/_.-])credentials?(\.[^/.]+)?\.(json|ya?ml|toml|ini|env|txt|csv)$/i, reason: "凭据文件" },
  { id: "dotrc", test: /(^|\/)_?\.?(npmrc|pypirc|netrc|git-credentials|pgpass)$/i, reason: "包管理或网络登录凭据" },
  { id: "secrets", test: /(^|\/)(secrets?|service[-_]?account[^/]*)\.(json|ya?ml|env)$/i, reason: "密钥配置文件" },
  { id: "docker", test: /(^|\/)\.docker\/config\.json$/i, reason: "容器仓库登录凭据" },
];
/** Shared by the scanner, the packer and the UI: one rule set, so a renamed check cannot diverge. */
export function credentialAttachmentRule(
  ...names: (string | undefined)[]
): { id: string; reason: string } | undefined {
  for (const raw of names) {
    if (!raw) continue;
    const name = raw.replace(/\\/g, "/");
    const hit = CREDENTIAL_RULES.find((rule) => rule.test.test(name));
    if (hit) return { id: `handoff.credential.${hit.id}`, reason: hit.reason };
  }
  return undefined;
}
export const attachmentSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
