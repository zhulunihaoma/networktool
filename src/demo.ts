import { SKILL_TARGETS, SKILL_TARGETS_CHECKED_AT } from "./shared/skill-targets";
import { createDemoAppUpdates } from "./demo-app-update";
import type {
  DesktopAPI,
  ProcessInfo,
  Session,
  StartInput,
  Settings,
  PlatformScan,
  ProviderScan,
  TriageRun,
} from "./shared/types";
import { AI_PLATFORMS } from "./shared/platforms";
import { ALL_ENDPOINTS } from "./shared/providers";
import { newTriage } from "./shared/triage";
import { createDemoAssistant } from "./demo-assistant";
import type { SkillCopyResult, SkillScan } from "./shared/skills";
const now = Date.now();
const processes: ProcessInfo[] = [
  {
    key: "demo:24108",
    pid: 24108,
    ppid: 1,
    name: "Cursor",
    created: "演示进程实例",
    relation: "root",
  },
  {
    key: "demo:24126",
    pid: 24126,
    ppid: 24108,
    name: "Cursor Helper",
    created: "演示进程实例",
    relation: "candidate",
  },
  {
    key: "demo:24590",
    pid: 24590,
    ppid: 24108,
    name: "node",
    created: "演示进程实例",
    relation: "candidate",
  },
  {
    key: "demo:8802",
    pid: 8802,
    ppid: 1,
    name: "Terminal",
    created: "演示进程实例",
    relation: "root",
  },
];
export function demoSession(): Session {
  return {
    id: "demo-session",
    name: "Cursor 客户端连接超时",
    target: "https://api.example.test/",
    host: "api.example.test",
    port: 443,
    status: "completed",
    started: now - 240000,
    ended: now - 150000,
    duration: 60,
    deadline: now - 180000,
    process: processes[0],
    scope: processes.slice(0, 3),
    proxy: "http://127.0.0.1:7897",
    mode: "diagnose",
    phase: "演示诊断完成",
    config: [
      {
        name: "系统代理",
        value: "127.0.0.1:7897",
        source: "示例配置",
        state: "read",
      },
      {
        name: "HTTPS_PROXY",
        value: "未设置",
        source: "示例诊断器环境",
        state: "read",
      },
    ],
    coverage: {
      platform: "演示环境",
      collector: "示例 TCP 快照",
      tcp: true,
      processes: true,
      version: "0.2.0",
      limitations: [
        "以下所有数据均为交互示例，不是这台电脑的诊断结果。",
        "TCP 快照可能漏掉短连接；没有请求正文或上传字节证据。",
        "目标进程实际代理环境未知。",
      ],
    },
    markers: [now - 205000],
    dropped: 0,
    sequence: 1,
    evidence: [
      {
        id: "E01",
        time: now - 235000,
        stage: "config",
        route: "local",
        status: "info",
        title: "网络配置基线",
        detail: "演示：系统代理存在，诊断器环境未设置 HTTPS_PROXY。",
        source: "demo",
        executor: "collector",
      },
      {
        id: "E02",
        time: now - 178000,
        stage: "dns",
        route: "direct",
        status: "success",
        title: "系统解析成功",
        detail: "演示地址：203.0.113.42",
        duration: 24,
        source: "demo",
        executor: "diagnostic_probe",
      },
      {
        id: "E03",
        time: now - 175000,
        stage: "tcp",
        route: "direct",
        status: "failed",
        title: "直连 TCP 建连超时",
        detail: "演示：连接在 3 秒预算内未完成。",
        code: "ETIMEDOUT",
        duration: 3001,
        source: "demo",
        executor: "diagnostic_probe",
      },
      {
        id: "E04",
        time: now - 172000,
        stage: "tcp",
        route: "http://127.0.0.1:7897",
        status: "success",
        title: "代理端点建连成功",
        detail: "演示：本地端点接受连接。",
        duration: 2,
        source: "demo",
        executor: "diagnostic_probe",
      },
      {
        id: "E05",
        time: now - 170000,
        stage: "proxy",
        route: "http://127.0.0.1:7897",
        status: "success",
        title: "HTTP CONNECT 隧道建立",
        detail: "演示：HTTP CONNECT 200",
        duration: 128,
        source: "demo",
        executor: "diagnostic_probe",
      },
      {
        id: "E06",
        time: now - 168000,
        stage: "tls",
        route: "http://127.0.0.1:7897",
        status: "success",
        title: "TLS 证书校验通过",
        detail: "演示：TLS 1.3；Node bundled roots。",
        duration: 186,
        source: "demo",
        executor: "diagnostic_probe",
      },
      {
        id: "E07",
        time: now - 165000,
        stage: "http",
        route: "http://127.0.0.1:7897",
        status: "success",
        title: "目标服务响应",
        detail: "演示：无认证 HEAD / 返回 HTTP 401。",
        httpStatus: 401,
        duration: 205,
        source: "demo",
        executor: "diagnostic_probe",
      },
    ],
    findings: [
      {
        id: "demo-R02",
        ruleId: "R02",
        version: 1,
        title: "直连与指定代理的探测路径存在差异",
        description:
          "诊断器直连目标的 TCP 建连超时，通过指定代理建立 TLS 成功。当前证据支持路径差异，目标客户端是否使用该代理仍需验证。",
        support: "limited",
        evidenceIds: ["E03", "E06"],
        missing: [
          "目标进程实际继承的代理环境不可读。",
          "缺少目标客户端自身日志与同上下文复测。",
        ],
        nextCheck: "在新的目标终端会话中显式设置代理后重试，记录客户端结果。",
        severity: "warning",
      },
      {
        id: "demo-R05",
        ruleId: "R05",
        version: 1,
        title: "目标服务响应了无认证请求",
        description:
          "诊断器收到 HTTP 401，表明本次请求到达应用层；不能据此判断客户端的令牌状态。",
        support: "limited",
        evidenceIds: ["E07"],
        missing: ["目标客户端实际请求与授权信息。"],
        nextCheck: "核对目标客户端日志与服务权限。",
        severity: "info",
      },
    ],
    flows: [
      {
        id: "flow1",
        processKey: "demo:24108",
        pid: 24108,
        process: "Cursor",
        local: "127.0.0.1:53201",
        remote: "127.0.0.1:7897",
        state: "ESTABLISHED",
        family: "IPv4",
        firstSeen: now - 220000,
        lastSeen: now - 181000,
        window: "baseline",
        source: "demo snapshot",
      },
      {
        id: "flow2",
        processKey: "demo:24126",
        pid: 24126,
        process: "Cursor Helper",
        local: "192.0.2.10:53206",
        remote: "203.0.113.42:443",
        state: "SYN_SENT",
        family: "IPv4",
        firstSeen: now - 210000,
        lastSeen: now - 201000,
        window: "baseline",
        source: "demo snapshot",
      },
      {
        id: "flow3",
        processKey: "demo:24590",
        pid: 24590,
        process: "node",
        local: "192.0.2.10:53209",
        remote: "198.51.100.18:443",
        state: "ESTABLISHED",
        family: "IPv4",
        firstSeen: now - 208000,
        lastSeen: now - 182000,
        window: "baseline",
        source: "demo snapshot",
      },
    ],
  };
}
export function createDemoAPI(): DesktopAPI {
  let sessions = [demoSession()],
    settings: Settings = { retentionDays: 7, redact: true };
  const listeners = new Set<(s: Session) => void>();
  const platformListeners = new Set<(scan: PlatformScan) => void>();
  const providerListeners = new Set<(scan: ProviderScan) => void>();
  const triageListeners = new Set<(run: TriageRun) => void>();
  let triage = newTriage("codex");
  const publishTriage = () => {
    triageListeners.forEach((fn) => fn(structuredClone(triage)));
    return structuredClone(triage);
  };
  let scan: PlatformScan = {
    id: "demo-platforms",
    status: "idle",
    results: AI_PLATFORMS.map((p) => ({
      platformId: p.id,
      status: "pending",
      summary: "等待示例检查",
      suggestion: "",
      route: "示例网络",
      runningApps: p.id === "cursor" ? ["Cursor"] : [],
      evidence: [],
    })),
  };
  let providerScan: ProviderScan = {
    id: "demo-providers",
    status: "idle",
    results: ALL_ENDPOINTS.map(({ provider, endpoint }) => ({
      providerId: provider.id,
      endpointId: endpoint.id,
      status: "pending",
      effectiveUrl: endpoint.url + endpoint.probePath,
      urlSource: "default" as const,
      summary: "等待示例检查",
      suggestion: "",
      route: "示例网络",
      evidence: [],
    })),
  };
  const get = (id: string) => {
    const s = sessions.find((s) => s.id === id);
    if (!s) throw new Error("示例记录不存在");
    return s;
  };
  const publish = (s: Session) => {
    listeners.forEach((fn) => fn({ ...s }));
    return { ...s };
  };
  const assistant = createDemoAssistant();
  return {
    ...assistant,
    ...createDemoAppUpdates(),
    memories: async (agent) => ({ agent, mode: "demo", checkedAt: Date.now(), documents: [], nodes: [], edges: [], roots: [], warnings: ["浏览器演示不读取本机记忆，请在桌面本地模式使用。"] }),
    chooseMemoryDirectory: async () => { throw new Error("浏览器演示不能选择本机目录，请使用桌面本地模式。"); },
    discoverHandoffTools: async () => [],
    listSourceTasks: async () => { throw new Error("演示模式不读取私人会话，请使用桌面本地模式。"); },
    browseSourceTasks: async () => { throw new Error("演示模式不读取私人会话与项目，请使用桌面本地模式。"); },
    importSourceTask: async () => { throw new Error("演示模式不导入私人会话。"); },
    chooseHandoffFile: async () => { throw new Error("演示模式不读取本地文件。"); },
    previewHandoff: async () => { throw new Error("请在桌面本地模式中导入真实任务后预览。"); },
    scanHandoffAttachments: async () => { throw new Error("演示模式不读取本地附件。"); },
    addHandoffAttachments: async () => { throw new Error("演示模式不读取本地附件。"); },
    exportHandoffPackage: async () => { throw new Error("演示模式不导出附件。"); },
    copyHandoff: async () => { throw new Error("演示模式不会复制任务内容。"); },
    skills: async (): Promise<SkillScan> => ({
      items: [],
      trash: [],
      roots: [
        { path: "~/.wiscode/skills", source: "WisCode", status: "scanned" },
        { path: "~/.codex/skills", source: "Codex", status: "missing", message: "演示模式未读取本机目录" },
      ],
      targets: SKILL_TARGETS.map(tool => ({
        id: tool.id, label: tool.label, path: `~/${tool.target}`, installed: false,
        directoryExists: false, copySupported: !tool.blockedReason,
        blockedReason: tool.blockedReason, activationHint: tool.activationHint,
        directorySource: tool.directorySource, directoryCheckedAt: SKILL_TARGETS_CHECKED_AT,
      })),
    }),
    previewSkills: async () => { throw new Error("演示模式不会读取本机 Skill，请在桌面应用中检查。"); },
    copySkills: async (): Promise<SkillCopyResult[]> => {
      throw new Error("交互演示不会写入本机目录，请在桌面应用中确认复制。");
    },
    previewDeleteSkills: async () => { throw new Error("演示模式不会检查本机 Skill 删除。 "); },
    deleteSkills: async () => { throw new Error("演示模式不会移动本机 Skill。 "); },
    restoreSkill: async () => { throw new Error("演示模式没有本机 Skill 回收区。 "); },
    triage: async () => structuredClone(triage),
    startTriage: async (targetId) => {
      triage = {
        ...newTriage(targetId, crypto.randomUUID()),
        status: "running",
        started: Date.now(),
        summary: "演示：正在按顺序检查，不进行真实网络探测。",
      };
      const id = triage.id;
      void (async () => {
        for (const step of triage.steps) {
          if (triage.id !== id || triage.status !== "running") return;
          step.status = "checking";
          publishTriage();
          await new Promise((resolve) => setTimeout(resolve, 250));
          if (triage.id !== id || triage.status !== "running") return;
          step.status =
            step.id === "proxy"
              ? "attention"
              : step.id === "stability"
                ? "unverified"
                : "pass";
          step.summary =
            step.id === "proxy"
              ? "演示：代理端点无法连接"
              : step.id === "stability"
                ? "演示：需要在原工具复现观察"
                : "演示：本项检查通过";
          step.suggestion =
            step.id === "proxy"
              ? "演示：确认获批客户端已运行，并核对本地代理端口。"
              : "演示：此结果用于展示交互，不能判断本机网络。";
          step.support = "none";
          step.evidence = ["演示数据，无真实采集。"];
          step.actions =
            step.id === "proxy"
              ? ["proxy_settings", "retry"]
              : step.id === "stability"
                ? ["observe", "copy_report"]
                : [];
          publishTriage();
        }
        triage.status = "completed";
        triage.ended = Date.now();
        triage.priorityIds = ["proxy"];
        triage.summary = "演示：建议先核对代理端口，再重新检查。";
        publishTriage();
      })();
      return publishTriage();
    },
    stopTriage: async () => {
      triage.status = "cancelled";
      triage.steps.forEach((s) => {
        if (["pending", "checking"].includes(s.status)) s.status = "skipped";
      });
      return publishTriage();
    },
    triageAction: async () => ({
      message: "浏览器演示不会打开系统设置或执行修复，请使用桌面应用。",
    }),
    observeTriage: async () => {
      triage.steps[4].summary =
        "演示不采集真实连接。请使用桌面应用进行 60 秒观察。";
      return publishTriage();
    },
    markTriage: async () => {
      throw new Error("演示未开始真实观察。");
    },
    verifyTriage: async (_id, result) => {
      triage.verification = result;
      return publishTriage();
    },
    onTriage: (fn) => {
      triageListeners.add(fn);
      return () => triageListeners.delete(fn);
    },
    platforms: async () => structuredClone(scan),
    scanPlatforms: async (id) => {
      scan = {
        ...scan,
        status: "completed",
        started: Date.now(),
        ended: Date.now(),
        results: scan.results.map((r, i) =>
          id && r.platformId !== id
            ? r
            : {
                ...r,
                status:
                  i === 8
                    ? "restricted"
                    : i === 9
                      ? "network_error"
                      : "reachable",
                checkedAt: Date.now(),
                duration: 120 + i * 10,
                summary:
                  i === 8
                    ? "演示：入口拒绝了访问"
                    : i === 9
                      ? "演示：这台电脑暂时连不上平台"
                      : "演示：平台入口可以连接",
                suggestion:
                  i === 8
                    ? "演示：在浏览器确认是否需要验证码。"
                    : i === 9
                      ? "演示：先确认网络，再重新检查。"
                      : "演示：如仍不能使用，请在工具中重新登录。",
              },
        ),
      };
      platformListeners.forEach((fn) => fn(structuredClone(scan)));
      return structuredClone(scan);
    },
    stopPlatforms: async () => {
      scan.status = "cancelled";
      return structuredClone(scan);
    },
    copyPlatformResult: async () => {
      throw new Error("浏览器演示中请展开反馈内容并手动复制。");
    },
    onPlatforms: (fn) => {
      platformListeners.add(fn);
      return () => platformListeners.delete(fn);
    },
    providers: async () => structuredClone(providerScan),
    scanProviders: async (id) => {
      providerScan = {
        ...providerScan,
        status: "completed",
        started: Date.now(),
        ended: Date.now(),
        results: providerScan.results.map((r, i) =>
          id && r.endpointId !== id
            ? r
            : {
                ...r,
                status:
                  i === 2
                    ? "restricted"
                    : i === 5
                      ? "network_error"
                      : "auth_required",
                checkedAt: Date.now(),
                duration: 120 + i * 10,
                httpStatus: i === 2 ? 403 : i === 5 ? undefined : 401,
                summary:
                  i === 2
                    ? "演示：入口拒绝了访问"
                    : i === 5
                      ? "演示：这台电脑暂时连不上端点"
                      : "演示：网络与 TLS 正常，端点要求认证",
                suggestion:
                  i === 2
                    ? "演示：在浏览器确认是否需要验证码。"
                    : i === 5
                      ? "演示：先确认网络，再重新检查。"
                      : "演示：不证明你的密钥有效。",
              },
        ),
      };
      providerListeners.forEach((fn) => fn(structuredClone(providerScan)));
      return structuredClone(providerScan);
    },
    stopProviders: async () => {
      providerScan.status = "cancelled";
      return structuredClone(providerScan);
    },
    copyProviderResult: async () => {
      throw new Error("浏览器演示中请展开反馈内容并手动复制。");
    },
    onProviders: (fn) => {
      providerListeners.add(fn);
      return () => providerListeners.delete(fn);
    },
    overview: async () => ({
      coverage: demoSession().coverage,
      sessions,
      settings,
      activeId: sessions.find((s) =>
        ["collecting", "analyzing", "preparing"].includes(s.status),
      )?.id,
    }),
    processes: async () => processes,
    toolUsage: async () => ({ version: 1, tools: {} }),
    connections: async (key) => ({
      flows: demoSession().flows.filter((f) => !key || f.processKey === key),
    }),
    get: async (id) => get(id),
    start: async (input: StartInput) => {
      const inventory = await assistant.tools();
      const tool = inventory.installs.find(
        (t) => t.id === input.tool?.installId,
      );
      const component = tool?.components.find(
        (c) => c.id === input.tool?.componentId,
      );
      if (input.tool && (!tool || !component))
        throw new Error("示例工具身份已失效。");
      const s: Session = {
        ...demoSession(),
        toolContext:
          input.tool && tool && component
            ? {
                ...input.tool,
                productId: tool.productId,
                toolName: tool.name,
                componentName: component.name,
                version: component.version,
                runtime: component.runtime,
                identityStatus: tool.identityStatus,
                adapterStatus: component.adapterStatus,
              }
            : undefined,
        id: crypto.randomUUID(),
        name: input.name || "交互示例诊断",
        target: input.target,
        host: input.target.replace(/^https:\/\//, "").split("/")[0],
        mode: input.mode,
        started: Date.now(),
        ended: undefined,
        status: "collecting" as const,
        phase: "演示：请复现问题",
        duration: input.duration,
        deadline: Date.now() + input.duration * 1000,
        evidence: [],
        findings: [],
        baselineEnded: undefined,
        markers: [],
        sequence: 1,
      };
      sessions = [s, ...sessions];
      return publish(s);
    },
    stop: async (id) => {
      const s = get(id);
      s.status = "cancelled";
      s.ended = Date.now();
      return publish(s);
    },
    finish: async (id) => {
      const s = get(id);
      const sample = demoSession();
      Object.assign(s, {
        status: "completed",
        ended: Date.now(),
        evidence: sample.evidence,
        findings: sample.findings,
      });
      return publish(s);
    },
    extend: async (id) => {
      const s = get(id);
      s.deadline += 60000;
      return publish(s);
    },
    mark: async (id) => {
      const s = get(id);
      s.markers = [...s.markers, Date.now()];
      return publish(s);
    },
    task: async (id) => {
      const s = get(id);
      s.baselineEnded = Date.now();
      s.deadline = Date.now() + s.duration * 1000;
      return publish(s);
    },
    verify: async (id, result) => {
      const s = get(id);
      s.verified = result;
      return publish(s);
    },
    remove: async (id) => {
      sessions = sessions.filter((s) => s.id !== id);
    },
    settings: async (input) => (settings = input),
    preview: async (id, format) => ({
      format,
      digest: "demo",
      content:
        format === "json"
          ? JSON.stringify(
              { demo: true, session: get(id).name, findings: get(id).findings },
              null,
              2,
            )
          : `# 演示诊断报告\n\n以下仅为交互示例，非真实网络结果。\n\n${get(id)
              .findings.map((f) => `## ${f.title}\n\n${f.description}`)
              .join("\n\n")}`,
    }),
    export: async () => {
      throw new Error("演示模式不写入文件。请在桌面程序中导出真实诊断报告。");
    },
    onUpdate: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
