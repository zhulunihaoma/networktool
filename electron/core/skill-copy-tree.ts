import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const SKILL_TREE_LIMITS = { files: 500, bytes: 20 * 1024 * 1024, entries: 4000, depth: 32 } as const;

export interface SkillTreeEntry {
  kind: "directory" | "file" | "external-link";
  relative: string;
  source: string;
  mode?: number;
  target?: string;
  targetKind?: "file" | "directory";
  replacement?: Buffer;
}

export interface SkillTreeAnalysis {
  hash: string;
  entries: SkillTreeEntry[];
  warnings: string[];
  changes: string[];
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function describeSkillLinkFailure(link: string, rawTarget: string, error: unknown): Error {
  const code = (error as NodeJS.ErrnoException)?.code;
  const suffix = `符号链接 ${link} → ${rawTarget}`;
  if (code === "ELOOP") return new Error(`${suffix} 存在循环引用，无法解析`);
  if (code === "ENOENT" || code === "ENOTDIR") return new Error(`${suffix} 已失效，目标不存在`);
  if (code === "EACCES" || code === "EPERM") return new Error(`${suffix} 的目标无读取权限`);
  return new Error(`${suffix} 无法解析（${code ?? (error as Error)?.message ?? "未知错误"}）`);
}

export async function resolveSkillLink(location: string, label = location): Promise<string> {
  let current = path.resolve(location);
  const visited = new Set<string>();
  const chain: string[] = [];
  for (let depth = 0; depth < 128; depth++) {
    if (visited.has(current)) throw new Error(`符号链接 ${label} 存在循环引用：${chain.join("；")}`);
    visited.add(current);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) { throw describeSkillLinkFailure(label, chain.join("；") || current, error); }
    if (stat.isSymbolicLink()) {
      const target = await fs.readlink(current).catch(error => { throw describeSkillLinkFailure(label, current, error); });
      chain.push(`${current} → ${target}`);
      current = path.resolve(path.dirname(current), target);
      continue;
    }
    try { return await fs.realpath(current); }
    catch (error) { throw describeSkillLinkFailure(label, chain.join("；") || current, error); }
  }
  throw new Error(`符号链接 ${label} 超过 128 层解析限制，疑似循环引用：${chain.join("；")}`);
}

function inspectSecret(relative: string, content: Buffer): void {
  // Filename hints such as "token-example.md" are common in documentation.
  // Block only high-confidence credential material found in file contents.
  const sample = content.toString("utf8");
  if (/(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{24,}|github_pat_[A-Za-z0-9_]{30,}|gh[pousr]_[A-Za-z0-9]{30,})\b)/.test(sample)) {
    throw new Error(`文件 ${relative} 的内容疑似包含私钥或访问凭据，已阻止复制；请移除真实凭据后重试`);
  }
}

