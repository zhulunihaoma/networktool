import fs from "node:fs/promises";
import { constants } from "node:fs";
import { SKILL_TARGETS as TOOL_REGISTRY, SKILL_TARGETS_CHECKED_AT, type SkillTargetDefinition } from "../../src/shared/skill-targets";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { SkillCopyResult, SkillItem, SkillScan, SkillCopyPreview, SkillVerification, SkillDeletePreview, SkillDeleteResult } from "../../src/shared/skills";
import { convertSkill, convertOpenaiMetadata, SKILL_RULES, SKILL_RULES_DATE } from "./skill-compatibility";
import { checkSkillResources, discoverOpenCode, matchDiscoveredSkill, type SkillProbe } from "./skill-verification";
import { analyzeSkillTree, copySkillTree, fingerprintSkillTree, resolveSkillLink } from "./skill-copy-tree";
import { adviseSkills, deletionFingerprint, listTrashedSkills, moveSkillToTrash, restoreTrashedSkill } from "./skill-cleanup";
import { attachSkillUsage } from "./skill-usage";

const MAX_DEPTH = 6, MAX_ENTRIES = 4000, MAX_DOCUMENT = 256 * 1024;
const MAX_COPY_FILES = 500;

// Copy targets are explicitly audited; legacy scan roots must never select the destination.

function clean(value: string, limit = 300) {
  return value.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}
