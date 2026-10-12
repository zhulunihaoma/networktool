import {
  TOOL_PRODUCTS,
  installed,
  type ToolInstall,
  type ToolUpdate,
} from "../../src/shared/assistant";
export const UPDATE_PAGE_URLS = [
  "https://github.com/anomalyco/opencode/releases",
  "https://github.com/farion1231/cc-switch/releases",
  "https://github.com/anywhere-labs/deepseek-harness-desktop/releases",
  "https://code.visualstudio.com/updates",
  "https://code.claude.com/docs/en/setup",
  "https://claude.com/download",
  "https://chatgpt.com/codex",
  "https://cursor.com/download",
  "https://www.codebuddy.cn/docs/workbuddy/Download-History",
  "https://wiscode.qihoo.net",
  "https://www.codebuddy.cn/docs/workbuddy/Changelog",
  "https://download.deepseek.com/dsh-desk/feeds/mac-arm64/",
  "https://github.com/openai/codex/releases",
  "https://github.com/google-gemini/gemini-cli/releases",
  "https://github.com/QwenLM/qwen-code/releases",
  "https://github.com/openclaw/openclaw/releases",
];
type Source = {
  url: string;
  page: string;
  label: string;
  channel: string;
  format: "npm" | "github" | "vscode" | "yaml" | "workbuddy-log";
  assetPrefix?: string;
};
export function updateSource(
  tool: ToolInstall,
  platform = process.platform,
  arch = process.arch,
): Source | undefined {
  const cli = tool.components[0]?.role === "cli";
  if (cli) {
    const product = TOOL_PRODUCTS.find((p) => p.id === tool.productId);
    if (product?.packageName)
      return {
        url: `https://registry.npmjs.org/${encodeURIComponent(product.packageName)}/latest`,
        page: manualPage(tool.productId),
        label: `npm 官方注册表 · ${product.packageName}`,
        channel: "npm latest（未核验工具内自动更新渠道）",
        format: "npm",
      };
    return;
  }
  const github: Record<string, [string, string?]> = {
    opencode: ["anomalyco/opencode", "opencode-desktop"],
    "cc-switch": ["farion1231/cc-switch"],
    "dsh-desktop": ["anywhere-labs/deepseek-harness-desktop"],
  };
  const repository = github[tool.productId];
  if (repository)
    return {
      url: `https://api.github.com/repos/${repository[0]}/releases/latest`,
      page: `https://github.com/${repository[0]}/releases`,
      label:
        tool.productId === "dsh-desktop"
          ? "应用提供的 GitHub 发布源"
          : "项目 GitHub Releases",
      channel: "latest 稳定发布",
      format: "github",
      assetPrefix: repository[1],
    };
  if (tool.productId === "vscode") {
    // Insiders have a separate identity/version scheme; never compare them to stable.
    if (tool.channel && tool.channel !== "stable") return;
    const target =
      platform === "darwin"
        ? arch === "arm64"
          ? "darwin-arm64"
          : "darwin"
        : platform === "win32"
          ? arch === "arm64"
            ? "win32-arm64-user"
            : "win32-x64-user"
          : undefined;
    if (target)
      return {
        url: `https://update.code.visualstudio.com/api/update/${target}/stable/latest`,
        page: "https://code.visualstudio.com/updates",
        label: "VS Code 官方更新服务",
        channel: "stable",
        format: "vscode",
      };
  }
  if (tool.productId === "workbuddy")
    return {
      url: "https://www.codebuddy.cn/docs/workbuddy/Changelog",
      page: "https://www.codebuddy.cn/docs/workbuddy/Changelog",
      label: "WorkBuddy 官方更新日志",
      channel: "公开日志的已发布版本（不代表灰度渠道）",
      format: "workbuddy-log",
    };
  if (platform === "darwin" && arch === "arm64" && tool.productId === "wiscode")
    return {
      url: "https://wiscode.qihoo.net/api/releases/desktop/macos/arm64/update/latest/latest-mac.yml",
      page: "https://wiscode.qihoo.net",
      label: "应用随附的 WisCode 更新源",
      channel: "macOS arm64 latest",
      format: "yaml",
    };
  if (
    platform === "darwin" &&
    arch === "arm64" &&
    tool.productId === "deepseek-harness"
  )
    return {
      url: "https://download.deepseek.com/dsh-desk/feeds/mac-arm64/nightly-mac.yml",
      page: "https://download.deepseek.com/dsh-desk/feeds/mac-arm64/",
      label: "应用随附的 DeepSeek 更新源",
      channel: "macOS arm64 nightly",
      format: "yaml",
    };
}
function manualPage(id: string): string {
  return (
    (
      {
        codex: "https://chatgpt.com/codex",
        "claude-code": "https://code.claude.com/docs/en/setup",
        "claude-desktop": "https://claude.com/download",
        cursor: "https://cursor.com/download",
        workbuddy: "https://www.codebuddy.cn/docs/workbuddy/Download-History",
        "gemini-cli": "https://github.com/google-gemini/gemini-cli/releases",
        "qwen-code": "https://github.com/QwenLM/qwen-code/releases",
        openclaw: "https://github.com/openclaw/openclaw/releases",
        opencode: "https://github.com/anomalyco/opencode/releases",
        "codebuddy-cli":
          "https://www.codebuddy.cn/docs/workbuddy/Download-History",
      } as Record<string, string>
    )[id] || ""
  );
}
export function initialUpdate(tool: ToolInstall): ToolUpdate {
  if (!installed(tool))
    return {
      status: "unknown",
      installedVersion: tool.version,
      message: "先核验安装身份；候选或历史记录不查询更新。",
    };
  const source = updateSource(tool);
  if (!source)
    return {
      status: "manual",
      installedVersion: tool.version,
      sourceUrl: manualPage(tool.productId) || undefined,
      message:
        "尚无经核验的机器可读发布源，请在工具的“检查更新”或官方发布页确认。",
    };
  return {
    status: "not_checked",
    installedVersion: tool.version,
    source: source.label,
    sourceUrl: source.page,
    channel: source.channel,
    message: "点击检查更新，只查询公开发布元数据。",
  };
}
// Numeric segments, prerelease order and build metadata; no locale/lexicographic version guesses.
export function compareVersions(a: string, b: string): number | undefined {
  const parse = (s: string) => {
    const match =
      /^v?(\d+(?:\.\d+){1,3})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
        s,
      );
    if (!match) return;
    const numbers = match[1].split(".").map(Number);
    if (numbers.some((n) => !Number.isSafeInteger(n))) return;
    return { numbers, pre: match[2]?.split(".") };
  };
  const left = parse(a),
    right = parse(b);
  if (!left || !right) return;
  for (
    let i = 0;
    i < Math.max(left.numbers.length, right.numbers.length);
    i++
  ) {
    const delta = (left.numbers[i] || 0) - (right.numbers[i] || 0);
    if (delta) return Math.sign(delta);
  }
  if (!left.pre && !right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const l = left.pre[i],
      r = right.pre[i];
    if (l === r) continue;
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = /^\d+$/.test(l),
      rn = /^\d+$/.test(r);
    if (ln && rn) {
      const x = BigInt(l),
        y = BigInt(r);
      if (x !== y) return x > y ? 1 : -1;
      continue;
    }
    if (ln !== rn) return ln ? -1 : 1;
    return l > r ? 1 : -1;
  }
  return 0;
}
export type UpdateFetch = (url: string, init: RequestInit) => Promise<Response>;
export async function readPublicMetadata(
  url: string,
  request: UpdateFetch,
  init: RequestInit = {},
): Promise<string> {
  const response = await request(url, {
    ...init,
    method: init.method || "GET",
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(10000)])
      : AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (Number(response.headers.get("content-length")) > 1024 * 1024)
    throw new Error("发布元数据超出大小限制");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("没有发布元数据");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1024 * 1024) throw new Error("发布元数据超出大小限制");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf8");
}
// Deduplicate identical public lookups across retained installations/extension versions.
// Each operation caps unique sources and total duration; no responses survive the operation.
export function scopedUpdateFetch(
  request: UpdateFetch,
  signal = AbortSignal.timeout(45000),
  maxSources = 50,
): UpdateFetch {
  const cache = new Map<string, Promise<string>>();
  return async (url, init) => {
    if (signal.aborted) throw new Error("更新查询时间预算已到");
    const key =
      url + "\n" + (init.method || "GET") + "\n" + String(init.body || "");
    let value = cache.get(key);
    if (!value) {
      if (cache.size >= maxSources) throw new Error("更新查询来源预算已到");
      value = readPublicMetadata(url, request, {
        ...init,
        signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal,
      });
      cache.set(key, value);
    }
    return new Response(await value);
  };
}
export async function checkToolUpdate(
  tool: ToolInstall,
  request: UpdateFetch = fetch,
): Promise<ToolUpdate> {
  const initial = initialUpdate(tool),
    source = updateSource(tool);
  if (!source || !installed(tool)) return initial;
  const checkedAt = Date.now(),
    base = { ...initial, checkedAt };
  try {
    const text = await readPublicMetadata(source.url, request, {
      headers: {
        Accept:
          source.format === "yaml"
            ? "text/plain"
            : source.format === "workbuddy-log"
              ? "text/html"
              : "application/json",
      },
    });
    let latestVersion: unknown;
    if (source.format === "yaml")
      latestVersion = /^version:\s*["']?([^\s"']+)["']?\s*$/m.exec(text)?.[1];
    else if (source.format === "workbuddy-log") {
      // Match release headings only. Page scripts and unrelated dependency versions are never evaluated.
      const headings = text.match(/<h2\b[^>]*>[\s\S]*?<\/h2>/gi) || [];
      const versions = headings.flatMap((heading) => {
        const version = heading
          .replace(/<[^>]+>/g, "")
          .match(/(\d+\.\d+\.\d+)\s*版本发布/);
        return version ? [version[1]] : [];
      });
      latestVersion = versions.sort((a, b) => compareVersions(b, a) || 0)[0];
    } else {
      const data = JSON.parse(text);
      if (source.format === "github") {
        if (data.draft || data.prerelease)
          throw new Error("发布源返回了非稳定版本");
        if (
          source.assetPrefix &&
          !data.assets?.some((a: { name?: string }) =>
            a.name?.startsWith(source.assetPrefix!),
          )
        )
          throw new Error("发布源未包含桌面版安装资产");
        latestVersion = data.tag_name;
      } else
        latestVersion =
          source.format === "vscode" ? data.productVersion : data.version;
    }
    if (
      typeof latestVersion !== "string" ||
      latestVersion.length > 100 ||
      compareVersions(latestVersion, latestVersion) !== 0
    )
      throw new Error("发布版本格式无法核验");
    latestVersion = latestVersion.replace(/^v/, "");
    const comparison = tool.version
      ? compareVersions(tool.version, latestVersion as string)
      : undefined;
    const status =
      comparison === undefined
        ? "unknown"
        : comparison < 0
          ? "available"
          : comparison > 0
            ? "installed_newer"
            : "current";
    const message =
      comparison === undefined
        ? "已取得发布版本，本机版本未知或格式无法比较，不能判定是否需要更新。"
        : comparison < 0
          ? "发布源有较新版本；更新前请在原工具核对渠道与兼容性。"
          : comparison > 0
            ? "本机版本高于此发布源，可能来自预览、灰度或其他渠道；不建议降级。"
            : "本机版本与本次发布源版本一致；不代表所有灰度渠道均无更新。";
    return { ...base, status, latestVersion: latestVersion as string, message };
  } catch (error) {
    const raw = error instanceof Error ? error.message : "";
    const reason =
      /^HTTP \d+$/.test(raw) || /元数据|发布源|版本格式|预算/.test(raw)
        ? raw
        : "网络、证书或超时错误";
    return {
      ...base,
      status: "error",
      message: `更新查询未完成（${reason}），不能判定已是最新。可在工具内检查后重试。`,
    };
  }
}
