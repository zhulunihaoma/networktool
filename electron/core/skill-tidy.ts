import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { SKILL_TARGETS } from "../../src/shared/skill-targets";
import type {
  SkillItem, SkillMoveRecord, SkillTidyAction, SkillTidyKind, SkillTidyScenario, SkillTidyVersion, SkillTidyResult,
} from "../../src/shared/skills";
import { ensureNetworkLensDir, managedSkillLocation, rejectLinkedAncestors, trashManagedPath } from "./skill-cleanup";

/**
 * 整理建议：只识别有本机证据支撑的场景。跨工具副本默认各自保留；
 * 移动类操作只进入可恢复回收区或记录可撤销的迁移，执行前重新核对内容。
 */

const DIGEST_LIMITS = { entries: 20_000, bytes: 1024 ** 3, depth: 32 } as const;
const NESTED_SEARCH = { depth: 4, entries: 3000 } as const;
const COPY_LIMITS = { files: 500, bytes: 20 * 1024 * 1024 } as const;
const MOVES_FILE = "skill-moves.json";
const CODEX_SKILLS_DOC = "https://developers.openai.com/codex/skills/";

export interface ContentDigest { digest: string; files: number; bytes: number; modifiedAt: number; identity: string }
export interface TidyPlanEntry { action: SkillTidyAction; digest?: string; identity?: string; keepDigest?: string }

const sortNames = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const actionId = (kind: SkillTidyKind, location: string) => createHash("sha256").update(`${kind}\0${location}`).digest("hex").slice(0, 24);

function hashFile(location: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(location).on("data", chunk => hash.update(chunk)).on("error", reject).on("end", () => resolve(hash.digest("hex")));
  });
}

/** 目录内容摘要：文件内容与相对路径，忽略权限位与时间；链接只记录链接文本，不跟随 */
export async function contentDigest(directory: string): Promise<ContentDigest> {
  const root = await fs.lstat(directory);
  if (root.isSymbolicLink() || !root.isDirectory()) throw new Error(`不是普通目录：${directory}`);
  const lines: string[] = [];
  let files = 0, bytes = 0, entries = 0, modifiedAt = 0;
  const walk = async (location: string, relative: string, depth: number): Promise<void> => {
    if (depth > DIGEST_LIMITS.depth) throw new Error(`目录层级超过 ${DIGEST_LIMITS.depth} 层：${relative}`);
    const children = (await fs.readdir(location, { withFileTypes: true })).sort((a, b) => sortNames(a.name, b.name));
    for (const child of children) {
      if (++entries > DIGEST_LIMITS.entries) throw new Error(`目录超过 ${DIGEST_LIMITS.entries} 项，未完成内容比对`);
      const full = path.join(location, child.name);
      const rel = relative ? `${relative}/${child.name}` : child.name;
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) { lines.push(`L ${rel} ${await fs.readlink(full)}`); continue; }
      if (stat.isDirectory()) { lines.push(`D ${rel}`); await walk(full, rel, depth + 1); continue; }
      if (!stat.isFile()) { lines.push(`S ${rel}`); continue; }
      files++;
      if ((bytes += stat.size) > DIGEST_LIMITS.bytes) throw new Error("目录超过 1 GB，未完成内容比对");
      modifiedAt = Math.max(modifiedAt, stat.mtimeMs);
      lines.push(`F ${rel} ${stat.size} ${await hashFile(full)}`);
    }
  };
  await walk(directory, "", 0);
  return { digest: createHash("sha256").update(lines.join("\n")).digest("hex"), files, bytes, modifiedAt, identity: `${root.dev}:${root.ino}` };
}

interface TopEntry { name: string; path: string; root: string }

async function isSkillDirectory(location: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(location);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    return (await fs.stat(path.join(location, "SKILL.md"))).isFile();
  } catch { return false; }
}

