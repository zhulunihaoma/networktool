import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { sanitizer } from "../../src/shared/handoff";
import {
  RISK_RULES,
  type RiskLevel,
  type RiskLine,
  type SkillRiskReport,
} from "../../src/shared/security-scan";

/** 只读扫描限额：超出时标记 truncated，不会无限读取。 */
export const SCAN_LIMITS = {
  files: 400,
  fileBytes: 256 * 1024,
  depth: 8,
  findings: 120,
  lineChars: 2000,
} as const;
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "__pycache__"]);
const ORDER: Record<RiskLevel, number> = { high: 3, medium: 2, low: 1 };
const URL_RE = /\bhttps?:\/\/[^\s)"'<>\]`]+/gi;
const COMMAND =
  /^(?:[$>]\s*)?(?:curl|wget|npx|uvx|npm\s+(?:i|install)|pnpm\s+(?:i|add|dlx)|yarn\s+dlx|pip3?\s+install|brew\s+install|bash|sh|python3?|node|chmod|sudo)\s/i;

interface Rule {
  id: string;
  test: (line: string) => boolean;
}
const re = (x: RegExp) => (line: string) => x.test(line);

function unpinned(line: string): boolean {
  const npx = /\bnpx\s+(?:-y|--yes)\s+(\S+)/i.exec(line);
  if (npx && !/.@(?:v?\d[\w.+-]*)$/.test(npx[1].replace(/['"`,;)]+$/, "")))
    return true;
  const uv = /\buvx?\b[^\n]*--from\s+(git\+\S+)/i.exec(line);
  return (
    !!uv &&
    !/@(?:v?\d|[0-9a-f]{7,40})/i.test(
      uv[1].replace(/^git\+[a-z]+:\/\/[^/]*\//i, ""),
    )
  );
}

const RULES: Rule[] = [
  {
    id: "pipe-to-shell",
    test: re(
      /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b|\b(?:ba|z)?sh\s+<\(\s*(?:curl|wget)\b|\b(?:ba|z)?sh\s+-c\s+["']?\$\(\s*(?:curl|wget)\b/i,
    ),
  },
  {
    id: "decode-exec",
    test: re(
      /base64\s+(?:-d|-D|--decode)\b[^\n]*\|\s*(?:sudo\s+)?(?:(?:ba|z)?sh|python3?|node|perl|ruby)\b|\beval\b[^\n]*(?:base64|atob\()|\bexec\(\s*(?:base64\.b64decode|atob)/i,
    ),
  },
  {
    id: "recursive-delete",
    test: re(
      /\brm\s+(?:-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*|-r\s+-f|-f\s+-r|--recursive\s+--force|--force\s+--recursive)\b/i,
    ),
  },
  {
    id: "credential-access",
    test: re(
      /(?:~|\$HOME|\$\{HOME\})\/\.(?:ssh|aws|gnupg|netrc|npmrc|git-credentials|docker\/config\.json|kube\/config)\b|\.ssh\/(?:id_|authorized_keys)|\bid_(?:rsa|ed25519|ecdsa)\b|[~\/.][\w.\/-]*\/auth\.json\b|\.aws\/credentials|\/\.?credentials(?:\.json|\.ya?ml)?\b|\b(?:cat|source|cp|scp|base64|less|more|head|tail|grep|xargs|curl\s+[^\n]*-F\s*\S*@)\s*[^\n|;&]*\.env(?:\.\w+)?\b/i,
    ),
  },
  {
    id: "privilege",
    test: re(
      /(?:^|[\s;&|`$(])sudo\s+[\w\/.-]+|\bchmod\s+(?:-R\s+)?(?:0?777|a\+rwx)\b/,
    ),
  },
  { id: "unpinned-launcher", test: unpinned },
  {
    id: "prompt-injection",
    test: re(
      /ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above)\s+(?:instructions|rules)|disregard\s+(?:all\s+)?(?:previous|prior)\s+(?:instructions|rules)|忽略(?:之前|以前|上面|先前|所有)(?:的)?(?:所有)?(?:指令|规则|提示|约束)|do\s+not\s+(?:tell|inform)\s+the\s+user|without\s+(?:telling|informing)\s+the\s+user|不要(?:告诉|让)用户知道/i,
    ),
  },
];

async function walk(
  root: string,
): Promise<{ files: string[]; truncated: boolean; links: number }> {
  const files: string[] = [];
  let truncated = false,
    links = 0;
  const stack: [string, number][] = [["", 0]];
  while (stack.length) {
    const [rel, depth] = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
    } catch (error) {
      if (!rel) throw error;
      truncated = true;
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        links++;
        truncated = true;
        continue;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (depth + 1 > SCAN_LIMITS.depth) {
          truncated = true;
          continue;
        }
        stack.push([next, depth + 1]);
      } else if (entry.isFile()) {
        if (files.length >= SCAN_LIMITS.files) {
          truncated = true;
          continue;
        }
        files.push(next);
      }
    }
  }
  files.sort();
  return { files, truncated, links };
}

/** string=文本；null=超过大小限额；undefined=二进制或不可读，直接跳过。 */
async function readText(file: string): Promise<string | null | undefined> {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return undefined;
    if (stat.size > SCAN_LIMITS.fileBytes) return null;
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);
    const slice = buffer.subarray(0, bytesRead);
    if (slice.subarray(0, 4096).includes(0)) return undefined;
    return slice.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function loadPrevious(
  dir: string,
): Promise<Map<string, Set<string>> | undefined> {
  try {
    // 旧版本位置若是符号链接则不对比，避免顺着链接读取目录外内容
    if (!(await fs.lstat(dir)).isDirectory()) return undefined;
    const { files } = await walk(dir);
    const map = new Map<string, Set<string>>();
    for (const file of files) {
      const text = await readText(path.join(dir, file));
      if (typeof text === "string")
        map.set(
          file,
          new Set(
            text
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean),
          ),
        );
    }
    return map;
  } catch {
    return undefined;
  }
}

function normalizeUrl(raw: string): { href: string; host: string } | undefined {
  try {
    const url = new URL(raw.replace(/[.,;:!?]+$/, ""));
    if (
      /^(?:localhost|127\.|0\.0\.0\.0|\[::1\]$)/.test(url.hostname) ||
      /(?:^|\.)example\.(?:com|org|net)$/.test(url.hostname)
    )
      return undefined;
    return {
      href: `${url.origin}${url.pathname === "/" ? "" : url.pathname}`,
      host: url.host,
    };
  } catch {
    return undefined;
  }
}

/** 待扫描的文件：relative 为 Skill 内相对路径；content 优先，否则从 location 读取（不跟随链接）。 */
export interface ScanSource {
  relative: string;
  location?: string;
  content?: string | Buffer;
}

function decode(content: string | Buffer): string | null | undefined {
  if (typeof content === "string")
    return content.length > SCAN_LIMITS.fileBytes ? null : content;
  if (content.length > SCAN_LIMITS.fileBytes) return null;
  return content.subarray(0, 4096).includes(0)
    ? undefined
    : content.toString("utf8");
}

/** 扫描一组文件（例如复制计划中真正会写入目标的文件）。 */
export async function scanSkillFiles(
  sources: ScanSource[],
  previousDir?: string,
  preTruncated = false,
): Promise<SkillRiskReport> {
  const { clean } = sanitizer();
  let truncated = preTruncated;
  const list = [...sources].sort((a, b) =>
    a.relative.localeCompare(b.relative),
  );
  if (list.length > SCAN_LIMITS.files) {
    truncated = true;
    list.length = SCAN_LIMITS.files;
  }
  const previous = previousDir ? await loadPrevious(previousDir) : undefined;
  const findings: RiskLine[] = [];
  const urls = new Set<string>();
  const commands = new Set<string>();
  let scanned = 0;
  const add = (
    file: string,
    line: number,
    raw: string,
    rule: string,
    changed: boolean,
  ) => {
    if (findings.length >= SCAN_LIMITS.findings) {
      truncated = true;
      return;
    }
    const info = RISK_RULES[rule];
    findings.push({
      file,
      line,
      text: clean(raw.trim()).slice(0, 200),
      rule,
      label: info.label,
      level: info.level,
      ...(changed ? { changed: true } : {}),
    });
  };
  for (const source of list) {
    const file = source.relative.split(path.sep).join("/");
    const text =
      source.content !== undefined
        ? decode(source.content)
        : source.location
          ? await readText(source.location)
          : undefined;
    if (text === null) {
      truncated = true;
      continue;
    }
    if (text === undefined) { truncated = true; continue; }
    scanned++;
    const before = previous?.get(file);
    const seenHosts = new Set<string>();
    text.split(/\r?\n/).forEach((raw, index) => {
      const line = raw.slice(0, SCAN_LIMITS.lineChars);
      const trimmed = line.trim();
      if (!trimmed) return;
      const changed = !!previous && !before?.has(trimmed);
      for (const rule of RULES)
        if (rule.test(line)) add(file, index + 1, trimmed, rule.id, changed);
      for (const match of line.matchAll(URL_RE)) {
        const origin = normalizeUrl(match[0]);
        if (!origin) continue;
        if (urls.size < 50) urls.add(clean(origin.href));
        if (!seenHosts.has(origin.host)) {
          seenHosts.add(origin.host);
          add(file, index + 1, trimmed, "external-url", changed);
        }
      }
      if (COMMAND.test(trimmed) && commands.size < 30)
        commands.add(clean(trimmed).slice(0, 160));
    });
  }
  findings.sort(
    (a, b) =>
      ORDER[b.level] - ORDER[a.level] ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );
  const level: SkillRiskReport["level"] = findings.length
    ? findings[0].level
    : "none";
  return {
    level,
    findings,
    urls: [...urls],
    commands: [...commands],
    scannedFiles: scanned,
    truncated,
    compared: previous !== undefined,
    changedCount: findings.filter((item) => item.changed).length,
  };
}

/**
 * 只读扫描一个 Skill 目录，找出高风险指令和外部地址。不跟随符号链接，有文件数/大小/深度限额。
 * previousDir：目标位置已存在的旧版本；传入后，新增行上的 finding 会标 changed=true。
 */
export async function scanSkillDirectory(
  dir: string,
  previousDir?: string,
): Promise<SkillRiskReport> {
  const { files, truncated } = await walk(dir);
  return scanSkillFiles(
    files.map((relative) => ({ relative, location: path.join(dir, relative) })),
    previousDir,
    truncated,
  );
}
