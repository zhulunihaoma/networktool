import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runProbe } from "../electron/core/probe";
import { evaluate } from "../electron/core/rules";
import { fixture } from "./fixtures";
import type { Evidence } from "../src/shared/types";
const listen = (server: net.Server) =>
  new Promise<number>((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () =>
      res((server.address() as net.AddressInfo).port),
    );
  });
const close = (server: net.Server) =>
  new Promise<void>((res) => server.close(() => res()));
test("受控同流 TLS / HEAD 429、CONNECT / SOCKS5、407、证书拒绝、取消", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "network-lens-tls-"));
  execFileSync(
    process.env.OPENSSL_BIN ||
      (process.platform === "win32" ? "openssl" : "/usr/bin/openssl"),
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      path.join(dir, "key.pem"),
      "-out",
      path.join(dir, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const cert = fs.readFileSync(path.join(dir, "cert.pem"), "utf8"),
    key = fs.readFileSync(path.join(dir, "key.pem"), "utf8");
  let request = "",
    connectionCount = 0;
  const sockets = new Set<net.Socket>();
  const target = tls.createServer({ cert, key }, (socket) => {
    connectionCount++;
    socket.on("error", () => {});
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.once("data", (chunk) => {
      request = chunk.toString();
      socket.end(
        "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 5\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
    });
  });
  const port = await listen(target);
  const environment = { ca: cert, trustProfile: "controlled fixture root" };
  const run = async (
    host: string,
    proxy?: string,
    env: { ca?: string; trustProfile?: string } = environment,
  ) => {
    const result: Evidence[] = [];
    await runProbe(
      fixture({ host, port, proxy }),
      new AbortController().signal,
      (e) => result.push(e),
      env,
    );
    return result;
  };
  await t.test("直连使用同一 TLS 流发送无认证 HEAD，不重新连接", async () => {
    const results = await run("127.0.0.1");
    assert.ok(results.some((e) => e.stage === "http" && e.httpStatus === 429));
    assert.ok(request.startsWith("HEAD / HTTP/1.1"));
    assert.ok(!request.includes("Authorization"));
    assert.equal(connectionCount, 1);
    const tcp = results.find((e) => e.stage === "tcp");
    assert.equal(
      tcp?.attemptId,
      results.find((e) => e.stage === "http")?.attemptId,
    );
    assert.ok(
      evaluate(fixture({ evidence: results })).some((f) => f.ruleId === "R06"),
    );
  });
  const connectProxy = net.createServer((client) => {
    client.on("error", () => {});
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.once("data", (header) => {
      assert.ok(header.toString().startsWith("CONNECT"));
      const upstream = net.connect(port, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection established\r\n\r\n");
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
    });
  });
  const proxyPort = await listen(connectProxy);
  await t.test("CONNECT 复用隧道并正确获取目标 HTTP 状态", async () => {
    const results = await run("localhost", `http://127.0.0.1:${proxyPort}`);
    assert.ok(
      results.some((e) => e.stage === "proxy" && e.status === "success"),
    );
    assert.ok(
      results.some((e) => e.route !== "direct" && e.httpStatus === 429),
    );
  });
  const socks = net.createServer((client) => {
    client.on("error", () => {});
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.once("data", () => {
      client.write(Buffer.from([5, 0]));
      client.once("data", (message) => {
        assert.equal(message[3], 3);
        const upstream = net.connect(port, "127.0.0.1", () => {
          client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 1]));
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.on("error", () => client.destroy());
        client.on("close", () => upstream.destroy());
      });
    });
  });
  const socksPort = await listen(socks);
  await t.test("SOCKS5 远端解析可在本地 DNS 失败后继续", async () => {
    const results = await run(
      "does-not-exist.example.invalid",
      `socks5://127.0.0.1:${socksPort}`,
    );
    assert.ok(results.some((e) => e.stage === "dns" && e.status === "failed"));
    assert.ok(
      results.some((e) => e.stage === "proxy" && e.status === "success"),
    );
    assert.ok(results.some((e) => e.stage === "tls" && e.status === "failed"));
  });
  const authProxy = net.createServer((client) => {
    client.on("error", () => {});
    client.once("data", () =>
      client.end(
        "HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n",
      ),
    );
  });
  const authPort = await listen(authProxy);
  await t.test("407 归属于代理握手，不归属于目标 HTTP", async () => {
    const results = await run(
      "local-test.invalid",
      `http://127.0.0.1:${authPort}`,
    );
    assert.ok(
      results.some(
        (e) => e.stage === "proxy" && e.code === "PROXY_AUTH_REQUIRED",
      ),
    );
    assert.ok(!results.some((e) => e.stage === "http"));
  });
  await t.test("未信任的自签名证书保留失败，绝不自动关闭校验", async () => {
    const results = await run("127.0.0.1", undefined, {});
    assert.ok(results.some((e) => e.stage === "tls" && e.status === "failed"));
    assert.ok(!results.some((e) => e.stage === "http"));
  });
  const hanging = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const hangingPort = await listen(hanging);
  await t.test("取消关闭挂起连接，且不再执行 HTTP", async () => {
    const abort = new AbortController(),
      results: Evidence[] = [];
    const begin = Date.now();
    setTimeout(() => abort.abort(), 100);
    await runProbe(
      fixture({
        host: "127.0.0.2",
        port: hangingPort,
        proxy: `http://127.0.0.1:${hangingPort}`,
      }),
      abort.signal,
      (e) => results.push(e),
    );
    assert.ok(Date.now() - begin < 1500);
    assert.ok(!results.some((e) => e.stage === "http"));
  });
  for (const socket of sockets) socket.destroy();
  await Promise.all(
    [target, connectProxy, socks, authProxy, hanging].map(close),
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
