/** User-scope directory audit: 2026-10-10. Source directories are NOT copy destinations. */
export const SKILL_TARGETS_CHECKED_AT = "2026-10-10";
export interface SkillTargetDefinition {
  id: string;
  label: string;
  candidates: string[];
  target: string;
  activationHint: string;
  directorySource: { label: string; url: string };
  blockedReason?: string;
}

export const SKILL_TARGETS: SkillTargetDefinition[] = [
  {
    id: "wiscode", label: "WisCode", target: ".wiscode/skills",
    candidates: [".wiscode/skills", ".wiscode/codex-agents/skills"],
    activationHint: "重新打开会话，在 Codex 模式输入 $ 选择 Skill；列表未更新时重启 WisCode。",
    directorySource: { label: "本机 WisCode getCodexSkillSources / getWiscodeSkillsRoot（已实机确认）", url: "/Applications/WisCode.app/Contents/Resources/dist-server/server/index.js" },
  },
  {
    id: "agents", label: "共享 Skills 目录", target: ".agents/skills", candidates: [".agents/skills"],
    activationHint: "这是多个 Agent 共用的目录，不是独立工具；需要只复制到某个工具时，请选择该工具。",
    directorySource: { label: "Codex 用户级共享目录说明", url: "https://developers.openai.com/codex/skills/" },
  },
  {
    id: "claude", label: "Claude Code", target: ".claude/skills", candidates: [".claude/skills"],
    activationHint: "在本机 Claude Code 输入 /技能名；未显示时新建会话。此目录不供 Cowork 或云端会话读取。",
    directorySource: { label: "Claude Code Personal Skills", url: "https://code.claude.com/docs/en/skills" },
  },
  {
    id: "codex", label: "Codex / OpenAI Skills", target: ".agents/skills", candidates: [".codex/skills", ".agents/skills"],
    activationHint: "Codex 自动发现更新，输入 $ 选择 Skill；未显示时重启 Codex。该目录也可能被其他支持共享 Skills 的工具读取。",
    directorySource: { label: "Codex USER Skills", url: "https://developers.openai.com/codex/skills/" },
  },
  {
    id: "cursor", label: "Cursor", target: ".cursor/skills", candidates: [".cursor/skills"],
    activationHint: "在本机 Cursor 的 Customize → Skills 中查看；未显示时重新打开会话。远程或云端 Agent 需要另行同步。",
    directorySource: { label: "Cursor User-level Skills", url: "https://cursor.com/docs/skills" },
  },
  {
    id: "windsurf", label: "Windsurf", target: ".codeium/windsurf/skills", candidates: [".codeium/windsurf/skills"],
    activationHint: "在 Cascade 的 Skills 面板查看，通过 @技能名选择；未显示时重新打开会话。",
    directorySource: { label: "Cascade Global Skills", url: "https://docs.windsurf.com/windsurf/cascade/skills" },
  },
  {
    id: "copilot", label: "GitHub Copilot", target: ".copilot/skills", candidates: [".copilot/skills", ".copilotcode/skills"],
    activationHint: "用于本机 Copilot 的个人 Skills；在支持 Agent Skills 的版本中查看或调用，未显示时新建会话。",
    directorySource: { label: "GitHub Copilot Personal Skills", url: "https://docs.github.com/en/copilot/concepts/agents/about-agent-skills" },
  },
  {
    id: "gemini", label: "Gemini CLI", target: ".gemini/skills", candidates: [".gemini/skills", ".gemini/config/skills"],
    activationHint: "在 Gemini CLI 执行 /skills reload，再用 /skills list 查看；被禁用的 Skill 需要自行启用。",
    directorySource: { label: "Gemini CLI User Skills", url: "https://geminicli.com/docs/cli/using-agent-skills/" },
  },
  {
    id: "opencode", label: "OpenCode", target: ".config/opencode/skills", candidates: [".config/opencode/skills", ".opencode/skills"],
    activationHint: "复制后会尝试通过本机 OpenCode CLI 检查发现结果；已有会话未显示时新建会话，调用仍受 Agent 权限控制。",
    directorySource: { label: "OpenCode Global Skills", url: "https://opencode.ai/docs/skills/" },
  },
  {
    id: "trae", label: "Trae 国际版", target: ".trae/skills", candidates: [".trae/skills"],
    blockedReason: "国际版官方页面未能核实用户级目录的直接加载规则，请在 Trae 的技能设置中导入。",
    activationHint: "通过工具内的技能导入入口安装。",
    directorySource: { label: "Trae 国际版 Skills（目录待核实）", url: "https://docs.trae.ai/ide/skills" },
  },
  {
    id: "trae-cn", label: "Trae CN", target: ".trae-cn/skills", candidates: [".trae-cn/skills"],
    activationHint: "在 Trae CN 设置 → 技能与命令 → 全局中查看并确认启用；未更新时新建会话。",
    directorySource: { label: "Trae CN 全局技能目录", url: "https://docs.trae.cn/ide_skills" },
  },
  {
    id: "qoder", label: "Qoder CLI", target: ".qoder/skills", candidates: [".qoder/skills"],
    activationHint: "在 Qoder CLI 执行 /skills reload，再用 /skills 查看或 /技能名 调用。QoderWork 使用不同目录，不适用此目标。",
    directorySource: { label: "Qoder CLI User-level Skills", url: "https://docs.qoder.com/cli/Skills" },
  },
  {
    id: "iflow", label: "iFlow CLI", target: ".iflow/skills", candidates: [".iflow/skills"],
    blockedReason: "目录已确认，但官方流程还涉及技能注册表、license 和安装设置；尚未验证仅原样复制即可加载，请使用 iFlow 的安装流程。",
    activationHint: "通过 iFlow 安装后执行 /skills refresh，再用 /skills list 验证。",
    directorySource: { label: "iFlow 技能安装与注册", url: "https://docs.iflow.cn/cli/examples/skill/" },
  },
  {
    id: "workbuddy", label: "WorkBuddy", target: ".workbuddy/skills", candidates: [".workbuddy/skills"],
    activationHint: "在 WorkBuddy 的技能 → 已安装中查看并确认启用；未更新时重新打开任务。",
    directorySource: { label: "本机 WorkBuddy 配置目录与 Skill 扫描实现（2026-08 安装包）", url: "/Applications/WorkBuddy.app/Contents/Resources/app.asar" },
  },
  {
    id: "roocode", label: "Roo Code", target: ".roo/skills", candidates: [".roo/skills", ".roo-cline/skills"],
    activationHint: "在 Roo Code 中描述相关任务以调用；项目级或模式专属的同名 Skill 可能优先于全局版本。",
    directorySource: { label: "Roo Code Global Skills", url: "https://roocodeinc.github.io/Roo-Code/features/skills/" },
  },
];
