import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { SecurityProgress, RetroHit, RetroScanReport, SecurityTool } from "../../src/shared/security";
import { sanitizer } from "../../src/shared/handoff";

/**
 * Retrospective scan of already-recorded AI tool sessions ("查杀"): finds past
 * risky operations (credential reads, pipe-to-shell, forced pushes, plaintext
 * secrets) in the session transcripts the tools themselves keep on disk.
 * Read-only, hard-limited, evidence sanitized. Never starts a tool or model.
 */

/** 只读扫描限额：超出时标记 truncated，不会无限读取。 */
const LIMITS = {
  files: 500,
  fileBytes: 256 * 1024,
  depth: 6,
  hits: 150,
  evidenceChars: 200,
} as const;
/** 每个来源最多取最近 N 个文件，避免单工具刷满限额。 */
const PER_SOURCE_FILES = 120;

/** 文件型会话来源：目录固定、只读，不执行任何源工具。 */
const SOURCES: { tool: SecurityTool; dir: string; label: string }[] = [
  { tool: "codex", dir: ".codex/sessions", label: "Codex 会话记录" },
  { tool: "claude", dir: ".claude/projects", label: "Claude Code 会话记录" },
  { tool: "zcode", dir: ".zcode/cli", label: "ZCode 会话记录" },
  { tool: "opencode", dir: ".local/share/opencode", label: "OpenCode 会话记录" },
  { tool: "wiscode", dir: ".wiscode", label: "WisCode 会话记录" },
  { tool: "dsh", dir: ".dsh", label: "DeepSeek Harness 会话记录" },
];

const hash = (s: string) =>
  createHash("sha256").update(s).digest("hex").slice(0, 16);

interface Rule {
  /** RetroHit.ruleId；沿用 guard 的规则 id，方便共用文案。 */
  id: string;
  level: RetroHit["level"];
  test: RegExp;
}
const RULES: Rule[] = [
  {
    id: "remote_exec",
    level: "high",
    test: /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b|\b(?:ba|z)?sh\s+<\(\s*(?:curl|wget)\b/i,
  },
  {
    id: "destructive",
    level: "high",
    test: /\brm\s+(?:-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*|--recursive\s+--force|--force\s+--recursive)\b|\bgit\s+push\b[^\n]*--force/i,
  },
  {
    id: "credential_read",
    level: "high",
    test: /(?:~|\$HOME|\$\{HOME\})\/\.(?:ssh|aws|gnupg|netrc|npmrc|git-credentials|docker\/config\.json|kube\/config)\b|\.ssh\/id_|\/\.?env(?:\.\w+)?\b|\bid_(?:rsa|ed25519|ecdsa)\b|auth\.json\b|\.aws\/credentials/i,
  },
  {
    id: "privilege",
    level: "medium",
    // JSON 行里 sudo 可能紧跟引号等字符，不限定前置边界
    test: /\bsudo\s+[\w\/.-]+|\bchmod\s+(?:-R\s+)?(?:0?777|a\+rwx)\b/,
  },
  {
    // 会话中出现的明文密钥（对话或命令里粘贴的），证据只保留前缀。
    id: "plaintext_secret",
    level: "high",
    test: /(?:sk-[A-Za-z0-9_-]{16,}|-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{12,})/,
  },
  {
    id: "dns_exfil",
    level: "medium",
    test: /\bcurl\b[^\n]*\b(?:-d|-F|-T|--data)\b[^\n]*https?:\/\/(?:\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9-]+\.(?:top|xyz|icu|tk)\b)/i,
  },
];

async function listSessionFiles(
  root: string,
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let truncated = false;
  // Walk newest-last by mtime is expensive; instead collect then sort by mtime.
  const stack: [string, number][] = [["", 0]];
  while (stack.length) {
    const [rel, depth] = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(path.join(root, rel), {
        withFileTypes: true,
      });
    } catch {
      if (!rel) return { files: [], truncated: false };
      continue;
    }
    for (const entry of entries) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (depth + 1 > LIMITS.depth) {
          truncated = true;
          continue;
        }
        stack.push([next, depth + 1]);
      } else if (entry.isFile() && /\.(?:json|jsonl|yaml|yml|md|txt)$/i.test(entry.name)) {
        files.push(next);
      }
    }
  }
  // Prefer the newest sessions within each source's budget.
  const withMtime = await Promise.all(
    files.slice(0, 2000).map(async (f) => {
      try {
        return { f, mtime: (await fs.stat(path.join(root, f))).mtimeMs };
      } catch {
        return { f, mtime: 0 };
      }
    }),
  );
  withMtime.sort((a, b) => b.mtime - a.mtime);
  const picked = withMtime.map((x) => x.f);
  if (files.length > 2000) truncated = true;
  return { files: picked, truncated };
}

/** 不跟随符号链接；超过限额返回 null；二进制返回 undefined。 */
async function readText(
  file: string,
): Promise<string | null | undefined> {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return undefined;
    if (stat.size > LIMITS.fileBytes) return null;
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);
    const slice = buffer.subarray(0, bytesRead);
    if (slice.subarray(0, 4096).includes(0)) return undefined;
    return slice.toString("utf8");
  } finally {
    await handle.close();
  }
}

