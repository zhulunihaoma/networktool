import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  TOOL_PRODUCTS,
  AGENT_EXTENSIONS,
  sortTools,
  installed,
  type ToolInstall,
  type ToolInventory,
  type ToolDiagnosisReference,
  type ToolDiagnosisContext,
} from "../../src/shared/assistant";
import type { ProcessInfo } from "../../src/shared/types";
import type { Store } from "./store";
import {
  discoverMacBundles,
  discoverCLIs,
  cliDirectories,
  smallJSON,
  inspectMacBundle,
  cleanVersion,
} from "./tool-discovery";
import {
  checkExtensionUpdate,
  initialExtensionUpdate,
} from "./extension-updates";
import {
  checkToolUpdate,
  initialUpdate,
  scopedUpdateFetch,
  type UpdateFetch,
} from "./tool-updates";
const execute = promisify(execFile);
type Product = (typeof TOOL_PRODUCTS)[number];
export interface DiscoveredTool {
  productId: string;
  location: string;
  executable?: string;
  version?: string;
  source: string;
  confirmed: boolean;
  role: "host" | "cli";
  channel?: string;
  extensions?: {
    name: string;
    version?: string;
    extensionId?: string;
    targetPlatform?: string;
  }[];
}
export async function discoverKnownTools(): Promise<{
  tools: DiscoveredTool[];
  limitations: string[];
}> {
  const tools: DiscoveredTool[] = [],
    limitations = [
      "检查系统和用户 Applications（含两层子目录、改名应用与应用链接）、PATH 及 NVM/fnm/常见 CLI 安装目录；不依赖工具是否打开。未扫描全盘或个人文档。",
      "版本未知或未经适配实验验证时，仅提供通用诊断；不执行工具专用配置修改。",
      "进程名称匹配仅为候选；镜像路径与创建时间一致的实例单独确认，仍不证明扩展、模型请求或远端活动。",
      "未覆盖 WSL、容器、SSH、商店包和远端 IDE 扩展。",
    ];
  if (process.platform === "darwin") {
    const mac = await discoverMacBundles([
      "/Applications",
      path.join(os.homedir(), "Applications"),
    ]);
    tools.push(...mac.tools);
    limitations.push(...mac.limitations);
  } else if (process.platform === "win32") {
    try {
      // Fixed script: never execute UninstallString, DisplayIcon, registry values or candidate binaries.
      const { stdout } = await execute(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$roots=@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '^(Codex|Cursor|Microsoft Visual Studio Code|Visual Studio Code|ChatGPT|Claude|OpenCode|WorkBuddy|WisCode|DSH Desktop|DeepSeek Harness|CC Switch|NAMIAI|Windsurf|Trae|Kiro|Zed)( |$)' } | Select-Object DisplayName,DisplayVersion,InstallLocation | ConvertTo-Json -Compress",
        ],
        { timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true },
      );
      const records = stdout.trim() ? JSON.parse(stdout) : [];
      for (const record of Array.isArray(records) ? records : [records]) {
        const name = String(record.DisplayName || "");
        const product = TOOL_PRODUCTS.find((p) =>
          p.apps.some(
            (appName) =>
              name.startsWith(appName) ||
              (p.id === "vscode" &&
                name.startsWith("Microsoft Visual Studio Code")),
          ),
        );
        if (!product) continue;
        const location =
          typeof record.InstallLocation === "string" &&
          path.isAbsolute(record.InstallLocation) &&
          !record.InstallLocation.startsWith("\\\\")
            ? record.InstallLocation
            : "";
        const executable = {
          codex: "Codex.exe",
          cursor: "Cursor.exe",
          vscode: "Code.exe",
        }[product.id as "codex" | "cursor" | "vscode"];
        let present = false;
        if (location && executable)
          try {
            present = (await fs.stat(path.join(location, executable))).isFile();
          } catch {}
        tools.push({
          productId: product.id,
          location: location || `卸载记录：${name}`,
          version:
            typeof record.DisplayVersion === "string"
              ? record.DisplayVersion
              : undefined,
          source: "Windows 卸载项（待核验发布者）",
          confirmed: false,
          role: "host",
        });
        if (!present)
          limitations.push(
            `${product.name} 卸载记录未确认程序仍存在，不能据此判定已安装。`,
          );
      }
    } catch {
      limitations.push("Windows 卸载项读取未完成，安装发现覆盖下降。");
    }
  }
  tools.push(...(await discoverCLIs(await cliDirectories())));
  for (const productId of ["vscode", "cursor"]) {
    if (!tools.some((t) => t.productId === productId && t.role === "host"))
      continue;
    try {
      const extensions = await discoverExtensions(productId);
      for (const tool of tools.filter(
        (t) => t.productId === productId && t.role === "host",
      ))
        tool.extensions = extensions;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        limitations.push(`${productId} 用户级扩展目录无法读取，组件覆盖下降。`);
    }
  }
  limitations.push(
    "扩展只识别用户目录内 Codex、Claude Code、Copilot、Cline、Roo、Kilo 等已知 Agent 扩展 manifest；保留版本逐项列出，未判断哪些正在启用；安装记录不证明激活、运行位置或请求归属。",
  );
  return {
    tools: [
      ...new Map(
        tools.map((t) => [t.productId + ":" + t.location, t]),
      ).values(),
    ],
    limitations: [...new Set(limitations)],
  };
}
export async function discoverExtensions(
  productId: string,
  home = os.homedir(),
) {
  const directory = path.join(
    home,
    productId === "vscode" ? ".vscode" : ".cursor",
    "extensions",
  );
  const known = AGENT_EXTENSIONS;
  const extensions: NonNullable<DiscoveredTool["extensions"]> = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries.slice(0, 1000)) {
    if (
      !entry.isDirectory() ||
      !Object.keys(known).some((id) =>
        entry.name.toLowerCase().startsWith(id + "-"),
      )
    )
      continue;
    const manifestPath = path.join(directory, entry.name, "package.json");
    try {
      if ((await fs.lstat(manifestPath)).isSymbolicLink()) continue;
      const manifest = await smallJSON(manifestPath),
        id = `${manifest.publisher}.${manifest.name}`.toLowerCase();
      if (!known[id]) continue;
      extensions.push({
        name: known[id],
        extensionId: id,
        targetPlatform:
          typeof manifest.__metadata?.targetPlatform === "string" &&
          manifest.__metadata.targetPlatform !== "undefined"
            ? manifest.__metadata.targetPlatform
            : undefined,
        version: cleanVersion(manifest.version),
      });
    } catch {}
  }
  return extensions;
}
export function component(
  product: Product,
  role: "host" | "cli",
  version?: string,
) {
  return {
    id: randomUUID(),
    name: role === "cli" ? product.name + " CLI" : product.name + " 宿主",
    role,
    version,
    runtime: "local" as const,
    adapterStatus: "unknown" as const,
    features: ["登录", "模型调用", "更新", "MCP"].map((name) => ({
      name,
      status: "not_tested" as const,
      targetSource: "尚未取得此版本的经验证端点与配置规则",
    })),
  };
}
export class ToolRegistry {
  private scanning = false;
  private pending?: Promise<ToolInventory>;
  private updatePending?: Promise<ToolInventory>;
  constructor(
    private store: Pick<Store, "assistant" | "putAssistant">,
    private processes: () => Promise<ProcessInfo[]>,
    private discover = discoverKnownTools,
    private updateChecker = checkToolUpdate,
    private extensionUpdateChecker = checkExtensionUpdate,
    private updateRequest: UpdateFetch = fetch,
  ) {}
  current(): ToolInventory {
    return {
      ...this.store.assistant<ToolInventory>("tools", {
        installs: [],
        scanning: false,
        limitations: [],
      }),
      scanning: this.scanning,
      checkingUpdates: !!this.updatePending,
    };
  }
  scan() {
    if (this.updatePending)
      throw new Error("请等待更新查询完成再刷新安装记录。");
    if (this.pending) return this.pending;
    this.pending = this.performScan().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async performScan() {
    this.scanning = true;
    try {
      const { tools, limitations } = await this.discover();
      let processes: ProcessInfo[] = [];
      try {
        processes = await this.processes();
      } catch {
        limitations.push("进程快照不可用，运行状态未知。");
      }
      const old = this.current().installs;
      for (const manual of old.filter((i) =>
        i.sources.includes("manual：用户选定程序路径"),
      )) {
        if (
          tools.some(
            (t) =>
              t.productId === manual.productId &&
              t.location === manual.location,
          )
        )
          continue;
        try {
          const stat = await fs.lstat(manual.location);
          if (!stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory()))
            tools.push({
              productId: manual.productId,
              location: manual.location,
              source: "manual：用户选定程序路径",
              role: manual.components[0]?.role === "cli" ? "cli" : "host",
              confirmed: true,
            });
        } catch {}
      }
      const installs: ToolInstall[] = tools.map((found) => {
        const product = TOOL_PRODUCTS.find((p) => p.id === found.productId)!;
        const previous = old.find(
          (p) => p.productId === product.id && p.location === found.location,
        );
        const matchedImages = found.executable
          ? processes.filter(
              (p) => p.imagePath === found.executable && !!p.created,
            )
          : [];
        const bound = found.confirmed ? matchedImages : [];
        const manualConfirmed =
          !!previous?.sources.includes("manual：用户选定程序路径") &&
          !found.source.includes("Info.plist");
        return {
          id: previous?.id || randomUUID(),
          productId: product.id,
          name: product.name,
          location: found.location,
          version: found.version,
          channel: found.channel,
          update:
            previous &&
            previous.version === found.version &&
            previous.channel === found.channel
              ? previous.update
              : undefined,
          sources: [
            ...new Set([
              found.source,
              ...(manualConfirmed ? ["manual：用户选定程序路径"] : []),
            ]),
          ],
          identityStatus: bound.length
            ? "running_confirmed"
            : found.confirmed || manualConfirmed
              ? "installed_confirmed"
              : "candidate",
          pinned: previous?.pinned || false,
          components: [
            {
              ...component(product, found.role, found.version),
              id: previous?.components[0]?.id || randomUUID(),
            },
            ...(found.extensions || []).map((extension) => ({
              ...component(product, "host", extension.version),
              id:
                previous?.components.find(
                  (c) =>
                    c.role === "extension" &&
                    c.name === extension.name &&
                    c.version === extension.version,
                )?.id || randomUUID(),
              name: extension.name,
              extensionId: extension.extensionId,
              targetPlatform: extension.targetPlatform,
              update:
                previous?.components.find(
                  (c) =>
                    c.extensionId === extension.extensionId &&
                    c.version === extension.version,
                )?.update ||
                initialExtensionUpdate(
                  extension.extensionId,
                  extension.version,
                ),
              role: "extension" as const,
              runtime: "unknown" as const,
              source: "用户级扩展 manifest（不证明与当前宿主实例的运行绑定）",
            })),
          ],
          processKeys: matchedImages.map((p) => p.key),
          lastSeen: Date.now(),
        };
      });
      for (const product of TOOL_PRODUCTS) {
        const names: string[] = [...product.apps, ...product.cli];
        const matches = processes.filter(
          (p) =>
            !installs.some(
              (i) =>
                i.processKeys.includes(p.key) ||
                (i.productId === product.id &&
                  tools.some(
                    (t) =>
                      t.productId === product.id &&
                      t.confirmed &&
                      t.executable === p.imagePath,
                  )),
            ) &&
            names.some(
              (n) =>
                p.name.toLowerCase() === n.toLowerCase() ||
                p.name.toLowerCase() === n.toLowerCase() + ".exe",
            ),
        );
        // No attribution to installations without image paths, especially with several channels.
        const previous = old.find(
          (i) => i.productId === product.id && i.location === "运行名称候选",
        );
        if (matches.length)
          installs.push({
            id: previous?.id || randomUUID(),
            productId: product.id,
            name: product.name,
            location: "运行名称候选",
            identityStatus: "candidate",
            sources: ["进程精确名称（镜像未核验）"],
            components: [
              {
                ...component(product, product.apps.length ? "host" : "cli"),
                id: previous?.components[0]?.id || randomUUID(),
              },
            ],
            processKeys: matches.map((p) => p.key),
            lastSeen: Date.now(),
            pinned: previous?.pinned || false,
          });
      }
      for (const previous of old)
        if (!installs.some((p) => p.id === previous.id))
          installs.push({
            ...previous,
            identityStatus: "stale",
            processKeys: [],
          });
      for (const tool of installs)
        if (!tool.update || !installed(tool)) tool.update = initialUpdate(tool);
      const result: ToolInventory = {
        installs: sortTools(installs),
        limitations,
        checkedAt: Date.now(),
        scanning: false,
      };
      this.store.putAssistant("tools", result);
      return result;
    } finally {
      this.scanning = false;
    }
  }
  checkUpdates(id?: string) {
    if (this.scanning) throw new Error("请等待安装识别完成，再检查更新。");
    if (this.updatePending) return this.updatePending;
    const snapshot = this.current().installs.filter((t) => !id || t.id === id);
    if (id && !snapshot.length) throw new Error("工具记录不存在，请刷新。");
    this.updatePending = (async () => {
      const request = scopedUpdateFetch(this.updateRequest);
      const results = new Map<
        string,
        {
          version?: string;
          update: Awaited<ReturnType<typeof checkToolUpdate>>;
          components: {
            id: string;
            version?: string;
            update: Awaited<ReturnType<typeof checkExtensionUpdate>>;
          }[];
        }
      >();
      // Three workers cap public metadata requests; each request has a timeout and byte limit.
      const queue = [...snapshot];
      await Promise.all(
        Array.from({ length: Math.min(3, queue.length) }, async () => {
          for (let tool = queue.shift(); tool; tool = queue.shift()) {
            const update = await this.updateChecker(tool, request);
            const components = [];
            if (
              ["installed_confirmed", "running_confirmed"].includes(
                tool.identityStatus,
              )
            )
              for (const component of tool.components.filter(
                (c) => c.role === "extension",
              ))
                components.push({
                  id: component.id,
                  version: component.version,
                  update: await this.extensionUpdateChecker(component, request),
                });
            results.set(tool.id, { version: tool.version, update, components });
          }
        }),
      );
      const state = this.current();
      for (const tool of state.installs) {
        const result = results.get(tool.id);
        if (result && result.version === tool.version) {
          tool.update = result.update;
          for (const component of tool.components) {
            const checked = result.components.find(
              (c) => c.id === component.id && c.version === component.version,
            );
            if (checked) component.update = checked.update;
          }
        }
      }
      state.checkingUpdates = false;
      this.store.putAssistant("tools", state);
      return state;
    })().finally(() => {
      this.updatePending = undefined;
    });
    return this.updatePending;
  }
  pin(id: string, pinned: boolean) {
    if (this.scanning) throw new Error("请等待工具识别完成后置顶。");
    const state = this.current(),
      tool = state.installs.find((p) => p.id === id);
    if (!tool) throw new Error("工具记录不存在，请刷新。");
    tool.pinned = pinned;
    state.installs = sortTools(state.installs);
    this.store.putAssistant("tools", state);
    return state;
  }
  diagnosisContext(reference: ToolDiagnosisReference): ToolDiagnosisContext {
    if (this.scanning) throw new Error("请等待工具识别完成，再冻结诊断范围。");
    const tool = this.current().installs.find(
      (i) => i.id === reference.installId,
    );
    const selected = tool?.components.find(
      (c) => c.id === reference.componentId,
    );
    if (!tool || !selected || tool.identityStatus === "stale")
      throw new Error("工具或组件记录已失效，请刷新识别并重新选择。");
    return {
      ...reference,
      productId: tool.productId,
      toolName: tool.name,
      componentName: selected.name,
      version: selected.version,
      runtime: selected.runtime,
      adapterStatus: selected.adapterStatus,
      source: selected.source || tool.sources.join("；"),
      identityStatus: tool.identityStatus,
    };
  }
  async manual(productId: string, chosen: string) {
    if (this.scanning || this.updatePending)
      throw new Error("请等待工具识别或更新查询完成。");
    const product = TOOL_PRODUCTS.find((p) => p.id === productId);
    if (!product || !path.isAbsolute(chosen) || chosen.startsWith("\\\\"))
      throw new Error("不支持的工具或非本机路径。");
    const location = await fs.realpath(chosen),
      stat = await fs.stat(location),
      basename = path.basename(chosen);
    if (this.scanning) throw new Error("请等待工具识别完成，再添加程序。");
    const bundle =
      process.platform === "darwin" &&
      stat.isDirectory() &&
      basename.endsWith(".app")
        ? await inspectMacBundle(location)
        : undefined;
    if (bundle && (!bundle.confirmed || bundle.productId !== productId))
      throw new Error("应用包标识与所选工具不一致，不能手动提升确认状态。");
    const host =
      !!bundle ||
      product.apps.some(
        (name) =>
          basename.toLowerCase() === (name + ".app").toLowerCase() ||
          basename.toLowerCase() === (name + ".exe").toLowerCase(),
      );
    const cli = product.cli.some((name) =>
      [name, name + ".exe"].includes(basename.toLowerCase()),
    );
    if (
      (!stat.isFile() && !stat.isDirectory()) ||
      (!host && !cli) ||
      (stat.isDirectory() && !basename.endsWith(".app"))
    )
      throw new Error(
        "请选择已知程序的应用包或可执行文件；不执行未知文件或脚本。",
      );
    const state = this.current(),
      existing = state.installs.find(
        (i) => i.productId === productId && i.location === location,
      );
    if (
      existing?.identityStatus === "candidate" &&
      existing.sources.some((s) => s.includes("Info.plist"))
    )
      throw new Error("应用包身份信号冲突，不能通过手动关联提升确认状态。");
    if (existing && existing.sources.includes("manual：用户选定程序路径"))
      return state;
    const record: ToolInstall = {
      id: existing?.id || randomUUID(),
      productId,
      name: product.name,
      location,
      identityStatus: "installed_confirmed",
      version: bundle?.version || existing?.version,
      channel: bundle?.channel,
      sources: [
        ...new Set([...(existing?.sources || []), "manual：用户选定程序路径"]),
      ],
      components: existing?.components.map((c, index) =>
        index === 0 && bundle ? { ...c, version: bundle.version } : c,
      ) || [component(product, cli ? "cli" : "host", bundle?.version)],
      processKeys: [],
      lastSeen: Date.now(),
      pinned: existing?.pinned || false,
    };
    state.installs = sortTools([
      ...state.installs.filter((i) => i.id !== record.id),
      record,
    ]);
    this.store.putAssistant("tools", state);
    return state;
  }
}
