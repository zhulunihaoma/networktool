# Skill 复制与任务接续验收

测试日期：2026-11-12。证据目录：`artifacts/transfer-acceptance-20261112/`。

## 结论与实测范围

已通过盒子的真实 Electron 界面、preload、IPC 和文件后端完成复制与交接，再调用本机真实 Codex CLI 验证结果。源 Skill、原生格式会话和附件均为专门创建的合成测试数据，没有导入用户真实对话，也没有覆盖用户既有 Skill 或配置。

| 场景 | 操作和验证 | 结果 |
| --- | --- | --- |
| Claude Code Skill → Codex | 在 Skill 中心选择目标并确认复制；逐字节核对 `SKILL.md` 和相对资源；真实 Codex 加载并读取资源中的随机码，返回 `SKILL_OK:<随机码>` | 通过 |
| Claude Code 会话 → Codex，无附件 | 从原生格式历史中选会话，选择“仅继续对话”，经界面生成预览并复制；真实 Codex 依据历史中累计值 37 和下一步加 5，返回 `HANDOFF_OK:42` | 通过 |
| OpenCode 导出会话 → Codex，文本与图片附件 | 导入 JSON、选择附件、导出 ZIP 并自动复制；验收码不出现在复制文字中；真实 Codex 使用只读命令解析 ZIP，读取文本内随机码和 PNG 宽高，返回 `BUNDLE_OK:<随机码>:1x1` | 通过 |
| Claude Code Skill → OpenCode | 经盒子界面复制，文件与资源逐字节一致；真实 `opencode debug skill` 返回的加载位置与本次副本完全一致 | 复制、发现通过；模型调用受账号/服务阻塞 |

Codex 的 Skill 调用使用隔离项目的 `.agents/skills` 加载规则，没有安装到真实用户全局目录。附件验收证明同机目标工具可通过导出包路径读取文件，不代表粘贴文字会自动上传附件到其他电脑或云端；图片测试核验原始字节和尺寸，不声称完成图片语义理解。

## 已通过的界面与边界场景

- Skill：单项/混合批量复制、同名同内容跳过、同名异内容先备份再更新、缺失元信息拒绝、可修复元信息只修复目标副本、回收与恢复、源文件保持原样。
- 会话：Codex 和 Claude 原生历史读取、OpenCode JSON 导入、项目筛选与搜索、内容选择、损坏源文件后的恢复、错误 IPC 参数拒绝、焦点恢复、Escape 关闭。
- 八来源附件：OpenCode、Codex、Claude Code、WorkBuddy、ZCode、WisCode、DeepSeek Harness、极库 Copilot Code。
- 附件明细保留重复引用；ZIP 按内容去重。独立 Python `zipfile` 检查 CRC、清单、原始 SHA-256、中文文件名，以及 3 条已选附件对应 2 个唯一文件、2 条缺失记录明确未携带。
- 无附件、勾选打包但没有可选附件时仍继续文字任务、手动补充附件、部分附件缺失、取消保存不写文件或修改剪贴板。
- ZIP 保存成功但自动复制失败时保留文件，重试复制相同导出；含空格路径、1440/1280/1024 和较小窗口下滚动与横向布局检查。
- 界面测试顺序执行，并在退出时恢复系统剪贴板格式；真实接收端仅使用合成数据。

## 测试发现并修复的问题

1. **Codex 无状态索引日志标题取错首条消息。** 首条用户消息实际是宿主注入的 AGENTS 前言时，标题变成空白且没有继续查找。现在依次寻找可读的用户请求；回归和实际界面列表均通过。
2. **ZCode 新归档路径遗漏部分 JSON 附件。** 没有主键的旧表走整行归档分支，序列化在 `data` 字符串中的显式附件未被扫描。现在保持原生行序列化不变，单独验证/扫描 JSON 正文；非 JSON 原始值仍保留并明确报告缺口。
3. **ZCode artifact 缓存的 data URI 被当成图片字节。** 现在先解码 URI，并使用实际 MIME 再进行哈希和归档，避免将 Base64 文本打包成图片。覆盖有主键/无主键两种表结构。归档读取版本提升，旧缓存按新逻辑重新读取。

同时更新了过时验收脚本：复制结果现在位于抽屉内、来源筛选现在使用 tab、附件为展开式设置、确认框默认值与成功文案已经变化。脚本仍验证取消、确认开关、复制一致性、独立 ZIP 内容和源文件不变，没有为了通过测试修改这些产品流程。

## 真实模型通道的限制与重试

- OpenCode 默认 CodingPlan 通道和 Claude Code 通道均明确返回 CodingPlan 订阅无效/过期；这是服务端拒绝，不能计为实际调用通过。
- 另一个已经配置的 OpenCode Agent Plan 通道返回服务端错误，也未计为通过。未续费、购买套餐或改写用户默认模型/凭据。
- Codex 默认 `gpt-6.1-sol` 完成 Skill 和纯文字接续；附件请求遇到模型容量不足。只重试附件接收端，临时指定本机模型列表中的 `gpt-6-luna`，最终读取附件并通过；没有修改默认配置。
- 所有接收端保留正常防护配置，Codex 使用只读沙箱。附件接收时 shell heredoc 的临时文件写入被沙箱拒绝，接收端自行改用只读 `python -c` 完成解析。

因此目前可确认：复制与交接功能、Codex 真实接收链路可用；OpenCode/Claude 的模型接收链路需在其订阅/服务恢复后再验证。

## 验证与证据

- 全量测试：**490 通过、1 跳过、0 失败**；其中历史/附件定向测试 52 项通过。
- TypeScript 检查、生产构建、修改文件空白检查通过。保留已有 Vite bundle 体积提示。
- 四组 Electron 界面脚本最终均通过；来源会话原件与附件哈希未改变。
- 实际 Skill、文字、附件接收输出：`live-codex/skill-receiver.stdout`、`live-codex/text-receiver.stdout`、`live-codex/attachment-retry-luna.result.json`。保留了容量不足和其他通道失败的原始尝试，不将失败尝试改写成成功。
- `acceptance-summary.json` 汇总最终语义场景。早期 `live-codex/results.json` 的通用检查名称仍含 OpenCode/Claude 字样，实际调用的是 Codex CLI；以该汇总及原始 CLI 事件为准，新脚本已修正名称。
- UI 截图和报告位于证据目录；`live-codex/exports with spaces/` 中保留可复核的合成附件包。

复现真实调用（会产生真实模型请求；请使用新的证据目录）：

```sh
TRANSFER_RECEIVER=codex \
TRANSFER_CODEX_MODEL=gpt-6-luna \
TRANSFER_EVIDENCE_DIR=/tmp/networktool-transfer-new-run \
node scripts/verify-live-transfers.mjs --live
```

源码和本地构建产物已更新；现有运行实例需正常重启后加载本次历史与附件修复。
