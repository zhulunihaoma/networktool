# 2026-10-03 首版验收记录

本记录区分源码测试、桌面操作、安装包构建和平台实机运行。

## 已完成

- `npm run build` 通过 TypeScript、Vite 与主进程 / preload 构建。
- `npm test`：21 项通过，0 失败，0 跳过。包含输入校验、R01–R08、缺失证据、报告脱敏和本地路径保留、SQLite 恢复，以及受控 TLS、CONNECT、SOCKS5、429、407、证书拒绝、取消测试。
- Prettier 检查通过；`git diff --check` 无报错。本仓库尚无初始提交，新增源码未进入 Git diff，因此格式检查是新增文件的主要格式验证。
- macOS ARM64 `.app` 与 ZIP 打包成功；Windows x64 NSIS `.exe` 打包成功。
- 原生开发版读到真实进程和 TCP 快照；选择当前进程实例，按 60 秒观察完成诊断。
- 测试目标使用 `.invalid` 域名，真实系统解析返回 `ENOTFOUND`。R01 显示支持有限和未确认项，后续 TCP 阶段显示跳过，未伪造成功结果。
- 原生界面打开证据详情和脱敏报告预览，通过系统保存窗口导出 Markdown。
- 最终 `.app` 从 `app.asar` 成功启动，读取到前次会话；再次通过原生保存窗口导出 [最终验收报告](desktop-final-report.md)，报告目标为 `target_1`，本地配置路径为 `local`。
- [最终程序首页截图](../screenshots/desktop-home.png)来自打包后的原生应用；[诊断结果截图](../screenshots/diagnosis.png)来自本机真实诊断。
- `npm audit --omit=dev`：运行时依赖 0 告警。

## 尚未完成或需要后续验证

- Windows 11 实机采集、运行、安装和权限覆盖尚未验收，跨平台打包成功不表示 Windows 功能实测通过。
- 应用未配置发布签名；macOS 未公证。当前为开发验收构建。
- 云端 AI、模型密钥管理、ETW、Network Extension、UDP 远端归因、逐进程字节统计尚未接入。
- 长时间稳定性、性能指标、百万级数据查询和文档全部发布要求尚未验收。
- 全量开发依赖审计仍有 8 个关联高危告警，源头是构建工具链的 `http-cache-semantics`。兼容的 `npm audit fix` 未能修复；截至核对时上游没有修复版本。该依赖不包含在应用运行时依赖中。参见 [GitHub 安全公告](https://github.com/advisories/GHSA-ch52-4w7c-c8xp)。

实现采用 Electron + React + TypeScript + Node.js 核心，SQLite 使用 sql.js；与文档建议的 Tauri / Rust、原生 SQLite WAL 方案的差异已在 README 说明。

安装包 SHA-256 见 [checksums.txt](checksums.txt)。
