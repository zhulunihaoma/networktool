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
import { HANDOFF_SOURCES, HANDOFF_TARGETS } from "../src/shared/handoff-api";
import { discoverHandoffTools } from "./core/handoff-tools";
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
import { TRIAGE_TARGETS, triageStatusPage, triageText } from "../src/shared/triage";
import { TriageDoctor } from "./core/triage";
import { inspectIPPaths, validateIPRepair } from "./core/ip-path";
import { ipv6RepairText } from "../src/shared/ip-path";
import { TOOL_PRODUCTS } from "../src/shared/assistant";
import {
  checkExtensionUpdate,
  EXTENSION_PAGE_URLS,
} from "./core/extension-updates";
import { UPDATE_PAGE_URLS } from "./core/tool-updates";
import { ToolRegistry } from "./core/tool-registry";
import { FileWorkflow } from "./core/file-workflow";
import { SecurityCenter, copyGuardScript } from "./security/center";
import { Forwarder } from "./security/forward";
import { autoProtectAllowed } from "./security/auto-protect";
import * as securityDoctor from "./security/doctor";
import { checkMcpConfig } from "./security/mcp-check";
import { SECURITY_TOOLS } from "../src/shared/security";
import { SkillScanner } from "./core/skills";
import { skillRiskLevel } from "../src/shared/skill-insights";
import type { SkillScan } from "../src/shared/skills";
import { ToolUsageTracker } from "./core/tool-usage";
import { HandoffManager } from "./core/handoff";
import { HistoryService } from "./core/history-service";
import { MemoryScanner } from "./core/memory";
import { AppUpdater } from "./core/app-update";
import { version as projectVersion } from "../package.json";
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
// Isolated verification profiles may point at a temporary home so tests never
// read or write the real user's tool configs. Requires an isolated data dir.
if (process.env.NETWORK_LENS_DATA_DIR && process.env.NETWORK_LENS_TEST_HOME)
  app.setPath("home", process.env.NETWORK_LENS_TEST_HOME);
