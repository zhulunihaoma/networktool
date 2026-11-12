import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type {
  DoctorReport,
  Finding,
  SecurityProgress,
  SecurityTool,
} from "../../src/shared/security";
import { parseJsonc, readConfig, tomlSections } from "./config-read";
const hash = (s: string) =>
  createHash("sha256").update(s).digest("hex").slice(0, 12);
/** 检查组：体检时逐组执行并上报进度，UI 逐项点亮。 */
const GROUPS = [
  "检查各工具的密钥与登录凭据文件",
  "检查 Codex 审批、沙箱与 MCP 配置",
  "检查 OpenCode、Claude、ZCode、DeepSeek 配置",
  "检查常见凭据位置（.ssh、.npmrc、.netrc 等）",
] as const;
/** Plain-language manual steps keyed by the local finding id. */
const STEPS: Record<string, string[]> = {
  unreadable: [
    "点“打开文件位置”找到该文件",
    "确认文件存在、是普通文件且格式正确",
    "回到这里点“重新体检”",
  ],
  permissions: ["点“一键修复”，文件会改为仅你自己可读写，内容不变"],
  approval: [
    "打开 Codex 设置，把“审批策略”改为需要确认（on-request 或 untrusted）",
    "或打开 ~/.codex/config.toml，删除 approval_policy = \"never\" 这一行",
    "回到这里点“重新体检”",
  ],
  sandbox: [
    "打开 ~/.codex/config.toml，把 sandbox_mode 改为 \"workspace-write\"",
    "只在确实需要时临时使用完全访问",
    "回到这里点“重新体检”",
  ],
  trusted: [
    "打开 ~/.codex/config.toml，找到 [projects.\"…\"] 段落",
    "删除不再使用的项目的 trust_level = \"trusted\"",
  ],
  "mcp-unpinned": [
    "打开 ~/.codex/config.toml 中对应的 [mcp_servers.…] 段落",
    "把 npx 包名写成 包名@版本号，例如 @scope/pkg@1.2.3",
  ],
  "broad-rules": [
    "打开 ~/.codex/rules/default.rules",
    "删除对 curl、wget、sudo、docker、git push 的 allow 规则，让它们执行前再问你",
  ],
  permission: [
    "打开 OpenCode 配置文件",
    "加入 \"permission\": { \"bash\": \"ask\", \"edit\": \"ask\" }，让命令执行前先问你",
  ],
  "bash-allow": [
    "打开 OpenCode 配置文件",
    "把 permission.bash 从 \"allow\" 改为 \"ask\"",
  ],
  "plugin-version": ["在 OpenCode 配置的 plugin 列表中，为 Git 插件地址加上 #版本号"],
  parse: ["打开 OpenCode 配置文件，修正 JSON 格式错误", "回到这里点“重新体检”"],
  bypass: [
    "打开 ~/.claude/settings.json",
    "删除 permissions.defaultMode 或改为 \"default\"",
  ],
  plaintext: [
    "确认该文件仅你自己可读（体检未报权限问题即已满足）",
    "不要把该文件同步到网盘或提交到 Git",
  ],
  common: [
    "点“一键修复”，文件会改为仅你自己可读写，内容不变",
    "确认这是你自己的凭据文件后再修复；不再使用可直接删除",
  ],
  js: [
    "打开 DeepSeek Harness 配置，确认 !!js 表达式是你自己写的",
    "不认识的表达式请删除，确认可信可点“暂不处理”",
  ],
};
export async function runDoctor(
  home: string,
  onProgress?: (p: SecurityProgress) => void,
): Promise<DoctorReport> {
  const findings: Finding[] = [];
  const progress = (step: number, title: string) =>
    onProgress?.({
      kind: "doctor",
      step,
      steps: GROUPS.length,
      title,
      found: findings.length,
    });
  const tools: SecurityTool[] = [
    "codex",
    "claude",
    "opencode",
    "zcode",
    "dsh",
    "wiscode",
  ];
  const scanned = tools.map((tool) => ({
    tool,
    files: 0,
    note: "未发现或无法读取配置" as string | undefined,
  }));
  // Every finding below is added right after reading the file it describes,
  // so the most recently read file is the evidence location.
  let lastFile: string | undefined;
  async function read(tool: SecurityTool, relative: string) {
    const file = path.join(home, relative);
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_000_000)
        throw new Error("未能读取配置");
      const text = await readConfig(home, relative);
      if (text === undefined) return undefined;
      const row = scanned.find((s) => s.tool === tool)!;
      row.files++;
      lastFile = file;
      row.note = undefined;
      return { file, text, mode: stat.mode & 0o777 };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      findings.push({
        id: `${tool}:unreadable:${hash(relative)}`,
        tool,
        title: "部分配置未能检查",
        level: "medium",
        category: "integrity",
        why: "配置读取不完整，不能据此判断安全。",
        evidence: relative,
        fix: "检查文件权限和格式后重新体检",
        path: file,
        steps: STEPS.unreadable,
      });
      return undefined;
    }
  }
  const add = (
    tool: SecurityTool,
    id: string,
    title: string,
    level: Finding["level"],
    evidence: string,
    fix: string,
    category: Finding["category"] = "permission",
    autoFix?: Finding["autoFix"],
  ) =>
    findings.push({
      id: `${tool}:${id}`,
      tool,
      title,
      level,
      category,
      why: "此配置可能扩大智能体的访问范围，请结合实际用途检查。",
      evidence,
      fix,
      autoFix,
      path: lastFile,
      steps: STEPS[id.split(":")[0]],
    });
  for (const [tool, rel] of [
    ["codex", ".codex/auth.json"],
    ["claude", ".claude/.credentials.json"],
    ["opencode", ".local/share/opencode/auth.json"],
    ["zcode", ".zcode/v2/config.json"],
    ["zcode", ".zcode/credentials.json"],
    ["zcode", ".zcode/provider_config.json"],
    ["dsh", ".dsh/.credentials.yaml"],
    ["dsh", ".dsh/profiles/desktop/cordis.patch.yml"],
    ["wiscode", ".wiscode/codex-agents/auth.json"],
  ] as const) {
    progress(0, GROUPS[0]);
    const f = await read(tool, rel);
    if (f && f.mode & 0o077)
      add(
        tool,
        `permissions:${hash(rel)}`,
        `${tool} 敏感配置对其他用户可读`,
        "high",
        `${rel} 权限 ${f.mode.toString(8)}（内容未显示）`,
        "将文件权限调整为仅当前用户可读写",
        "secret",
        { kind: "chmod", path: f.file, mode: 0o600, fromMode: f.mode },
      );
  }
  progress(1, GROUPS[1]);
  const codex = await read("codex", ".codex/config.toml");
  if (codex) {
    const sections = tomlSections(codex.text);
    if (sections.some((s) => s.values.approval_policy === "never"))
      add(
        "codex",
        "approval",
        "Codex 关闭了操作审批",
        "high",
        "approval_policy = never",
        "检查 Codex 审批设置",
      );
    if (sections.some((s) => s.values.sandbox_mode === "danger-full-access"))
      add(
        "codex",
        "sandbox",
        "Codex 允许完整文件访问",
        "high",
        "sandbox_mode = danger-full-access",
        "改用限制写入范围的沙箱",
      );
    const trusted = sections.filter(
      (s) => s.values.trust_level === "trusted",
    ).length;
    if (trusted > 10)
      add(
        "codex",
        "trusted",
        "Codex 已信任较多项目",
        "low",
        `${trusted} 个项目被标记为 trusted`,
        "定期移除不再使用的项目信任",
      );
    for (const s of sections.filter(
      (s) => s.name.startsWith("mcp_servers.") && !s.name.endsWith(".env"),
    )) {
      const cmd = `${s.values.command ?? ""} ${Array.isArray(s.values.args) ? s.values.args.join(" ") : ""}`;
      if (
        (/\bnpx\b/.test(cmd) && !/@\d/.test(cmd)) ||
        (/uvx.*git\+/.test(cmd) && !/git\+\S+@[\w.-]+/.test(cmd))
      )
        add(
          "codex",
          `mcp-unpinned:${hash(s.name)}`,
          "Codex MCP 启动依赖未固定版本",
          "medium",
          s.name,
          "固定到可信版本或提交",
          "supply_chain",
        );
    }
  }
  const rules = await read("codex", ".codex/rules/default.rules");
  if (
    rules &&
    /decision\s*=\s*["']allow/.test(rules.text) &&
    /curl|wget|sudo|docker|git push/.test(rules.text)
  )
    add(
      "codex",
      "broad-rules",
      "Codex 存在高风险命令自动放行规则",
      "medium",
      ".codex/rules/default.rules 中存在相关 allow 规则（未展示内容）",
      "检查并缩小自动放行范围",
    );
  progress(2, GROUPS[2]);
  const oc =
    (await read("opencode", ".config/opencode/opencode.jsonc")) ??
    (await read("opencode", ".config/opencode/opencode.json"));
  if (oc) {
    try {
      const data = parseJsonc(oc.text);
      if (!data.permission)
        add(
          "opencode",
          "permission",
          "OpenCode 未显式配置操作权限",
          "medium",
          "未发现 permission 字段",
          "检查 OpenCode 的权限配置",
        );
      if (data.permission?.bash === "allow")
        add(
          "opencode",
          "bash-allow",
          "OpenCode 自动放行所有 Bash 操作",
          "high",
          "permission.bash = allow",
          "缩小允许范围",
        );
      if (
        (data.plugin ?? []).some(
          (v: unknown) =>
            typeof v === "string" && v.includes("git+") && !v.includes("#"),
        )
      )
        add(
          "opencode",
          "plugin-version",
          "OpenCode 插件未锁定版本",
          "medium",
          "检测到未固定版本的 Git 插件",
          "固定插件到可信版本",
          "supply_chain",
        );
    } catch {
      add(
        "opencode",
        "parse",
        "OpenCode 配置无法解析",
        "medium",
        "配置未完成检查",
        "检查配置格式",
        "integrity",
      );
    }
  }
  const claude = await read("claude", ".claude/settings.json");
  if (claude) {
    try {
      const data = JSON.parse(claude.text);
      if (data.permissions?.defaultMode === "bypassPermissions")
        add(
          "claude",
          "bypass",
          "Claude Code 跳过操作审批",
          "high",
          "permissions.defaultMode = bypassPermissions",
          "调整权限模式",
        );
    } catch {}
  }
  const zcode = await read("zcode", ".zcode/v2/config.json");
  if (zcode && /["']apiKey["']\s*:\s*["'][^"']+/.test(zcode.text))
    add(
      "zcode",
      "plaintext",
      "ZCode 配置包含明文密钥",
      zcode.mode & 0o077 ? "high" : "low",
      "检测到 apiKey 字段（值已隐藏）",
      "限制文件权限并考虑使用安全凭据存储",
      "secret",
    );
  const dsh = await read("dsh", ".dsh/profiles/desktop/cordis.patch.yml");
  if (dsh && /!!js/.test(dsh.text))
    add(
      "dsh",
      "js",
      "DeepSeek Harness 配置包含可执行表达式",
      "low",
      "配置包含 !!js 标签",
      "确认表达式来源可信",
      "integrity",
    );
  progress(3, GROUPS[3]);
  // 常见凭据位置：AI 工具经常被引导读写这些文件；只检查权限，不读内容。
  for (const rel of [
    ".ssh/id_rsa",
    ".ssh/id_ed25519",
    ".ssh/config",
    ".ssh/known_hosts",
    ".npmrc",
    ".netrc",
    ".git-credentials",
  ] as const) {
    const file = path.join(home, rel);
    try {
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      if (stat.mode & 0o077) {
        findings.push({
          id: `system:common:${hash(rel)}`,
          tool: "system",
          title: `常见凭据文件 ${rel} 对其他用户可读`,
          level: rel.startsWith(".ssh/id_") ? "high" : "medium",
          category: "secret",
          why: "这类文件保存登录凭据或私钥；AI 工具常被引导读取它们（如 cat ~/.ssh/id_rsa），权限过宽会扩大泄露面。",
          evidence: `${rel} 权限 ${stat.mode.toString(8).slice(-3)}（内容未读取）`,
          fix: "将文件权限调整为仅当前用户可读写",
          autoFix: { kind: "chmod", path: file, mode: 0o600, fromMode: stat.mode & 0o777 },
          path: file,
          steps: STEPS.common,
        });
      }
    } catch {
      // 不存在是正常情况，跳过
    }
  }
  progress(GROUPS.length, "体检完成");
  return { at: Date.now(), findings, scanned, ignored: [] };
}
export { collectInventory, diffInventory } from "./inventory";
