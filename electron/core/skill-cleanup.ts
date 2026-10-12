import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SKILL_TARGETS } from "../../src/shared/skill-targets";
import type { SkillCleanupAdvice, SkillItem, SkillTrashEntry } from "../../src/shared/skills";
import { analyzeSkillTree, fingerprintSkillTree } from "./skill-copy-tree";

const MAX_ADVICE_CHECKS = 150;
const TRASH_FOLDER = path.join(".network-lens", "skill-trash");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function directChild(root: string, location: string): boolean {
  const relative = path.relative(root, location);
  return !!relative && relative !== "." && !relative.startsWith("..") && !path.isAbsolute(relative) && !relative.includes(path.sep);
}

export function managedSkillLocation(home: string, location: string) {
  const resolved = path.resolve(location);
  for (const tool of SKILL_TARGETS) {
    for (const candidate of tool.candidates) {
      const root = path.join(home, candidate);
      if (!directChild(root, resolved)) continue;
      return { root, tool: tool.label, candidate, protected: candidate === ".wiscode/codex-agents/skills" };
    }
  }
  return undefined;
}

function sharedImpact(home: string, location: string): string[] {
  const evidence = ["只移动本行所示的本机路径；回收区可以恢复原目录或链接"];
  if (directChild(path.join(home, ".agents", "skills"), location)) {
    evidence.push("这是共享 Skills 目录，Codex 与其他读取该目录的工具可能同时受影响");
  }
  return evidence;
}

export function basicCleanupAdvice(home: string, item: SkillItem): SkillCleanupAdvice {
  const managed = managedSkillLocation(home, item.path);
  const impact = sharedImpact(home, item.path);
  if (!managed) return {
    level: "unknown", title: "来源需核对", reasons: ["此 Skill 不在已核实的工具用户级目录的直接子目录中；可能属于项目、插件或自定义扫描源"],
    impact, deletable: false,
  };
  if (managed.protected || path.basename(item.path).startsWith(".")) return {
    level: "unknown", title: "由其他安装源管理", reasons: [`${managed.root} 可能由插件或工具管理，应从原安装源处理`],
    impact, deletable: false,
  };
  if (item.kind === "broken-link") return {
    level: "cleanup", title: "建议清理失效链接", reasons: [item.description],
    impact: ["仅移动这个符号链接，链接目标不会被删除", ...impact], deletable: true,
  };
  if (item.kind === "linked-skill") return {
    level: "consider", title: "链接由用户核对", reasons: [item.description],
    impact: ["仅移动这个符号链接，链接目标不会被删除", ...impact], deletable: true,
  };
  if (item.kind === "empty-directory") return {
    level: "unknown", title: "空目录来源未知", reasons: ["目录为空；没有安装记录时不能证明它是 Skill 残留"],
    impact, deletable: true,
  };
  if (item.kind === "unreadable-skill") return {
    level: "repair", title: "建议修复入口文件", reasons: [item.description],
    impact, deletable: true,
  };
  return { level: "keep", title: "暂无清理建议", reasons: ["尚未发现足以证明这份本地副本失效或重复的证据"], impact, deletable: true };
}

/** Add bounded, evidence-backed advice. Equal content in different tools is not treated as redundant. */
export async function adviseSkills(home: string, items: SkillItem[]): Promise<void> {
  const hashes = new Map<string, string>();
  let checked = 0;
  for (const item of items) {
    item.cleanup = basicCleanupAdvice(home, item);
    if ((item.kind && item.kind !== "skill") || !item.cleanup.deletable) continue;
    if (checked++ >= MAX_ADVICE_CHECKS) {
      item.cleanup = { ...item.cleanup, level: "unknown", title: "尚未完整检查", reasons: ["本次完整内容检查已达到 150 项预算，未推断是否失效或重复"] };
      continue;
    }
    try { hashes.set(item.path, (await analyzeSkillTree(item.path)).hash); }
    catch (error) {
      const reason = (error as Error).message;
      item.cleanup = /已失效|循环引用|目标不存在|无读取权限|非普通文件/.test(reason)
        ? { ...item.cleanup, level: "repair", title: "建议修复", reasons: [reason] }
        : { ...item.cleanup, level: "unknown", title: "完整性尚未确认", reasons: [reason] };
    }
  }
  for (const tool of SKILL_TARGETS) {
    if (["agents", "codex", "wiscode"].includes(tool.id) || tool.candidates.length < 2) continue;
    const preferred = path.join(home, tool.target);
    const primary = items.filter(item => directChild(preferred, item.path));
    for (const item of items) {
      if (!item.cleanup?.deletable || item.cleanup.level !== "keep" || directChild(preferred, item.path)) continue;
      const owner = managedSkillLocation(home, item.path);
      if (!owner || !tool.candidates.includes(owner.candidate)) continue;
      const match = primary.find(other => path.basename(other.path) === path.basename(item.path)
        && hashes.has(other.path) && hashes.get(other.path) === hashes.get(item.path));
      if (!match) continue;
      item.cleanup = {
        ...item.cleanup, level: "consider", title: "可合并重复副本",
        reasons: [`同一工具的首选目录 ${match.path} 有同名且完整内容一致的副本；请核对自定义加载设置后决定是否保留旧目录`],
      };
    }
  }
}