const dev = process.env.NETWORK_LENS_DEV === "1";
let win: BrowserWindow | undefined;
let manager: Manager;
let doctor: PlatformDoctor;
let providerDoctor: ProviderDoctor;
let triage: TriageDoctor;
let files: FileWorkflow;
let skills: SkillScanner;
let toolUsage: ToolUsageTracker | undefined;
let appUpdater: AppUpdater | undefined;
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
    const securityDir = path.join(app.getPath("userData"), "security");
    files = new FileWorkflow(store, path.join(securityDir, "file-policy-snapshot.json"));
    fs.mkdirSync(securityDir, { recursive: true, mode: 0o700 });
    const guardScript = copyGuardScript(
      path.join(__dirname, "guard.cjs"),
      securityDir,
    );
    const security = new SecurityCenter({
      home: app.getPath("home"),
      dataDir: securityDir,
      autoProtect: autoProtectAllowed(process.env),
      guard: {
        runtime: process.execPath,
        env: { ELECTRON_RUN_AS_NODE: "1" },
        script: guardScript,
        dataDir: securityDir,
      },
      doctor: securityDoctor,
      publish: (event) => {
        if (win && !win.isDestroyed())
          win.webContents.send("security-event", event);
      },
      publishProgress: (p) => {
        if (win && !win.isDestroyed())
          win.webContents.send("security-progress", p);
      },
    });
    const stopSecurityWatch = security.watch();
    app.on("will-quit", stopSecurityWatch);
    // Resume forwardding from where the last run stopped; a no-op when the
    // user never enabled it.
    try {
      const forwarding = security.forwardSettings();
      if (forwarding.enabled) {
        const loop = new Forwarder({ dataDir: securityDir });
        loop.start(forwarding);
        app.on("will-quit", () => loop.stop());
      }
    } catch (error) {
      console.warn("安全日志外送启动失败，已跳过", error);
    }
    // Protect-by-default: run once per start, before the window opens. The
    // preference is persisted, so a manual "off" or a global opt-out wins.
    // Never fail the app because a third-party config could not be updated.
    if (autoProtectAllowed(process.env)) {
      try {
        security.runAutoProtect();
      } catch (error) {
        console.warn("自动开启防护失败，已跳过", error);
      }
    }
    const securityEvent = (e: {
      operation: string;
      decision: "deny" | "allow" | "ask";
      ruleId?: string;
      reason?: string;
      project?: string;
    }) => {
      security.record(
        {
          decision: e.decision,
          operation: e.operation,
          ruleId: e.ruleId,
          reason: e.reason,
        },
        { tool: "app", project: e.project },
        "scan",
      );
    };
    skills = new SkillScanner(app.getPath("home"), [], undefined, {
      onSecurityEvent: securityEvent,
    });
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
        ipPath: inspectIPPaths,
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
    const securityTool = z.enum(SECURITY_TOOLS);
    handle("security-overview", () => security.overview());
    handle("security-timeline", (filter) =>
      security.timeline(
        z
          .object({
            source: z
              .enum([
                "all",
                "real_block",
                "real_allow",
                "self_check",
                "scan",
                "network",
                "session",
                "action",
                "error",
              ])
              .optional(),
            sources: z
              .array(
                z.enum([
                  "real_block",
                  "real_allow",
                  "self_check",
                  "scan",
                  "network",
                  "session",
                  "action",
                  "error",
                ]),
              )
              .max(8)
              .optional(),
            ruleId: z.string().max(60).optional(),
            tool: z.string().max(50).optional(),
            query: z.string().max(200).optional(),
            limit: z.number().int().min(1).max(1000).optional(),
            offset: z.number().int().min(0).max(100000).optional(),
            from: z.number().int().min(0).optional(),
            to: z.number().int().min(0).optional(),
          })
          .parse(filter),
      ),
    );
    handle("security-doctor", () => security.doctor());
    handle("security-retro-scan", () => security.retroScan());
    handle("security-incidents", (filter) =>
      security.incidents(
        z
          .object({
            severity: z
              .enum(["all", "critical", "high", "medium", "low"])
              .optional(),
            limit: z.number().int().min(1).max(500).optional(),
          })
          .parse(filter ?? {}),
      ),
    );
    handle("security-chains", (filter) =>
      security.chains(
        z
          .object({
            incidentId: z.string().max(120).optional(),
            severity: z
              .enum(["all", "critical", "high", "medium", "low"])
              .optional(),
            limit: z.number().int().min(1).max(500).optional(),
          })
          .parse(filter ?? {}),
      ),
    );
    handle("security-last-doctor", () => security.lastReport());
    handle("security-forward-settings", () => security.forwardSettings());
    handle("security-forward-save", (settings) =>
      security.saveForwardSettings(
        z
          .object({
            enabled: z.boolean(),
            includeIncidents: z.boolean().optional(),
            targets: z
              .array(
                z
                  .object({
                    id: z.string().max(80).optional(),
                    enabled: z.boolean().optional(),
                    kind: z.enum(["http", "udp", "tcp", "tls"]),
                    host: z.string().max(255).optional(),
                    port: z.number().int().min(1).max(65535).optional(),
                    url: z.string().max(2000).optional(),
                    token: z.string().max(500).optional(),
                  })
                  .strict(),
              )
              .max(8),
          })
          .parse(settings),
      ),
    );
    handle("security-forward-stats", () => security.forwardStats());
    handle("security-forward-now", () => security.forwardNow());
    handle("security-forward-export", () => security.exportForwardFile());
    handle("security-ignore", (id, ignored) =>
      security.ignoreFinding(
        z.string().max(300).parse(id),
        z.boolean().parse(ignored),
      ),
    );
    handle("security-reveal-finding", (id) => {
      const file = security.findingPath(z.string().max(300).parse(id));
      if (file) shell.showItemInFolder(file);
    });
    handle("security-inventory", (rebaseline) =>
      security.inventoryCheck(z.boolean().parse(rebaseline)),
    );
    handle("security-trust-codex", () => security.trustCodex());
    handle("security-preview", (kind, target) =>
      security.preview(
        z.enum(["enable", "disable", "fix", "fix_all"]).parse(kind),
        z.string().max(300).optional().parse(target),
      ),
    );
    handle("security-apply", (token) =>
      security.apply(z.string().uuid().parse(token)),
    );
    handle("security-self-check", (tool) =>
      security.selfCheck(securityTool.parse(tool)),
    );
    handle("security-auto-protect", (enabled) =>
      security.setAutoProtect(z.boolean().parse(enabled)),
    );
    handle("security-run-auto-protect", () => security.runAutoProtect());
    handle("security-choose-project", async () => {
      const result = await dialog.showOpenDialog(win!, {
        title: "选择要保护的项目",
        properties: ["openDirectory"],
      });
      return result.canceled || !result.filePaths[0]
        ? undefined
        : fs.realpathSync(result.filePaths[0]);
    });
    handle("security-check-mcp", (text) => {
      const result = checkMcpConfig(z.string().min(1).max(200000).parse(text));
      security.record(
        {
          decision: result.level === "high" ? "deny" : "allow",
          operation: "MCP 安装前检查",
          reason: `发现 ${result.findings.length} 项提醒；未安装或执行配置`,
        },
        { tool: "app" },
        "scan",
      );
      return result;
    });
    handle("security-copy-mcp", (text) => {
      clipboard.writeText(
        checkMcpConfig(z.string().min(1).max(200000).parse(text))
          .redactedConfig,
      );
    });
    handle("security-save-policy", (policy) => {
      const parsed = z
        .object({
          version: z.literal(1),
          protectedBranches: z.array(z.string().max(300)).max(200),
          blockedCommands: z.array(z.string().max(300)).max(200),
          sensitivePaths: z.array(z.string().max(300)).max(200),
          writeProtectedPaths: z.array(z.string().max(300)).max(200),
          projectRoots: z.array(z.string()).max(200),
          allowOutsideProjectWrites: z.boolean(),
          autoProtect: z.boolean().optional(),
          toolPreferences: z
            .record(z.string().max(40), z.enum(["auto", "off"]))
            .optional(),
          projects: z
            .array(
              z.object({
                root: z.string().max(2000),
                enabled: z.boolean(),
                protectedBranches: z.array(z.string().max(300)).max(100),
                protectedPaths: z.array(z.string().max(300)).max(100),
              }),
            )
            .max(50)
            .optional(),
          rules: z
            .array(
              z.object({
                id: z.string().max(100),
                enabled: z.boolean(),
                level: z.string().max(30),
              }),
            )
            .max(100),
        })
        .parse(policy);
      return security.savePolicy(parsed);
    });
    handle("security-add-exception", (id) =>
      security.addException(z.string().max(100).parse(id)),
    );
    handle("security-remove-exception", (rule, project) =>
      security.removeException(
        z.string().max(100).parse(rule),
        z.string().max(1000).parse(project),
      ),
    );
    handle("security-export", async (format) => {
      const type = z.enum(["md", "json"]).parse(format);
      const result = await dialog.showSaveDialog(win!, {
        title: "导出安全事件",
        defaultPath: `security-events.${type}`,
      });
      if (result.canceled || !result.filePath) return { cancelled: true };
      fs.writeFileSync(result.filePath, security.exportReport(type), {
        mode: 0o600,
      });
      return { path: result.filePath };
    });
    const updatePreference = z.enum(["auto", "gitee", "github"]);
    const savedSource = updatePreference.safeParse(store.assistant("app-update-source", "auto"));
    const updater = appUpdater = new AppUpdater({
      version: app.isPackaged ? app.getVersion() : projectVersion,
      platform: `${process.platform}-${process.arch}`,
      directory: path.join(app.getPath("userData"), "updates"),
      fetch: (url, init) => net.fetch(url instanceof URL ? url.href : url, init),
      preference: savedSource.success ? savedSource.data : "auto",
      persistPreference: source => store.putAssistant("app-update-source", source),
      publish: state => { if (win && !win.isDestroyed()) win.webContents.send("app-update", state); },
      reveal: file => shell.showItemInFolder(file),
      openExternal: url => shell.openExternal(url),
    });
    handle("app-update-state", () => updater.state());
    handle("app-update-source", source => updater.setSource(updatePreference.parse(source)));
    handle("app-update-check", () => updater.check());
    handle("app-update-download", () => updater.download());
    handle("app-update-cancel", () => updater.cancel());
    handle("app-update-reveal", () => updater.reveal());
    handle("app-update-page", source => updater.openReleasePage(z.enum(["gitee", "github"]).parse(source)));
    const memories = new MemoryScanner(app.getPath("home"));
    const memoryAgent = z.enum(["codex", "claude", "gemini", "cursor", "opencode"]);
    handle("memories", (agent) => memories.scan(memoryAgent.parse(agent)));
    handle("choose-memory-directory", async (agent, mode) => {
      const selectedAgent = memoryAgent.parse(agent);
      const selectedMode = z.enum(["project", "memory"]).parse(mode);
      const result = await dialog.showOpenDialog(win!, {
        title: selectedMode === "project" ? "选择项目以读取 Agent 指令" : "选择本地记忆文档目录",
        properties: ["openDirectory"],
      });
      if (result.canceled || !result.filePaths[0]) return;
      if (selectedMode === "project") memories.setProject(result.filePaths[0]);
      else memories.addDirectory(selectedAgent, result.filePaths[0]);
      return memories.scan(selectedAgent);
    });
    const history = new HistoryService(
      path.join(app.getPath("userData"), "handoff-history"),
      app.getPath("home"),
    );
    const handoffs = new HandoffManager(
      undefined,
      undefined,
      undefined,
      history,
      { onSecurityEvent: securityEvent },
    );
    app.once("before-quit", () => history.close());
    handle("handoff-tools", async () => {
      const tools = await discoverHandoffTools();
      for (const tool of tools) {
        if (!tool.readable) continue;
        try {
          const page = await history.browse(tool.id, { refresh: true });
          tool.sessionCount = page.total;
        } catch {
          // An unreadable source must not hide other tools or look like zero sessions.
        }
      }
      return tools;
    });
    handle("handoff-list", (source) => handoffs.list(z.enum(HANDOFF_SOURCES).parse(source || "OpenCode")));
    handle("handoff-browse", (source, query) => handoffs.browse(z.enum(HANDOFF_SOURCES).parse(source || "OpenCode"), z.object({ projectId: z.string().max(4096).optional(), cursor: z.string().uuid().optional(), search: z.string().max(500).optional(), kind: z.enum(["conversation", "archived", "subagent", "automation", "draft", "deleted", "orphan"]).optional(), refresh: z.boolean().optional() }).strict().optional().parse(query)));
    handle("handoff-context", (id, offset) => handoffs.readContext(z.string().uuid().parse(id), z.number().int().nonnegative().optional().parse(offset)));
    handle("handoff-context-export", (id) => handoffs.exportContext(z.string().uuid().parse(id), async () => { const result = await dialog.showOpenDialog(win!, { title: "导出完整原始上下文（未经脱敏）", properties: ["openDirectory", "createDirectory"] }); return result.canceled ? undefined : result.filePaths[0]; }));
    handle("handoff-verify", (source) => history.verify(z.enum(HANDOFF_SOURCES).parse(source)));
    handle("handoff-verify-cancel", () => history.cancelVerification());
    handle("handoff-verify-progress", () => history.getVerification());
    handle("handoff-source-directory", async (source) => { const selected = z.enum(HANDOFF_SOURCES).parse(source); const result = await dialog.showOpenDialog(win!, { title: `选择 ${selected} 的数据根目录（配置或 profile 目录）`, properties: ["openDirectory"] }); return result.canceled ? undefined : history.addRoot(selected, result.filePaths[0]); });
    handle("handoff-import", (id, source) => handoffs.importSession(z.string().max(150).parse(id), z.enum(HANDOFF_SOURCES).parse(source || "OpenCode")));
    handle("handoff-file", async () => {
      const result = await dialog.showOpenDialog(win!, { title: "导入 OpenCode 导出会话", properties: ["openFile"], filters: [{ name: "OpenCode JSON", extensions: ["json"] }] });
      if (result.canceled || !result.filePaths[0]) return;
      return handoffs.importFile(result.filePaths[0]);
    });
    handle("handoff-preview", (goal, target, options) => handoffs.prepare(z.string().min(1).max(4000).parse(goal), z.enum(HANDOFF_TARGETS).parse(target), z.object({ includeTranscript: z.boolean(), includeWorkspace: z.boolean(), taskScope: z.enum(["project", "conversation"]).optional(), packAttachments: z.boolean().optional(), attachmentIds: z.array(z.string().uuid()).max(128).optional(), attachmentScanToken: z.string().uuid().optional(), allowPartialAttachments: z.boolean().optional() }).strict().optional().parse(options)));
    handle("handoff-attachments", (session) => handoffs.scanAttachments(z.string().uuid().parse(session)));
    handle("handoff-attachments-add", (session) => handoffs.addAttachments(z.string().uuid().parse(session),async () => {
      const result = await dialog.showOpenDialog(win!,{title:"补充本次接续的附件",properties:["openFile","multiSelections"]});
      return result.canceled ? [] : result.filePaths;
    }));
    handle("handoff-export", (token) => handoffs.exportPackage(z.string().uuid().parse(token),async () => {
      const result = await dialog.showOpenDialog(win!,{title:"选择附件接续包的保存目录",properties:["openDirectory","createDirectory"]});
      return result.canceled ? undefined : result.filePaths[0];
    }));
    handle("handoff-copy", (token) => handoffs.copy(z.string().uuid().parse(token), (content) => clipboard.writeText(content)));
    const publishSkillScan = (scan: SkillScan) => {
      const visible = scan.items.filter(i => !i.insight?.riskIgnored);
      const high = visible.filter(i => skillRiskLevel(i) === 'high').length;
      const medium = visible.filter(i => skillRiskLevel(i) === 'medium').length;
      security.updateSkillSummary({ checkedAt: scan.checkedAt ?? new Date().toISOString(), installed: scan.items.length, groups: scan.groups?.length ?? 0, high, medium, incomplete: scan.items.filter(i => !i.insight?.risk || i.insight.risk.truncated || i.insight.riskError).length, ignored: scan.items.filter(i => i.insight?.riskIgnored).length });
      security.record({ operation: 'Skill 目录安全扫描', decision: high || medium ? 'ask' : 'allow', reason: `检查 ${scan.items.length} 个安装项；${high} 项高风险、${medium} 项需注意。静态发现，不代表已执行或真实拦截` }, { tool: 'app' }, 'scan');
      return scan;
    };
    handle("skills", async () => publishSkillScan(await skills.scan()));
    handle("skill-preference", async (id, kind, value) => publishSkillScan(await skills.skillPreference(z.string().max(200).parse(id), z.enum(['preserve', 'ignore-risk']).parse(kind), z.boolean().parse(value))));
    handle("compare-skills", (left, right) => skills.compareSkills(z.string().max(200).parse(left), z.string().max(200).parse(right)));
    handle("preview-merge-skills", (keepId, ids) => skills.previewMerge(z.string().max(200).parse(keepId), z.array(z.string().max(200)).min(1).max(500).parse(ids)));
    handle("merge-skills", (keepId, ids, token) => skills.mergeSkills(z.string().max(200).parse(keepId), z.array(z.string().max(200)).min(1).max(500).parse(ids), z.string().uuid().parse(token)));
    handle("skill-tidy", () => skills.tidyReport());
    handle("apply-skill-tidy", (ids, token) => skills.applyTidy(z.array(z.string().max(64)).min(1).max(500).parse(ids), z.string().uuid().parse(token)));
    handle("revert-skill-move", (id) => skills.revertMove(z.string().uuid().parse(id)));
    handle("preview-skills", (ids, target) =>
      skills.preview(
        z.array(z.string().max(200)).max(500).parse(ids),
        z.string().max(40).parse(target),
      ),
    );
    handle("copy-skills", (ids, target, token, autoConvert, riskAcknowledged) =>
      skills.copy(
        z.array(z.string().max(200)).max(500).parse(ids),
        z.string().max(40).parse(target),
        z.string().max(100).parse(token),
        z.boolean().parse(autoConvert),
        z.boolean().optional().parse(riskAcknowledged) ?? false,
      ),
    );
    handle("preview-delete-skills", (ids) =>
      skills.previewDelete(z.array(z.string().max(200)).max(500).parse(ids)),
    );
    handle("delete-skills", (ids, token) =>
      skills.deleteSkills(
        z.array(z.string().max(200)).max(500).parse(ids),
        z.string().uuid().parse(token),
      ),
    );
    handle("restore-skill", (id) =>
      skills.restoreSkill(z.string().uuid().parse(id)),
    );
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
    const fileDraft = z.object({resourceId: sessionId, read: decision, write: decision, delete: decision.optional(), disclose: decision, enabled: z.boolean()}).strict();
    handle("trial-file-policy", (id, draft, expected) => files.trial(sessionId.parse(id), fileDraft.parse(draft), z.number().int().min(0).max(1000000).parse(expected)));
    handle("publish-file-policy", id => files.publish(sessionId.parse(id)));
    handle("rollback-file-policy", (scope, resource, expected) => files.rollback(sessionId.parse(scope), sessionId.parse(resource), z.number().int().min(1).parse(expected)));
    handle("reconfirm-file-candidate", (scope, resource) => files.reconfirm(sessionId.parse(scope),sessionId.parse(resource)));
    handle("review-file-candidate", (scope, resource, deferred) => files.review(sessionId.parse(scope), sessionId.parse(resource), z.boolean().parse(deferred)));
    handle("start-file-task", (scope, resource, kind) => files.start(sessionId.parse(scope), sessionId.parse(resource), z.enum(["preview", "redact"]).parse(kind)));
    handle("grant-file-task", (task, reason) => files.grant(sessionId.parse(task), z.string().trim().min(1).max(200).parse(reason)));
    handle("run-file-task", task => files.run(sessionId.parse(task)));
    handle("revoke-file-grant", id => files.revoke(sessionId.parse(id)));
    handle("export-file-task-copy", async (rawTask, rawDigest) => {
      const task = sessionId.parse(rawTask), digest = z.string().length(64).parse(rawDigest);
      await files.copyContent(task, digest);
      const choice = await dialog.showSaveDialog(win!, {title: "保存本地脱敏副本（不覆盖已有文件）", defaultPath: "redacted-copy.txt", filters:[{name:"文本副本",extensions:["txt"]}]});
      if (choice.canceled || !choice.filePath) return {cancelled:true};
      const content = await files.copyContent(task, digest);
      await fs.promises.writeFile(choice.filePath, content, {encoding:"utf8", flag:"wx", mode:0o600});
      return {cancelled:false,path:choice.filePath};
    });
    handle("retry-file-deployment", () => files.retryDeployment());
    handle("save-file-policy", async (scopeId, policy, expected) => {
      const trial = await files.trial(sessionId.parse(scopeId), fileDraft.parse(policy), z.number().int().min(0).max(1000000).parse(expected));
      return files.publish(trial.id);
    });
    handle("evaluate-file-policy", (scopeId, resourceId, operation) =>
      files.evaluate(
        sessionId.parse(scopeId),
        sessionId.parse(resourceId),
        z.enum(["read", "write", "delete", "disclose"]).parse(operation),
      ),
    );
    handle("audit-events", (filter) =>
      files.audit(
        z
          .object({
            scopeId: sessionId.optional(),
            operation: z
              .enum(["enumerate", "policy_update", "read", "write", "delete", "disclose"])
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
          "copy_ipv6_plan",
          "copy_ipv6_restore",
        ])
        .parse(rawAction);
      triage.authorize(sessionId.parse(id), action);
      if (triage.busy() && action !== "copy_report")
        throw new Error("请先停止正在进行的观察，再执行修复操作。");
      const run = triage.current();
      if (action === "copy_ipv6_plan" || action === "copy_ipv6_restore") {
        const plan = action === "copy_ipv6_plan" ? run.ipPath?.repair : run.ipv6Recovery;
        if (!plan || !run.ipPath) throw new Error("当前结果没有可用的 IPv6 修复或恢复方案，请重新检查。");
        await validateIPRepair(run.ipPath, action === "copy_ipv6_restore");
        triage.authorize(sessionId.parse(id), action);
        clipboard.writeText(action === "copy_ipv6_plan" ? ipv6RepairText(plan) : plan.restoreCommand);
        return { message: "已复制方案，未修改系统设置。请先保存恢复命令，在本机终端单独执行所需命令，再重连 VPN 并复测。" };
      }
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
        if (action === "service_status") {
          // Status page comes from reviewed target data; never fall back to a
          // fixed URL that would misattribute another vendor's status.
          const statusPage = triageStatusPage(run.targetId);
          if (!statusPage)
            throw new Error("该排查目标没有已核实的官方状态页，请直接打开平台入口。");
          await shell.openExternal(statusPage);
          return {
            message: "已打开官方状态页。请在原工具确认登录与实际任务是否正常。",
          };
        }
        await shell.openExternal(target.url);
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
  appUpdater?.cancel();
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