/** 根目录下的真实 Skill 目录（不含链接、隐藏项） */
async function topSkills(root: string): Promise<TopEntry[]> {
  let names: string[];
  try {
    const stat = await fs.lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return [];
    names = await fs.readdir(root);
  } catch { return []; }
  const result: TopEntry[] = [];
  for (const name of names.sort(sortNames)) {
    if (name.startsWith(".")) continue;
    const location = path.join(root, name);
    if (await isSkillDirectory(location)) result.push({ name, path: location, root });
  }
  return result;
}

/** 父包内（不含父包本身）的子 Skill，按目录名索引 */
async function nestedSkills(parent: string): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  let visited = 0;
  const walk = async (location: string, depth: number): Promise<void> => {
    if (depth > NESTED_SEARCH.depth || visited > NESTED_SEARCH.entries) return;
    let children;
    try { children = await fs.readdir(location, { withFileTypes: true }); } catch { return; }
    for (const child of children.sort((a, b) => sortNames(a.name, b.name))) {
      if (++visited > NESTED_SEARCH.entries) return;
      if (!child.isDirectory() || child.name.startsWith(".") || child.name === "node_modules") continue;
      const full = path.join(location, child.name);
      if (await isSkillDirectory(full)) found.set(child.name, [...(found.get(child.name) ?? []), full]);
      await walk(full, depth + 1);
    }
  };
  await walk(parent, 1);
  return found;
}

async function exists(location: string) {
  try { await fs.lstat(location); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function readOwnership(projection: string): Promise<{ links: Record<string, unknown>; error?: string }> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(projection, ".wiscode-skill-ownership.json"), "utf8"));
    return { links: parsed && typeof parsed.links === "object" && parsed.links ? parsed.links : {} };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { links: {} };
    return { links: {}, error: `WisCode 归属清单无法读取：${(error as Error).message}` };
  }
}

/** 只读最近几份 WisCode 主进程日志，查找投射冲突记录 */
async function projectionConflictEvidence(home: string): Promise<string | undefined> {
  const logs = path.join(home, ".wiscode", "logs");
  let names: string[];
  try { names = (await fs.readdir(logs)).filter(name => /^\d{8}\.log$/.test(name)).sort().slice(-5).reverse(); }
  catch { return; }
  for (const name of names) {
    try {
      const handle = await fs.open(path.join(logs, name), "r");
      try {
        const stat = await handle.stat();
        const size = Math.min(stat.size, 32 * 1024 * 1024);
        const buffer = Buffer.alloc(size);
        await handle.read(buffer, 0, size, stat.size - size);
        const lines = buffer.toString("utf8").split("\n").filter(line => line.includes("codex-skill-target-conflict"));
        const last = lines[lines.length - 1];
        if (last) return `WisCode 日志 ${name} 记录了 ${lines.length} 次 Skill 投射失败（codex-skill-target-conflict），最近一次 ${/^\[([^\]]+)\]/.exec(last)?.[1] ?? "时间未知"}`;
      } finally { await handle.close(); }
    } catch { /* 日志不可读不影响建议 */ }
  }
}

const display = (home: string, location: string) => location.startsWith(home + path.sep) ? `~/${path.relative(home, location)}` : location;

export interface TidyAnalysis { scenarios: SkillTidyScenario[]; plans: Map<string, TidyPlanEntry>; notes: string[] }

