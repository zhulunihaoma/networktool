# Codex 会话与项目读取

任务接续使用 Codex 官方 App Server 获取聊天身份与正文；源数据只读，不调用恢复聊天、模型生成、编辑或修复方法。

## 数据路径

1. 客户端项目登记与聊天分开读取。保留 `.codex-global-state.json` 的 `local-projects` 名称、多个 `rootPaths` 与顺序；结合 SQLite 的 `projects` / `project_roots`，兼容迁移前后的项目 ID。无聊天项目仍显示。
2. SQLite 通过 Electron 的原生 `node:sqlite` 只读连接读取，包含已提交的 WAL 数据；动态识别 `state_*.sqlite` 和已有字段。不能将主数据库文件单独交给 sql.js，否则近期聊天可能漏读。
3. 官方会话通过 `codex app-server --stdio` 的 `thread/list` 获取。传入交互来源、非归档条件、更新时间排序和 `useStateDbOnly: true`。每页 50 条；项目选择独立传入登记目录，而不是过滤全局第一页。对旧聊天空 `project_id` 按登记根目录兼容归属，不修改原索引。
4. 使用官方 `name` / `preview` 与 thread ID，不根据日志头猜标题，也不将一个 thread 的多个 rollout 当成多条聊天。内部 Guardian、审查和子 Agent 记录不作为用户聊天。
5. 导入时重新 `thread/read`，不恢复聊天；通过 `thread/turns/list` 按正序读取全部历史分页。仅迁移可见用户文本与回复，脱敏后生成原有一次性接力预览。

## 版本与降级

- 从实际安装的 CLI 导出协议 schema，确认 `useStateDbOnly` 与来源过滤受支持；按二进制版本信息缓存探测，避免旧客户端忽略参数后自动修复索引。
- 接口不可用时，明确显示“兼容读取 · 客户端可见性未验证”。本地索引仍可展示标题和项目。
- 旧版正文只从索引当前指向、身份一致的活动日志读取。没有数据库时，旧日志按聊天 ID 去重，并利用名称索引补充标题。
- 分页历史不能降级成某一份旧日志；无法获取完整分页时阻止导入，不伪装成完整上下文。分页途中失败也不混入另一种来源。
- 会话数据有大小与数量上限，超限明确失败，不静默截断。JSON-RPC 方法有白名单、响应上限、超时及子进程清理。

## 验证

- `npm test`：项目查询不依赖全局首屏、去重、内部记录过滤、分页顺序、完整性、脱敏、协议限制、旧日志兼容。
- `node scripts/verify-codex-workspace.mjs`：隔离 Electron + 原生 SQLite/WAL + 合成只读协议；验证超过 50 条聊天、较旧项目、多个根目录/项目别名、空项目、搜索、官方正文、预览与系统剪贴板，以及显式降级。
- `node scripts/verify-codex-workspace.mjs --receiver`：仅用合成历史，实际交给禁用工具和 MCP 的 Claude Code，核对结果；恢复原剪贴板。
- `node scripts/verify-codex-workspace.mjs --live`：只读核对本机 `shop_agent` 的一条真实聊天、标题和官方正文，生成本地预览；不复制或发送私人聊天，不可与 `--receiver` 合用。
- `node scripts/verify-handoff-workspace.mjs`：保留 OpenCode / Claude Code / 旧版 Codex 导入和接力回归。

## 参考

- [官方 App Server 协议](https://developers.openai.com/codex/app-server/)
- [Codex-Session-Manager](https://github.com/fengchenzxc/Codex-Session-Manager)：客户端可见性与本地状态区分。
- [codex-sessions](https://github.com/seba-rb/codex-sessions)：官方 JSON-RPC 与会话分页。
- [SessionManager](https://github.com/gitmeBT/SessionManager)：thread ID 与当前 rollout 路径关联。
