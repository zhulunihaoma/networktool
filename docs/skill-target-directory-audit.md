# Skill 复制目标目录核查

核对日期：2026-10-10。针对本机默认配置、用户级安装。路径中的 `~` 指运行复制工具的用户主目录。文档规则可证明默认发现目录，不能证明任意已安装版本、禁用状态、远程会话或业务任务可运行。

## 已确认的复制目标

| 目标 | 用户级复制目录 | 依据与使用方式 |
| --- | --- | --- |
| WisCode | `~/.wiscode/skills` | 本机安装包 `dist-server/server/index.js` 中 `getWiscodeSkillsRoot`、`getCodexSkillSources`；用户已确认补放此目录后在 `$` 菜单可见。Codex 内部目录继续扫描但不作为安装目标。 |
| 共享 Skills 目录 | `~/.agents/skills` | [Codex USER 目录](https://developers.openai.com/codex/skills/)；这是共享存储，不是单独运行宿主。 |
| Claude Code | `~/.claude/skills` | [Personal Skills](https://code.claude.com/docs/en/skills)，本机 `/技能名`；不覆盖 Cowork、云会话。 |
| Codex | `~/.agents/skills` | [Where Codex loads local skills](https://developers.openai.com/codex/skills/)，`$` 选择；未刷新时重启。 |
| Cursor | `~/.cursor/skills` | [Skill directories](https://cursor.com/docs/skills)，Customize → Skills；云端和远程有独立同步要求。 |
| Windsurf | `~/.codeium/windsurf/skills` | [Cascade Global Skills](https://docs.windsurf.com/windsurf/cascade/skills)，官方页面现跳转 Devin 文档，仍明确保留该全局目录；`@` 选择。 |
| GitHub Copilot | `~/.copilot/skills` | [Personal Skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills)，本机支持 Agent Skills 的客户端；`.copilotcode/skills` 仅保留历史扫描。 |
| Gemini CLI | `~/.gemini/skills` | [Discovery tiers](https://geminicli.com/docs/cli/using-agent-skills/)，`/skills reload` 后 `/skills list`；`.gemini/config/skills` 仅作历史扫描。 |
| OpenCode | `~/.config/opencode/skills` | [Global config](https://opencode.ai/docs/skills/)，已有 CLI 探针 `opencode debug skill` 校验名称及真实路径。权限与业务执行另行验证。 |
| Trae CN | `~/.trae-cn/skills` | [技能所在目录](https://docs.trae.cn/ide_skills)，全局技能列表确认启用；与国际版分列。 |
| Qoder CLI | `~/.qoder/skills` | [Where Skills live](https://docs.qoder.com/cli/Skills)，`/skills reload` 后 `/skills` 或 `/技能名`；不将 QoderWork 的 `~/.qoderwork/skills` 混为同一产品。 |
| WorkBuddy | `~/.workbuddy/skills` | 本机 `WorkBuddy.app/Contents/Resources/app.asar` 的配置根与扫描代码；见下方本机证据。技能 → 已安装，确认启用。 |
| Roo Code | `~/.roo/skills` | [Global Roo-specific skills](https://roocodeinc.github.io/Roo-Code/features/skills/)，按描述触发；同名项目或模式技能可能覆盖。`.roo-cline/skills` 仅历史扫描。 |

## 暂不直接复制

- Trae 国际版：`https://docs.trae.ai/ide/skills` 本次可打开但正文为空，未获得当前用户级目录及直接加载依据。保留 `.trae/skills` 的扫描，复制选项禁用；提示通过工具内导入。不能把 CN 的核实结果套用国际版。
- iFlow CLI：[官方安装与注册说明](https://docs.iflow.cn/cli/examples/skill/) 确认 `~/.iflow/skills`，同时描述 `skill.toml` 注册信息、必需 `license`、安装设置及 `/skills refresh`。本机无 iFlow CLI，未验证普通 Skill 仅复制后的注册结果，保留扫描并禁用直接复制。

## 本机安装包证据

只读检查，未改动宿主应用文件。

- WisCode：`/Applications/WisCode.app/Contents/Resources/dist-server/server/index.js` 的 `getWiscodeSkillsRoot()` 返回 userData 下 `skills`；`getCodexSkillSources()` 把此目录注册为 `sourceKind: wiscode`、`executable: true`、`commandPrefix: $`。也列出内部 `$CODEX_HOME/skills`，所以不能断言后者完全不被扫描；共享目录是此次用户已验证的安装位置。
- WorkBuddy：`app.asar` 中 `main/cli-prewarm-pool.js` 将 runtime configDir 传给 `CODEBUDDY_CONFIG_DIR` 与 `WORKBUDDY_CONFIG_DIR`，默认数据目录名 `.workbuddy`；`main/index.js` 描述用户目录树 `.workbuddy/{logs,app,skills,...}`；随包 CLI 读取此配置根下的 Skills。官网[技能管理](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market) 另说明安装和启用是独立状态。

## 实现边界

`src/shared/skill-targets.ts` 是复制支持状态、固定目标、目录依据与使用提示的单一来源。来源候选目录仅用于扫描；目录存在不再改变复制位置。前后端都限制未确认目标，不能绕过下拉框通过 IPC 写入。

保留原样复制、同名跳过、敏感文件/符号链接拒绝与哈希核验。目录依据已核实、落盘完整、宿主实际发现、业务运行分别报告。自定义配置目录及远程环境不在默认目标适用范围内；不自动迁移或清理旧副本。

回归用隔离临时目录覆盖全部开放目标，特别验证：历史目录存在但标准目标不存在时仍写入标准目标；不同 Trae 版本不串目录；未确认目标不写文件；结果包含落盘路径及使用提示。该测试不等价于逐工具真实运行验证。
