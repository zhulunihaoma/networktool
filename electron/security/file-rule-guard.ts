import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  extractReadPaths,
  extractWritePaths,
  type GuardInput,
  type GuardDecision,
} from "./guard-protocol";
interface Entry {
  path: string;
  identity: string;
  read: string;
  write: string;
  delete: string;
  revision: number;
  stale?: boolean;
}
/** This adapter restricts only the paths actually exposed by the hook payload. */
export function decideFileRules(
  dataDir: string,
  input: GuardInput,
): GuardDecision | undefined {
  const file = path.join(dataDir, "file-policy-snapshot.json");
  const deny = (reason: string): GuardDecision => ({
    decision: "deny",
    ruleId: "file_policy",
    operation: input.toolName || "file",
    reason,
  });
  try {
    fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      return deny("无法检查文件策略快照，请修复防护。");
    try {
      fs.lstatSync(path.join(dataDir, "file-policy-required"));
      return deny("文件策略快照缺失，已暂停钩子操作；请打开文件策略重新下发。");
    } catch (markerError) {
      return (markerError as NodeJS.ErrnoException).code === "ENOENT"
        ? undefined
        : deny("无法检查文件策略状态，请修复防护。");
    }
  }
  let entries: Entry[];
  try {
    if (fs.statSync(file).size > 2_000_000)
      return deny("文件策略快照超出预算，已拒绝本次操作，请修复防护。");
    const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
    if (snapshot.version !== 1 || !Array.isArray(snapshot.entries))
      return deny("文件策略快照无效，请重新下发。");
    entries = snapshot.entries;
    if (
      entries.some(
        (e) =>
          !e ||
          !path.isAbsolute(e.path) ||
          typeof e.identity !== "string" ||
          !["read", "write", "delete"].every((op) =>
            ["allow", "ask", "deny"].includes(e[op as keyof Entry] as string),
          ),
      )
    )
      return deny("文件策略快照字段无效，请重新下发。");
  } catch {
    return deny("文件策略快照无法读取，已拒绝本次操作，请重新下发。");
  }
  const canonical = (p: string) => {
    p = p.replace(/^~(?=[/\\]|$)/, os.homedir());
    const absolute = path.resolve(input.project || process.cwd(), p);
    try {
      return fs.realpathSync(absolute);
    } catch {
      return absolute;
    }
  };
  const command = input.command || "";
  const deleting =
    /\b(?:rm|unlink|Remove-Item)\b/i.test(command) ||
    /delete|unlink/i.test(input.toolName || "") ||
    /\*\*\* Delete File:/.test(command);
  const reads = [...(input.readPaths || []), ...extractReadPaths(command)];
  const writes = [...(input.paths || []), ...extractWritePaths(command)];
  for (const [op, targets] of [
    ["read", reads],
    [deleting ? "delete" : "write", writes],
  ] as const) {
    for (const target of targets) {
      const resolved = canonical(target);
      const absolute = path.resolve(
        input.project || process.cwd(),
        target.replace(/^~(?=[/\\]|$)/, os.homedir()),
      );
      let parent = path.dirname(absolute);
      const tail = [path.basename(absolute)];
      // Canonicalize existing ancestors without following the final component.
      // This preserves matching for missing files and final-component symlinks.
      while (true) {
        try {
          parent = fs.realpathSync(parent);
          break;
        } catch {
          const next = path.dirname(parent);
          if (next === parent) break;
          tail.unshift(path.basename(parent));
          parent = next;
        }
      }
      const lexical = path.join(parent, ...tail);
      for (const entry of entries) {
        // Directory reads (e.g. grep) can include any protected descendant.
        let sameObject = false;
        try {
          const a = fs.statSync(resolved),
            b = fs.statSync(entry.path);
          sameObject = a.dev === b.dev && a.ino === b.ino;
        } catch {}
        if (
          resolved !== entry.path &&
          lexical !== entry.path &&
          !entry.path.startsWith(resolved + path.sep) &&
          !entry.path.startsWith(lexical + path.sep) &&
          !sameObject
        )
          continue;
        if (entry.stale)
          return deny(
            "受保护文件已变化或未发现；原规则仍在，请重新确认文件版本。",
          );
        try {
          const stat = fs.statSync(entry.path);
          const current = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.mtimeMs}:${stat.size}`;
          if (current !== entry.identity || stat.nlink !== 1)
            return deny(
              "受保护文件版本已变化，请重新扫描并确认；旧规则不会静默放行。",
            );
        } catch {
          return deny("受保护对象已消失或不可访问，请重新扫描确认。");
        }
        if (entry[op] !== "allow")
          return deny(
            `命中文件策略 v${entry.revision}：${op === "read" ? "读取" : op === "delete" ? "删除" : "修改"}${entry[op] === "ask" ? "需要单独确认，当前先阻断；页面临时授权仅用于本地文本任务，不授权此工具" : "被禁止"}。`,
          );
      }
    }
  }
}