function parse(text: string, fallback: string) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const meta: Record<string, string> = {};
  let start = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
    if (end > 0) {
      start = end + 1;
      for (let i = 1; i < end; i++) {
        const match = /^(name|description):\s*(.*)$/.exec(lines[i]);
        if (!match) continue;
        let value = match[2];
        if (/^[|>][-+]?$/.test(value)) {
          value = "";
          while (i + 1 < end && /^\s+/.test(lines[i + 1])) value += " " + lines[++i].trim();
        }
        meta[match[1]] = clean(value.replace(/^['"]|['"]$/g, ""));
      }
    }
  }
  const body = lines.slice(start);
  const heading = body.find((line) => /^#\s+/.test(line))?.replace(/^#\s+/, "");
  const paragraph = body.find((line) => line.trim() && !/^(#|```|\s*[-*])/u.test(line));
  const features = [...new Set(body.filter((line) => /^#{2,3}\s+/.test(line)).map((line) => clean(line.replace(/^#+\s+/, ""), 80)))].slice(0, 6);
  return { name: meta.name || clean(heading || fallback, 100), description: meta.description || clean(paragraph || "未提供用途说明，请查看原文。"), features };
}
async function noLinks(location: string) {
  if ((await fs.lstat(location)).isSymbolicLink()) throw new Error("符号链接目录不参与扫描或复制");
}
function insideAny(real: string, boundaries: string[]) {
  return boundaries.some((boundary) => {
    const relative = path.relative(boundary, real);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}
async function readDocument(file: string) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_DOCUMENT) throw new Error("说明文件超过 256 KB 或不是普通文件");
    const buffer = Buffer.alloc(MAX_DOCUMENT + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_DOCUMENT) throw new Error("说明文件超过 256 KB");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
}
export class SkillScanner {
  private plans = new Map<string, { ids: string[]; target: string; expires: number; hashes: Map<string, string>; rows: Map<string, SkillCopyPreview["items"][number]>; existingFingerprints: Map<string, string> }>();
  private deletePlans = new Map<string, { ids: string[]; expires: number; fingerprints: Map<string, string>; rows: Map<string, SkillDeletePreview["items"][number]> }>();
  private extraRoots: string[] = [];
  private installedDirs = new Set<string>();
  private snapshot = new Map<string, SkillItem>();
  private pending?: Promise<SkillScan>;
  private copying = false;
  private deleting = false;
  constructor(private home: string, extraRoots: string[] = [], private probe: SkillProbe = discoverOpenCode) {
    this.home = path.resolve(home);
    for (const root of extraRoots) this.addRoot(root);
  }
  addRoot(location: string) {
    if (!path.isAbsolute(location) || location.includes("\0")) throw new Error("请选择绝对目录路径");
    if (!this.extraRoots.includes(path.normalize(location))) this.extraRoots.push(path.normalize(location));
  }
  private toolPaths(tool: SkillTargetDefinition) {
    return tool.candidates.map((candidate) => path.join(this.home, candidate));
  }
  private targets() {
    return TOOL_REGISTRY.map((tool) => {
      const paths = this.toolPaths(tool);
      const existing = paths.filter((location) => this.installedDirs.has(location));
      return {
        id: tool.id, label: tool.label, path: path.join(this.home, tool.target), installed: existing.length > 0,
        directoryExists: this.installedDirs.has(path.join(this.home, tool.target)),
        copySupported: !tool.blockedReason, blockedReason: tool.blockedReason,
        activationHint: tool.activationHint, directorySource: tool.directorySource,
        directoryCheckedAt: SKILL_TARGETS_CHECKED_AT,
      };
    });
  }
  scan(): Promise<SkillScan> {
    if (this.copying || this.deleting) return Promise.reject(new Error("Skill 文件操作进行中，请稍后扫描"));
    return this.pending ||= this.performScan().finally(() => { this.pending = undefined; });
  }
  private async performScan(): Promise<SkillScan> {
    this.plans.clear();
    this.deletePlans.clear();
    const discovered = new Set<string>();
    // 边界比较必须在真实路径空间进行：主目录本身可能经符号链接到达（如 macOS /var -> /private/var）
    const homeBoundary = await fs.realpath(this.home).catch(() => this.home);
    for (const tool of TOOL_REGISTRY) {
      for (const location of this.toolPaths(tool)) {
        try { if ((await fs.stat(location)).isDirectory()) discovered.add(location); } catch { /* 工具未安装，跳过 */ }
      }
    }
    this.installedDirs = discovered;
    const targets = this.targets();
    const defaults: { path: string; source: string }[] = [];
    for (const tool of TOOL_REGISTRY) {
      for (const location of this.toolPaths(tool)) if (discovered.has(location)) defaults.push({ path: location, source: tool.label });
    }
    const roots = [...new Map([...defaults, ...this.extraRoots.map((p) => ({ path: p, source: "自定义目录" }))].map((r) => [r.path, r])).values()];
    const result: SkillScan = { items: [], roots: [], targets, trash: [] };
    const seen = new Set<string>();
    const listed = new Set<string>();
    for (const root of roots) {
      let count = 0;
      const messages = new Set<string>();
      const record: SkillScan["roots"][number] = { ...root, status: "scanned" };
      result.roots.push(record);
      try {
        const base = await fs.realpath(root.path);
        if (!(await fs.stat(base)).isDirectory()) throw new Error("请选择目录");
        if ((await fs.lstat(root.path)).isSymbolicLink() && !insideAny(base, [homeBoundary])) throw new Error("符号链接根目录指向主目录之外");
        // 跟随链接的前提：目标仍在用户主目录或该根目录内部
        const boundaries = [homeBoundary, base];
        const scanBase = root.source === "自定义目录" ? base : root.path;
        const addCandidate = (location: string, kind: NonNullable<SkillItem["kind"]>, description: string, linkTarget?: string) => {
          if (listed.has(location)) return;
          result.items.push({
            id: createHash("sha256").update(location).digest("hex"), name: path.basename(location),
            description, features: [], source: root.source, scope: root.source === "自定义目录" ? "自定义" : "用户级",
            path: location, warnings: [description], kind, linkTarget,
          });
          listed.add(location);
        };
        const emit = async (directory: string, document: string) => {
          if (seen.has(directory)) return;
          try {
            const text = await readDocument(document);
            result.items.push({ id: createHash("sha256").update(directory).digest("hex"), ...parse(text, path.basename(directory)), source: root.source, scope: root.source === "自定义目录" ? "自定义" : "用户级", path: directory, warnings: ["摘要来自说明文件；运行能力与目标工具兼容性未验证", "依赖、脚本与配置不会自动执行或安装"] });
            seen.add(directory);
            listed.add(directory);
          } catch (error) {
            const reason = `Skill ${directory} 的 SKILL.md 读取失败：${(error as Error).message}`;
            messages.add(reason);
            if (path.dirname(directory) === scanBase) addCandidate(directory, "unreadable-skill", reason);
          }
        };
        const visited = new Set<string>([base, scanBase]);
        const walk = async (directory: string, depth: number): Promise<void> => {
          if (count >= MAX_ENTRIES) { messages.add("达到 4000 项扫描上限，部分目录未扫描"); return; }
          const entries = await fs.readdir(directory, { withFileTypes: true });
          for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (++count > MAX_ENTRIES) { messages.add("达到 4000 项扫描上限，部分目录未扫描"); break; }
            const location = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) {
              // 只跟随仍位于用户主目录内的链接（WisCode 等工具用链接分发插件 Skill）
              try {
                const target = await resolveSkillLink(location, location);
                if (!insideAny(target, boundaries)) {
                  messages.add(`已跳过指向主目录外的符号链接 ${location} → ${target}`);
                  continue;
                }
                const stat = await fs.stat(target);
                if (stat.isDirectory()) {
                  if (depth === 0 && entry.name !== "SKILL.md") {
                    try {
                      if ((await fs.stat(path.join(target, "SKILL.md"))).isFile())
                        addCandidate(location, "linked-skill", `此处是指向 ${target} 的 Skill 链接；删除此行只会移走链接`, target);
                    } catch { /* The target may contain nested skills instead. */ }
                  }
                  if (visited.has(target)) {
                    messages.add(`发现目录符号链接循环引用 ${location} → ${target}，已跳过`);
                    continue;
                  }
                  if (depth >= MAX_DEPTH) { messages.add("达到 6 层目录深度上限，部分目录未扫描"); continue; }
                  visited.add(target);
                  await walk(target, depth + 1);
                } else if (stat.isFile() && entry.name === "SKILL.md") await emit(directory, target);
              } catch (error) {
                messages.add((error as Error).message);
                if (depth === 0 && entry.name !== "SKILL.md" && /已失效|循环引用/.test((error as Error).message))
                  addCandidate(location, "broken-link", (error as Error).message);
              }
              continue;
            }
            if (entry.isFile() && entry.name === "SKILL.md") await emit(directory, location);
            else if (entry.isDirectory() && !["node_modules", ".git", ".codegraph"].includes(entry.name)) {
              if (depth === 0 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)) {
                try {
                  if ((await fs.readdir(location)).length === 0) {
                    addCandidate(location, "empty-directory", "此目录为空，未找到 SKILL.md；安装来源和是否仍被使用未知");
                    continue;
                  }
                } catch { /* The normal walker reports unreadable directories. */ }
              }
              if (depth < MAX_DEPTH) {
                if (visited.has(location)) continue;
                visited.add(location);
                visited.add(await fs.realpath(location));
                try { await walk(location, depth + 1); } catch (error) { messages.add(`子目录 ${location} 无法读取：${(error as Error).message}`); }
              } else messages.add("达到 6 层目录深度上限，部分目录未扫描");
            }
          }
        };
        await walk(scanBase, 0);
        record.message = [...messages].join("；") || undefined;
      } catch (error) {
        record.status = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "error";
        record.message = record.status === "missing" ? "目录不存在" : (error as Error).message;
      }
    }
    await adviseSkills(this.home, result.items);
    await attachSkillUsage(this.home, result.items);
    try { result.trash = await listTrashedSkills(this.home); }
    catch (error) { result.trashError = (error as Error).message; }
    this.snapshot = new Map(result.items.map((item) => [item.id, item]));
    return result;
  }
  private async safeTarget(location: string) {
    // Reject linked ancestors too: a safe leaf beneath a linked parent is not safe.
    let current = this.home;
    for (const part of path.relative(this.home, location).split(path.sep)) {
      current = path.join(current, part);
      try { await noLinks(current); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
  private async inspect(directory: string) {
    return (await analyzeSkillTree(directory)).hash;
  }
  private async review(directory: string, target: string): Promise<SkillVerification> {
    let document: string;
    try { document = await fs.realpath(path.join(directory, "SKILL.md")); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") throw new Error(`Skill 入口文件 SKILL.md 失效：${path.join(directory, "SKILL.md")}（目标不存在）`);
      if (code === "ELOOP") throw new Error(`Skill 入口文件 SKILL.md 存在循环符号链接：${path.join(directory, "SKILL.md")}`);
      if (code === "EACCES" || code === "EPERM") throw new Error(`Skill 入口文件 SKILL.md 无读取权限：${path.join(directory, "SKILL.md")}`);
      throw error;
    }
    const text = await readDocument(document);
    const result = convertSkill(text, path.basename(directory), target, false);
    const definition = TOOL_REGISTRY.find(tool => tool.id === target)!;
    let sidecarText = "";
    try {
      const sidecar = await fs.realpath(path.join(directory, "agents/openai.yaml"));
      sidecarText = await readDocument(sidecar);
      result.warnings.push(...convertOpenaiMetadata(sidecarText, target).warnings);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const mcpReferences = [...new Set([...text.matchAll(/\bmcp__[A-Za-z0-9_-]+\b/gi)].map(match => match[0]))].slice(0, 20);
    const authVariables = [...new Set([...text.matchAll(/\b[A-Z][A-Z0-9_]*(?:_API_KEY|_TOKEN|_SECRET|_PASSWORD)\b/g)].map(match => match[0]))].slice(0, 20);
    const runtimeDetails = [
      "不会安装或运行依赖；目标工具连接状态、登录状态和 Agent 权限不会读取",
      ...(mcpReferences.length ? [`文档提到的 MCP 标识：${mcpReferences.join("、")}`] : []),
      ...( /\btype:\s*mcp\b/i.test(sidecarText) ? ["agents/openai.yaml 声明了 MCP 依赖；目标配置和授权未验证"] : []),
      ...(authVariables.length ? [`文档引用的认证环境变量名：${authVariables.join("、")}；只检查名称，不读取变量值`] : []),
    ];
    return {
      checkedAt: new Date().toISOString(), rulesDate: SKILL_RULES_DATE, ruleSource: SKILL_RULES[target],
      checks: [
        { label: "复制目录", state: "passed", detail: `已核实默认用户级目录 ~/${definition.target}；依据：${definition.directorySource.label}（${SKILL_TARGETS_CHECKED_AT}）。实际发现状态另行检查` },
        { label: "基础格式", state: "passed", detail: "名称、说明和 YAML 结构通过检查；所有文件原样保留" },
        { label: "目标规则", state: !SKILL_RULES[target] ? "unverified" : result.warnings.length ? "warning" : "passed", detail: SKILL_RULES[target] ? "已按内置文档规则比对；本机版本及运行结果另行验证" : "尚无该工具的专属规则，仅完成通用规范检查" },
        ...result.warnings.map(detail => detail === "仅完成通用规范检查，该目标的专属加载规则尚未核实"
          ? { label: "目标兼容性", state: "unverified" as const, detail }
          : { label: "兼容性差异", state: "warning" as const, detail }),
        ...await checkSkillResources(directory, text),
        { label: "依赖与权限", state: "unverified", detail: runtimeDetails.join("；") },
        { label: "实际运行", state: "unverified", detail: "未执行 Skill 业务任务；规则或发现检查通过不代表所有任务可运行" },
      ],
    };
  }
  async preview(ids: string[], target: string): Promise<SkillCopyPreview> {
    if (this.copying || this.deleting || this.pending) throw new Error("扫描或文件操作进行中，请稍后检查");
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_COPY_FILES || new Set(ids).size !== ids.length) throw new Error("请选择不重复的 Skill（最多 500 项）");
    const destination = this.targets().find(item => item.id === target);
    if (!destination) throw new Error("不支持的目标工具");
    const preview: SkillCopyPreview = { token: randomUUID(), target, path: destination.path, items: [] };
    const hashes = new Map<string, string>();
    const existingFingerprints = new Map<string, string>();
    const sourceByDestinationName = new Map<string, { hash: string; name: string }>();
    const supported = destination.copySupported;
    for (const id of ids) {
      const item = this.snapshot.get(id);
      const row: SkillCopyPreview["items"][number] = { id, name: item?.name ?? id, status: "blocked", changes: [], warnings: [] };
      preview.items.push(row);
      try {
        if (!item) throw new Error("仅允许复制最近扫描结果");
        if (item.kind && item.kind !== "skill") throw new Error(`此项为${item.kind === "broken-link" ? "失效链接" : item.kind === "linked-skill" ? "链接" : "不完整目录"}，请先修复或直接管理原位置，不能作为完整 Skill 复制`);
        if (!supported) throw new Error(destination.blockedReason ?? "目标目录加载规则未核实，暂不开放直接复制");
        await this.safeTarget(destination.path);
        const final = path.join(destination.path, path.basename(item.path));
        const source = await analyzeSkillTree(item.path);
        const destinationName = path.basename(item.path);
        const duplicate = sourceByDestinationName.get(destinationName);
        if (duplicate) {
          if (duplicate.hash !== source.hash) throw new Error(`本次选择中有多个目录名为 ${destinationName} 的 Skill，内容不同，无法写入同一目标目录；请分开复制并先整理其中一个名称`);
          row.status = "skipped";
          row.reason = `与本次已选 Skill「${duplicate.name}」内容一致，目标只需复制一份`;
          row.verification = { checkedAt: new Date().toISOString(), rulesDate: SKILL_RULES_DATE, sourceHash: source.hash, checks: [{ label: "批次同名检查", state: "passed", detail: row.reason }] };
          continue;
        }
        sourceByDestinationName.set(destinationName, { hash: source.hash, name: item.name });
        row.changes.push(...source.changes);
        row.warnings.push(...source.warnings);
        row.verification = await this.review(item.path, target);
        row.verification.checks.push(...source.warnings.map(detail => ({ label: "外部依赖", state: "warning" as const, detail })));
        row.warnings = [...new Set([...row.warnings, ...row.verification.checks.filter(check => check.state === "warning").map(check => check.detail)])];
        if (row.verification.checks.some(check => check.state === "failed")) {
          row.reason = row.verification.checks.filter(check => check.state === "failed").map(check => check.detail).join("；");
          continue;
        }
        try {
          const targetStat = await fs.lstat(final);
          if (targetStat.isSymbolicLink()) throw new Error(`目标同名路径是符号链接，拒绝替换以避免写入目录外：${final}`);
          if (!targetStat.isDirectory()) throw new Error(`目标同名路径不是目录，无法安全更新：${final}`);
          const fingerprint = await fingerprintSkillTree(final);
          existingFingerprints.set(id, fingerprint);
          let destinationHash: string | undefined;
          let destinationProblem: string | undefined;
          try { destinationHash = await this.inspect(final); }
          catch (error) { destinationProblem = (error as Error).message; }
          hashes.set(id, source.hash);
          if (destinationHash === source.hash) {
            row.status = "skipped";
            row.reason = "目标已存在且与源内容一致，未重复复制";
            row.verification.sourceHash = source.hash;
            row.verification.destinationHash = destinationHash;
            row.verification.checks.unshift({ label: "已有文件完整性", state: "passed", detail: row.reason });
          } else {
            row.status = "update";
            row.reason = destinationProblem
              ? `旧目标无法完整比对：${destinationProblem}。确认后会先将整个旧目录备份，再更新。`
              : "目标内容与源不同。确认后会先将整个旧目录备份，再更新，不会丢弃旧内容。";
            row.verification.sourceHash = source.hash;
            if (destinationHash) row.verification.destinationHash = destinationHash;
            row.verification.checks.unshift({ label: "已有文件处理", state: "warning", detail: row.reason });
          }
          continue;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        hashes.set(id, source.hash);
        row.warnings = row.verification.checks.filter(check => check.state === "warning").map(check => check.detail);
        if (row.verification.checks.some(check => check.state === "failed")) {
          row.reason = row.verification.checks.filter(check => check.state === "failed").map(check => check.detail).join("；");
          continue;
        }
        row.status = "ready";
      } catch (error) { row.reason = (error as Error).message; }
    }
    this.plans.clear();
    this.plans.set(preview.token, { ids: [...ids], target, expires: Date.now() + 10 * 60_000, hashes, rows: new Map(preview.items.map(row => [row.id, row])), existingFingerprints });
    return preview;
  }
  async copy(ids: string[], target: string, token?: string, _autoConvert = false): Promise<SkillCopyResult[]> {
    if (this.copying || this.deleting || this.pending) throw new Error("扫描或文件操作进行中，请稍后安装");
    const destination = this.targets().find((item) => item.id === target);
    if (!destination) throw new Error("不支持的目标工具");
    if (!Array.isArray(ids) || ids.length > MAX_COPY_FILES) throw new Error("复制项目数量超过上限");
    const plan = token ? this.plans.get(token) : undefined;
    if (!plan || plan.expires < Date.now() || plan.target !== target || JSON.stringify(plan.ids) !== JSON.stringify(ids)) throw new Error("兼容检查已失效，请重新检查并确认");
    this.plans.delete(token!);
    this.copying = true;
    try {
      await this.safeTarget(destination.path);
      if (plan.hashes.size) await fs.mkdir(destination.path, { recursive: true });
      const results: SkillCopyResult[] = [];
      for (const id of ids) {
        const item = this.snapshot.get(id);
        if (!item) { results.push({ name: id, status: "failed", message: "仅允许复制最近扫描结果" }); continue; }
        const destinationSkill = path.join(destination.path, path.basename(item.path));
        if (path.resolve(item.path) === path.resolve(destination.path) || path.resolve(destination.path).startsWith(path.resolve(item.path) + path.sep)) {
          results.push({ name: item.name, status: "skipped", message: "来源与目标相同或目标位于来源内" }); continue;
        }
        try {
          const previewRow = plan.rows.get(id);
          if (previewRow?.status === "skipped") {
            results.push({ name: item.name, status: "skipped", message: previewRow.reason ?? "目标内容已一致，未重复复制", verification: previewRow.verification });
            continue;
          }
          if (!plan.hashes.has(id)) { results.push({ name: item.name, status: "skipped", message: previewRow?.reason ?? "检查未通过或目标已存在，未安装", verification: previewRow?.verification }); continue; }
          const sourceAnalysis = await analyzeSkillTree(item.path);
          const sourceHash = plan.hashes.get(id)!;
          if (sourceAnalysis.hash !== sourceHash) throw new Error("源文件、链接目标或权限已变化，请重新检查并确认");
          const temporary = await fs.mkdtemp(path.join(destination.path, ".skill-copy-"));
          const staged = path.join(temporary, path.basename(item.path));
          let backupPath: string | undefined;
          try {
            await copySkillTree(sourceAnalysis, staged);
            const stagedAnalysis = await analyzeSkillTree(staged);
            if (stagedAnalysis.hash !== sourceHash) throw new Error("暂存副本与检查时的源内容不一致，未安装；请重新检查");
            const verification = await this.review(staged, target);
            if (verification.checks.some(check => check.state === "failed")) throw new Error("复制后的资源检查失败");
            verification.checks.push(...sourceAnalysis.changes.map(detail => ({ label: "符号链接处理", state: "passed" as const, detail })));
            verification.checks.push(...sourceAnalysis.warnings.map(detail => ({ label: "外部依赖", state: "warning" as const, detail })));
            let destinationHash = "";
            await this.safeTarget(destination.path);
            const updating = previewRow?.status === "update";
            if (updating) {
              const expectedFingerprint = plan.existingFingerprints.get(id);
              if (!expectedFingerprint) throw new Error("旧目标没有有效备份快照，请重新检查");
              const current = await fs.lstat(destinationSkill).catch(() => undefined);
              if (!current) throw new Error("旧目标在确认后已消失，请重新检查");
              if (current.isSymbolicLink() || !current.isDirectory()) throw new Error("旧目标在确认后已变成链接或非目录，已停止更新");
              if (await fingerprintSkillTree(destinationSkill) !== expectedFingerprint) throw new Error("旧目标在确认后又发生变化，为保护新内容已停止更新；请重新检查");
              const backupRoot = path.join(path.dirname(destination.path), ".skill-backups", path.basename(destination.path));
              await this.safeTarget(backupRoot);
              await fs.mkdir(backupRoot, { recursive: true });
              backupPath = path.join(backupRoot, `${path.basename(item.path)}-${Date.now()}-${randomUUID().slice(0, 8)}`);
              await fs.rename(destinationSkill, backupPath);
              if (await fingerprintSkillTree(backupPath) !== expectedFingerprint) {
                await fs.rename(backupPath, destinationSkill);
                backupPath = undefined;
                throw new Error("旧目标在备份时发生变化，已恢复原目录并停止更新");
              }
            } else {
              try {
                await fs.lstat(destinationSkill);
                throw new Error("目标目录在检查后已出现，未覆盖；请重新检查");
              } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
            }

            let createdDestination = false;
            const published: string[] = [];
            try {
              // Exclusive directory reservation prevents replacing an existing path.
              await fs.mkdir(destinationSkill);
              createdDestination = true;
              // Publish SKILL.md last so discovery cannot observe missing resources.
              const entries = (await fs.readdir(staged)).filter(entry => entry !== "SKILL.md");
              for (const entry of [...entries, "SKILL.md"]) {
                const output = path.join(destinationSkill, entry);
                await fs.rename(path.join(staged, entry), output);
                published.push(output);
              }
              destinationHash = await this.inspect(destinationSkill);
              if (destinationHash !== sourceHash) throw new Error("目标文件与源文件不一致，已撤销本次复制");
            } catch (error) {
              // Only remove our entries; never recursively delete the destination.
              for (const output of published) await fs.rm(output, { recursive: true, force: true });
              if (createdDestination) await fs.rmdir(destinationSkill).catch(() => undefined);
              if (backupPath) {
                try { await fs.rename(backupPath, destinationSkill); backupPath = undefined; }
                catch (restoreError) { throw new Error(`${(error as Error).message}；旧目录仍保存在备份位置 ${backupPath}，自动恢复失败：${(restoreError as Error).message}`); }
              }
              throw error;
            }
            await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
            verification.sourceHash = sourceHash;
            verification.destinationHash = destinationHash;
            verification.checks.unshift({ label: "完整性", state: "passed", detail: "源 Skill 可访问内容与目标副本哈希一致；文件内容和可执行权限已核对，内部链接已展开，外部链接按依赖保留" });
            results.push({ name: item.name, status: "copied", destination: destinationSkill, backup: backupPath, message: backupPath ? `旧版已备份到 ${backupPath}，新副本已安装并通过完整性校验` : "已复制并通过完整性校验；具体兼容性和依赖状态见下方", verification });
          }
          catch (error) {
            await fs.rm(temporary, { recursive: true, force: true });
            let message = (error as Error).message;
            if (backupPath) {
              try {
                await fs.lstat(destinationSkill);
              } catch (destinationError) {
                if ((destinationError as NodeJS.ErrnoException).code === "ENOENT") {
                  try { await fs.rename(backupPath, destinationSkill); backupPath = undefined; }
                  catch (restoreError) { message += `；旧目录仍保存在备份位置 ${backupPath}，自动恢复失败：${(restoreError as Error).message}`; }
                }
              }
            }
            results.push({ name: item.name, status: "failed", backup: backupPath, message });
          }
        } catch (error) { results.push({ name: item.name, status: "failed", message: (error as Error).message }); }
      }
      const copied = results.filter(row => row.status === "copied" && row.verification);
      if (target === "opencode" && copied.length) {
        const discovery = await this.probe(this.home).catch(() => ({ check: { label: "OpenCode 实际发现", state: "unverified" as const, detail: "发现检查发生异常；已复制文件保留" } }));
        for (const row of copied) {
          row.verification!.checks.push(await matchDiscoveredSkill(discovery, row.name, path.join(destination.path, row.name, "SKILL.md")));
          row.verification!.checkedAt = new Date().toISOString();
        }
      } else {
        for (const row of copied) row.verification!.checks.push({ label: "目标实际发现", state: "unverified", detail: "该目标尚未接入发现接口，当前提供规则比对结果" });
      }
      return results.map(row => ({
        ...row,
        activationHint: row.status === "copied" ? destination.activationHint : undefined,
      }));
    } finally { this.copying = false; }
  }
  async previewDelete(ids: string[]): Promise<SkillDeletePreview> {
    if (this.copying || this.deleting || this.pending) throw new Error("扫描或文件操作进行中，请稍后检查");
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_COPY_FILES || new Set(ids).size !== ids.length)
      throw new Error("请选择不重复的 Skill（最多 500 项）");
    const preview: SkillDeletePreview = { token: randomUUID(), items: [] };
    const fingerprints = new Map<string, string>();
    for (const id of ids) {
      const item = this.snapshot.get(id);
      const cleanup = item?.cleanup ?? { level: "unknown" as const, title: "来源未知", reasons: ["请重新扫描"], impact: [], deletable: false };
      const row: SkillDeletePreview["items"][number] = {
        id, name: item?.name ?? id, path: item?.path ?? "", status: "blocked", cleanup,
        usage: item?.usage ?? { status: "unknown", evidence: "没有可确认的使用记录" },
      };
      preview.items.push(row);
      try {
        if (!item) throw new Error("仅允许处理最近扫描到的 Skill");
        if (!cleanup.deletable) throw new Error(cleanup.reasons.join("；"));
        const children = [...this.snapshot.values()].filter(other => other.id !== id && other.path.startsWith(item.path + path.sep));
        if (children.length) throw new Error(`该目录还包含 ${children.length} 个独立 Skill；请先整理子目录，避免一并移走`);
        const linked = [...this.snapshot.values()].filter(other => other.linkTarget === item.path);
        if (linked.length) row.cleanup = { ...cleanup, impact: [...cleanup.impact, `${linked.length} 个已扫描到的链接指向此目录，移走后这些链接会失效`] };
        fingerprints.set(id, (await deletionFingerprint(this.home, item.path)).fingerprint);
        row.status = "ready";
      } catch (error) { row.reason = (error as Error).message; }
    }
    this.deletePlans.clear();
    this.deletePlans.set(preview.token, {
      ids: [...ids], expires: Date.now() + 10 * 60_000, fingerprints,
      rows: new Map(preview.items.map(row => [row.id, row])),
    });
    return preview;
  }
  async deleteSkills(ids: string[], token: string): Promise<SkillDeleteResult[]> {
    if (this.copying || this.deleting || this.pending) throw new Error("扫描或文件操作进行中，请稍后处理");
    const plan = this.deletePlans.get(token);
    if (!plan || plan.expires < Date.now() || JSON.stringify(plan.ids) !== JSON.stringify(ids))
      throw new Error("删除预检已失效，请重新检查具体路径");
    this.deletePlans.clear();
    this.deleting = true;
    try {
      const results: SkillDeleteResult[] = [];
      for (const id of ids) {
        const item = this.snapshot.get(id);
        const row = plan.rows.get(id);
        if (!item || row?.status !== "ready" || !plan.fingerprints.has(id)) {
          results.push({ id, name: item?.name ?? id, status: "skipped", message: row?.reason ?? "预检未通过" });
          continue;
        }
        try {
          const moved = await moveSkillToTrash(this.home, item, plan.fingerprints.get(id)!);
          this.snapshot.delete(id);
          results.push({ id, name: item.name, status: "trashed", message: "已移入回收区，可恢复到原位置", trashId: moved.id, originalPath: moved.originalPath });
        } catch (error) { results.push({ id, name: item.name, status: "failed", message: (error as Error).message }); }
      }
      this.plans.clear();
      return results;
    } finally { this.deleting = false; }
  }
  async restoreSkill(id: string) {
    if (this.copying || this.deleting || this.pending) throw new Error("扫描或文件操作进行中，请稍后恢复");
    this.deleting = true;
    try {
      const restored = await restoreTrashedSkill(this.home, id);
      this.plans.clear();
      this.deletePlans.clear();
      return restored;
    } finally { this.deleting = false; }
  }
}
