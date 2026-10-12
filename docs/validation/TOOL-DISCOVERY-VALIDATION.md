# 本机工具识别、版本与更新提示验收

2026-10-04。本次补充解决固定应用文件名、有限产品目录、只扫描当前 PATH 和扩展发行者大小写导致的漏识别。安装发现不需要启动目标工具，运行状态单独呈现。

## 本次实现

- macOS 扫描系统与用户 Applications，包含两层子目录和应用链接；以已知 Bundle ID 优先判断工具，应用改名不再漏掉。同一真实路径去重，名称匹配但标识不符的应用保留为候选。
- 产品目录扩展至 21 类，包含本机 Codex、Claude、OpenCode、WorkBuddy、WisCode、两种 DeepSeek 桌面工具、CC Switch、纳米 AI、VS Code，以及 Cursor、Windsurf、Trae、Kiro、Zed、Gemini CLI、Qwen Code、OpenClaw、CodeBuddy CLI 等。不同安装位置与宿主/CLI 版本保持独立。
- CLI 检查 PATH、用户级原生目录、Homebrew、npm、Bun、Volta、NVM 与 fnm 的有限安装位置；不执行发现的程序或安装脚本。npm 版本必须和 package name、manifest 的 bin 实际路径对应。Claude 原生启动器版本通过版本文件路径或相同文件 SHA256 验证，不按最大保留版本推测当前版本。
- 已知 Agent 扩展从用户级安装 manifest 发现，发行者/名称大小写归一化。保留版本逐项展示，安装不证明启用、归属当前宿主进程或正在运行。
- 顶部“检查更新”与单项检查通过主进程白名单查询公开发布元数据，显示本机版本、发布版本、来源、比较渠道和时间。有更新筛选也包含扩展更新。无来源的工具显示应用内检查提示；查询失败、未知版本、较新本机版本与版本一致分开处理。
- 更新使用 Electron 网络栈及正常证书校验，凭据不随查询发送，不发送本机路径或文件。单次请求 10 秒、响应 1 MiB、每批最多 50 个不同查询来源和 45 秒、最多三个工作队列；同批相同发布请求复用结果，分别比较各安装版本。不会自动下载安装更新。
- 更新期间刷新安装记录受限，页面重新进入时读取正在查询的状态，结束后解除忙碌。置顶的并发变更不会被查询结果覆盖；安装版本变化清除旧更新判断，候选和历史记录不沿用已确认的更新结论。

## 原生实机结果

使用临时用户数据目录运行真实 Electron 页面，真实读取本机安装元数据与公开发布源。结果记录于 [TOOL-DISCOVERY-result.json](TOOL-DISCOVERY-result.json)，时间及更新结果以该文件为准，发布版本后续可能变化。

- 已确认 13 条安装：10 个桌面安装和 3 个 CLI 安装。其中 7 条没有确认运行中的进程。
- 13 条均取得安装版本。OpenCode 桌面与 NVM CLI 分别为 1.18.34、1.18.15；Claude Code 用户级原生与 NVM 安装分别为 2.1.278、2.1.29。
- VS Code 下识别 4 条 Claude Code 扩展保留版本（2.1.283、2.1.285、2.1.286、2.1.288）和极库 Copilot Code 2.1.7。
- 本次获得 CC Switch、VS Code、两条 Claude Code CLI、OpenCode CLI、WorkBuddy 的较新发布版本；OpenCode 桌面、WisCode、DeepSeek Harness 与本次比较源一致。
- DSH Desktop 更新源查询失败；Visual Studio Marketplace 对本机扩展查询返回 HTTP 403。错误在界面显示，未因此宣称已经最新。
- Codex/Claude 桌面及纳米 AI 暂无在此实现中核验的自动发布接口，提供在工具内检查提示。Codex 随桌面应用附带的 CLI 没有取得可核验的版本元数据，保留为候选；不拿桌面版本充当 CLI 版本。
- 界面默认不运行网页平台探测；有更新筛选、详情来源、版本独立展示、1024 × 720 无横向溢出、页面错误数组为空均通过。

页面截图：[tool-discovery-updates.png](../screenshots/tool-discovery-updates.png)。

## 测试与构建

Node.js 24.19.0 完整测试 56 项通过，0 失败、0 跳过；TypeScript、Vite、Electron 主进程/preload 构建通过。新增测试覆盖改名/嵌套/链接/未运行安装、Bundle ID 冲突、NVM 非当前版本、npm bin 不一致、原生启动器版本匹配、扩展大小写与保留版本、数字/预发布版本比较、未知版本、错误和大小预算、平台与稳定扩展过滤、查询去重、并发置顶以及安装版本变化。

```sh
node --import tsx --test tests/*.test.ts
npm run build
node scripts/verify-tool-updates.mjs
```

## 当前边界

本次实机验收为 macOS Apple Silicon。Windows 卸载记录仍作为候选，未在 Windows 验收发布者校验；不声明所有系统或全盘发现。自定义安装目录、Python/pipx 工具、商店包、远端/容器和未登记产品可能需要手动关联或新增发现规则。扩展目录扫描不判断编辑器选用哪个保留版本，更新提示也不证明宿主兼容性、灰度更新资格或实际安装完成。

部分工具的更新渠道只有应用内接口或受企业分发控制。无可核验来源时显示“需在工具内检查”，请求失败显示失败；不抓取账号配置、不执行更新命令、不关闭证书校验来获取结果。此前完整文档中的修复、文件网关、隔离及系统审计缺口仍见 [ASSISTANT-VALIDATION.md](ASSISTANT-VALIDATION.md)。现有 release 安装包未重新生成。

## 发布来源

- [OpenCode 官方项目](https://github.com/anomalyco/opencode)及 GitHub Releases；npm 的 opencode-ai。
- [CC Switch 官方项目](https://github.com/farion1231/cc-switch)及 GitHub Releases。
- [VS Code 官方更新服务源码](https://github.com/microsoft/vscode/blob/main/src/vs/platform/update/electron-main/updateService.darwin.ts)。
- [Claude Code 安装与渠道说明](https://code.claude.com/docs/en/setup)；CLI 比较源为 npm latest，未将其冒充工具内配置的 stable 渠道。
- [WorkBuddy 官方更新日志](https://www.codebuddy.cn/docs/workbuddy/Changelog)，仅解析发布标题，不执行网页脚本。
- [VS Code 官方扩展市场查询源码](https://github.com/microsoft/vscode/blob/main/src/vs/platform/extensionManagement/common/extensionGalleryService.ts)。
- WisCode、DeepSeek Harness、DSH Desktop 的固定来源来自本机应用随附更新元数据。路径和渠道在实现中固定，不允许渲染器或任意应用注入请求 URL。