export async function analyzeTidy(home: string, items: SkillItem[]): Promise<TidyAnalysis> {
  const notes: string[] = [];
  const plans = new Map<string, TidyPlanEntry>();
  const digests = new Map<string, Promise<ContentDigest>>();
  const digest = (location: string) => {
    if (!digests.has(location)) digests.set(location, contentDigest(location));
    return digests.get(location)!;
  };
  const safeDigest = async (location: string) => { try { return await digest(location); } catch (error) { return error as Error; } };
  const version = async (location: string, source: string): Promise<SkillTidyVersion> => {
    const value = await safeDigest(location);
    return value instanceof Error
      ? { path: location, source }
      : { path: location, source, digest: value.digest.slice(0, 12), modifiedAt: new Date(value.modifiedAt).toISOString(), files: value.files, bytes: value.bytes };
  };
  const sourceLabel = (location: string) => managedSkillLocation(home, location)?.tool ?? "其他";
  const claimed = new Set<string>();
  const nestedIndex = new Map<string, Promise<Map<string, string[]>>>();
  const findNested = async (parent: string, name: string) => {
    if (!nestedIndex.has(parent)) nestedIndex.set(parent, nestedSkills(parent));
    return (await nestedIndex.get(parent)!).get(name) ?? [];
  };
  const register = async (action: SkillTidyAction, withKeep = false) => {
    if (action.status === "ready" && action.operation !== "none" && action.operation !== "sync") {
      const value = await digest(action.path);
      const keepDigest = withKeep && action.keep ? (await digest(action.keep)).digest : undefined;
      plans.set(action.id, { action, digest: value.digest, identity: value.identity, keepDigest });
    }
    claimed.add(action.path);
  };

  const wiscodeRoot = path.join(home, ".wiscode", "skills");
  const projection = path.join(home, ".wiscode", "codex-agents", "skills");
  const legacyCodex = path.join(home, ".codex", "skills");
  const agentsRoot = path.join(home, ".agents", "skills");
  const knownRoots = [...new Set(SKILL_TARGETS.flatMap(tool => tool.candidates.map(candidate => path.join(home, candidate))))];
  const tops = new Map<string, TopEntry[]>();
  for (const root of knownRoots) tops.set(root, await topSkills(root));

  // 1. WisCode 投射目录中的同名实体目录
  const shadow: SkillTidyScenario = {
    kind: "wiscode-shadow", title: "WisCode 投射目录中的同名旧副本",
    summary: "WisCode 会把 ~/.wiscode/skills 中的 Skill 以符号链接投射到 ~/.wiscode/codex-agents/skills。这里存在同名的真实目录时，投射会因冲突中止，后续安装的 Skill 也不会出现在 $ 列表。",
    impact: ["只移动 ~/.wiscode/codex-agents/skills 下的这一份；~/.wiscode/skills 中的版本保持不变", "移入可恢复回收区；WisCode 下次同步（通常是重启）会自动建立指向 ~/.wiscode/skills 的链接"],
    actions: [],
  };
  const ownership = await readOwnership(projection);
  if (ownership.error) notes.push(ownership.error);
  const conflictLog = await projectionConflictEvidence(home);
  if (conflictLog) shadow.summary += ` ${conflictLog}。`;
  for (const entry of tops.get(projection) ?? []) {
    const keep = path.join(wiscodeRoot, entry.name);
    if (!(await isSkillDirectory(keep)) || ownership.links[entry.name]) continue;
    const [mine, theirs] = [await safeDigest(entry.path), await safeDigest(keep)];
    const action: SkillTidyAction = {
      id: actionId("wiscode-shadow", entry.path), kind: "wiscode-shadow", name: entry.name, path: entry.path, keep,
      operation: "trash", status: "ready", evidence: [], warnings: [],
      versions: [await version(entry.path, "WisCode 投射目录（待移走）"), await version(keep, "WisCode Skill 目录（保留）")],
    };
    action.evidence.push(`WisCode 归属清单未登记 ${entry.name}，且 ${display(home, keep)} 存在同名 Skill`);
    if (mine instanceof Error || theirs instanceof Error) {
      action.status = "blocked";
      action.reason = `内容比对未完成：${(mine instanceof Error ? mine : theirs as Error).message}`;
    } else {
      action.contentMatches = mine.digest === theirs.digest;
      if (!action.contentMatches) {
        action.warnings.push("此副本与 ~/.wiscode/skills 中的版本内容不同；移走后 WisCode 将改用 ~/.wiscode/skills 的版本");
        if (mine.modifiedAt > theirs.modifiedAt) action.warnings.push("此副本的文件修改时间更晚；如有需要保留的改动，请先复制到 ~/.wiscode/skills");
      }
    }
    shadow.actions.push(action);
    await register(action, true);
  }

  // 2. 同一工具目录内：独立目录与另一包内嵌的同名子 Skill 内容一致
  const nested: SkillTidyScenario = {
    kind: "nested-duplicate", title: "与包内子 Skill 完全相同的独立副本",
    summary: "同一工具目录中，某个独立 Skill 与另一个 Skill 包内的同名子 Skill 内容完全一致（忽略文件权限）。保留包内那份即可。",
    impact: ["移走后不再有独立的同名入口，需要通过父包的说明路由使用", "移入可恢复回收区，可随时恢复"],
    actions: [],
  };
  for (const [root, entries] of tops) {
    for (const entry of entries) {
      if (claimed.has(entry.path)) continue;
      for (const parent of entries) {
        if (parent.path === entry.path) continue;
        const matches = await findNested(parent.path, entry.name);
        let hit: string | undefined;
        for (const candidate of matches) {
          const [a, b] = [await safeDigest(entry.path), await safeDigest(candidate)];
          if (!(a instanceof Error) && !(b instanceof Error) && a.digest === b.digest) { hit = candidate; break; }
        }
        if (!hit) continue;
        const action: SkillTidyAction = {
          id: actionId("nested-duplicate", entry.path), kind: "nested-duplicate", name: entry.name, path: entry.path, keep: hit,
          operation: "trash", status: "ready", contentMatches: true, evidence: [`与 ${display(home, hit)} 文件内容完全一致`], warnings: [],
          versions: [await version(entry.path, `${sourceLabel(entry.path)}（待移走）`), await version(hit, `${parent.name} 包内（保留）`)],
        };
        try {
          if ((await fs.readFile(path.join(parent.path, "SKILL.md"), "utf8")).includes(entry.name)) action.evidence.push(`父包 ${parent.name} 的 SKILL.md 引用了 ${entry.name}`);
          else action.warnings.push(`父包 ${parent.name} 的 SKILL.md 未直接提到 ${entry.name}，移走前请确认可通过父包使用`);
        } catch { action.warnings.push(`父包 ${parent.name} 的 SKILL.md 无法读取`); }
        const parentShadow = shadow.actions.find(row => row.path === parent.path);
        if (parentShadow?.keep) {
          const upstream = (await findNested(parentShadow.keep, entry.name))[0];
          action.warnings.push(`父包 ${parent.name} 本身也是待处理的旧副本；处理后由 ${display(home, parentShadow.keep)} 提供${upstream ? "同名子 Skill" : "路由，但其中未发现同名子 Skill"}`);
        }
        if (root === projection) action.evidence.push("该目录不在 WisCode 归属清单中，属于手动放入的副本");
        nested.actions.push(action);
        await register(action, true);
        break;
      }
    }
  }

  // 3. ~/.codex/skills 旧目录迁移到官方用户级目录 ~/.agents/skills
  const legacy: SkillTidyScenario = {
    kind: "legacy-codex", title: "Codex 旧用户目录中的 Skill",
    summary: `Codex 官方文档列出的用户级目录是 $HOME/.agents/skills（${CODEX_SKILLS_DOC}）。~/.codex/skills 是旧位置，其中 .system 由 Codex 自带，不处理。`,
    impact: ["迁移到 ~/.agents/skills：Codex、WisCode 等读取共享目录的工具都会看到它", "旧版 Codex 可能仍读取 ~/.codex/skills；迁移后请在 Codex 中输入 $ 确认可见", "共享目录已有完全相同的副本时，旧位置这份移入回收区；迁移可在本页撤销"],
    actions: [],
  };
  const allTops = [...tops.values()].flat();
  for (const entry of tops.get(legacyCodex) ?? []) {
    if (claimed.has(entry.path)) continue;
    const destination = path.join(agentsRoot, entry.name);
    const action: SkillTidyAction = {
      id: actionId("legacy-codex", entry.path), kind: "legacy-codex", name: entry.name, path: entry.path,
      operation: "move", destination, keep: destination, status: "ready", evidence: [], warnings: [],
    };
    const mine = await safeDigest(entry.path);
    const others = allTops.filter(other => other.name === entry.name && other.path !== entry.path);
    action.versions = [await version(entry.path, "Codex 旧目录"), ...await Promise.all(others.map(other => version(other.path, sourceLabel(other.path))))];
    if (others.length) action.warnings.push(`以下位置也有同名 Skill：${others.map(other => display(home, other.path)).join("、")}；迁移后读取多个目录的工具可能看到重名项`);
    if (mine instanceof Error) { action.status = "blocked"; action.reason = `内容比对未完成：${mine.message}`; }
    else {
      for (const other of others) {
        const value = await safeDigest(other.path);
        if (!(value instanceof Error) && value.digest !== mine.digest && value.modifiedAt > mine.modifiedAt) {
          action.warnings.push(`此副本比 ${display(home, other.path)} 中的同名版本旧，迁移后可再用最新版本更新`);
          break;
        }
      }
      try {
        const stat = await fs.lstat(destination);
        if (stat.isSymbolicLink() || !stat.isDirectory()) { action.status = "blocked"; action.reason = `${display(home, destination)} 已存在且不是普通目录，未处理`; }
        else {
          const theirs = await safeDigest(destination);
          if (!(theirs instanceof Error) && theirs.digest === mine.digest) {
            action.operation = "trash";
            action.contentMatches = true;
            action.destination = undefined;
            action.evidence.push(`${display(home, destination)} 已有完全相同的副本，旧位置这份可直接移入回收区`);
          } else {
            action.status = "blocked";
            action.contentMatches = false;
            action.reason = `${display(home, destination)} 已有内容不同的同名 Skill，请先比较并决定保留哪个版本`;
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") { action.status = "blocked"; action.reason = (error as Error).message; }
        else action.evidence.push(`${display(home, destination)} 不存在同名项，可直接迁移`);
      }
    }
    legacy.actions.push(action);
    await register(action, action.operation === "trash");
  }

  // 4. 同名 Skill 在多个工具中的版本不一致：用最近修改的版本经复制流程更新
  const drift: SkillTidyScenario = {
    kind: "version-drift", title: "多个工具中的同名 Skill 版本不一致",
    summary: "同名 Skill 在各工具目录中内容不同（已忽略文件权限）。各工具需要各自保留一份，建议统一成同一个版本，而不是只留一份。",
    impact: ["“更新”会打开现有复制流程：先做兼容与风险检查，确认后旧目录先备份再替换", "“最近修改”依据文件修改时间推断，可能反映安装时间而非版本先后；更新前可在分组详情中比较差异"],
    actions: [],
  };
  const copyTargets = new Map<string, string>();
  for (const tool of SKILL_TARGETS) {
    const location = path.join(home, tool.target);
    if (!tool.blockedReason && !copyTargets.has(location)) copyTargets.set(location, tool.id);
  }
  const byName = new Map<string, TopEntry[]>();
  for (const entry of allTops) byName.set(entry.name, [...(byName.get(entry.name) ?? []), entry]);
  for (const [name, entries] of [...byName].sort(([a], [b]) => sortNames(a, b))) {
    if (entries.length < 2) continue;
    const rows = (await Promise.all(entries.map(async entry => ({ entry, value: await safeDigest(entry.path) }))))
      .filter((row): row is { entry: TopEntry; value: ContentDigest } => !(row.value instanceof Error));
    if (new Set(rows.map(row => row.value.digest)).size < 2) continue;
    const newest = rows.reduce((top, row) => row.value.modifiedAt > top.value.modifiedAt ? row : top);
    const sourceItem = items.find(item => item.path === newest.entry.path && (!item.kind || item.kind === "skill"));
    const versions = rows.map(row => ({
      path: row.entry.path, source: sourceLabel(row.entry.path), digest: row.value.digest.slice(0, 12),
      modifiedAt: new Date(row.value.modifiedAt).toISOString(), files: row.value.files, bytes: row.value.bytes, newest: row === newest,
    }));
    for (const row of rows) {
      const targetId = copyTargets.get(row.entry.root);
      if (row === newest || row.value.digest === newest.value.digest || !targetId || claimed.has(row.entry.path)) continue;
      const action: SkillTidyAction = {
        id: actionId("version-drift", row.entry.path), kind: "version-drift", name, path: row.entry.path, keep: newest.entry.path,
        operation: "sync", status: "ready", contentMatches: false, sourceItemId: sourceItem?.id, targetId, versions,
        evidence: [`最近修改的版本位于 ${display(home, newest.entry.path)}（${new Date(newest.value.modifiedAt).toLocaleDateString("zh-CN")}）`], warnings: [],
      };
      if (claimed.has(newest.entry.path)) action.warnings.push("最近修改的版本位于待整理的位置；请先确认是否以它为准");
      if (!sourceItem) { action.status = "blocked"; action.reason = "最近修改的版本未出现在本次扫描结果中，请重新扫描"; }
      else if (newest.value.files > COPY_LIMITS.files || newest.value.bytes > COPY_LIMITS.bytes) {
        action.status = "blocked";
        action.reason = "最近修改的版本超过复制流程 500 个文件 / 20 MB 上限，需要用该 Skill 自带的安装方式更新";
      }
      drift.actions.push(action);
    }
  }

  // 5. 由安装器管理的副本：只说明，不提供删除
  const managed: SkillTidyScenario = {
    kind: "managed", title: "由安装器统一管理的副本",
    summary: "这些 Skill 由安装器分发到多个工具，并在目录中留有管理清单。手动删除会让清单与实际文件不一致，请使用安装器自己的升级或卸载命令。",
    impact: ["不提供清理按钮"],
    actions: [],
  };
  const owners = new Map<string, { roots: string[]; skills: Set<string> }>();
  for (const root of knownRoots) {
    let names: string[];
    try { names = await fs.readdir(root); } catch { continue; }
    for (const file of names) {
      const match = /^\.(.+)-managed-skills\.json$/.exec(file);
      if (!match) continue;
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(root, file), "utf8"));
        const owner = typeof parsed?.owner === "string" ? parsed.owner : match[1];
        const row = owners.get(owner) ?? { roots: [], skills: new Set<string>() };
        row.roots.push(root);
        for (const skill of Object.keys(parsed?.skills ?? {})) row.skills.add(skill);
        owners.set(owner, row);
      } catch { notes.push(`管理清单 ${display(home, path.join(root, file))} 无法读取`); }
    }
  }
  for (const [owner, row] of owners) {
    managed.actions.push({
      id: actionId("managed", owner), kind: "managed", name: owner, path: row.roots[0], operation: "none", status: "blocked",
      reason: `请使用 ${owner} 的升级 / 卸载命令处理`,
      evidence: [`${row.skills.size} 个 Skill，分布在 ${row.roots.length} 个工具目录：${row.roots.map(root => display(home, root)).join("、")}`], warnings: [],
    });
  }

  return { scenarios: [shadow, nested, legacy, drift, managed].filter(row => row.actions.length), plans, notes };
}

