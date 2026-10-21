/** Read-only Markdown discovery. No model calls, writes, commands, or remote imports. */
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  emptyMemorySnapshot,
  parseMemoryDocument,
  type MemoryAgent,
  type MemoryKind,
  type MemorySnapshot,
} from "../../src/shared/memory";
import { sanitizer } from "../../src/shared/handoff";

export const MEMORY_LIMITS = {
  fileBytes: 256 * 1024,
  totalBytes: 4 * 1024 * 1024,
  documents: 100,
  nodes: 8000,
  entries: 4000,
  depth: 4,
} as const;
type Source = { path: string; kind: MemoryKind; scope: string; depth?: number };
const skipped = new Set([
  ".git",
  ".codegraph",
  "node_modules",
  "rollout_summaries",
  "sessions",
  "chats",
  "logs",
  "cache",
  "skills",
]);
const missing = (error: unknown) =>
  ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code || "");
const inside = (base: string, file: string) => {
  const relative = path.relative(base, file);
  return (
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  );
};

export class MemoryScanner {
  private project?: string;
  private extra = new Map<MemoryAgent, string[]>();
  constructor(private home: string) {
    this.home = path.resolve(home);
  }
  setProject(directory: string) {
    this.project = this.validate(directory);
  }
  addDirectory(agent: MemoryAgent, directory: string) {
    const roots = this.extra.get(agent) || [];
    const normalized = this.validate(directory);
    if (!roots.includes(normalized)) roots.push(normalized);
    this.extra.set(agent, roots);
  }
  private validate(directory: string) {
    if (!path.isAbsolute(directory) || directory.includes("\0"))
      throw new Error("请选择绝对目录路径");
    return path.resolve(directory);
  }
  private async sources(
    agent: MemoryAgent,
    result: MemorySnapshot,
  ): Promise<Source[]> {
    const global = (relative: string, kind: MemoryKind, depth = 0): Source => ({
      path: path.join(this.home, relative),
      kind,
      scope: "用户级",
      depth,
    });
    const sources: Source[] = [];
    if (agent === "codex")
      sources.push(
        global(".codex/memories", "memory", MEMORY_LIMITS.depth),
        global(".codex/AGENTS.md", "instruction"),
      );
    if (agent === "claude" || agent === "gemini") {
      const prefix = agent === "claude" ? ".claude/projects" : ".gemini/tmp";
      const base = path.join(this.home, prefix);
      try {
        // Project directories are enumerated; transcripts and unrelated subtrees are never walked.
        await this.assertUnlinked(base);
        const entries = await fs.readdir(base, { withFileTypes: true });
        if (entries.length > MEMORY_LIMITS.entries)
          result.warnings.push("项目目录达到扫描上限，部分项目未读取。");
        for (const entry of entries
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, MEMORY_LIMITS.entries)) {
          if (entry.isDirectory())
            sources.push({
              path: path.join(base, entry.name, "memory"),
              kind: "memory",
              scope: entry.name,
              depth: 3,
            });
        }
        result.roots.push({ path: base, status: "read" });
      } catch (error) {
        result.roots.push({
          path: base,
          status: missing(error) ? "missing" : "error",
          message: missing(error) ? undefined : (error as Error).message,
        });
      }
      sources.push(
        global(
          agent === "claude" ? ".claude/CLAUDE.md" : ".gemini/GEMINI.md",
          "instruction",
        ),
      );
      if (agent === "gemini")
        result.warnings.push(
          "只展示已发现的 Markdown；Auto Memory 的 .patch 候选不作为已应用记忆读取。",
        );
    }
    if (agent === "cursor")
      sources.push(global(".cursor/rules", "instruction", 3));
    if (agent === "opencode") {
      const primary = global(".config/opencode/AGENTS.md", "instruction");
      sources.push(primary);
      try {
        await fs.lstat(primary.path);
      } catch (error) {
        if (missing(error))
          sources.push(global(".claude/CLAUDE.md", "instruction"));
      }
    }
    if (this.project) {
      const add = (relative: string, depth = 0) =>
        sources.push({
          path: path.join(this.project!, relative),
          kind: "instruction",
          scope: this.project!,
          depth,
        });
      if (agent === "codex") {
        add("AGENTS.md");
        add("AGENTS.override.md");
      }
      if (agent === "claude") {
        add("CLAUDE.md");
        add("CLAUDE.local.md");
        add(".claude/CLAUDE.md");
        add(".claude/rules", 3);
        add("AGENTS.md");
      }
      if (agent === "gemini") add("GEMINI.md");
      if (agent === "cursor") {
        add("AGENTS.md");
        add(".cursor/rules", 3);
        add(".cursorrules");
      }
      if (agent === "opencode") {
        add("AGENTS.md");
        add("CLAUDE.md");
      }
    }
    for (const directory of this.extra.get(agent) || [])
      sources.push({
        path: directory,
        kind: "document",
        scope: "自选目录",
        depth: MEMORY_LIMITS.depth,
      });
    return sources;
  }
  private async assertUnlinked(location: string) {
    const parsed = path.parse(location);
    let current = parsed.root;
    for (const part of location
      .slice(parsed.root.length)
      .split(path.sep)
      .filter(Boolean)) {
      current = path.join(current, part);
      // macOS /var -> /private/var is a system alias, not a user-controlled source link.
      if ((await fs.lstat(current)).isSymbolicLink()) {
        const real = await fs.realpath(current);
        if (
          !(
            process.platform === "darwin" &&
            current === "/var" &&
            real === "/private/var"
          ) &&
          !(
            process.platform === "darwin" &&
            current === "/tmp" &&
            real === "/private/tmp"
          )
        )
          throw new Error("已跳过符号链接路径");
      }
    }
  }
  async scan(agent: MemoryAgent): Promise<MemorySnapshot> {
    const result = emptyMemorySnapshot(agent);
    result.project = this.project;
    const sources = await this.sources(agent, result);
    const seen = new Set<string>();
    const warnings = new Set(result.warnings);
    let entries = 0,
      bytes = 0,
      reached = false;
    const addFile = async (file: string, source: Source) => {
      const real = await fs.realpath(file);
      if (seen.has(real)) return;
      if (
        result.documents.length >= MEMORY_LIMITS.documents ||
        result.nodes.length >= MEMORY_LIMITS.nodes
      ) {
        reached = true;
        return;
      }
      await this.assertUnlinked(file);
      const handle = await fs.open(
        file,
        constants.O_RDONLY |
          (constants.O_NOFOLLOW || 0) |
          (constants.O_NONBLOCK || 0),
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error("不是普通文档");
        if (stat.size > MEMORY_LIMITS.fileBytes)
          throw new Error("文件超过 256 KB，未读取");
        if (bytes + stat.size > MEMORY_LIMITS.totalBytes) {
          reached = true;
          return;
        }
        const buffer = Buffer.alloc(MEMORY_LIMITS.fileBytes + 1);
        let length = 0;
        while (length < buffer.length) {
          const read = await handle.read(
            buffer,
            length,
            buffer.length - length,
            length,
          );
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        if (length > MEMORY_LIMITS.fileBytes)
          throw new Error("文件增长超过 256 KB，未读取");
        if (bytes + length > MEMORY_LIMITS.totalBytes) {
          reached = true;
          return;
        }
        const after = await handle.stat();
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
          throw new Error("文件读取期间发生变化，请刷新");
        const clean = sanitizer();
        let privateKey = false;
        const raw = buffer
          .subarray(0, length)
          .toString("utf8")
          .replace(
            /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
            (value) => {
              privateKey = true;
              return value
                .split("\n")
                .map(() => "[已脱敏]")
                .join("\n");
            },
          );
        // Sanitization must not shift the line numbers used by source evidence.
        const text = raw
          .split("\n")
          .map((line) => clean.clean(line))
          .join("\n");
        const id = createHash("sha256")
          .update(agent + "\0" + real)
          .digest("hex")
          .slice(0, 24);
        const parsed = parseMemoryDocument(
          {
            id,
            title: path.basename(file),
            path: file,
            scope: source.scope,
            kind: source.kind,
            modified: stat.mtimeMs,
          },
          text,
          Math.min(500, MEMORY_LIMITS.nodes - result.nodes.length),
        );
        result.documents.push(parsed.document);
        result.nodes.push(...parsed.nodes);
        result.edges.push(...parsed.edges);
        if (parsed.document.truncated)
          warnings.add(`${file} 的内容节点达到上限，部分内容未展示。`);
        if (privateKey || clean.count())
          warnings.add("已隐藏已知格式的密钥和凭据；来源文件保持不变。");
        seen.add(real);
        bytes += length;
      } finally {
        await handle.close();
      }
    };
    for (const source of sources) {
      if (reached) break;
      const record: MemorySnapshot["roots"][number] = {
        path: source.path,
        status: "read",
      };
      result.roots.push(record);
      try {
        await this.assertUnlinked(source.path);
        const stat = await fs.lstat(source.path);
        const walk = async (
          directory: string,
          depth: number,
        ): Promise<void> => {
          const children = await fs.readdir(directory, { withFileTypes: true });
          for (const child of children.sort((a, b) =>
            a.name.localeCompare(b.name),
          )) {
            if (++entries > MEMORY_LIMITS.entries) {
              reached = true;
              return;
            }
            if (reached) return;
            if (child.isSymbolicLink()) {
              warnings.add("已跳过符号链接，避免越出所选来源。");
              continue;
            }
            const location = path.join(directory, child.name);
            if (!inside(source.path, location)) continue;
            if (child.isDirectory() && !skipped.has(child.name)) {
              if (depth < (source.depth || 0)) {
                await this.assertUnlinked(location);
                await walk(location, depth + 1);
              } else
                warnings.add(
                  `${source.path} 达到目录深度上限，部分目录未读取。`,
                );
            } else if (child.isFile() && /\.(md|mdc)$/i.test(child.name)) {
              try {
                await addFile(location, source);
              } catch (error) {
                warnings.add(`${location}：${(error as Error).message}`);
              }
            }
          }
        };
        if (stat.isDirectory()) await walk(source.path, 0);
        else if (stat.isFile()) await addFile(source.path, source);
        else throw new Error("不是普通文件或目录");
      } catch (error) {
        record.status = missing(error) ? "missing" : "error";
        record.message = missing(error) ? undefined : (error as Error).message;
      }
    }
    if (reached)
      warnings.add(
        "已达到扫描预算（100 个文件 / 4 MB / 8000 个节点 / 4000 个目录项），部分来源未读取；可选择更小的目录。",
      );
    // Explicit Markdown references connect only documents already in this scan.
    const byPath = new Map(
      result.documents.map((d) => [path.resolve(d.path), d]),
    );
    for (const node of result.nodes) {
      const document = result.documents.find((d) => d.id === node.documentId)!;
      for (const match of node.content.matchAll(
        /\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g,
      )) {
        const href = match[1];
        if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) continue;
        let file: string;
        try {
          file = decodeURIComponent(href.split("#")[0]);
        } catch {
          continue;
        }
        const target = file
          ? byPath.get(path.resolve(path.dirname(document.path), file))
          : document;
        if (
          target &&
          target.id !== document.id &&
          !result.edges.some(
            (e) => e.from === node.id && e.to === target.rootId,
          )
        )
          result.edges.push({
            from: node.id,
            to: target.rootId,
            kind: "reference",
          });
      }
    }
    result.warnings = [...warnings];
    return result;
  }
}
