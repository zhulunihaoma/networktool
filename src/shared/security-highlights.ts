export type SecurityTextPart = {
  text: string;
  kind?: "sensitive" | "path" | "risk";
};

// Presentation only: keep every character, including redactions and incomplete JSON.
// Quoted paths may contain spaces; unquoted paths stop at prose/JSON boundaries.
const SENSITIVE =
  /\b(?:[\w.-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|password|passwd|credential|authorization|private[_-]?key|(?:user|account)[_-]?id)[\w.-]*|token)\b/;
const PATH =
  /["'`](?:[A-Za-z]:[\\/]|~?\/|\.{1,2}\/|\.[\w-]+\/)[^"'`\r\n]+["'`]|(?:[A-Za-z]:[\\/]|~?\/|\.{1,2}\/|\.[\w-]+\/)[^\s"'`<>，。；、（）(){}\[\],;]+|\b[\w.-]+\/(?:[\w.@+-]+\/)*[\w.@+-]+|\.(?:env(?:\.[\w-]+)?|npmrc|netrc|git-credentials)\b/;
const RISK =
  /\b(?:approval_policy|sandbox_mode|trust_level|permissions?(?:\.[\w]+)*|defaultMode|danger-full-access|bypassPermissions|never)\b|!!js|高风险|明文密钥|登录凭据|私钥|权限过宽|自动放行|跳过操作审批|完整文件访问|扩大泄露面/;
const TOKENS = new RegExp(
  `(?<path>${PATH.source})|(?<sensitive>${SENSITIVE.source})|(?<risk>${RISK.source})`,
  "gi",
);

export function highlightSecurityText(text: string): SecurityTextPart[] {
  const parts: SecurityTextPart[] = [];
  let end = 0;
  for (const match of text.matchAll(TOKENS)) {
    const start = match.index!;
    if (start > end) parts.push({ text: text.slice(end, start) });
    const value = match[0];
    // Paths take precedence, even when a filename contains "credentials".
    const kind = match.groups?.path
      ? "path"
      : match.groups?.sensitive
        ? "sensitive"
        : "risk";
    parts.push({ text: value, kind });
    end = start + value.length;
  }
  if (end < text.length) parts.push({ text: text.slice(end) });
  return parts;
}

// Display tokens only; risk decisions still come from the scanner. Never read
// files or recover secret values here: the input is already redacted evidence.
const SKILL_RISK_TOKENS = /\b(?:sudo|curl|wget|eval|exec|atob)\b|\|\s*(?:(?:sudo\s+)?(?:ba|z|da|k)?sh|python3?|node|perl|ruby)\b|\brm\s+(?:-[a-z]*[rf][a-z]*(?:\s+-[rf])?|--(?:recursive|force)(?:\s+--(?:recursive|force))?)\b|\bchmod\s+(?:-R\s+)?(?:0?777|a\+rwx)\b|\bbase64\s+(?:-d|-D|--decode)\b|\bnpx\s+(?:-y|--yes)\s+[^\s`'";]+|\buvx?\b[^\n]*?--from\s+git\+[^\s`'";]+|ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above)\s+(?:instructions|rules)|disregard\s+(?:all\s+)?(?:previous|prior)\s+(?:instructions|rules)|忽略(?:之前|以前|上面|先前|所有)(?:的)?(?:所有)?(?:指令|规则|提示|约束)|do\s+not\s+(?:tell|inform)\s+the\s+user|without\s+(?:telling|informing)\s+the\s+user|不要(?:告诉|让)用户知道/gi;

export function highlightSkillRiskText(text: string): SecurityTextPart[] {
  const parts: SecurityTextPart[] = [];
  let end = 0;
  for (const match of text.matchAll(SKILL_RISK_TOKENS)) {
    const start = match.index!;
    parts.push(...highlightSecurityText(text.slice(end, start)));
    parts.push({ text: match[0], kind: "risk" });
    end = start + match[0].length;
  }
  parts.push(...highlightSecurityText(text.slice(end)));
  return parts;
}
