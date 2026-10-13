import {
  app,
  net,
  BrowserWindow,
  ipcMain,
  dialog,
  Menu,
  shell,
  clipboard,
  session as electronSession,
} from "electron";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { Store } from "./core/store";
import { Manager } from "./core/manager";
import { listProcesses, collectConnections } from "./core/collector";
import { buildReport } from "./core/report";
import { PlatformDoctor } from "./core/platforms";
import { probePlatform } from "./core/platform-probe";
import { AI_PLATFORMS, platformHelpText } from "../src/shared/platforms";
import { ProviderDoctor } from "./core/providers";
import { probeEndpoint } from "./core/provider-probe";
import { providerHelpText } from "../src/shared/providers";
import { TRIAGE_TARGETS, triageText } from "../src/shared/triage";
import { TriageDoctor } from "./core/triage";
import { TOOL_PRODUCTS } from "../src/shared/assistant";
import {
  checkExtensionUpdate,
  EXTENSION_PAGE_URLS,
} from "./core/extension-updates";
import { UPDATE_PAGE_URLS } from "./core/tool-updates";
import { ToolRegistry } from "./core/tool-registry";
import { FilePolicies } from "./core/file-policies";
import { SkillScanner } from "./core/skills";
import { ToolUsageTracker } from "./core/tool-usage";
import { HandoffManager } from "./core/handoff";
import { ADAPTER_SOURCE_URLS } from "../src/shared/adapters";
import {
  networkSnapshot,
  inspectProxyEndpoint,
  lookupEntrance,
  bounded,
} from "./core/triage-probe";
app.setName("360AI盒子");
if (process.env.NETWORK_LENS_DATA_DIR)
  app.setPath("userData", process.env.NETWORK_LENS_DATA_DIR);