function executableCompatibility(relative: string, content: Buffer): string | undefined {
  const magic = content.length >= 4 ? content.readUInt32BE(0) : 0;
  let format = "", platform = "", architectures: string[] = [];
  const archName = (cpu: number): string | undefined => ({
    3: "ia32", 7: "ia32", 12: "arm", 40: "arm", 0x01000007: "x64", 0x0100000c: "arm64",
    21: "ppc64", 22: "s390x", 62: "x64", 183: "arm64", 243: "riscv64",
    0x8664: "x64", 0xaa64: "arm64", 0x14c: "ia32", 0x1c4: "arm",
  } as Record<number, string>)[cpu];
  if (content.length >= 20 && content.toString("ascii", 0, 4) === "\x7fELF") {
    format = "ELF"; platform = "linux";
    const little = content[5] === 1;
    architectures = [archName(little ? content.readUInt16LE(18) : content.readUInt16BE(18))].filter((value): value is string => !!value);
  } else if (content.length >= 8 && [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) {
    format = "Mach-O"; platform = "darwin";
    const little = magic === 0xcefaedfe || magic === 0xcffaedfe;
    architectures = [archName(little ? content.readUInt32LE(4) : content.readUInt32BE(4))].filter((value): value is string => !!value);
  } else if (content.length >= 8 && [0xcafebabe, 0xbebafeca].includes(magic)) {
    format = "universal Mach-O"; platform = "darwin";
    const little = magic === 0xbebafeca;
    const count = little ? content.readUInt32LE(4) : content.readUInt32BE(4);
    if (count > 0 && count <= 32 && content.length >= 8 + count * 20) {
      for (let i = 0; i < count; i++) {
        const offset = 8 + i * 20;
        const cpu = little ? content.readUInt32LE(offset) : content.readUInt32BE(offset);
        const name = archName(cpu);
        if (name) architectures.push(name);
      }
    }
  } else if (content.length >= 64 && content.toString("ascii", 0, 2) === "MZ") {
    const peOffset = content.readUInt32LE(0x3c);
    if (peOffset + 6 <= content.length && content.toString("ascii", peOffset, peOffset + 4) === "PE\0\0") {
      format = "PE"; platform = "win32";
      architectures = [archName(content.readUInt16LE(peOffset + 4))].filter((value): value is string => !!value);
    }
  }
  if (format) {
    if (platform !== process.platform) return `可执行文件 ${relative} 是 ${format}/${platform} 格式；当前系统为 ${process.platform}，原样复制无法消除平台不匹配`;
    if (!architectures.length) return `可执行文件 ${relative} 的格式可识别为 ${format}，但 CPU 架构无法识别；运行兼容性未验证`;
    if (!architectures.includes(process.arch)) return `可执行文件 ${relative} 的架构为 ${architectures.join("/")}；当前 CPU 架构为 ${process.arch}，原样复制无法消除架构不匹配`;
    return undefined;
  }
  if ((content.length > 0 && (content[0] === 0x7f || content[0] === 0x4d || content.includes(0))) || !content.toString("utf8", 0, Math.min(content.length, 128)).startsWith("#!")) {
    return `可执行文件 ${relative} 的二进制格式或解释器无法识别；运行兼容性未验证`;
  }
  return `脚本 ${relative} 会被复制并保留可执行权限；解释器和脚本内部依赖未执行验证`;
}

export async function analyzeSkillTree(directory: string, replacements: ReadonlyMap<string, string> = new Map()): Promise<SkillTreeAnalysis> {
  const root = await fs.realpath(directory);
  const rootStat = await fs.stat(root);
  if (!rootStat.isDirectory()) throw new Error(`Skill 源路径不是目录：${directory}`);
  const entries: SkillTreeEntry[] = [];
  const warnings = new Set<string>();
  const changes = new Set<string>();
  const hash = createHash("sha256");
  let files = 0, bytes = 0, visitedEntries = 0;

  const walk = async (location: string, relative: string, activeDirectories: Set<string>): Promise<void> => {
    if (relative.split(path.sep).length > SKILL_TREE_LIMITS.depth) throw new Error(`资源路径 ${relative} 超过 ${SKILL_TREE_LIMITS.depth} 层限制`);
    let stat = await fs.lstat(location);
    if (stat.isSymbolicLink()) {
      const resolved = await resolveSkillLink(location, relative || location);
      stat = await fs.stat(resolved);
      if (inside(root, resolved)) {
        changes.add(`已将内部符号链接 ${relative} 展开为实际文件或目录，并保留可执行权限`);
        if (stat.isDirectory() && activeDirectories.has(resolved)) {
          throw new Error(`目录符号链接 ${relative} 循环引用到 ${resolved}，无法复制`);
        }
        await walk(resolved, relative, activeDirectories);
        return;
      }
      if (!stat.isFile() && !stat.isDirectory()) throw new Error(`外部符号链接 ${relative} 指向不支持的特殊文件：${resolved}`);
      const kind = stat.isFile() ? "file" : "directory";
      entries.push({ kind: "external-link", relative, source: location, target: resolved, targetKind: kind, mode: stat.mode & 0o777 });
      hash.update(`external-link:${relative}:${kind}:${resolved}:${stat.mode & 0o777}:${stat.size}\0`);
      if (kind === "file") {
        if (++files > SKILL_TREE_LIMITS.files || (bytes += stat.size) > SKILL_TREE_LIMITS.bytes) throw new Error(`外部链接 ${relative} 指向的文件超过 500 文件或 20 MB 限制`);
        let handle;
        try { handle = await fs.open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); }
        catch (error) { throw new Error(`外部依赖 ${relative} → ${resolved} 无法读取：${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`); }
        try {
          const content = await handle.readFile();
          if (content.length !== stat.size) throw new Error(`外部依赖 ${relative} 在检查时发生变化，请重新检查`);
          inspectSecret(relative, content);
          hash.update(content);
          warnings.add(`外部文件依赖 ${relative} → ${resolved} 已存在；目标副本会保留为本机绝对路径链接，换电脑或该路径变化后需要重新安装依赖`);
          if ((stat.mode & 0o111) !== 0) {
            const compatibility = executableCompatibility(relative, content);
            if (compatibility) warnings.add(compatibility);
            else warnings.add(`外部程序 ${resolved} 的文件格式与当前系统及 CPU 架构匹配；其动态库、登录状态和运行行为仍未验证`);
          }
        } finally { await handle.close(); }
      } else {
        warnings.add(`外部目录依赖 ${relative} → ${resolved} 已存在；目录内容不会复制，目标仍依赖本机该路径`);
      }
      return;
    }

    const canonical = await fs.realpath(location);
    if (stat.isDirectory()) {
      if (activeDirectories.has(canonical)) throw new Error(`目录 ${relative || "."} 循环引用到 ${canonical}，无法复制`);
      entries.push({ kind: "directory", relative, source: canonical });
      hash.update(`directory:${relative}\0`);
      activeDirectories.add(canonical);
      try {
        const children = (await fs.readdir(canonical, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
        for (const child of children) {
          if (++visitedEntries > SKILL_TREE_LIMITS.entries) throw new Error(`资源目录超过 ${SKILL_TREE_LIMITS.entries} 项限制（检查到 ${path.join(relative, child.name)}）`);
          await walk(path.join(canonical, child.name), path.join(relative, child.name), activeDirectories);
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === "EACCES" || code === "EPERM") throw new Error(`目录 ${relative || "."} 无读取权限`);
        throw error;
      } finally { activeDirectories.delete(canonical); }
      return;
    }

    if (!stat.isFile()) throw new Error(`路径 ${relative} 是非普通文件，无法安全复制`);
    if (++files > SKILL_TREE_LIMITS.files || (bytes += stat.size) > SKILL_TREE_LIMITS.bytes) throw new Error(`检查到 ${relative} 时，Skill 超过 500 个文件或 20 MB 限制`);
    let handle;
    try { handle = await fs.open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "EACCES" || code === "EPERM") throw new Error(`文件 ${relative} 无读取权限`);
      throw new Error(`文件 ${relative} 无法读取：${code ?? (error as Error).message}`);
    }
    try {
      const current = await handle.stat();
      if (!current.isFile()) throw new Error(`文件 ${relative} 在检查时已变成非普通文件`);
      const original = await handle.readFile();
      if (original.length !== current.size) throw new Error(`文件 ${relative} 在检查时发生变化，请重新检查`);
      inspectSecret(relative, original);
      const replacement = replacements.has(relative) ? Buffer.from(replacements.get(relative)!, "utf8") : undefined;
      const content = replacement ?? original;
      if (replacement && (bytes += replacement.length - original.length) > SKILL_TREE_LIMITS.bytes) throw new Error("修复后的 Skill 超过 20 MB 限制");
      const mode = current.mode & 0o777;
      entries.push({ kind: "file", relative, source: canonical, mode, replacement });
      hash.update(`file:${relative}:${mode}:${content.length}\0`);
      hash.update(content);
      if ((mode & 0o111) !== 0) {
        const compatibility = executableCompatibility(relative, content);
        if (compatibility) warnings.add(compatibility);
      }
    } finally { await handle.close(); }
  };

  await walk(root, "", new Set());
  return { hash: hash.digest("hex"), entries, warnings: [...warnings], changes: [...changes] };
}

export async function fingerprintSkillTree(directory: string): Promise<string> {
  const hash = createHash("sha256");
  let entries = 0, bytes = 0;
  const walk = async (location: string, relative: string): Promise<void> => {
    const stat = await fs.lstat(location);
    if (stat.isSymbolicLink()) {
      hash.update(`link:${relative}:${await fs.readlink(location)}\0`);
      return;
    }
    if (stat.isDirectory()) {
      hash.update(`directory:${relative}\0`);
      for (const child of (await fs.readdir(location)).sort()) {
        if (++entries > SKILL_TREE_LIMITS.entries) throw new Error(`现有目标目录超过 ${SKILL_TREE_LIMITS.entries} 项，无法建立备份快照`);
        await walk(path.join(location, child), path.join(relative, child));
      }
      return;
    }
    if (!stat.isFile()) throw new Error(`现有目标包含不支持的特殊文件：${relative}`);
    if (++entries > SKILL_TREE_LIMITS.entries || (bytes += stat.size) > SKILL_TREE_LIMITS.bytes) throw new Error(`现有目标超过快照限制（检查到 ${relative}）`);
    const handle = await fs.open(location, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const current = await handle.stat();
      const content = await handle.readFile();
      if (content.length !== current.size) throw new Error(`现有目标文件 ${relative} 正在变化，无法建立备份快照`);
      hash.update(`file:${relative}:${current.mode & 0o777}:${current.size}\0`);
      hash.update(content);
    } finally { await handle.close(); }
  };
  await walk(directory, "");
  return hash.digest("hex");
}

export async function copySkillTree(analysis: SkillTreeAnalysis, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true });
  for (const entry of analysis.entries) {
    const output = entry.relative ? path.join(destination, entry.relative) : destination;
    if (entry.kind === "directory") {
      await fs.mkdir(output, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(output), { recursive: true });
      if (entry.kind === "external-link") {
        try { await fs.symlink(entry.target!, output, entry.targetKind === "directory" ? "dir" : "file"); }
        catch (error) { throw new Error(`无法保留外部依赖链接 ${entry.relative} → ${entry.target}：${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`); }
      } else {
        try {
          if (entry.replacement) await fs.writeFile(output, entry.replacement, { flag: "wx" });
          else await fs.copyFile(entry.source, output, constants.COPYFILE_EXCL);
          if (entry.mode !== undefined) await fs.chmod(output, entry.mode);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException)?.code;
          if (code === "EACCES" || code === "EPERM") throw new Error(`无法复制 ${entry.relative}：没有读取源文件或写入目标目录的权限`);
          throw new Error(`无法复制 ${entry.relative}：${code ?? (error as Error).message}`);
        }
      }
    }
  }
}
