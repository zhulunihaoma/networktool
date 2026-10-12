// Bundled guidance is reviewed data, never downloaded executable code.
// Official documentation does not by itself qualify a concrete installed version for repair.
export interface NetworkGuidance {
  productId: string;
  releaseState: "draft";
  testedVersions: readonly string[];
  reviewedAt: string;
  source: { label: string; url: string };
  facts: string[];
  manualSteps: string[];
  missingTests: string[];
}
export const NETWORK_GUIDANCE: readonly NetworkGuidance[] = [
  {
    productId: "codex",
    releaseState: "draft",
    testedVersions: [],
    reviewedAt: "2026-10-04",
    source: {
      label: "OpenAI Codex 官方代理源码（main，不是本机版本证明）",
      url: "https://github.com/openai/codex/blob/main/codex-rs/http-client/src/outbound_proxy.rs",
    },
    facts: [
      "官方主分支区分 HTTP、HTTPS 和 WebSocket 的代理选择；还存在系统代理分支。不能只看一个 HTTPS_PROXY 就断言当前桌面组件的路径。",
      "桌面宿主、CLI、MCP 子进程与云端任务需分别确定配置与运行位置。",
    ],
    manualSteps: [
      "在当前失败组件记录复现时刻和实际错误阶段，先比较诊断路径。",
      "确认目标版本、系统代理设置及启动时继承的环境；保留未取得的环境为未知。",
    ],
    missingTests: [
      "本机二进制与源码版本对应",
      "系统代理与环境冲突优先级",
      "WebSocket 和流式目标功能复测",
    ],
  },
  {
    productId: "claude-code",
    releaseState: "draft",
    testedVersions: [],
    reviewedAt: "2026-10-04",
    source: {
      label: "Claude Code 官方企业网络配置",
      url: "https://code.claude.com/docs/en/network-config",
    },
    facts: [
      "当前官方文档说明代理变量在启动时读取；小写与大写变量有具体优先级，不能以通用规则替代。Claude Code 不支持 SOCKS 代理。",
      "CLI、Desktop 托管连接、后台会话的配置作用域不同；CA 信任还取决于安装方式与运行时版本。",
    ],
    manualSteps: [
      "先区分终端 CLI、Desktop 会话和后台 Agent，再按官方作用域核对代理配置。",
      "变更终端环境后使用新会话复测；在工具自身状态页核对实际代理，模型成功标准仍需单独验证。",
    ],
    missingTests: [
      "确切工具版本与安装方式",
      "多个代理变量和 settings 作用域冲突",
      "目标功能与证书信任复测",
    ],
  },
  {
    productId: "cursor",
    releaseState: "draft",
    testedVersions: [],
    reviewedAt: "2026-10-04",
    source: {
      label: "Cursor 官方网络与代理排查",
      url: "https://cursor.com/help/troubleshooting/network",
    },
    facts: [
      "官方排查说明流式响应使用 HTTP/2；某些企业代理可能与其不兼容。",
      "Cursor Remote SSH 的官方说明将 AI 请求路径与远端文件访问区分；此说明不代表所有插件或其他远端模式相同。",
    ],
    manualSteps: [
      "打开 Cursor Settings → Network → Run Diagnostics，记录工具自身的结果。",
      "若证据指向 HTTP/2 兼容性，可按官方说明记录原 HTTP Compatibility Mode、手动切至 HTTP/1.1 并重启；失败时恢复原设置。",
    ],
    missingTests: [
      "本机版本的实际设置位置",
      "代理与流式连接对照",
      "重启与恢复原设置实验",
    ],
  },
  {
    productId: "vscode",
    releaseState: "draft",
    testedVersions: [],
    reviewedAt: "2026-10-04",
    source: {
      label: "VS Code 官方网络连接说明",
      url: "https://code.visualstudio.com/docs/setup/network",
    },
    facts: [
      "官方说明宿主采用 Chromium 网络能力；扩展和 CLI 存在不同的代理支持范围。",
      "宿主更新或市场连接成功，不证明某扩展的模型请求成功；不能将 VS Code 的规则外推至 Cursor。",
    ],
    manualSteps: [
      "先确认失败的是宿主、扩展还是 CLI，以及运行在本机还是远端。",
      "按该组件的官方配置核对代理和证书，不关闭 TLS 校验；处理后在原功能中复测。",
    ],
    missingTests: [
      "宿主与扩展确切版本",
      "扩展网络栈与代理优先级",
      "远端实际配置与功能验证",
    ],
  },
];
export const ADAPTER_SOURCE_URLS = NETWORK_GUIDANCE.map(
  (profile) => profile.source.url,
);
export function guidanceFor(productId: string) {
  return NETWORK_GUIDANCE.find((profile) => profile.productId === productId);
}
export function repairEligibility(productId: string, version?: string) {
  const profile = guidanceFor(productId);
  return {
    allowed: false as const,
    reason: !version
      ? "工具版本未知，不启用专用修复。"
      : !profile || !profile.testedVersions.includes(version)
        ? "该版本未通过组件适配与回滚实验，不启用专用修复。"
        : "适配档案尚未发布，不启用专用修复。",
  };
}
