import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { sanitizer } from "../../src/shared/handoff";
import { normalizeCommand } from "./normalize";
import { classifyInput } from "./classification";
import type { GuardFacts } from "../../src/shared/security";
export interface GuardPolicyFile {
  version: 1;
  protectedBranches: string[];
  blockedCommands: string[];
  sensitivePaths: string[];
  writeProtectedPaths: string[];
  projectRoots: string[];
  allowOutsideProjectWrites: boolean;
  rules: { id: string; enabled: boolean; level: string }[];
  exceptions?: { ruleId: string; project: string; createdAt: number }[];
  projects?: {
    root: string;
    enabled: boolean;
    protectedBranches: string[];
    protectedPaths: string[];
  }[];
  autoProtect?: boolean;
  toolPreferences?: Record<string, "auto" | "off">;
}
export interface GuardInput {
  tool: string;
  project?: string;
  sessionId?: string;
  toolName?: string;
  command?: string;
  paths?: string[];
  readPaths?: string[];
  urls?: string[];
}
export interface GuardDecision {
  decision: "deny" | "ask" | "allow";
  ruleId?: string;
  reason?: string;
  operation: string;
}
const MAX_COMMAND = 1_000_000;
const MAX_PATHS = 40;
export function defaultPolicy(): GuardPolicyFile {
  return {
    version: 1,
    protectedBranches: ["main", "master", "release/*", "prod", "production"],
    blockedCommands: [],
    sensitivePaths: [
      ".env",
      ".env.*",
      "*.pem",
      "*.key",
      "*.p12",
      "id_rsa",
      "id_ed25519",
      ".ssh",
      ".aws/credentials",
      ".codex/auth.json",
      ".codex/config.toml",
      ".claude/.credentials.json",
      ".config/opencode/auth.json",
      ".zcode/credentials.json",
      ".zcode/v2/config.json",
      ".zcode/provider_config.json",
      ".dsh/.credentials.yaml",
      ".dsh/profiles/desktop/cordis.patch.yml",
      ".local/share/opencode/auth.json",
      ".wiscode/codex-agents/auth.json",
      ".npmrc",
      ".netrc",
      "*.pfx",
    ],
    writeProtectedPaths: [".git/hooks", ".git/config", ".husky"],
    projectRoots: [],
    allowOutsideProjectWrites: true,
    // Protect-by-default: installed tools that support pre-execution hooks get
    // the guard on first run. Users can still turn an individual tool off.
    autoProtect: true,
    toolPreferences: {},
    rules: [
      { id: "protected_branch", enabled: true, level: "high" },
      { id: "destructive", enabled: true, level: "high" },
      { id: "remote_exec", enabled: true, level: "high" },
      { id: "credential_read", enabled: true, level: "high" },
      { id: "credential_write", enabled: true, level: "high" },
      { id: "privilege", enabled: true, level: "medium" },
      { id: "protected_path_write", enabled: true, level: "medium" },
      { id: "dns_exfil", enabled: true, level: "medium" },
      { id: "infra_destroy", enabled: true, level: "high" },
      { id: "db_destroy", enabled: true, level: "high" },
      { id: "cloud_delete", enabled: true, level: "high" },
      { id: "prod_write", enabled: true, level: "medium" },
      { id: "obfuscated_exec", enabled: true, level: "high" },
    ],
  };
}
const escapeRegExp = (value: string) =>
  value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
const globToRegExp = (glob: string) =>
  new RegExp("^" + glob.split("*").map(escapeRegExp).join("[^/]*") + "$");
