import { parseDocument } from "yaml";
import { isDeepStrictEqual } from "node:util";
import { SKILL_TARGETS } from "../../src/shared/skill-targets";

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COMMON = new Set(["name", "description", "license", "compatibility", "metadata"]);
const SUPPORTED = new Set(SKILL_TARGETS.filter(target => !target.blockedReason).map(target => target.id));
// Document snapshots, not a claim about every installed host version.
export const SKILL_RULES: Record<string, { label: string; url: string }> = {
  opencode: { label: "OpenCode Skill 规则", url: "https://opencode.ai/docs/skills/" },
  claude: { label: "Claude Code Skill 规则", url: "https://code.claude.com/docs/en/skills" },
  cursor: { label: "Cursor Skill 规则", url: "https://cursor.com/docs/skills" },
  codex: { label: "Codex Skill 规则", url: "https://developers.openai.com/codex/skills/" },
  agents: { label: "Agent Skills 通用规范（共享目录，无独立运行宿主）", url: "https://agentskills.io/specification" },
  ...Object.fromEntries(SKILL_TARGETS.filter(target => ["windsurf", "copilot", "gemini", "trae-cn", "qoder", "roocode"].includes(target.id)).map(target => [target.id, target.directorySource])),
};
export const SKILL_RULES_DATE = "2026-10-10";

function mapping(text: string) {
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length) throw new Error("YAML 格式错误或字段重复");
  const value = document.toJS({ maxAliasCount: 0 });
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("元信息必须是字段映射");
  return value as Record<string, unknown>;
}

