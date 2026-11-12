import fs from "node:fs/promises";
import path from "node:path";
import { sanitizer } from "../../src/shared/handoff";

/** Remove JSON comments and trailing commas without damaging quoted URLs. */
export function parseJsonc(text: string): any {
  let out = "",
    quoted = false,
    escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i],
      next = text[i + 1];
    if (quoted) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') {
      quoted = true;
      out += c;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      if (i >= text.length) throw new Error("JSON 注释没有结束");
      i++;
      out += " ";
    } else if (c === ",") {
      let j = i + 1;
      while (/\s/.test(text[j] ?? "") && j < text.length) j++;
      if (text[j] !== "}" && text[j] !== "]") out += c;
    } else out += c;
  }
  return JSON.parse(out);
}

/** TOML sections and common scalar/array values used by Codex; never execute input. */
export function tomlSections(
  text: string,
): { name: string; values: Record<string, unknown> }[] {
  const rows: { name: string; values: Record<string, unknown> }[] = [
    { name: "", values: {} },
  ];
  let current = rows[0];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const header = line.match(/^\[([^\]]+)\]\s*(?:#.*)?$/);
    if (header) {
      current = { name: header[1], values: {} };
      rows.push(current);
      continue;
    }
    const m = line.match(/^([\w-]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let raw = m[2];
    if (raw.startsWith("[") && !raw.includes("]")) {
      while (++i < lines.length) {
        raw += "\n" + lines[i];
        if (lines[i].includes("]")) break;
      }
    }
    try {
      current.values[m[1]] = parseJsonc(raw.replace(/\s+#.*$/gm, ""));
    } catch {
      const single = raw.match(/^'([^']*)'\s*(?:#.*)?$/);
      if (single) current.values[m[1]] = single[1];
      else if (
        current.name.startsWith("mcp_servers.") &&
        ["command", "args", "url"].includes(m[1])
      )
        throw new Error("MCP TOML 字段无法解析");
    }
  }
  return rows;
}

export async function readConfig(
  home: string,
  relative: string,
): Promise<string | undefined> {
  const file = path.resolve(home, relative);
  try {
    const stat = await fs.lstat(file);
    const real = await fs.realpath(file),
      root = await fs.realpath(home);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      !real.startsWith(root + path.sep) ||
      stat.size > 2_000_000
    )
      throw new Error("配置不是安全的普通文件，或超过 2MB");
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`无法完整读取 ${relative}，未更新巡检基线。`);
  }
}
export const secretField =
  /(?:api.?key|token|secret|password|authorization|cookie|credential)/i;
export function safeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()])
      if (secretField.test(key)) url.searchParams.set(key, "[已脱敏]");
    url.hash = "";
    return sanitizer().clean(url.toString());
  } catch {
    return sanitizer().clean(raw);
  }
}
export function redactConfig(value: unknown, key = ""): any {
  if (secretField.test(key) && value != null) return "[已脱敏]";
  if (typeof value === "string")
    return sanitizer()
      .clean(value)
      .replace(
        /(--(?:api[-_]key|token|password|secret)\s+)(?:"[^"]*"|'[^']*'|\S+)/gi,
        "$1[已脱敏]",
      )
      .replace(/https?:\/\/[^\s"'<>]+/g, safeUrl);
  if (Array.isArray(value))
    return value.map((v, i) =>
      typeof v === "string" &&
      i > 0 &&
      typeof value[i - 1] === "string" &&
      secretField.test(value[i - 1])
        ? "[已脱敏]"
        : redactConfig(v),
    );
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redactConfig(v, k)]),
    );
  return value;
}