/** 从会话文件内容里尽量恢复项目目录与会话 id（只用于展示）。 */
function sessionMeta(text: string, file: string) {
  const sessionId =
    /"(?:session_?[Ii]d|sessionId|thread_?[Ii]d)"\s*:\s*"([^"]{4,80})"/.exec(
      text,
    )?.[1] ?? path.basename(file, path.extname(file));
  const project =
    /"(?:cwd|workdir|project_?path|root)"\s*:\s*"([^"]{3,300})"/.exec(text)
      ?.[1];
  return { sessionId, project };
}

/** Inspect command payloads, not session metadata, tool output or quoted instructions. */
function scanPayloads(line: string): { text: string; command: boolean }[] {
  const command = (input: unknown): { text: string; command: boolean }[] => {
    if (typeof input === "string") {
      try { return command(JSON.parse(input)); } catch { return [{ text: input, command: true }]; }
    }
    if (!input || typeof input !== "object") return [];
    const value = input as Record<string, unknown>;
    const text = value.command ?? value.cmd;
    return typeof text === "string" ? [{ text, command: true }] : [];
  };
  let row;
  try { row = JSON.parse(line); } catch {
    // Unstructured transcripts are only hints; require a command at the line start.
    if (/^\s*[\[{]/.test(line)) return []; // malformed JSON is not a transcript command
    return [{ text: line, command: /^\s*(?:[$>]\s*)?(?:cat|head|tail|less|more|base64|cp|scp|curl|wget|rm|git|sudo|chmod|bash|sh)\s/.test(line) }];
  }
  if (!row || typeof row !== "object") return [];
  if (["session_meta", "turn_context", "tool_result", "function_call_output"].includes(row.type)) return [];
  const value = row.type === "response_item" ? row.payload : row;
  if (!value || typeof value !== "object") return [];
  if (value.type === "command") return command(value.command);
  if (value.type === "function_call" && /^(?:exec_command|shell|shell_command|run_terminal_cmd|Bash)$/.test(value.name ?? "")) return command(value.arguments);
  const message = value.message ?? value;
  const content = message.content;
  const results: { text: string; command: boolean }[] = [];
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part?.type === "tool_use" && /^(?:Bash|bash|shell|exec_command)$/.test(part.name ?? "")) results.push(...command(part.input));
      else if (["text", "input_text", "output_text"].includes(part?.type) && typeof part.text === "string") results.push({ text: part.text, command: false });
    }
  } else if (typeof content === "string") results.push({ text: content, command: false });
  if (value.type === "message" && typeof value.text === "string") results.push({ text: value.text, command: false });
  return results;
}

export async function runRetroScan(
  home: string,
  onProgress?: (p: SecurityProgress) => void,
): Promise<RetroScanReport> {
  const started = Date.now();
  const { clean } = sanitizer();
  const hits: RetroHit[] = [];
  const seen = new Set<string>();
  const sourcesSeen: string[] = [];
  let scannedFiles = 0;
  let truncated = false;
  for (let i = 0; i < SOURCES.length; i++) {
    const source = SOURCES[i];
    onProgress?.({
      kind: "retro",
      step: i,
      steps: SOURCES.length,
      title: `正在回溯 ${source.label}`,
      found: hits.length,
    });
    const root = path.join(home, source.dir);
    try {
      if (!(await fs.stat(root)).isDirectory()) continue;
    } catch {
      continue;
    }
    sourcesSeen.push(source.label);
    const { files, truncated: t } = await listSessionFiles(root);
    truncated ||= t;
    for (const file of files.slice(0, PER_SOURCE_FILES)) {
      if (scannedFiles >= LIMITS.files || hits.length >= LIMITS.hits) {
        truncated = true;
        break;
      }
      const full = path.join(root, file);
      const text = await readText(full);
      if (text === undefined || text === null) {
        if (text === null) truncated = true;
        continue;
      }
      scannedFiles++;
      const { sessionId, project } = sessionMeta(text, file);
      for (const payload of text.split(/\r?\n/).flatMap(scanPayloads)) {
        if (hits.length >= LIMITS.hits) { truncated = true; break; }
        for (const rule of RULES) {
          if (!payload.command && rule.id !== "plaintext_secret") continue;
          const match = rule.test.exec(payload.text);
          if (!match) continue;
          // Sanitize before clipping; show the matched payload rather than a JSON envelope.
          const cleaned = clean(payload.text.slice(Math.max(0, match.index - 40)));
          const evidence = cleaned.trim().slice(0, LIMITS.evidenceChars);
          const id = `retro:${source.tool}:${rule.id}:${hash(`${sessionId}\0${evidence}`)}`;
          if (seen.has(id)) break;
          seen.add(id);
          hits.push({
            id,
            tool: source.tool,
            project,
            sessionId: sessionId.slice(0, 80),
            ruleId: rule.id,
            level: rule.level,
            evidence,
          });
          break; // 每行只记最高优先级命中（RULES 已按严重度排序）
        }
      }
    }
    if (files.length > PER_SOURCE_FILES) truncated = true;
  }
  onProgress?.({
    kind: "retro",
    step: SOURCES.length,
    steps: SOURCES.length,
    title: "回溯扫描完成",
    found: hits.length,
  });
  return {
    at: Date.now(),
    scannedFiles,
    sources: sourcesSeen,
    hits,
    truncated,
    durationMs: Date.now() - started,
  };
}
