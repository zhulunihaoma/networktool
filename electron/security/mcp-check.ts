import { parseJsonc, redactConfig, secretField } from "./config-read";
import type { McpCheckReport, RiskLevel } from "../../src/shared/security";
export function checkMcpConfig(text: string): McpCheckReport {
  const root = parseJsonc(text);
  if (!root || typeof root !== "object" || Array.isArray(root))
    throw new Error("请提供 MCP JSON 配置对象。");
  const servers = root.mcpServers ?? root.mcp;
  if (!servers || typeof servers !== "object" || Array.isArray(servers))
    throw new Error("配置中没有 mcpServers 或 mcp 对象。");
  const findings: McpCheckReport["findings"] = [];
  const add = (level: RiskLevel, title: string, detail: string) =>
    findings.push({ level, title, detail });
  const scan = (value: any, prefix: string, depth: number) => {
    if (!value || typeof value !== "object" || depth > 10) return;
    for (const [k, v] of Object.entries(value)) {
      if (
        secretField.test(k) &&
        typeof v === "string" &&
        v &&
        !/^\$|^\{env:/.test(v)
      )
        add(
          "medium",
          "配置中含明文凭据",
          `${prefix}${k} 的值已隐藏，请优先使用环境变量引用。`,
        );
      else if (v && typeof v === "object") scan(v, `${prefix}${k}.`, depth + 1);
    }
  };
  scan(servers, "", 0);
  const summary: McpCheckReport["servers"] = [];
  const clean = redactConfig(root);
  const cleanedServers = clean.mcpServers ?? clean.mcp;
  for (const [name, value] of Object.entries(servers)) {
    const server = value as any;
    if (!server || typeof server !== "object") {
      add("medium", "MCP 定义无效", `服务器 ${name} 需要配置对象。`);
      continue;
    }
    if (
      server.args !== undefined &&
      (!Array.isArray(server.args) ||
        server.args.some((arg: unknown) => typeof arg !== "string"))
    )
      throw new Error(`${name} 的 args 必须是字符串数组。`);
    if (
      server.command !== undefined &&
      typeof server.command !== "string" &&
      !Array.isArray(server.command)
    )
      throw new Error(`${name} 的 command 类型无效。`);
    const cmd = Array.isArray(server.command)
      ? server.command.join(" ")
      : [server.command ?? "", ...(server.args ?? [])].join(" ");
    const shown = cleanedServers[name];
    summary.push({
      name,
      command: shown.command
        ? JSON.stringify(shown.command) +
          (shown.args ? " " + JSON.stringify(shown.args) : "")
        : undefined,
      url: shown.url,
    });
    if (
      /(curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:bash|sh|zsh)\b|\beval\b/.test(cmd)
    )
      add(
        "high",
        "启动命令会执行下载内容",
        `${name}：应先检查脚本来源与内容。`,
      );
    if (/\bnpx\b/.test(cmd) && !/\S+@(?:\d[\w.-]*|[a-f0-9]{7,})\b/.test(cmd))
      add(
        "medium",
        "启动依赖未固定版本",
        `${name} 使用 npx，请固定到可信版本。`,
      );
    if (/\buvx\b/.test(cmd) && !/==[\w.]+|git\+\S+@[\w.-]+/.test(cmd))
      add(
        "medium",
        "启动依赖未固定版本",
        `${name} 使用 uvx，请固定版本或提交。`,
      );
    if (
      typeof server.url === "string" &&
      server.url.startsWith("http://") &&
      !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/.test(server.url)
    )
      add(
        "medium",
        "远程连接未加密",
        `${name} 使用 HTTP，请确认服务来源并优先使用 HTTPS。`,
      );
    if (!server.url && !server.command)
      add("medium", "缺少启动方式", `${name} 没有 command 或 url。`);
  }
  const level = findings.some((f) => f.level === "high")
    ? "high"
    : findings.some((f) => f.level === "medium")
      ? "medium"
      : "none";
  return {
    level,
    findings,
    servers: summary,
    redactedConfig: JSON.stringify(clean, null, 2),
  };
}
