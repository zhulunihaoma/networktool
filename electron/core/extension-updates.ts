import {
  AGENT_EXTENSIONS,
  type ToolComponent,
  type ToolUpdate,
} from "../../src/shared/assistant";
import {
  compareVersions,
  readPublicMetadata,
  type UpdateFetch,
} from "./tool-updates";
export const EXTENSION_PAGE_URLS = Object.keys(AGENT_EXTENSIONS).map(
  (id) => `https://marketplace.visualstudio.com/items?itemName=${id}`,
);
export function initialExtensionUpdate(
  id?: string,
  version?: string,
): ToolUpdate {
  if (!id || !AGENT_EXTENSIONS[id])
    return {
      status: "manual",
      installedVersion: version,
      message: "扩展尚无可核验的发布源，请在编辑器扩展页检查更新。",
    };
  if (id === "geelib-copilot-code.copilotcodepro")
    return {
      status: "manual",
      installedVersion: version,
      message: "企业扩展需在编辑器或企业分发渠道核对更新。",
    };
  return {
    status: "not_checked",
    installedVersion: version,
    source: "Visual Studio Marketplace",
    sourceUrl: `https://marketplace.visualstudio.com/items?itemName=${id}`,
    channel: "公开稳定发布（未验证编辑器兼容性）",
    message: "点击检查更新查询扩展发布版本；保留版本不代表正在启用。",
  };
}
export async function checkExtensionUpdate(
  component: ToolComponent,
  request: UpdateFetch = fetch,
): Promise<ToolUpdate> {
  const initial = initialExtensionUpdate(
    component.extensionId,
    component.version,
  );
  if (initial.status === "manual") return initial;
  const base = { ...initial, checkedAt: Date.now() },
    id = component.extensionId!;
  try {
    const text = await readPublicMetadata(
      "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery",
      request,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json;api-version=7.2-preview.1",
        },
        // IncludeVersions (1) + IncludeVersionProperties (16): required to reject prereleases.
        body: JSON.stringify({
          filters: [
            {
              criteria: [{ filterType: 7, value: id }],
              pageNumber: 1,
              pageSize: 1,
            },
          ],
          flags: 17,
        }),
      },
    );
    const extensions = JSON.parse(text).results?.[0]?.extensions;
    const extension = Array.isArray(extensions)
      ? extensions.find(
          (e) =>
            `${e.publisher?.publisherName}.${e.extensionName}`.toLowerCase() ===
            id,
        )
      : undefined;
    if (!extension || !Array.isArray(extension.versions))
      throw new Error("没有扩展发布元数据");
    const versions = extension.versions
      .filter(
        (v: {
          version?: string;
          targetPlatform?: string;
          properties?: { key: string; value: string }[];
        }) =>
          typeof v.version === "string" &&
          compareVersions(v.version, v.version) === 0 &&
          !v.properties?.some(
            (p) =>
              p.key === "Microsoft.VisualStudio.Code.PreRelease" &&
              p.value === "true",
          ) &&
          (!v.targetPlatform ||
            v.targetPlatform === "universal" ||
            (component.targetPlatform &&
              v.targetPlatform === component.targetPlatform)),
      )
      .map((v: { version: string }) => v.version)
      .sort((a: string, b: string) => compareVersions(b, a) || 0);
    const latestVersion = versions[0];
    if (!latestVersion) throw new Error("无法确认同平台稳定发布版本");
    const delta = component.version
      ? compareVersions(component.version, latestVersion)
      : undefined;
    const status =
      delta === undefined
        ? "unknown"
        : delta < 0
          ? "available"
          : delta > 0
            ? "installed_newer"
            : "current";
    return {
      ...base,
      status,
      latestVersion,
      message:
        delta === undefined
          ? "本机版本无法比较，请在扩展页确认。"
          : delta < 0
            ? "扩展发布源有新版本；请在编辑器确认宿主兼容性及启用版本。"
            : delta > 0
              ? "此保留版本比稳定发布源更新，可能是预发布渠道。"
              : "此版本与本次扩展发布源一致；不证明它正在启用。",
    };
  } catch (error) {
    const raw = error instanceof Error ? error.message : "";
    const reason = /^HTTP \d+$/.test(raw)
      ? raw
      : /预算/.test(raw)
        ? "查询预算已到"
        : "网络、格式或发布平台未确认";
    return {
      ...base,
      status: "error",
      message: `扩展更新查询未完成（${reason}），请在编辑器扩展页检查；不能判定已是最新。`,
    };
  }
}
