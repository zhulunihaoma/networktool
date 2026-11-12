import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Forwarder, type ForwardRecord } from "../electron/security/forward";
import {
  decide,
  defaultPolicy,
  logDecision,
  summarizePayload,
} from "../electron/security/guard-protocol";
import { timeline } from "../electron/security/timeline";
import type { ForwardSettings } from "../src/shared/security";

const policy = defaultPolicy();
const write = (dir: string, command: string) => {
  const input = summarizePayload(
    { tool_name: "Bash", tool_input: { command } },
    "codex",
  );
  return logDecision(dir, decide(input, policy), input, { source: "real_allow" });
};

/** Minimal SIEM stand-in: records every batch it accepts. */
const startReceiver = async (fail = false) => {
  const batches: { schema: string; records: ForwardRecord[] }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      if (fail) {
        res.writeHead(500).end();
        return;
      }
      batches.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(202).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    batches,
    url: `http://127.0.0.1:${port}/ingest`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

const httpSettings = (url: string): ForwardSettings => ({
  enabled: true,
  targets: [{ id: "t1", enabled: true, kind: "http", url }],
});

test("只发送新增记录，重启后不重复", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nl-forward-"));
  const receiver = await startReceiver();
  try {
    write(dir, "ls");
    const first = await new Forwarder({ dataDir: dir }).flush(
      httpSettings(receiver.url),
    );
    assert.equal(first.sent, 1);

    // 新的 Forwarder 实例模拟应用重启：状态从磁盘恢复。
    const again = await new Forwarder({ dataDir: dir }).flush(
      httpSettings(receiver.url),
    );
    assert.equal(again.sent, 0);

    write(dir, "git status");
    const third = await new Forwarder({ dataDir: dir }).flush(
      httpSettings(receiver.url),
    );
    assert.equal(third.sent, 1);
    assert.equal(
      receiver.batches.flatMap((b) => b.records).length,
      2,
    );
    assert.equal(receiver.batches[0].schema, "ai-guard.batch/v1");
    assert.equal(receiver.batches[0].records[0].schema, "ai-guard.event/v1");
  } finally {
    await receiver.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("平台报错时保留待发送并在下次重试", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nl-forward-"));
  const failing = await startReceiver(true);
  const healthy = await startReceiver();
  try {
    write(dir, "npm test");
    const failed = await new Forwarder({ dataDir: dir }).flush(
      httpSettings(failing.url),
    );
    assert.equal(failed.sent, 0);
    assert.match(failed.error ?? "", /平台返回 500/);

    // 状态文件记录了错误，但没有推进 offset，因此重试能发出同一条记录。
    const forwarder = new Forwarder({ dataDir: dir });
    assert.match(forwarder.stats().lastError ?? "", /500/);
    const retried = await forwarder.flush(httpSettings(healthy.url));
    assert.equal(retried.sent, 1);
    assert.equal(healthy.batches[0].records.length, 1);
  } finally {
    await failing.close();
    await healthy.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("外送不改变本地记录和哈希链", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nl-forward-"));
  const receiver = await startReceiver();
  try {
    write(dir, "ls");
    write(dir, "cat .env");
    const before = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8");
    await new Forwarder({ dataDir: dir }).flush(httpSettings(receiver.url));
    const after = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8");
    assert.equal(before, after);
    assert.equal(timeline(dir, { limit: 10 }).chain.status, "ok");
  } finally {
    await receiver.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("未开启外送时不做任何网络请求", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nl-forward-"));
  const receiver = await startReceiver();
  try {
    write(dir, "ls");
    const sent = await new Forwarder({ dataDir: dir }).flush({
      enabled: false,
      targets: [{ id: "t", enabled: true, kind: "http", url: receiver.url }],
    });
    assert.equal(sent.sent, 0);
    assert.equal(receiver.batches.length, 0);
  } finally {
    await receiver.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("可以导出 NDJSON 给平台直接导入", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nl-forward-"));
  try {
    write(dir, "ls");
    write(dir, "git status");
    const file = new Forwarder({ dataDir: dir }).exportNdjson();
    assert.equal(file.rows, 2);
    const rows = fs
      .readFileSync(file.path, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].facts.level, "L2", "ls 读取目录属于文件资源访问");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
