/**
 * Per-tool installers for the pre-execution guard. Every writer:
 *  - backs up the original file once per change (timestamped, 0600),
 *  - merges only our own entry (identified by MARKER) and preserves the rest,
 *  - writes atomically, and can be reverted by `remove`.
 */
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { hasCurrentCodexTrust, CODEX_GUARD_MATCHER } from "./codex-trust";
import type { InstallState, SecurityTool } from "../../src/shared/security";
export const MARKER = "network-lens-guard";
export interface GuardCommand {
  /** Absolute path of an executable able to run JS (Electron in Node mode or node). */
  runtime: string;
  /** Extra env assignments placed before the runtime, e.g. ELECTRON_RUN_AS_NODE=1. */
  env: Record<string, string>;
  script: string;
  dataDir: string;
}
export interface AdapterContext {
  home: string;
  guard: GuardCommand;
  backupDir: string;
  now?: () => number;
}
export interface PlannedChange {
  path: string;
  action: "create" | "update" | "remove";
  detail: string;
  before?: string;
  after?: string;
}
export interface AdapterStatus {
  installed: boolean;
  version?: string;
  state: InstallState;
  configPath?: string;
  note?: string;
  /** Set when the user disabled hooks inside the tool itself. Auto-protect must
   *  not override that choice; only an explicit manual enable may do so. */
  autoEnableBlockedReason?: string;
}
export interface Adapter {
  tool: SecurityTool;
  mechanism: string;
  detect(ctx: AdapterContext): AdapterStatus;
  planEnable(ctx: AdapterContext): PlannedChange[];
  planDisable(ctx: AdapterContext): PlannedChange[];
  nextSteps: string[];
  warnings: string[];
}
const quote = (value: string) =>
  /^[A-Za-z0-9_./:=@%+-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`;
export function hookCommand(guard: GuardCommand, tool: SecurityTool): string {
  const env = Object.entries(guard.env).map(([k, v]) => `${k}=${quote(v)}`);
  return [
    ...env,
    quote(guard.runtime),
    quote(guard.script),
    "--tool",
    tool,
    "--data",
    quote(guard.dataDir),
    "--marker",
    MARKER,
  ].join(" ");
}
const read = (file: string): string | undefined => {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024)
      throw new Error(`无法安全读取配置 ${file}：不是普通文件或文件过大。`);
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};
const exists = (file: string) => {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
};
const parseJson = (
  text: string | undefined,
  file: string,
): Record<string, any> => {
  if (text === undefined || !text.trim()) return {};
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value))
      return value;
  } catch {}
  throw new Error(`${file} 不是合法 JSON，为避免破坏原配置已停止修改。`);
};
const pretty = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const isOurs = (hook: any) =>
  typeof hook?.command === "string" && hook.command.includes(MARKER);
/** Remove our hook from a Claude-style `{EventName: [{matcher, hooks:[...]}]}` map. */
export function stripHooks(events: Record<string, any> | undefined) {
  if (!events || typeof events !== "object") return events;
  const next: Record<string, any> = {};
  for (const [event, groups] of Object.entries(events)) {
    if (!Array.isArray(groups)) {
      next[event] = groups;
      continue;
    }
    const kept = groups
      .map((group) =>
        group && Array.isArray(group.hooks)
          ? { ...group, hooks: group.hooks.filter((h: any) => !isOurs(h)) }
          : group,
      )
      .filter(
        (group) =>
          !group || !Array.isArray(group.hooks) || group.hooks.length > 0,
      );
    if (kept.length) next[event] = kept;
  }
  return next;
}
export const hasOurHook = (
  events: Record<string, any> | undefined,
  command?: string,
) =>
  !!events &&
  Object.values(events).some(
    (groups) =>
      Array.isArray(groups) &&
      groups.some(
        (group: any) =>
          Array.isArray(group?.hooks) &&
          group.hooks.some(
            (h: any) => isOurs(h) && (!command || h.command === command),
          ),
      ),
  );
const guardScriptPresent = (ctx: AdapterContext) =>
  exists(ctx.guard.script) && exists(ctx.guard.runtime);
const finalState = (
  ctx: AdapterContext,
  configured: boolean,
  upToDate: boolean,
  pending?: InstallState,
): InstallState => {
  if (!configured) return "off";
  if (!guardScriptPresent(ctx) || !upToDate) return "broken";
  return pending ?? "enabled";
};
// ---------------- Codex ----------------
const codexHooksFile = (home: string) =>
  path.join(home, ".codex", "hooks.json");
const codexEntry = (ctx: AdapterContext) => ({
  matcher: CODEX_GUARD_MATCHER,
  hooks: [
    {
      type: "command",
      command: hookCommand(ctx.guard, "codex"),
      timeout: 15,
      statusMessage: "360AI盒子 安全检查",
    },
  ],
});
export const codexAdapter: Adapter = {
  tool: "codex",
  mechanism: "Codex 官方 PreToolUse 钩子（~/.codex/hooks.json）",
  nextSteps: [
    "点击本页“信任此防护”，即可保存 Codex 对本工具安全钩子的信任。",
    "保存后重新打开 Codex 会话，真实钩子事件可作为运行证据。",
  ],
  warnings: [
    "新钩子需保存信任后才会运行，可直接在本页完成；不会信任其他钩子。",
  ],
  detect(ctx) {
    const dir = path.join(ctx.home, ".codex");
    const installed = exists(dir);
    const file = codexHooksFile(ctx.home);
    let configured = false,
      upToDate = false;
    try {
      const hooks = parseJson(read(file), file).hooks;
      configured = hasOurHook(hooks);
      upToDate = hasOurHook(hooks, hookCommand(ctx.guard, "codex"));
    } catch {}
    return {
      installed,
      configPath: file,
      // A trust entry can refer to a different hook or stale hash; never infer
      // this specific definition is trusted from another entry.
      state: installed
        ? finalState(ctx, configured, upToDate, hasCurrentCodexTrust(ctx) ? "enabled" : "needs_trust")
        : "absent",
    };
  },
  planEnable(ctx) {
    const file = codexHooksFile(ctx.home);
    const before = read(file);
    const root = parseJson(before, file);
    const events = stripHooks(root.hooks) ?? {};
    events.PreToolUse = [
      ...(Array.isArray(events.PreToolUse) ? events.PreToolUse : []),
      codexEntry(ctx),
    ];
    const after = pretty({ ...root, hooks: events });
    return [
      {
        path: file,
        action: before === undefined ? "create" : "update",
        detail: "加入 PreToolUse 安全检查钩子（保留你已有的其他钩子）",
        before,
        after,
      },
    ];
  },
  planDisable(ctx) {
    const file = codexHooksFile(ctx.home);
    const before = read(file);
    if (before === undefined) return [];
    const root = parseJson(before, file);
    if (!hasOurHook(root.hooks)) return [];
    return [
      {
        path: file,
        action: "update",
        detail: "移除 360AI盒子 安全检查钩子，保留其他钩子",
        before,
        after: pretty({ ...root, hooks: stripHooks(root.hooks) }),
      },
    ];
  },
};
// ---------------- Claude Code ----------------
const claudeSettings = (home: string) =>
  path.join(home, ".claude", "settings.json");
const claudeEntry = (
  ctx: AdapterContext,
  tool: SecurityTool,
  matcher: string,
) => ({
  matcher,
  hooks: [
    { type: "command", command: hookCommand(ctx.guard, tool), timeout: 15 },
  ],
});
export const claudeAdapter: Adapter = {
  tool: "claude",
  mechanism: "Claude Code 官方 PreToolUse 钩子（~/.claude/settings.json）",
  nextSteps: ["重新打开 Claude Code 会话后生效，可点击“验证”确认。"],
  warnings: [],
  detect(ctx) {
    const file = claudeSettings(ctx.home);
    const installed = exists(path.join(ctx.home, ".claude"));
    let configured = false,
      upToDate = false;
    try {
      const hooks = parseJson(read(file), file).hooks;
      configured = hasOurHook(hooks);
      upToDate = hasOurHook(hooks, hookCommand(ctx.guard, "claude"));
    } catch {}
    return {
      installed,
      configPath: file,
      state: installed ? finalState(ctx, configured, upToDate) : "absent",
    };
  },
  planEnable(ctx) {
    const file = claudeSettings(ctx.home);
    const before = read(file);
    const root = parseJson(before, file);
    const events = stripHooks(root.hooks) ?? {};
    events.PreToolUse = [
      ...(Array.isArray(events.PreToolUse) ? events.PreToolUse : []),
      claudeEntry(
        ctx,
        "claude",
        "Bash|Edit|Write|MultiEdit|Read|NotebookEdit|WebFetch",
      ),
    ];
    return [
      {
        path: file,
        action: before === undefined ? "create" : "update",
        detail: "加入 PreToolUse 安全检查钩子（保留原有设置）",
        before,
        after: pretty({ ...root, hooks: events }),
      },
    ];
  },
  planDisable(ctx) {
    const file = claudeSettings(ctx.home);
    const before = read(file);
    if (before === undefined) return [];
    const root = parseJson(before, file);
    if (!hasOurHook(root.hooks)) return [];
    const hooks = stripHooks(root.hooks);
    const next = { ...root, hooks };
    if (hooks && !Object.keys(hooks).length) delete next.hooks;
    return [
      {
        path: file,
        action: "update",
        detail: "移除安全检查钩子",
        before,
        after: pretty(next),
      },
    ];
  },
};
// ---------------- ZCode ----------------
const zcodeConfig = (home: string) =>
  path.join(home, ".zcode", "cli", "config.json");
export const zcodeAdapter: Adapter = {
  tool: "zcode",
  mechanism: "ZCode 用户级 hooks（~/.zcode/cli/config.json，出错时放行）",
  nextSteps: ["重新打开 ZCode 会话后生效，可点击“验证”确认。"],
  warnings: [],
  detect(ctx) {
    const file = zcodeConfig(ctx.home);
    const installed = exists(path.join(ctx.home, ".zcode"));
    let configured = false,
      upToDate = false,
      disabled = false;
    try {
      const hooks = parseJson(read(file), file).hooks;
      configured = hasOurHook(hooks?.events);
      upToDate = hasOurHook(hooks?.events, hookCommand(ctx.guard, "zcode"));
      disabled = hooks?.enabled === false;
    } catch {}
    return {
      installed,
      configPath: file,
      state: installed
        ? finalState(ctx, configured, upToDate && !disabled)
        : "absent",
      note: disabled ? "ZCode hooks 总开关已关闭" : undefined,
      autoEnableBlockedReason: disabled
        ? "ZCode hooks 总开关已在工具内关闭，默认开启不会覆盖"
        : undefined,
    };
  },
  planEnable(ctx) {
    const file = zcodeConfig(ctx.home);
    const before = read(file);
    const root = parseJson(before, file);
    const hooks =
      root.hooks && typeof root.hooks === "object" ? root.hooks : {};
    const events = stripHooks(hooks.events) ?? {};
    events.PreToolUse = [
      ...(Array.isArray(events.PreToolUse) ? events.PreToolUse : []),
      {
        matcher: ".*",
        hooks: [
          {
            type: "command",
            command: hookCommand(ctx.guard, "zcode"),
            timeoutMs: 15000,
            onError: "allow",
            statusMessage: "360AI盒子 安全检查",
          },
        ],
      },
    ];
    return [
      {
        path: file,
        action: before === undefined ? "create" : "update",
        detail: "开启 hooks 并加入 PreToolUse 安全检查（保留插件等原有配置）",
        before,
        after: pretty({ ...root, hooks: { ...hooks, enabled: true, events } }),
      },
    ];
  },
  planDisable(ctx) {
    const file = zcodeConfig(ctx.home);
    const before = read(file);
    if (before === undefined) return [];
    const root = parseJson(before, file);
    if (!hasOurHook(root.hooks?.events)) return [];
    const events = stripHooks(root.hooks.events) ?? {};
    const hooks = { ...root.hooks, events };
    const next = { ...root, hooks };
    // Keep enabled, timeout and other user settings even when no event remains.
    return [
      {
        path: file,
        action: "update",
        detail: "移除安全检查钩子",
        before,
        after: pretty(next),
      },
    ];
  },
};
// ---------------- OpenCode ----------------
const opencodeDir = (home: string) => path.join(home, ".config", "opencode");
const opencodePlugin = (home: string) =>
  path.join(opencodeDir(home), "plugin", `${MARKER}.js`);
export function opencodePluginSource(ctx: AdapterContext): string {
  const spec = JSON.stringify({
    runtime: ctx.guard.runtime,
    env: ctx.guard.env,
    script: ctx.guard.script,
    dataDir: ctx.guard.dataDir,
  });
  return `// ${MARKER}: generated by 360AI盒子 安全中心. Remove via the app or delete this file.
import { spawnSync } from "node:child_process";
const GUARD = ${spec};
const decide = (payload) => {
  const result = spawnSync(GUARD.runtime, [GUARD.script, "--tool", "opencode", "--data", GUARD.dataDir, "--marker", "${MARKER}"], {
    input: JSON.stringify(payload),
    env: { ...process.env, ...GUARD.env },
    encoding: "utf8",
    timeout: 15000,
  });
  if (result.error || result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout.trim().split("\\n").pop() || "{}").hookSpecificOutput;
  } catch {
    return undefined;
  }
};
export const NetworkLensGuard = async ({ directory }) => ({
  "tool.execute.before": async (input, output) => {
    const verdict = decide({ cwd: directory, sessionId: input.sessionID, toolName: input.tool, args: output.args });
    if (verdict && verdict.permissionDecision === "deny") throw new Error(verdict.permissionDecisionReason || "已被 360AI盒子 安全中心拦截");
  },
});
`;
}
export const opencodeAdapter: Adapter = {
  tool: "opencode",
  mechanism: "OpenCode 插件 tool.execute.before（~/.config/opencode/plugin/）",
  nextSteps: ["重新启动 OpenCode 后插件加载生效，可点击“验证”确认。"],
  warnings: [],
  detect(ctx) {
    const installed = exists(opencodeDir(ctx.home));
    const file = opencodePlugin(ctx.home);
    const content = read(file);
    return {
      installed,
      configPath: file,
      state: installed
        ? finalState(
            ctx,
            content !== undefined,
            content === opencodePluginSource(ctx),
          )
        : "absent",
    };
  },
  planEnable(ctx) {
    const file = opencodePlugin(ctx.home);
    const before = read(file);
    return [
      {
        path: file,
        action: before === undefined ? "create" : "update",
        detail: "写入执行前检查插件（独立文件，不改动 opencode.json）",
        before,
        after: opencodePluginSource(ctx),
      },
    ];
  },
  planDisable(ctx) {
    const file = opencodePlugin(ctx.home);
    const before = read(file);
    return before === undefined
      ? []
      : [
          {
            path: file,
            action: "remove",
            detail: "删除执行前检查插件",
            before,
          },
        ];
  },
};
// ---------------- DeepSeek Harness ----------------
const dshProfile = (home: string) =>
  path.join(home, ".dsh", "profiles", "desktop", "cordis.patch.yml");
const dshHooksFile = (home: string) =>
  path.join(home, ".dsh", `${MARKER}.hooks.json`);
const DSH_ROW_ID = `${MARKER}-hooks`;
const DSH_BEGIN = `# ${MARKER}:begin`;
const DSH_END = `# ${MARKER}:end`;
const dshRows = (text: string | undefined): any[] => {
  if (text === undefined || !text.trim()) return [];
  const doc = parseYaml(text, {
    customTags: [
      {
        tag: "tag:yaml.org,2002:js",
        resolve: (v: string) => ({ __js: v }),
      } as any,
    ],
  });
  if (doc == null) return [];
  if (!Array.isArray(doc))
    throw new Error("DeepSeek Harness 配置不是预期的列表格式，已停止修改。");
  return doc;
};
const dshUsesJs = (text?: string) => !!text && /!!js/.test(text);
export const dshAdapter: Adapter = {
  tool: "dsh",
  mechanism:
    "DeepSeek Harness 内置 Claude Code 钩子桥（@deepseek-ai/dsh-hooks-claude-code）",
  nextSteps: ["完全退出并重新打开 DeepSeek Harness 后生效，可点击“验证”确认。"],
  warnings: [
    "会在你的 DeepSeek Harness 配置末尾追加一行插件挂载，原有配置保持不变。",
  ],
  detect(ctx) {
    const file = dshProfile(ctx.home);
    const installed = exists(path.join(ctx.home, ".dsh"));
    const text = read(file);
    const hooks = read(dshHooksFile(ctx.home));
    const configured = !!text && text.includes(DSH_ROW_ID);
    let upToDate = false;
    try {
      upToDate = hasOurHook(
        JSON.parse(hooks ?? "{}").hooks,
        hookCommand(ctx.guard, "dsh"),
      );
    } catch {}
    return {
      installed,
      configPath: file,
      state: installed ? finalState(ctx, configured, upToDate) : "absent",
    };
  },
  planEnable(ctx) {
    const file = dshProfile(ctx.home);
    const before = read(file);
    const hooksFile = dshHooksFile(ctx.home);
    const hooksBefore = read(hooksFile);
    const hooksAfter = pretty({
      hooks: { PreToolUse: [claudeEntry(ctx, "dsh", "*")] },
    });
    const changes: PlannedChange[] = [
      {
        path: hooksFile,
        action: hooksBefore === undefined ? "create" : "update",
        detail: "写入安全检查钩子定义",
        before: hooksBefore,
        after: hooksAfter,
      },
    ];
    dshRows(before); // Validate without reserializing user !!js expressions.
    if (!before?.includes(DSH_BEGIN)) {
      if (before?.includes(DSH_ROW_ID))
        throw new Error("发现旧版 DeepSeek 防护配置，请先关闭后再重新开启。");
      const row = stringifyYaml([
        {
          insert: [
            {
              id: DSH_ROW_ID,
              name: "@deepseek-ai/dsh-hooks-claude-code",
              config: { configPath: hooksFile, defaultTimeoutMs: 15000 },
            },
          ],
        },
      ]);
      const head =
        before === undefined
          ? ""
          : before.endsWith("\n")
            ? before
            : before + "\n";
      const insert = DSH_BEGIN + "\n" + row + DSH_END + "\n";
      changes.push({
        path: file,
        action: before === undefined ? "create" : "update",
        detail: "在配置末尾追加钩子桥挂载（原有行不变）",
        before,
        after: head + insert,
      });
    }
    if (dshUsesJs(before))
      changes[changes.length - 1].detail +=
        "；检测到 !!js 表达式，已用文本追加方式保持原样";
    return changes;
  },
  planDisable(ctx) {
    const file = dshProfile(ctx.home);
    const before = read(file);
    const changes: PlannedChange[] = [];
    if (before && before.includes(DSH_ROW_ID)) {
      const begin = before.indexOf(DSH_BEGIN);
      const end = before.indexOf(DSH_END);
      if (begin >= 0 && end > begin) {
        changes.push({
          path: file,
          action: "update",
          detail: "移除安全中心挂载块，保留原配置",
          before,
          after:
            before.slice(0, begin) +
            before.slice(end + DSH_END.length).replace(/^\n/, ""),
        });
      } else {
        const lines = before.split("\n");
        const out: string[] = [];
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(`# ${MARKER}`)) continue;
          if (lines[i].startsWith("- id: " + DSH_ROW_ID)) {
            i++;
            while (
              i < lines.length &&
              (lines[i].startsWith(" ") || lines[i] === "")
            ) {
              if (lines[i] === "" && i === lines.length - 1) break;
              i++;
            }
            i--;
            continue;
          }
          out.push(lines[i]);
        }
        changes.push({
          path: file,
          action: "update",
          detail: "移除钩子桥挂载行",
          before,
          after: out.join("\n"),
        });
      }
    }
    const hooksFile = dshHooksFile(ctx.home);
    const hooksBefore = read(hooksFile);
    if (hooksBefore !== undefined)
      changes.push({
        path: hooksFile,
        action: "remove",
        detail: "删除钩子定义文件",
        before: hooksBefore,
      });
    return changes;
  },
};
// ---------------- WisCode ----------------
export const wiscodeAdapter: Adapter = {
  tool: "wiscode",
  mechanism: "未发现公开的执行前钩子接口",
  nextSteps: [],
  warnings: [],
  detect(ctx) {
    // Windows installers land under Program Files or the per-user Programs
    // directory; only the presence of the executable is checked, never run.
    const windowsApp =
      process.platform === "win32"
        ? [
            path.join(
              process.env["ProgramFiles"] || "C:\\Program Files",
              "WisCode",
              "WisCode.exe",
            ),
            path.join(
              process.env["LOCALAPPDATA"] ||
                path.join(ctx.home, "AppData", "Local"),
              "Programs",
              "WisCode",
              "WisCode.exe",
            ),
          ].some((file) => exists(file))
        : false;
    const installed =
      exists(path.join(ctx.home, ".wiscode")) ||
      exists("/Applications/WisCode.app") ||
      windowsApp;
    return {
      installed,
      state: installed ? "unsupported" : "absent",
      note: "可做配置体检与事件记录，暂不能在执行前拦截。",
    };
  },
  planEnable: () => [],
  planDisable: () => [],
};
export const ADAPTERS: Adapter[] = [
  codexAdapter,
  claudeAdapter,
  opencodeAdapter,
  zcodeAdapter,
  dshAdapter,
  wiscodeAdapter,
];
export const adapterFor = (tool: SecurityTool) => {
  const adapter = ADAPTERS.find((a) => a.tool === tool);
  if (!adapter) throw new Error("不支持的工具");
  return adapter;
};
/** Apply planned changes with per-file backup; on failure, restore everything already written. */
export function applyChanges(
  changes: PlannedChange[],
  backupDir: string,
  now = Date.now(),
): string[] {
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const applied: PlannedChange[] = [];
  const backups: string[] = [];
  const modes = new Map<string, number>();
  try {
    for (const change of changes) {
      const current = read(change.path);
      if (current !== change.before)
        throw new Error(
          `${change.path} 在预览后被其他程序修改，请重新预览后再试。`,
        );
      if (change.before !== undefined) {
        modes.set(change.path, fs.statSync(change.path).mode & 0o777);
        const backup = path.join(
          backupDir,
          `${now}-${change.path.replace(/[\\/:]/g, "_")}`,
        );
        fs.writeFileSync(backup, change.before, { mode: 0o600 });
        backups.push(backup);
      }
      if (change.action === "remove") fs.unlinkSync(change.path);
      else {
        fs.mkdirSync(path.dirname(change.path), { recursive: true });
        const mode =
          change.before !== undefined
            ? fs.statSync(change.path).mode & 0o777
            : 0o600;
        const temp = `${change.path}.${process.pid}.${now}.tmp`;
        fs.writeFileSync(temp, change.after ?? "", { mode });
        fs.renameSync(temp, change.path);
      }
      applied.push(change);
    }
  } catch (error) {
    for (const change of applied.reverse()) {
      try {
        if (change.before === undefined) fs.unlinkSync(change.path);
        else {
          fs.writeFileSync(change.path, change.before, {
            mode: modes.get(change.path) ?? 0o600,
          });
          fs.chmodSync(change.path, modes.get(change.path) ?? 0o600);
        }
      } catch {}
    }
    throw error;
  }
  return backups;
}