async function rejectLinkedAncestors(home: string, location: string): Promise<void> {
  let current = path.resolve(home);
  const relative = path.relative(current, path.dirname(location));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("路径不在当前用户主目录中");
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`上级目录不是安全的普通目录：${current}`);
  }
}

export async function deletionFingerprint(home: string, location: string): Promise<{ fingerprint: string; kind: "directory" | "link" }> {
  const managed = managedSkillLocation(home, location);
  if (!managed || managed.protected || path.basename(location).startsWith(".")) throw new Error("此路径不属于可管理的用户级 Skill 目录");
  await rejectLinkedAncestors(home, location);
  const stat = await fs.lstat(location);
  const kind = stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : undefined;
  if (!kind) throw new Error("Skill 路径既不是目录也不是符号链接");
  const hash = await fingerprintSkillTree(location);
  return { fingerprint: `${stat.dev}:${stat.ino}:${hash}`, kind };
}

function trashRoot(home: string) { return path.join(home, TRASH_FOLDER); }

async function ensureTrashRoot(home: string): Promise<string> {
  const parent = path.join(home, ".network-lens");
  for (const location of [parent, trashRoot(home)]) {
    try {
      const stat = await fs.lstat(location);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`回收区上级路径不是普通目录：${location}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fs.mkdir(location, { mode: 0o700 });
    }
  }
  return trashRoot(home);
}

export async function moveSkillToTrash(home: string, item: SkillItem, fingerprint: string): Promise<SkillTrashEntry> {
  const current = await deletionFingerprint(home, item.path);
  if (current.fingerprint !== fingerprint) throw new Error("Skill 路径、文件内容或权限在预检后发生变化，请重新检查");
  const root = await ensureTrashRoot(home);
  const id = randomUUID();
  const record = path.join(root, id);
  const entry: SkillTrashEntry = {
    id, name: item.name, originalPath: item.path, deletedAt: new Date().toISOString(), source: item.source, kind: current.kind,
  };
  await fs.mkdir(record, { mode: 0o700 });
  try {
    await fs.writeFile(path.join(record, "manifest.json"), JSON.stringify(entry), { flag: "wx", mode: 0o600 });
    // Rename is atomic on one filesystem. A cross-device source remains untouched.
    await fs.rename(item.path, path.join(record, "item"));
    return entry;
  } catch (error) {
    await fs.rm(record, { recursive: true, force: true }).catch(() => {});
    if ((error as NodeJS.ErrnoException).code === "EXDEV") throw new Error("来源与回收区不在同一文件系统，无法安全移动；原 Skill 保持原位");
    throw error;
  }
}

async function readTrashEntry(home: string, id: string): Promise<SkillTrashEntry | undefined> {
  if (!uuid.test(id)) return;
  const record = path.join(trashRoot(home), id);
  const container = await fs.lstat(record);
  if (!container.isDirectory() || container.isSymbolicLink()) return;
  const manifest = path.join(record, "manifest.json");
  const stat = await fs.lstat(manifest);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) return;
  const parsed: unknown = JSON.parse(await fs.readFile(manifest, "utf8"));
  if (!parsed || typeof parsed !== "object") return;
  const row = parsed as Partial<SkillTrashEntry>;
  if (row.id !== id || typeof row.name !== "string" || typeof row.originalPath !== "string"
    || typeof row.deletedAt !== "string" || typeof row.source !== "string"
    || (row.kind !== "directory" && row.kind !== "link") || !managedSkillLocation(home, row.originalPath)) return;
  await fs.lstat(path.join(record, "item"));
  return row as SkillTrashEntry;
}

export async function listTrashedSkills(home: string): Promise<SkillTrashEntry[]> {
  let entries;
  try { entries = await fs.readdir(trashRoot(home), { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const results: SkillTrashEntry[] = [];
  for (const entry of entries.slice(0, 500)) {
    if (!entry.isDirectory() || !uuid.test(entry.name)) continue;
    try { const row = await readTrashEntry(home, entry.name); if (row) results.push(row); }
    catch { /* Broken or partial records are not offered for restore. */ }
  }
  return results.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

export async function restoreTrashedSkill(home: string, id: string): Promise<SkillTrashEntry> {
  const entry = await readTrashEntry(home, id);
  if (!entry) throw new Error("回收区记录不存在或已损坏");
  const managed = managedSkillLocation(home, entry.originalPath);
  if (!managed || managed.protected) throw new Error("原目录不再属于可恢复的用户级 Skill 目录");
  await rejectLinkedAncestors(home, entry.originalPath);
  try {
    await fs.lstat(entry.originalPath);
    throw new Error(`原位置已有同名文件或目录，未覆盖：${entry.originalPath}`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const record = path.join(trashRoot(home), id);
  await fs.rename(path.join(record, "item"), entry.originalPath);
  await fs.rm(record, { recursive: true, force: true }).catch(() => {});
  return entry;
}