const dev = process.env.NETWORK_LENS_DEV === "1";
let win: BrowserWindow | undefined;
let manager: Manager;
let doctor: PlatformDoctor;
let providerDoctor: ProviderDoctor;
let triage: TriageDoctor;
let files: FilePolicies;
let skills: SkillScanner;
let toolUsage: ToolUsageTracker | undefined;
let resettingProbe = false;
const entry = path.join(__dirname, "../dist/index.html");
const sessionId = z.string().uuid();
const format = z.enum(["md", "json"]);
async function windowCreate() {
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1024,
    minHeight: 720,
    title: "360AI盒子 · AI 工具网络助手",
    backgroundColor: "#f7f9fb",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 20, y: 20 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (
      AI_PLATFORMS.some((p) => p.url === url) ||
      ADAPTER_SOURCE_URLS.includes(url) ||
      [...UPDATE_PAGE_URLS, ...EXTENSION_PAGE_URLS].some(
        (page) => new URL(page).href === url,
      )
    )
      void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== (dev ? "http://127.0.0.1:5173/" : pathToFileURL(entry).href))
      event.preventDefault();
  });
  await (dev ? win.loadURL("http://127.0.0.1:5173") : win.loadFile(entry));
}
app
  .whenReady()
  .then(async () => {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(process.platform === "darwin"
          ? [
              {
                label: "360AI盒子",
                submenu: [
                  { label: "关于 360AI盒子", role: "about" as const },
                  { type: "separator" as const },
                  { label: "隐藏 360AI盒子", role: "hide" as const },
                  { label: "退出 360AI盒子", role: "quit" as const },
                ],
              },
            ]
          : []),
        {
          label: "编辑",
          submenu: [
            { label: "撤销", role: "undo" },
            { label: "重做", role: "redo" },
            { type: "separator" },
            { label: "剪切", role: "cut" },
            { label: "复制", role: "copy" },
            { label: "粘贴", role: "paste" },
            { label: "全选", role: "selectAll" },
          ],
        },
        {
          label: "视图",
          submenu: [
            { label: "恢复缩放", role: "resetZoom" },
            { label: "放大", role: "zoomIn" },
            { label: "缩小", role: "zoomOut" },
            { type: "separator" },
            { label: "全屏", role: "togglefullscreen" },
          ],
        },
        {
          label: "窗口",
          submenu: [
            { label: "最小化", role: "minimize" },
            { label: "关闭窗口", role: "close" },
          ],
        },
      ]),
    );
    electronSession.defaultSession.setPermissionRequestHandler(
      (_web, _permission, callback) => callback(false),
    );
    const store = new Store(
      path.join(app.getPath("userData"), "diagnostics.sqlite"),
      path.join(app.getAppPath(), "node_modules/sql.js/dist/sql-wasm.wasm"),
    );
    await store.init();
    const registry = new ToolRegistry(
      store,
      listProcesses,
      undefined,
      undefined,
      undefined,
      (url, init) => net.fetch(url, init),
    );
    manager = new Manager(
      store,
      (s) =>
        win && !win.isDestroyed() && win.webContents.send("session-update", s),
      (reference) => registry.diagnosisContext(reference),
    );
    manager.init();
    files = new FilePolicies(store);
    skills = new SkillScanner(app.getPath("home"));
    if (!toolUsage) {
      toolUsage = new ToolUsageTracker(store, listProcesses);
      toolUsage.start();
      app.on("will-quit", () => toolUsage?.stop());
    }
    doctor = new PlatformDoctor(
      { processes: listProcesses, probe: probePlatform },
      (scan) => {
        if (win && !win.isDestroyed())
          win.webContents.send("platform-update", scan);
      },
    );
    providerDoctor = new ProviderDoctor({ probe: probeEndpoint }, (scan) => {
      if (win && !win.isDestroyed())
        win.webContents.send("provider-update", scan);
    });
    triage = new TriageDoctor(
      {
        network: networkSnapshot,
        proxy: (url) =>
          bounded(
            electronSession.defaultSession.resolveProxy(url),
            AbortSignal.timeout(4000),
          ),
        proxyEndpoint: inspectProxyEndpoint,
        dns: lookupEntrance,
        probe: probePlatform,
        processes: listProcesses,
        connections: collectConnections,
      },
      (run) => {
        if (win && !win.isDestroyed())
          win.webContents.send("triage-update", run);
      },
    );
    const handle = (name: string, fn: (...args: any[]) => any) =>
      ipcMain.handle(name, (event, ...args) => {
        const url = event.senderFrame?.url;
        const expected = dev
          ? "http://127.0.0.1:5173/"
          : pathToFileURL(entry).href;
        if (event.sender !== win?.webContents || url !== expected)
          throw new Error("拒绝未经授权的界面请求。");
        return fn(...args);
      });
    handle("overview", () => manager.overview());
    const handoffs = new HandoffManager();
    handle("handoff-list", (source) => handoffs.list(z.enum(["OpenCode", "Codex"]).parse(source || "OpenCode")));
    handle("handoff-import", (id, source) => handoffs.importSession(z.string().max(150).parse(id), z.enum(["OpenCode", "Codex"]).parse(source || "OpenCode")));
    handle("handoff-file", async () => {
      const result = await dialog.showOpenDialog(win!, { title: "导入 OpenCode 导出会话", properties: ["openFile"], filters: [{ name: "OpenCode JSON", extensions: ["json"] }] });
      if (result.canceled || !result.filePaths[0]) return;
      return handoffs.importFile(result.filePaths[0]);
    });
    handle("handoff-preview", (goal, target) => handoffs.prepare(z.string().min(1).max(4000).parse(goal), z.enum(["WisCode", "OpenCode", "Codex", "WorkBuddy"]).parse(target)));
    handle("handoff-copy", (token) => {
      handoffs.consume(z.string().uuid().parse(token), (content) => clipboard.writeText(content));
    });
    handle("skills", () => skills.scan());
    handle("preview-skills", (ids, target) => skills.preview(z.array(z.string().max(200)).max(500).parse(ids), z.string().max(40).parse(target)));
    handle("copy-skills", (ids, target, token, autoConvert) => skills.copy(z.array(z.string().max(200)).max(500).parse(ids), z.string().max(40).parse(target), z.string().max(100).parse(token), z.boolean().parse(autoConvert)));
    handle("preview-delete-skills", (ids) => skills.previewDelete(z.array(z.string().max(200)).max(500).parse(ids)));
    handle("delete-skills", (ids, token) => skills.deleteSkills(z.array(z.string().max(200)).max(500).parse(ids), z.string().uuid().parse(token)));
    handle("restore-skill", (id) => skills.restoreSkill(z.string().uuid().parse(id)));
    handle("tools", () => registry.current());
    handle("discover-tools", () => registry.scan());
    handle("check-tool-updates", (id) =>
      registry.checkUpdates(id === undefined ? undefined : sessionId.parse(id)),
    );
    handle("pin-tool", (id, pinned) =>
      registry.pin(sessionId.parse(id), z.boolean().parse(pinned)),
    );
    handle("choose-tool-path", async (rawProduct) => {
      const productId = z
        .string()
        .max(100)
        .refine((id) => TOOL_PRODUCTS.some((p) => p.id === id), "不支持的工具")
        .parse(rawProduct);
      const choice = await dialog.showOpenDialog(win!, {
        title: "手动确认程序位置（不执行程序，版本未知时保留未知）",
        properties: ["openFile"],
      });
      if (choice.canceled || !choice.filePaths[0]) return undefined;
      return registry.manual(productId, choice.filePaths[0]);
    });
    handle("file-workspace", () => files.workspace());
    handle("choose-file-scope", async () => {
      if (files.workspace().scanning)
        throw new Error("请先完成或停止正在进行的扫描。");
      const choice = await dialog.showOpenDialog(win!, {
        title: "选择文件策略范围（仅枚举元数据，不读取正文）",
        properties: ["openDirectory"],
      });
      if (choice.canceled || !choice.filePaths[0]) return undefined;
      return files.scan(choice.filePaths[0]);
    });
    handle("cancel-file-scan", () => files.cancel());
    handle("rescan-file-scope", (id) => files.rescan(sessionId.parse(id)));
    handle("choose-sensitive-file", async (rawId) => {
      const id = sessionId.parse(rawId);
      const choice = await dialog.showOpenDialog(win!, {
        title: "选择范围内的敏感文件（仅读取元数据）",
        defaultPath: files.scopeRoot(id),
        properties: ["openFile"],
      });
      if (choice.canceled || !choice.filePaths[0]) return undefined;
      return files.addCandidate(id, choice.filePaths[0]);
    });
    const decision = z.enum(["allow", "ask", "deny"]);
    handle("save-file-policy", (scopeId, policy, expected) =>
      files.save(
        sessionId.parse(scopeId),
        z
          .object({
            resourceId: sessionId,
            read: decision,
            write: decision,
            disclose: decision,
            enabled: z.boolean(),
          })
          .strict()
          .parse(policy),
        z.number().int().min(0).max(1000000).parse(expected),
      ),
    );
    handle("evaluate-file-policy", (scopeId, resourceId, operation) =>
      files.evaluate(
        sessionId.parse(scopeId),
        sessionId.parse(resourceId),
        z.enum(["read", "write", "disclose"]).parse(operation),
      ),
    );
    handle("audit-events", (filter) =>
      files.audit(
        z
          .object({
            scopeId: sessionId.optional(),
            operation: z
              .enum(["enumerate", "policy_update", "read", "write", "disclose"])
              .optional(),
            cursor: z.number().int().positive().optional(),
          })
          .strict()
          .parse(filter),
      ),
    );
    handle("acknowledge-file-alert", (id) =>
      files.acknowledge(sessionId.parse(id)),
    );
    handle("preview-file-audit", (id, type) =>
      files.report(sessionId.optional().parse(id), format.parse(type)),
    );
    handle("export-file-audit", async (id, rawDigest, type) => {
      const report = files.report(
        sessionId.optional().parse(id),
        format.parse(type),
      );
      if (z.string().length(64).parse(rawDigest) !== report.digest)
        throw new Error("审计或提醒已更新，请重新预览报告。");
      const result = await dialog.showSaveDialog(win!, {
        title: "保存脱敏文件审计报告",
        defaultPath: `network-lens-file-audit.${report.format}`,
        filters: [
          {
            name: report.format === "md" ? "Markdown 报告" : "JSON 证据包",
            extensions: [report.format],
          },
        ],
      });
      if (result.canceled || !result.filePath) return { cancelled: true };
      const temporary = result.filePath + `.${Date.now()}.tmp`;
      try {
        fs.writeFileSync(temporary, report.content, { mode: 0o600 });
        fs.renameSync(temporary, result.filePath);
      } catch (error) {
        try {
          fs.unlinkSync(temporary);
        } catch {}
        throw error;
      }
      return { path: result.filePath };
    });
    handle("triage", () => triage.current());
    handle("start-triage", (targetId) => {
      if (resettingProbe) throw new Error("检测连接正在重建，请稍后检查。");
      if (doctor.current().status === "running")
        throw new Error("平台体检正在进行，请等待完成或先停止体检。");
      return triage.start(z.string().max(60).parse(targetId));
    });
    handle("stop-triage", () => triage.stop());
    handle("observe-triage", (id) => {
      if (resettingProbe) throw new Error("检测连接正在重建，请稍后观察。");
      if (doctor.current().status === "running")
        throw new Error("请先完成或停止平台体检，再开始观察。");
      return triage.observe(sessionId.parse(id));
    });
    handle("mark-triage", (id) => triage.mark(sessionId.parse(id)));
    handle("verify-triage", (id, result) =>
      triage.verify(
        sessionId.parse(id),
        z.enum(["restored", "still_failed"]).parse(result),
      ),
    );
    handle("triage-action", async (id, rawAction) => {
      const action = z
        .enum([
          "retry",
          "network_settings",
          "proxy_settings",
          "date_settings",
          "open_platform",
          "service_status",
          "reset_probe",
          "observe",
          "copy_report",
        ])
        .parse(rawAction);
      triage.authorize(sessionId.parse(id), action);
      if (triage.busy() && action !== "copy_report")
        throw new Error("请先停止正在进行的观察，再执行修复操作。");
      const run = triage.current();
      if (action === "copy_report") {
        clipboard.writeText(triageText(run));
        return { message: "已复制脱敏排查结果，可交给 IT。" };
      }
      if (action === "reset_probe") {
        if (
          resettingProbe ||
          doctor.current().status === "running" ||
          manager.overview().activeId
        )
          throw new Error("请先完成其他诊断，再重建检测连接。");
        resettingProbe = true;
        try {
          await electronSession.defaultSession.clearHostResolverCache();
          await electronSession.defaultSession.closeAllConnections();
        } finally {
          resettingProbe = false;
        }
        return {
          message:
            "已清理 360AI盒子 自身的解析缓存并关闭自身连接；原 AI 工具未重启。请等待限频间隔后重新检查。",
        };
      }
      if (action === "open_platform" || action === "service_status") {
        const target = TRIAGE_TARGETS.find((p) => p.id === run.targetId)!;
        await shell.openExternal(
          action === "service_status"
            ? "https://status.openai.com/"
            : target.url,
        );
        return {
          message: "已打开官方页面。请在原工具确认登录与实际任务是否正常。",
        };
      }
      const settings = {
        network_settings: {
          darwin: "x-apple.systempreferences:com.apple.preference.network",
          win32: "ms-settings:network-status",
        },
        proxy_settings: {
          darwin: "x-apple.systempreferences:com.apple.preference.network",
          win32: "ms-settings:network-proxy",
        },
        date_settings: {
          darwin: "x-apple.systempreferences:com.apple.preference.datetime",
          win32: "ms-settings:dateandtime",
        },
      };
      if (action in settings) {
        const uri =
          settings[action as keyof typeof settings][
            process.platform as "darwin" | "win32"
          ];
        if (!uri)
          throw new Error("当前系统不支持此设置入口，请手动打开系统设置。");
        await shell.openExternal(uri);
        return {
          message:
            "已请求打开系统设置；设置未自动修改。按本项建议处理后点击“处理后重新检查”。",
        };
      }
      throw new Error("请通过界面对应的检查或观察按钮执行该操作。");
    });
    handle("platforms", () => doctor.current());
    handle("scan-platforms", (id?: string) => {
      if (resettingProbe) throw new Error("检测连接正在重建，请稍后测试。");
      if (triage.busy())
        throw new Error("顺序排查或观察正在进行，请先停止后再测试平台。");
      return doctor.start(
        id === undefined ? undefined : z.string().max(60).parse(id),
      );
    });
    handle("stop-platforms", () => doctor.stop());
    handle("providers", () => providerDoctor.current());
    handle("scan-providers", (id?: string) => {
      if (resettingProbe) throw new Error("检测连接正在重建，请稍后测试。");
      if (triage.busy())
        throw new Error("顺序排查或观察正在进行，请先停止后再测试端点。");
      return providerDoctor.start(
        id === undefined ? undefined : z.string().max(60).parse(id),
      );
    });
    handle("stop-providers", () => providerDoctor.stop());
    handle("copy-provider-result", (id) => {
      const scan = providerDoctor.current();
      const result = scan.results.find(
        (r) => r.endpointId === z.string().max(60).parse(id),
      );
      if (!result) throw new Error("不支持的端点。");
      clipboard.writeText(providerHelpText(scan, result));
    });
    handle("copy-platform-result", (id) => {
      const scan = doctor.current();
      const result = scan.results.find(
        (r) => r.platformId === z.string().max(60).parse(id),
      );
      if (!result) throw new Error("不支持的平台。");
      clipboard.writeText(platformHelpText(scan, result));
    });
    handle("processes", () => listProcesses());
    handle("tool-usage", () => toolUsage?.current() ?? { version: 1, tools: {} });
    handle("connections", async (key?: string) => {
      if (key !== undefined) z.string().max(300).parse(key);
      const ps = await listProcesses();
      const result = await collectConnections(ps);
      return {
        ...result,
        flows: result.flows
          .filter((f) => !key || f.processKey === key)
          .slice(0, 2000),
      };
    });
    handle("start", (input) => {
      if (resettingProbe) throw new Error("检测连接正在重建，请稍后诊断。");
      return manager.start(input);
    });
    handle("get", (id) => manager.get(sessionId.parse(id)));
    handle("stop", (id) => manager.stop(sessionId.parse(id)));
    handle("finish", (id) => manager.finish(sessionId.parse(id)));
    handle("extend", (id) => manager.extend(sessionId.parse(id)));
    handle("mark", (id) => manager.mark(sessionId.parse(id)));
    handle("task", (id) => manager.task(sessionId.parse(id)));
    handle("verify", (id, result) =>
      manager.verify(
        sessionId.parse(id),
        z.enum(["success", "failed", "unknown"]).parse(result),
      ),
    );
    handle("remove", (id) => manager.remove(sessionId.parse(id)));
    handle("settings", (s) => manager.setSettings(s));
    handle("preview", (id, type) =>
      buildReport(
        manager.get(sessionId.parse(id)),
        format.parse(type),
        manager.overview().settings.redact,
      ),
    );
    handle("export", async (id, digest, type) => {
      const s = manager.get(sessionId.parse(id));
      const report = buildReport(
        s,
        format.parse(type),
        manager.overview().settings.redact,
      );
      if (z.string().length(64).parse(digest) !== report.digest)
        throw new Error("会话已更新，请重新预览报告。");
      const result = await dialog.showSaveDialog(win!, {
        title: "保存诊断报告",
        defaultPath: `network-lens-${new Date(s.started).toISOString().slice(0, 10)}.${report.format}`,
        filters: [
          {
            name: report.format === "md" ? "Markdown 报告" : "JSON 证据包",
            extensions: [report.format],
          },
        ],
      });
      if (result.canceled || !result.filePath) return { cancelled: true };
      const temp = result.filePath + `.${Date.now()}.tmp`;
      try {
        fs.writeFileSync(temp, report.content, { mode: 0o600 });
        fs.renameSync(temp, result.filePath);
      } catch (e) {
        try {
          fs.unlinkSync(temp);
        } catch {}
        throw e;
      }
      return { path: result.filePath };
    });
    await windowCreate();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) void windowCreate();
    });
  })
  .catch((e) => {
    dialog.showErrorBox("360AI盒子 启动失败", String(e));
    app.quit();
  });
app.on("before-quit", () => {
  files?.cancel();
  triage?.stop();
  doctor?.stop();
  providerDoctor?.stop();
  manager?.shutdown();
});
app.on("window-all-closed", () => {
  triage?.stop();
  manager?.shutdown();
  doctor?.stop();
  providerDoctor?.stop();
  if (process.platform !== "darwin") app.quit();
});
