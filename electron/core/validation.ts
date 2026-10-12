import { z } from "zod";
import net from "node:net";
export const startSchema = z
  .object({
    name: z.string().trim().max(100),
    target: z.string().trim().min(1).max(2048),
    duration: z.number().int().min(10).max(300),
    processKey: z.string().max(300).optional(),
    scopeKeys: z.array(z.string().max(300)).max(100),
    proxy: z.string().trim().max(512).optional(),
    mode: z.enum(["diagnose", "compare"]),
    clientRequestId: z.string().min(8).max(100),
    tool: z
      .object({
        installId: z.string().uuid(),
        componentId: z.string().uuid(),
        feature: z.enum(["login", "model", "update", "mcp", "other"]),
      })
      .strict()
      .optional(),
  })
  .strict();
export const settingsSchema = z
  .object({
    retentionDays: z.union([z.literal(1), z.literal(7), z.literal(30)]),
    redact: z.boolean(),
  })
  .strict();
export function normalizeTarget(input: string) {
  if (/[\x00-\x20\x7f\\]/.test(input) || input.length > 2048)
    throw new Error("目标包含非法字符。请输入域名或 HTTPS URL。");
  let url: URL;
  try {
    url = new URL(input.includes("://") ? input : `https://${input}`);
  } catch {
    throw new Error("目标格式无效，请输入域名或 HTTPS URL。");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !url.hostname
  )
    throw new Error("仅支持不含账号和密码的 HTTPS 目标。");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    host.length > 253 ||
    (!net.isIP(host) &&
      !/^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_.-]*[a-z0-9_])?$/i.test(host))
  )
    throw new Error("目标主机名无效。");
  const port = Number(url.port || 443);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("端口需要在 1–65535 之间。");
  return {
    host,
    port,
    target: `https://${net.isIP(host) === 6 ? `[${host}]` : host}${port === 443 ? "" : `:${port}`}/`,
  };
}
export function normalizeProxy(input?: string) {
  if (!input) return undefined;
  if (/[\x00-\x20\x7f]/.test(input)) throw new Error("代理地址包含非法字符。");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(
      "代理格式应为 http://127.0.0.1:7897 或 socks5://127.0.0.1:1080。",
    );
  }
  if (
    !["http:", "socks5:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.pathname && url.pathname !== "/") ||
    url.search ||
    url.hash ||
    !url.port
  )
    throw new Error("代理仅支持带端口、无认证的 HTTP CONNECT 或 SOCKS5。");
  return `${url.protocol}//${url.host}`;
}
