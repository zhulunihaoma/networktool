import net from "node:net";
import tls from "node:tls";
import dns from "node:dns/promises";
import { randomUUID } from "node:crypto";
import type { Evidence, Session } from "../../src/shared/types";
type Emit = (e: Evidence) => void;
interface ProbeEnvironment {
  ca?: string;
  trustProfile?: string;
}
interface ProbeOptions {
  httpMethod?: "HEAD" | "GET";
  httpPath?: string;
}
const attemptsByHost = new Map<string, number[]>();
const errorCode = (e: unknown) =>
  String(
    (e as { code?: string }).code ||
      ((e as Error).name === "AbortError" ? "CANCELLED" : "PROTOCOL_ERROR"),
  );
function abortError() {
  return Object.assign(new Error("诊断已取消"), { code: "CANCELLED" });
}
function budget<T>(
  promise: Promise<T>,
  ms: number,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => done(Object.assign(new Error("阶段超时"), { code: "ETIMEDOUT" })),
      ms,
    );
    const abort = () => done(abortError());
    const done = (e: unknown, value?: T) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      e ? reject(e) : resolve(value as T);
    };
    if (signal.aborted) {
      done(abortError());
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (v) => done(null, v),
      (e) => done(e),
    );
  });
}
async function connect(host: string, port: number, signal: AbortSignal) {
  const socket = net.connect({ host, port });
  try {
    await budget(
      new Promise<void>((res, rej) => {
        socket.once("connect", res);
        socket.once("error", rej);
      }),
      3000,
      signal,
    );
    return socket;
  } catch (e) {
    socket.destroy();
    throw e;
  }
}
function readUntil(
  socket: net.Socket,
  finish: (buf: Buffer) => number,
  signal: AbortSignal,
  max = 16384,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(
      () =>
        fail(
          Object.assign(new Error("等待协议响应超时"), { code: "ETIMEDOUT" }),
        ),
      5000,
    );
    const clean = () => {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("error", fail);
      socket.removeListener("end", ended);
      signal.removeEventListener("abort", abort);
    };
    const fail = (e: unknown) => {
      clean();
      reject(e);
    };
    const ended = () =>
      fail(Object.assign(new Error("连接提前关闭"), { code: "ECONNRESET" }));
    const abort = () => fail(abortError());
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        const length = finish(buffer);
        if (length > 0 && buffer.length >= length) {
          socket.pause();
          clean();
          if (buffer.length > length) socket.unshift(buffer.subarray(length));
          resolve(buffer.subarray(0, length));
          return;
        }
        if (buffer.length > max)
          fail(
            Object.assign(new Error("协议头超过大小限制"), {
              code: "HEADER_TOO_LARGE",
            }),
          );
      } catch (e) {
        fail(e);
      }
    };
    if (signal.aborted) {
      fail(abortError());
      return;
    }
    socket.on("data", onData);
    socket.once("error", fail);
    socket.once("end", ended);
    signal.addEventListener("abort", abort, { once: true });
    socket.resume();
  });
}
const headerLength = (b: Buffer) => {
  const i = b.indexOf("\r\n\r\n");
  return i < 0 ? 0 : i + 4;
};
async function tunnel(
  socket: net.Socket,
  proxy: URL,
  host: string,
  port: number,
  signal: AbortSignal,
) {
  if (proxy.protocol === "http:") {
    const authority = `${net.isIP(host) === 6 ? `[${host}]` : host}:${port}`;
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    const header = (await readUntil(socket, headerLength, signal)).toString(
      "latin1",
    );
    const status = Number(header.match(/^HTTP\/1\.[01] (\d{3})/)?.[1]);
    if (status < 200 || status >= 300 || !status)
      throw Object.assign(
        new Error(
          status === 407
            ? "代理要求认证；首版不支持代理凭据"
            : `代理 CONNECT 返回 ${status || "无效响应"}`,
        ),
        {
          code: status === 407 ? "PROXY_AUTH_REQUIRED" : "PROXY_CONNECT_FAILED",
        },
      );
    return `HTTP CONNECT ${status}`;
  }
  socket.write(Buffer.from([5, 1, 0]));
  const greeting = await readUntil(socket, () => 2, signal);
  if (greeting[0] !== 5 || greeting[1] !== 0)
    throw Object.assign(new Error("SOCKS5 不支持所选认证方式或返回无效版本"), {
      code: "UNSUPPORTED_AUTH",
    });
  const hostBytes = Buffer.from(host);
  if (hostBytes.length > 255) throw new Error("SOCKS5 主机名过长");
  // A domain address delegates target resolution to the SOCKS server (including literal IP strings).
  socket.write(
    Buffer.concat([
      Buffer.from([5, 1, 0, 3, hostBytes.length]),
      hostBytes,
      Buffer.from([port >> 8, port & 255]),
    ]),
  );
  const reply = await readUntil(
    socket,
    (b) => {
      if (b.length < 5) return 0;
      if (b[3] === 1) return 10;
      if (b[3] === 4) return 22;
      if (b[3] === 3) return 7 + b[4];
      throw new Error("SOCKS5 地址类型无效");
    },
    signal,
  );
  if (reply[0] !== 5 || reply[1] !== 0 || reply[2] !== 0)
    throw Object.assign(new Error(`SOCKS5 连接失败，回复码 ${reply[1]}`), {
      code: `SOCKS_REPLY_${reply[1]}`,
    });
  return "SOCKS5 隧道已建立 · 目标由代理解析";
}
async function tlsHttp(
  socket: net.Socket,
  session: Session,
  signal: AbortSignal,
  step: <T>(
    stage: Evidence["stage"],
    fn: () => Promise<T>,
    describe: (value: T) => string,
  ) => Promise<T>,
  environment: ProbeEnvironment,
  options: ProbeOptions = {},
) {
  const secure = tls.connect({
    socket,
    ca: environment.ca,
    servername: net.isIP(session.host) ? undefined : session.host,
    rejectUnauthorized: true,
    ALPNProtocols: ["http/1.1"],
    checkServerIdentity: (_name, cert) =>
      tls.checkServerIdentity(session.host, cert),
  });
  // Probe uses bundled Node roots. Target trust stores can differ.
  try {
    await step(
      "tls",
      () =>
        budget(
          new Promise<string>((res, rej) => {
            secure.once("secureConnect", () =>
              res(
                `${secure.getProtocol()} · ${secure.getCipher().name} · 证书校验通过`,
              ),
            );
            secure.once("error", rej);
          }),
          5000,
          signal,
        ),
      (v) =>
        `${v}；信任配置：${environment.trustProfile || (process.env.NODE_EXTRA_CA_CERTS ? "Node roots + NODE_EXTRA_CA_CERTS" : "Node bundled roots")}；未验证 HTTP/2/3`,
    );
    const host = `${net.isIP(session.host) === 6 ? `[${session.host}]` : session.host}${session.port === 443 ? "" : `:${session.port}`}`;
    const method = options.httpMethod || "HEAD";
    const probePath = options.httpPath || "/";
    const result = await step(
      "http",
      async () => {
        const response = readUntil(secure, headerLength, signal);
        secure.write(
          `${method} ${probePath} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: NetworkLens/0.1\r\nConnection: close\r\n\r\n`,
        );
        const header = (await response).toString("latin1");
        const code = Number(header.match(/^HTTP\/1\.[01] (\d{3})/)?.[1]);
        if (!code)
          throw Object.assign(new Error("HTTP 响应头无效"), {
            code: "HTTP_INVALID",
          });
        return { code, header };
      },
      (v) =>
        `${method} ${probePath} → HTTP ${v.code}；不携带 Cookie 或授权头；${v.code >= 300 && v.code < 400 ? "仅报告重定向，不跟随新目标；" : ""}${v.header.match(/^retry-after:\s*(.+)$/im)?.[0] || ""}`,
    );
    return result.code;
  } finally {
    secure.destroy();
  }
}
export async function runProbe(
  session: Session,
  signal: AbortSignal,
  emit: Emit,
  environment: ProbeEnvironment = {},
  options: ProbeOptions = {},
) {
  const start = Date.now();
  const routes = session.proxy ? ["direct", session.proxy] : ["direct"];
  let addresses: { address: string; family: number }[] = [];
  const emitResult = (
    e: Omit<Evidence, "id" | "time" | "source" | "executor">,
  ) =>
    emit({
      ...e,
      id: `E-${randomUUID().slice(0, 8)}`,
      time: Date.now(),
      source: `Node ${process.versions.node} · layered probe`,
      executor: "diagnostic_probe",
    });
  try {
    const before = Date.now();
    addresses = await budget(
      dns.lookup(session.host, { all: true }),
      3000,
      signal,
    );
    if (!addresses.length)
      throw Object.assign(new Error("没有获得 A / AAAA 地址"), {
        code: "ENODATA",
      });
    emitResult({
      stage: "dns",
      route: "direct",
      status: "success",
      title: "系统解析成功",
      detail: addresses
        .map((a) => `${a.family === 6 ? "IPv6" : "IPv4"} ${a.address}`)
        .join("\n"),
      duration: Date.now() - before,
    });
  } catch (e) {
    if (signal.aborted) return;
    emitResult({
      stage: "dns",
      route: "direct",
      status: "failed",
      title: "系统解析失败",
      detail: (e as Error).message,
      code: errorCode(e),
    });
  }
  for (const route of routes) {
    if (signal.aborted || Date.now() - start > 30000) return;
    const proxy = route === "direct" ? undefined : new URL(route);
    const candidates = proxy
      ? [{ address: proxy.hostname.replace(/^\[|\]$/g, ""), family: 0 }]
      : [
          addresses.find((a) => a.family === 4),
          addresses.find((a) => a.family === 6),
        ].filter((a): a is { address: string; family: number } => !!a);
    if (!candidates.length) {
      emitResult({
        stage: "tcp",
        route,
        status: "skipped",
        title: "未执行 TCP 探测",
        detail: "没有可用的直连解析结果。",
      });
      continue;
    }
    for (const addr of candidates) {
      if (signal.aborted) return;
      const attemptId = randomUUID();
      let socket: net.Socket | undefined;
      const recent = (attemptsByHost.get(session.host) || []).filter(
        (t) => Date.now() - t < 60000,
      );
      attemptsByHost.set(session.host, recent);
      if (recent.length >= 6) {
        emitResult({
          stage: "tcp",
          route,
          status: "skipped",
          title: "已达到目标探测频率上限",
          detail: "每个主机每分钟最多 6 次连接尝试，请稍后复测。",
          code: "RATE_LIMIT_LOCAL",
        });
        return;
      }
      recent.push(Date.now());
      const step = async <T>(
        stage: Evidence["stage"],
        fn: () => Promise<T>,
        describe: (value: T) => string,
      ): Promise<T> => {
        const before = Date.now();
        try {
          const value = await fn();
          const detail = describe(value);
          emitResult({
            stage,
            route,
            attemptId,
            family: addr.family,
            status: "success",
            title: `${stage.toUpperCase()} 阶段完成`,
            detail,
            duration: Date.now() - before,
            httpStatus:
              stage === "http" ? (value as { code: number }).code : undefined,
          });
          return value;
        } catch (e) {
          if (!signal.aborted)
            emitResult({
              stage,
              route,
              attemptId,
              family: addr.family,
              status: "failed",
              title: `${stage.toUpperCase()} 阶段失败`,
              detail: (e as Error).message,
              code: errorCode(e),
              duration: Date.now() - before,
            });
          throw e;
        }
      };
      const abort = () => socket?.destroy();
      signal.addEventListener("abort", abort, { once: true });
      try {
        socket = await step(
          "tcp",
          () =>
            connect(
              addr.address,
              proxy ? Number(proxy.port) : session.port,
              signal,
            ),
          (s) =>
            `${s.localAddress}:${s.localPort} → ${s.remoteAddress}:${s.remotePort}`,
        );
        if (proxy)
          await step(
            "proxy",
            () => tunnel(socket!, proxy, session.host, session.port, signal),
            (v) => v,
          );
        await tlsHttp(socket, session, signal, step, environment, options);
      } catch {
        /* failure evidence already emitted */
      } finally {
        signal.removeEventListener("abort", abort);
        socket?.destroy();
      }
    }
  }
}