// ---- 迁移记录 ----

async function movesFile(home: string) { return path.join(await ensureNetworkLensDir(home), MOVES_FILE); }

export async function listSkillMoves(home: string): Promise<SkillMoveRecord[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(home, ".network-lens", MOVES_FILE), "utf8"));
    if (!Array.isArray(parsed?.moves)) return [];
    return parsed.moves.filter((row: Partial<SkillMoveRecord>) =>
      typeof row?.id === "string" && typeof row.name === "string" && typeof row.from === "string" && typeof row.to === "string" && typeof row.movedAt === "string"
      && !!managedSkillLocation(home, row.from) && !!managedSkillLocation(home, row.to));
  } catch { return []; }
}

async function writeMoves(home: string, moves: SkillMoveRecord[]) {
  const file = await movesFile(home);
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({ schema: 1, moves }, null, 2), { mode: 0o600, flag: "wx" });
  await fs.rename(temporary, file);
}

/** 目标父目录：已存在的祖先不得是链接，缺失部分逐级创建 */
async function prepareParent(home: string, directory: string) {
  const relative = path.relative(home, directory);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("目标不在当前用户主目录中");
  let current = home;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`目标上级路径不是普通目录：${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fs.mkdir(current);
    }
  }
}

export async function applyTidyPlan(home: string, entry: TidyPlanEntry): Promise<SkillTidyResult> {
  const { action } = entry;
  const base = { id: action.id, name: action.name, kind: action.kind, path: action.path, destination: action.destination };
  try {
    if (action.status !== "ready" || !entry.digest) return { ...base, status: "skipped", message: action.reason ?? "预检未通过，未处理" };
    let current: ContentDigest;
    try { current = await contentDigest(action.path); }
    catch (error) { throw new Error(`待处理目录已不可用：${(error as Error).message}`); }
    if (current.digest !== entry.digest || current.identity !== entry.identity) throw new Error("目录内容或位置在预检后发生变化，未处理；请重新生成建议");
    if (entry.keepDigest && action.keep) {
      const keep = await contentDigest(action.keep).catch(() => undefined);
      if (!keep) throw new Error(`保留位置 ${action.keep} 已不可用，未处理`);
      if (keep.digest !== entry.keepDigest) throw new Error("保留版本在预检后发生变化，未处理；请重新生成建议");
    }
    const managed = managedSkillLocation(home, action.path);
    if (action.operation === "trash") {
      const moved = await trashManagedPath(home, action.path, { name: action.name, source: managed?.tool ?? "其他", protectedRoot: managed?.protected });
      return { ...base, status: "done", trashId: moved.id, message: action.kind === "wiscode-shadow" ? "已移入回收区；重启 WisCode 后会重新建立指向 ~/.wiscode/skills 的链接" : "已移入回收区，可恢复到原位置" };
    }
    if (action.operation === "move" && action.destination) {
      if (!managedSkillLocation(home, action.destination)) throw new Error("迁移目标不是已核实的 Skill 目录");
      await rejectLinkedAncestors(home, action.path);
      await prepareParent(home, path.dirname(action.destination));
      if (await exists(action.destination)) throw new Error("迁移目标在预检后已出现同名项，未覆盖");
      try { await fs.rename(action.path, action.destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EXDEV") throw new Error("来源与目标不在同一文件系统，无法安全移动；原 Skill 保持原位");
        throw error;
      }
      const record: SkillMoveRecord = { id: randomUUID(), name: action.name, from: action.path, to: action.destination, movedAt: new Date().toISOString() };
      try { await writeMoves(home, [record, ...await listSkillMoves(home)]); }
      catch (error) {
        await fs.rename(action.destination, action.path).catch(() => undefined);
        throw new Error(`迁移记录无法保存，已移回原位置：${(error as Error).message}`);
      }
      return { ...base, status: "done", moveId: record.id, message: "已迁移，可在本页撤销" };
    }
    return { ...base, status: "skipped", message: "此建议需通过复制流程处理" };
  } catch (error) {
    return { ...base, status: "failed", message: (error as Error).message };
  }
}

export async function revertSkillMove(home: string, id: string): Promise<SkillMoveRecord> {
  const moves = await listSkillMoves(home);
  const record = moves.find(row => row.id === id);
  if (!record) throw new Error("迁移记录不存在或已撤销");
  if (await exists(record.from)) throw new Error(`原位置已有同名项，未覆盖：${record.from}`);
  const stat = await fs.lstat(record.to).catch(() => undefined);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`迁移后的目录已不存在或不是普通目录：${record.to}`);
  await rejectLinkedAncestors(home, record.to);
  await prepareParent(home, path.dirname(record.from));
  await fs.rename(record.to, record.from);
  await writeMoves(home, moves.filter(row => row.id !== id));
  return record;
}