export function matchesAny(value: string, globs: string[]): boolean {
  const normalized = value
    .replace(/^~(?=\/|$)/, os.homedir())
    .replace(/^\$HOME(?=\/|$)/, os.homedir())
    .replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  return globs.some((glob) => {
    // A bare name matches any path segment, so ".ssh" also covers files inside ~/.ssh.
    if (!glob.includes("/")) {
      const pattern = globToRegExp(glob);
      return segments.some((segment) => pattern.test(segment));
    }
    const full = glob
      .replace(/^~(?=\/|$)/, os.homedir())
      .replace(/^\$HOME(?=\/|$)/, os.homedir())
      .replace(/\\/g, "/")
      .replace(/\/+$/, "");
    // Directory patterns retain the same segment wildcard behavior as bare
    // filenames, and also cover descendants of a matched directory.
    const pattern = full.split("*").map(escapeRegExp).join("[^/]*");
    return new RegExp(
      (full.startsWith("/") ? "^" : "(?:^|/)") + pattern + "(?:/|$)",
    ).test(normalized);
  });
}
export function splitCommands(command: string): string[] {
  return command
    .split(/\n|&&|\|\||;|\|(?!\|)/)
    .map((s) => s.trim())
    .filter(Boolean);
}
const OPERAND = /("[^"]+"|'[^']+'|[^\s"'|&;]+)/;
const clean = (value?: string) =>
  value ? value.replace(/^["']|["']$/g, "") : "";
export function extractWritePaths(segment: string): string[] {
  const paths: string[] = [];
  for (const match of segment.matchAll(
    new RegExp("(?:^|[^0-9&<>])\\d?(?:>>|>)\\s*" + OPERAND.source, "g"),
  ))
    if (!/^&?\d$/.test(match[1]) && match[1] !== "/dev/null")
      paths.push(clean(match[1]));
  for (const match of segment.matchAll(
    new RegExp(
      "\\b(?:touch|mkdir|tee)\\s+(?:-\\S+\\s+)*" +
        OPERAND.source +
        "(?:\\s+" +
        OPERAND.source +
        ")?",
      "g",
    ),
  ))
    for (const group of match.slice(1)) if (group) paths.push(clean(group));
  for (const match of segment.matchAll(
    new RegExp(
      "\\b(?:cp|mv|install)\\s+(?:-\\S+\\s+)*" +
        OPERAND.source +
        "\\s+" +
        OPERAND.source,
      "g",
    ),
  ))
    paths.push(clean(match[2]));
  for (const match of segment.matchAll(
    new RegExp(
      "\\bsed\\s+-[a-zA-Z]*i[a-zA-Z]*\\s+(?:-e\\s+\\S+\\s+)?" + OPERAND.source,
      "g",
    ),
  ))
    paths.push(clean(match[1]));
  for (const match of segment.matchAll(
    new RegExp(
      "\\bperl\\s+-[0-9a-zA-Z]*i\\S*\\s+(?:-e\\s+" +
        OPERAND.source +
        "\\s+)?" +
        OPERAND.source,
      "g",
    ),
  ))
    paths.push(clean(match[2]));
  const tokens = segment.match(/"[^"]*"|'[^']*'|[^\s]+/g)?.map(clean) ?? [];
  if (/\b(?:rm|chmod|chown|sed|perl|tee|touch)\b/.test(segment))
    paths.push(...tokens.filter((t) => !t.startsWith("-")));
  return [...new Set(paths.filter(Boolean))];
}
export function extractReadPaths(segment: string): string[] {
  const paths: string[] = [];
  for (const match of segment.matchAll(
    new RegExp(
      "\\b(?:cat|head|tail|less|more|awk|grep|rg|strings|xxd|od|base64|scp|rsync)\\s+(?:-\\S+\\s+)*" +
        OPERAND.source,
      "g",
    ),
  ))
    paths.push(clean(match[1]));
  for (const match of segment.matchAll(
    new RegExp("\\bopen\\s+" + OPERAND.source, "g"),
  ))
    paths.push(clean(match[1]));
  for (const match of segment.matchAll(
    new RegExp("\\bcurl\\b[^|]*?(?:-H|-d|-F|-T)\\s+@?" + OPERAND.source, "g"),
  ))
    paths.push(clean(match[1]));
  if (
    /\b(?:cat|head|tail|less|more|grep|rg|cp|scp|rsync|base64|source)\b/.test(
      segment,
    )
  ) {
    const tokens = segment.match(/"[^"]*"|'[^']*'|[^\s]+/g)?.map(clean) ?? [];
    paths.push(...tokens.filter((t) => !t.startsWith("-")));
  }
  return [...new Set(paths.filter((p) => p && !p.startsWith("-")))];
}
export const extractUrls = (text: string): string[] =>
  [...new Set(text.match(/\bhttps?:\/\/[^\s"'<>]+/g) ?? [])].slice(0, 20);
export function branchFromPush(segment: string): string | undefined {
  const match = segment.match(/git\s+push\b(.*)$/);
  if (!match) return undefined;
  const parts = match[1]
    .replace(/--?\S+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  // A single argument is normally the remote name, not a branch. The current
  // branch/upstream cannot be determined reliably from the hook payload.
  if (parts.length <= 1) return "current";
  const target = parts[parts.length - 1];
  const ref = target.includes(":") ? target.split(":").pop()! : target;
  return ref.replace(/^refs\/heads\//, "").replace(/^HEAD$/, "current");
}
const branchMatches = (branch: string, protectedBranches: string[]) =>
  protectedBranches.some((glob) =>
    glob.endsWith("/*")
      ? branch.startsWith(glob.slice(0, -1))
      : branch === glob,
  );

/** Infrastructure-wide destroy: terraform/pulumi tearing everything down. */
const INFRA_DESTROY =
  /\b(?:terraform|tofu)\s+destroy\b|\bterraform\s+apply\b[^\n]*--?auto-approve\b|\bpulumi\s+destroy\b/i;
/** `terraform plan`, `terraform apply` and `terraform state list` stay allowed. */
const INFRA_READONLY = /^\s*(?:terraform|tofu|pulumi)\s+(?:plan|validate|fmt|show|output|state|providers?|version)\b/i;

/** SQL that wipes a database or table outright. */
const DB_DESTROY =
  /\b(?:drop\s+(?:database|table|schema|index|view)\b|truncate\s+(?:table\s+)?[\w."`[]|flushall\b|flushdb\b)/i;
/**
 * SQL text only matters when it is sent to a database. Without this,
 * `grep "drop table" docs/` or `git log --grep TRUNCATE` would be blocked.
 */
const DB_CLIENT =
  /\b(?:psql|mysql|mariadb|sqlite3?|sqlcmd|mongo|mongosh|redis-cli|clickhouse(?:-client)?|cqlsh|duckdb|pgcli|mycli|usql|snowsql|bq\s+query)\b|\b(?:prisma|knex|sequelize|typeorm)\b[^\n]*\b(?:db\s+execute|raw|query)\b/i;
/** FLUSHALL/FLUSHDB are Redis commands; a redis client must be present. */
const REDIS_WIPE = /\bredis-cli\b[^\n]*\bflush(?:all|db)\b/i;
const isDatabaseWipe = (segment: string) =>
  REDIS_WIPE.test(segment) ||
  (DB_CLIENT.test(segment) &&
    (DB_DESTROY.test(segment) || deletesEverything(segment)));
/**
 * `DELETE FROM t` with no WHERE removes every row. Checked separately so the
 * common `DELETE FROM t WHERE id = 1` stays allowed.
 */
function deletesEverything(command: string): boolean {
  const match = command.match(/\bdelete\s+from\b(.*)$/is);
  if (!match) return false;
  // A following statement may carry its own WHERE; only the DELETE clause counts.
  const clause = match[1].split(/;|\n/)[0];
  return !/\bwhere\b/i.test(clause);
}

/** Cloud control-plane deletes, e.g. kubectl delete / aws ... delete-bucket. */
const CLOUD_DELETE =
  /\b(?:kubectl\s+delete\b|(?:aws|gcloud|az|aliyun|tccli|hcloud)\b[^\n]*\s(?:delete-[\w-]+|delete|Delete[\w]*|rm)\b)/i;

/**
 * Operations that reach beyond this machine: databases, clusters, registries,
 * cloud APIs. Local file edits are excluded on purpose — they are already
 * covered by `destructive` / `protected_path_write`, and including them here
 * would block routine `npm run build:prod` style commands.
 */
const REMOTE_WRITE =
  /\bkubectl\s+(?:apply|delete|patch|scale|rollout|replace|drain|cordon)\b|\bterraform\s+apply\b|\bhelm\s+(?:install|upgrade|uninstall|delete)\b|\bdocker\s+(?:push|rm|rmi)\b|\bnpm\s+publish\b|\b(?:curl|wget)\b[^\n]*\s(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--request\s+(?:POST|PUT|PATCH|DELETE))/i;
/** SQL write verbs; only meaningful when a database client is in the same segment. */
const SQL_WRITE = /\b(?:insert|update|delete|alter|drop|truncate|grant|revoke|create|replace|merge)\b/i;
/** Production markers as whole words, so "product" and "reproduce" do not count. */
const PROD_MARKER =
  /(?:^|[^a-z0-9])(?:prod|prd|production|prod-[a-z0-9-]+)(?:[^a-z0-9]|$)/i;
/** Reading production config/state is normal; only pair it with a remote write. */
function looksLikeProductionWrite(segment: string): boolean {
  if (!PROD_MARKER.test(segment)) return false;
  if (INFRA_READONLY.test(segment)) return false;
  return (
    REMOTE_WRITE.test(segment) ||
    (DB_CLIENT.test(segment) && SQL_WRITE.test(segment))
  );
}
/** Read-only cloud queries stay allowed even with a production target. */
const CLOUD_READONLY =
  /\b(?:kubectl\s+(?:get|describe|logs|top)\b|aws\b[^\n]*\s(?:list|describe|get)-|\bgcloud\b[^\n]*\s(?:list|describe)\b)/i;

/** Apply rules, then per-project exceptions the user granted from the timeline. */
export function decide(
  input: GuardInput,
  policy: GuardPolicyFile,
): GuardDecision {
  const canonical = (value: string) => {
    try {
      return fs.realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  };
  const directory = input.project ? canonical(input.project) : undefined;
  input = { ...input, project: directory };
  const project = directory
    ? (policy.projects ?? [])
        .filter(
          (p) =>
            p.enabled &&
            (directory === canonical(p.root) ||
              directory.startsWith(canonical(p.root) + path.sep)),
        )
        .sort((a, b) => b.root.length - a.root.length)[0]
    : undefined;
  const effective = project
    ? {
        ...policy,
        protectedBranches: [
          ...new Set([
            ...policy.protectedBranches,
            ...project.protectedBranches,
          ]),
        ],
        writeProtectedPaths: [
          ...policy.writeProtectedPaths,
          ...project.protectedPaths.map((p) => path.resolve(project.root, p)),
        ],
      }
    : policy;
  const result = evaluate(input, effective);
  if (result.decision !== "deny" || !input.project) return result;
  const currentProject = canonical(input.project);
  const exempt = (policy.exceptions ?? []).some(
    (e) =>
      e.ruleId === result.ruleId && currentProject === canonical(e.project),
  );
  return exempt
    ? {
        decision: "allow",
        operation: result.operation,
        ruleId: result.ruleId,
        reason: "已按你设置的项目例外放行",
      }
    : result;
}
function evaluate(input: GuardInput, policy: GuardPolicyFile): GuardDecision {
  const enabled = new Set(
    policy.rules.filter((r) => r.enabled).map((r) => r.id),
  );
  const raw = (input.command ?? "").slice(0, MAX_COMMAND);
  /**
   * Match against a normalised copy so quoting tricks, variable indirection and
   * shell wrappers keep hitting the same rules. `raw` still drives the recorded
   * operation text, so nothing user-visible changes for benign commands.
   */
  const normalized = raw ? normalizeCommand(raw) : undefined;
  const command = normalized?.text ?? raw;
  const segments = command ? splitCommands(command) : [];
  const operation =
    (input.toolName ?? "tool") +
    (raw
      ? ": " + (raw.trim().match(/^[a-zA-Z0-9_.-]+/)?.[0] ?? "命令")
      : "");
  const deny = (ruleId: string, reason: string): GuardDecision => ({
    decision: "deny",
    ruleId,
    reason,
    operation,
  });
  /**
   * "Needs confirmation" rules still return deny. Only Codex and Claude Code
   * understand permissionDecision="ask"; the OpenCode plugin only acts on
   * "deny", so returning ask would silently allow the operation there. The
   * reason text tells the user this is a confirmation gate, not a hard block.
   */
  const confirm = (ruleId: string, reason: string): GuardDecision =>
    deny(ruleId, `${reason}确认无误后请手动执行，或在安全中心为该项目添加例外。`);
  const protectedWrite = (target: string) =>
    matchesAny(target, policy.writeProtectedPaths) ||
    (!!input.project &&
      matchesAny(
        path.resolve(input.project, target),
        policy.writeProtectedPaths,
      ));
  if (
    (input.command?.length ?? 0) > MAX_COMMAND ||
    (input.paths?.length ?? 0) > MAX_PATHS ||
    (input.readPaths?.length ?? 0) > MAX_PATHS
  )
    return deny("input_limit", "操作内容超过单次检查上限，请拆分操作。");
  if (enabled.has("obfuscated_exec") && normalized?.dynamic)
    return deny(
      "obfuscated_exec",
      `命令的执行内容由算式生成（${normalized.traces.join("、")}），无法在执行前审计。`,
    );
  // Pipelines must be checked before segment splitting separates "curl" from "sh".
  if (
    enabled.has("remote_exec") &&
    /(curl|wget)\b[^\n;&]*\|\s*(sudo\s+)?(ba|z|d|k)?sh\b/.test(command)
  )
    return deny("remote_exec", "下载后直接执行远程脚本，内容无法审计。");
  if (
    enabled.has("remote_exec") &&
    /\b(ba|z)?sh\s+<\(\s*(curl|wget)\b/.test(command)
  )
    return deny("remote_exec", "下载后直接执行远程脚本，内容无法审计。");
  for (const segment of segments) {
    if (enabled.has("privilege") && /(^|\s)(sudo|doas)\s/.test(segment))
      return deny("privilege", "提升权限执行需要人工确认，已在执行前拦截。");
    if (
      enabled.has("privilege") &&
      /\bchmod\s+(?:-R\s+)?(?:0?777|a\+rwx)\b/.test(segment)
    )
      return deny("privilege", "向所有用户开放读写和执行权限。");
    if (
      enabled.has("destructive") &&
      /\bgit\s+(?:-\S+\s+)*push\b[^\n]*(?:--force(?:-with-lease)?\b|\s-[\w]*f\b|\s\+\S)/.test(
        segment,
      )
    )
      return deny("destructive", "强制推送可能覆盖远程提交。");
    if (
      enabled.has("destructive") &&
      policy.blockedCommands.some((blocked) => {
        const prefix = blocked.trim().toLowerCase();
        const command = segment.toLowerCase();
        return (
          !!prefix &&
          command.startsWith(prefix) &&
          (command.length === prefix.length ||
            /\s/.test(command[prefix.length]))
        );
      })
    )
      return deny("destructive", "命中高危命令黑名单。");
    if (
      enabled.has("destructive") &&
      /\brm\s+(?:-[a-zA-Z]+\s+)+(?:["']?(?:\/|~\/?|\$HOME\/?)["']?)(?:\s|$)/.test(
        segment,
      )
    )
      return deny("destructive", "递归删除根目录或用户主目录。");
    if (enabled.has("infra_destroy") && INFRA_DESTROY.test(segment))
      return deny(
        "infra_destroy",
        "该命令会整体销毁基础设施，请先确认目标环境并改用分步操作。",
      );
    if (enabled.has("db_destroy") && isDatabaseWipe(segment))
      return deny(
        "db_destroy",
        "该命令会清空数据库或整张表，请确认后改用带条件的语句。",
      );
    if (enabled.has("protected_branch") && /\bgit\s+push\b/.test(segment)) {
      const pushArgs = segment
        .replace(/^.*?\bgit\s+push\s*/, "")
        .split(/\s+/)
        .filter((p) => p && !p.startsWith("-"));
      const branches = pushArgs.slice(1).map((p) =>
        p
          .split(":")
          .pop()!
          .replace(/^refs\/heads\//, ""),
      );
      const branch =
        branches.find((b) => branchMatches(b, policy.protectedBranches)) ??
        branchFromPush(segment);
      if (/--all|--mirror/.test(segment))
        return deny(
          "protected_branch",
          "批量推送可能包含受保护分支，请逐个指定分支。",
        );
      if (
        branch &&
        (branch === "current" ||
          branchMatches(branch, policy.protectedBranches))
      )
        return deny(
          "protected_branch",
          branch === "current"
            ? "无法从命令确定推送分支，请明确指定非受保护分支。"
            : `推送到受保护分支 ${branch}，请改用特性分支或合并请求。`,
        );
    }
    if (enabled.has("credential_write"))
      for (const target of extractWritePaths(segment))
        if (matchesAny(target, policy.sensitivePaths))
          return deny("credential_write", `改写凭据类文件 ${target}。`);
    if (enabled.has("credential_read"))
      for (const target of extractReadPaths(segment))
        if (matchesAny(target, policy.sensitivePaths))
          return deny("credential_read", `读取凭据类文件 ${target}。`);
    if (enabled.has("protected_path_write"))
      for (const target of extractWritePaths(segment))
        if (protectedWrite(target))
          return deny("protected_path_write", `改写受保护路径 ${target}。`);
    if (
      enabled.has("cloud_delete") &&
      !CLOUD_READONLY.test(segment) &&
      CLOUD_DELETE.test(segment)
    )
      return confirm(
        "cloud_delete",
        "该命令会删除云资源，请确认命名空间与环境。",
      );
    if (enabled.has("prod_write") && looksLikeProductionWrite(segment))
      return confirm(
        "prod_write",
        "该命令同时涉及生产环境与写操作，请确认目标环境。",
      );
  }
  if (input.paths?.length) {
    if (enabled.has("credential_write"))
      for (const target of input.paths.slice(0, MAX_PATHS))
        if (matchesAny(target, policy.sensitivePaths))
          return deny("credential_write", `改写凭据类文件 ${target}。`);
    if (enabled.has("protected_path_write"))
      for (const target of input.paths.slice(0, MAX_PATHS))
        if (protectedWrite(target))
          return deny("protected_path_write", `改写受保护路径 ${target}。`);
  }
  if (input.readPaths?.length && enabled.has("credential_read"))
    for (const target of input.readPaths.slice(0, MAX_PATHS))
      if (matchesAny(target, policy.sensitivePaths))
        return deny("credential_read", `读取凭据类文件 ${target}。`);
  if (
    enabled.has("dns_exfil") &&
    /\b(?:curl|wget)\b[^\n]*(?:\s-(?:d|F|T)\b|--data|--upload-file)/.test(
      command,
    )
  )
    for (const url of [...(input.urls ?? []), ...extractUrls(command)]) {
      const host = url
        .replace(/^https?:\/\//, "")
        .split(/[/?#:]/)[0]
        .toLowerCase();
      if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host))
        return deny("dns_exfil", `命令尝试向裸 IP 地址发送数据`);
      if (/\.(top|xyz|icu|tk)$/.test(host))
        return deny("dns_exfil", `命令尝试向高风险域名发送数据`);
    }
  return { decision: "allow", operation };
}
export const eventsFile = (dataDir: string) =>
  path.join(dataDir, "events.jsonl");
const truncate = (value: string, size = 400) =>
  value.length > size ? value.slice(0, size) + "…" : value;
/** Keep only bounded, already-derived labels: no raw command text can leak in. */
function cleanFacts(facts: GuardFacts): GuardFacts {
  const clean = sanitizer().clean;
  const list = (values: string[], size = 6) =>
    [...new Set(values.map((v) => clean(String(v)).slice(0, 40)))].filter(
      Boolean,
    ).slice(0, size);
  return {
    level: facts.level,
    ...(facts.classifierVersion ? { classifierVersion: facts.classifierVersion } : {}),
    kinds: list(facts.kinds),
    verbs: list(facts.verbs),
    hits: list(facts.hits, 8),
    ...(facts.hosts?.length ? { hosts: list(facts.hosts, 10) } : {}),
    ...(facts.env ? { env: facts.env } : {}),
    ...(facts.normalized ? { normalized: true } : {}),
  };
}
export interface GuardEventLine {
  id: string;
  at: number;
  tool: string;
  project: string;
  sessionId: string;
  toolName: string;
  operation: string;
  ruleId?: string;
  decision: "deny" | "ask" | "allow";
  outcome: "observed";
  source: string;
  reason?: string;
  facts?: GuardFacts;
  prev: string;
  hash: string;
}
export function readLastHash(file: string): string {
  try {
    const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
    const last = lines[lines.length - 1];
    return last ? (JSON.parse(last).hash as string) : "";
  } catch {
    return "";
  }
}
export function logDecision(
  dataDir: string,
  decision: GuardDecision,
  input: GuardInput,
  extra: { source?: string; at?: number; facts?: GuardFacts } = {},
): GuardEventLine {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = eventsFile(dataDir);
  const at = extra.at ?? Date.now();
  const clean = sanitizer().clean;
  const lock = file + ".lock";
  const start = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) {
          fs.rmdirSync(lock);
          continue;
        }
      } catch {}
      if (Date.now() - start > 1200)
        throw new Error("安全日志繁忙，未记录本次事件");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 8_000_000)
      fs.renameSync(file, file + ".1");
    // Classify while the full input is still in hand; only the verdict is
    // stored, never the raw command. Callers may pass a precomputed verdict.
    const facts =
      extra.facts ??
      (input.tool === "app"
        ? undefined
        : classifyInput(input, decision.ruleId));
    const body = {
      id: randomUUID(),
      at,
      tool: input.tool,
      project: truncate(clean(input.project ?? "")),
      sessionId: truncate(clean(input.sessionId ?? ""), 120),
      toolName: truncate(clean(input.toolName ?? ""), 120),
      operation: truncate(clean(decision.operation)),
      ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
      decision: decision.decision,
      outcome: "observed" as const,
      source: extra.source ?? "real_block",
      ...(decision.reason ? { reason: truncate(clean(decision.reason)) } : {}),
      ...(facts ? { facts: cleanFacts(facts) } : {}),
      prev: readLastHash(file) || readLastHash(file + ".1"),
    };
    const line: GuardEventLine = {
      ...body,
      hash: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
    };
    fs.appendFileSync(file, JSON.stringify(line) + "\n", { mode: 0o600 });
    return line;
  } finally {
    fs.rmdirSync(lock);
  }
}
export function hookOutput(decision: GuardDecision, event = "PreToolUse") {
  if (decision.decision === "deny")
    return {
      hookSpecificOutput: {
        hookEventName: event,
        permissionDecision: "deny",
        permissionDecisionReason: `[360AI盒子 安全中心] ${decision.reason ?? "命中防护规则"}`,
      },
    };
  if (decision.decision === "ask")
    return {
      hookSpecificOutput: {
        hookEventName: event,
        permissionDecision: "ask",
        permissionDecisionReason: decision.reason,
      },
    };
  return {};
}
const stringField = (value: unknown) =>
  typeof value === "string" ? value : undefined;
const READ_TOOLS =
  /^(read|view|grep|glob|ls|list|search|notebookread|read_file|cat)$/i;
const PATCH_FILE = /^\*\*\* (?:(?:Update|Add|Delete) File|Move to): (.+)$/gm;
/**
 * Normalise stdin payloads of every supported dialect into GuardInput.
 * Codex/Claude/ZCode/DSH send `tool_name` + `tool_input`; the OpenCode plugin
 * sends `toolName` + `args` with the same meaning.
 */
export function summarizePayload(payload: unknown, tool: string): GuardInput {
  const root = (payload ?? {}) as Record<string, unknown>;
  const toolInput =
    root.tool_input && typeof root.tool_input === "object"
      ? (root.tool_input as Record<string, unknown>)
      : root.args && typeof root.args === "object"
        ? (root.args as Record<string, unknown>)
        : {};
  const toolName =
    stringField(root.tool_name) ?? stringField(root.toolName) ?? "tool";
  let command =
    stringField(toolInput.command) ?? stringField(toolInput.cmd) ?? undefined;
  const patch =
    stringField(toolInput.patch) ??
    stringField(toolInput.patchText) ??
    (command && command.includes("*** Begin Patch") ? command : undefined);
  if (patch && command === patch) command = undefined;
  const filePath =
    stringField(toolInput.file_path) ??
    stringField(toolInput.filePath) ??
    stringField(toolInput.path) ??
    stringField(toolInput.notebook_path);
  const patchPaths = patch
    ? [...patch.matchAll(PATCH_FILE)].map((m) => m[1].trim())
    : [];
  const isRead =
    READ_TOOLS.test(toolName) ||
    (toolName === "str_replace_editor" && toolInput.command === "view");
  const writes = [...(isRead ? [] : [filePath]), ...patchPaths].filter(
    (p): p is string => !!p,
  );
  const reads = isRead && filePath ? [filePath] : [];
  const url = stringField(toolInput.url);
  return {
    tool,
    project: (() => {
      const cwd =
        stringField(root.cwd) ??
        stringField(root.directory) ??
        stringField(root.project);
      const workdir =
        stringField(toolInput.workdir) ?? stringField(toolInput.cwd);
      return workdir ? path.resolve(cwd ?? process.cwd(), workdir) : cwd;
    })(),
    sessionId: stringField(root.session_id) ?? stringField(root.sessionId),
    toolName,
    ...(command ? { command } : {}),
    ...(writes.length ? { paths: writes } : {}),
    ...(reads.length ? { readPaths: reads } : {}),
    ...(url ? { urls: [url] } : {}),
  };
}