// Legacy export names are retained for existing callers. These checks never rewrite bytes.
export function convertSkill(text: string, folder: string, target: string, _native: boolean, _autoConvert = false) {
  if (!SUPPORTED.has(target)) throw new Error("目标安装规则或版本未核实，暂不开放直接安装");
  const normalized = text.replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(normalized);
  if (!match) throw new Error("缺少完整 YAML 元信息；为保持原文，不自动补写");
  const meta = mapping(match[1]);
  const warnings: string[] = [];
  if (!NAME.test(folder) || folder.length > 64) throw new Error("目录名不符合通用命名规范；保持原名，不自动重命名");
  if (meta.name === undefined && target === "claude") {
    // Claude documents a directory-name default.
  } else if (typeof meta.name !== "string" || meta.name !== folder) {
    throw new Error("name 缺失或与目录名不一致；保持文件完整，不自动修改名称");
  }
  if (typeof meta.description !== "string" || !meta.description.trim() || meta.description.length > 1024) throw new Error("description 必须是非空字符串且不超过 1024 字符（通用规范检查）");
  if (meta.metadata !== undefined && (!meta.metadata || typeof meta.metadata !== "object" || Array.isArray(meta.metadata) || Object.values(meta.metadata).some(value => typeof value !== "string"))) throw new Error("metadata 必须是字符串映射（通用规范检查）");
  for (const key of ["license", "compatibility"]) {
    if (meta[key] !== undefined && typeof meta[key] !== "string") throw new Error(`${key} 必须是字符串`);
  }
  if (typeof meta.compatibility === "string" && (!meta.compatibility.length || meta.compatibility.length > 500)) throw new Error("compatibility 必须为 1–500 字符（通用规范检查）");
  if (typeof meta.compatibility === "string") warnings.push(`Skill 声明的环境要求尚需满足：${meta.compatibility.slice(0, 500)}`);
  const extensions = Object.keys(meta).filter(key => !COMMON.has(key));
  for (const key of extensions) {
    const handled = target === "claude" && ["disable-model-invocation", "user-invocable", "allowed-tools", "argument-hint", "context", "agent", "hooks", "model"].includes(key)
      || target === "cursor" && key === "disable-model-invocation";
    if (handled) {
      if (["disable-model-invocation", "user-invocable"].includes(key) && typeof meta[key] !== "boolean") throw new Error(`${key} 在目标工具中必须是布尔值`);
      if (key === "allowed-tools" && typeof meta[key] !== "string" && !(Array.isArray(meta[key]) && meta[key].every(value => typeof value === "string"))) throw new Error("allowed-tools 在目标工具中必须是字符串或字符串列表");
      continue;
    }
    warnings.push(target === "opencode"
      ? `${key} 原样保留；OpenCode 文档说明未识别的字段会被忽略，该字段的行为约束不会自动迁移`
      : `${key} 原样保留；尚未验证目标对该扩展字段的支持`);
  }
  if (!SKILL_RULES[target]) warnings.push("仅完成通用规范检查，该目标的专属加载规则尚未核实");
  const body = normalized.slice(match[0].length);
  if (target !== "claude" && /!`|```!|\$ARGUMENTS\b|\$\d+\b|\$\{CLAUDE_(?:SKILL_DIR|SESSION_ID)\}|\b(?:subagent_type|activate_skill)\b/.test(body)) warnings.push("正文含宿主专属执行或参数语法，原样保留；目标运行兼容性未通过，可能需要作者提供适配版本");
  if (/(?:sk-[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|password)\s*[:=]\s*["']?[A-Za-z0-9_/-]{16,})/i.test(text)) throw new Error("说明内容疑似包含凭据，请人工检查（不展示凭据）");
  if (/(?:\/Users\/|\/home\/|[A-Z]:\\)/.test(body)) warnings.push("正文含外部绝对路径，其资源是否可访问尚未验证");
  return { text, changes: [] as string[], warnings };
}

const INTERFACE_FIELDS = new Set(["display_name", "short_description", "icon_small", "icon_large", "brand_color", "default_prompt"]);

/** Repair only a blank interface followed by its known, misplaced string fields. */
function repairInterfaceIndentation(text: string, meta: Record<string, unknown>) {
  const fields = Object.keys(meta).filter(key => INTERFACE_FIELDS.has(key));
  if (meta.interface !== null || !fields.length || fields.some(key => typeof meta[key] !== "string")) return;
  const lines = text.split(/(?<=\n)/);
  const start = lines.findIndex(line => /^interface:[ \t]*(?:#[^\r\n]*)?\r?\n?$/.test(line.replace(/^\uFEFF/, "")));
  if (start < 0) return;
  const found: string[] = [];
  let end = start + 1;
  for (; end < lines.length; end++) {
    const line = lines[end];
    if (/^\s*(?:#.*)?$/.test(line) || /^[ \t]/.test(line)) continue;
    const key = /^([a-z_][a-z0-9_-]*):(?:[ \t\r\n]|$)/i.exec(line)?.[1];
    if (!key || !INTERFACE_FIELDS.has(key)) break;
    found.push(key);
  }
  if (!found.length || fields.some(key => !found.includes(key))) return;
  const repaired = lines.map((line, index) => index > start && index < end && line.trim() ? `  ${line}` : line).join("");
  const expected: Record<string, unknown> = { ...meta, interface: Object.fromEntries(found.map(key => [key, meta[key]])) };
  for (const key of found) delete expected[key];
  // Reparse and compare every value, including policy, dependencies and unknown fields.
  const parsed = mapping(repaired);
  if (!isDeepStrictEqual(parsed, expected)) return;
  return { text: repaired, meta: parsed, change: `agents/openai.yaml：自动修复 interface 下 ${found.join("、")} 的缩进层级；字段值、策略、依赖及其他配置保持不变` };
}

export function convertOpenaiMetadata(text: string, target: string, autoConvert = false) {
  const warnings: string[] = [];
  const changes: string[] = [];
  const native = target === "codex" || target === "wiscode";
  let meta: Record<string, unknown>;
  try { meta = mapping(text); }
  catch (error) {
    if (native) throw error;
    return { text, changes: [] as string[], instructions: "", warnings: ["agents/openai.yaml 原样保留，但 YAML 无法解析；目标对该文件的支持未验证"] };
  }
  if (autoConvert) {
    const repaired = repairInterfaceIndentation(text, meta);
    if (repaired) { text = repaired.text; meta = repaired.meta; changes.push(repaired.change); }
  }
  if (native) {
    for (const key of ["interface", "policy", "dependencies"]) {
      if (meta[key] !== undefined && (!meta[key] || typeof meta[key] !== "object" || Array.isArray(meta[key]))) throw new Error(`openai.yaml 的 ${key} 必须是字段映射`);
    }
    if (meta.policy && typeof meta.policy === "object" && "allow_implicit_invocation" in meta.policy && typeof meta.policy.allow_implicit_invocation !== "boolean") throw new Error("allow_implicit_invocation 必须是布尔值");
  }
  if (!native) warnings.push("agents/openai.yaml 完整保留；这是 OpenAI 专属配置，目标不保证执行其中的调用策略和依赖声明");
  if (meta.dependencies !== undefined) warnings.push("Skill 声明了工具依赖；文件复制不会自动配置 MCP、登录或授权，依赖可用性尚未验证");
  return { text, changes, instructions: "", warnings };
}
export function checkOpenaiMetadata(text: string, target: string) {
  return convertOpenaiMetadata(text, target);
}
