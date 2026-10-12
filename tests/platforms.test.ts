import { test } from "node:test";
import assert from "node:assert/strict";
import { AI_PLATFORMS, platformHelpText } from "../src/shared/platforms";
import {
  classifyPlatform,
  detectRunningApps,
  PlatformDoctor,
} from "../electron/core/platforms";
import type {
  Evidence,
  PlatformResult,
  PlatformScan,
  ProcessInfo,
} from "../src/shared/types";
const sample = (overrides: Partial<Evidence> = {}): Evidence => ({
  id: "E-test",
  time: 0,
  stage: "http",
  route: "system",
  status: "success",
  title: "test",
  detail: "test",
  executor: "diagnostic_probe",
  source: "Chromium · system network",
  ...overrides,
});
const classified = (status: number) =>
  classifyPlatform(
    "chatgpt",
    [sample({ httpStatus: status })],
    "系统网络",
    status,
  );
test("平台目录固定 HTTPS 根入口、唯一 ID、国内海外和办公工具均覆盖", () => {
  assert.equal(AI_PLATFORMS.length, 14);
  assert.equal(new Set(AI_PLATFORMS.map((p) => p.id)).size, 14);
  for (const platform of AI_PLATFORMS) {
    const url = new URL(platform.url);
    assert.equal(url.protocol, "https:");
    assert.equal(url.pathname, "/");
    assert.equal(url.search, "");
  }
  assert.equal(AI_PLATFORMS.filter((p) => p.region === "国内").length, 7);
  assert.ok(AI_PLATFORMS.some((p) => p.name === "WPS AI"));
});
test("200 和重定向只代表入口有响应，401 不推断用户登录失效", () => {
  for (const status of [200, 204, 301, 302])
    assert.equal(classified(status).status, "reachable");
  assert.match(classified(200).suggestion, /不验证 AI 对话/);
  assert.equal(classified(401).status, "auth_required");
  assert.match(classified(401).suggestion, /不能判断账号是否失效/);
});
test("403 与 451 为访问限制，不误报断网或登录问题；429、503不推断全球故障", () => {
  for (const status of [403, 451])
    assert.equal(classified(status).status, "restricted");
  for (const status of [429, 503]) {
    assert.equal(classified(status).status, "busy");
    assert.match(classified(status).suggestion, /不能证明平台全球故障/);
  }
  assert.equal(classified(0).status, "check_failed");
  for (const status of [404, 405])
    assert.equal(classified(status).status, "reachable");
});
test("名称解析、证书和代理异常给出办公用户建议，缺失证据不冒充通过", () => {
  for (const [code, text] of [
    ["ERR_NAME_NOT_RESOLVED", "解析"],
    ["ERR_CERT_AUTHORITY_INVALID", "安全连接"],
    ["ERR_PROXY_CONNECTION_FAILED", "代理"],
  ]) {
    const result = classifyPlatform(
      "claude",
      [sample({ status: "failed", code })],
      "系统网络",
    );
    assert.equal(result.status, "network_error");
    assert.ok(result.summary.includes(text));
  }
  assert.equal(
    classifyPlatform("claude", [], "系统网络").status,
    "check_failed",
  );
  const mixed = classifyPlatform(
    "claude",
    [
      sample({ status: "failed", code: "ERR_TIMED_OUT" }),
      sample({ source: "Node · layered probe", httpStatus: 200 }),
    ],
    "系统网络",
  );
  assert.equal(mixed.status, "reachable");
  assert.deepEqual(
    mixed.paths?.map(({ label, status }) => [label, status]),
    [
      ["系统路径", "unreachable"],
      ["代理路径", "accessible"],
    ],
  );
});
test("进程名称边界识别客户端，不将浏览器或包含单词的其他进程归因", () => {
  const platform = AI_PLATFORMS.find((p) => p.id === "claude")!;
  const names = [
    "/Applications/Claude.app/Contents/MacOS/Claude",
    "Claude Helper (Renderer)",
    "C:\\Apps\\Claude.exe",
    "Google Chrome",
    "ClaudeNotes",
    "my-claude",
  ];
  const processes = names.map((name, i) => ({
    key: String(i),
    pid: i,
    ppid: 1,
    name,
    created: "",
    relation: "root",
  })) as ProcessInfo[];
  assert.equal(detectRunningApps(platform, processes).length, 3);
});
test("给 IT 的反馈不包含原始证据自由文本、进程路径或代理端点", () => {
  const result = classifyPlatform(
    "chatgpt",
    [
      sample({
        detail: "/Users/person 10.0.0.1 credential-secret",
        code: "ERR_TIMED_OUT",
        status: "failed",
      }),
    ],
    "系统网络（检测到代理）",
  );
  result.runningApps = ["/Users/person/Claude"];
  const text = platformHelpText(
    { id: "test", status: "completed", results: [result] },
    result,
  );
  for (const secret of ["/Users/person", "10.0.0.1", "credential-secret"])
    assert.ok(!text.includes(secret));
  assert.match(text, /ERR_TIMED_OUT/);
  assert.match(text, /未验证账号/);
});
test("扫描最多并发四个目标，停止后不发布迟到结果，单平台复测受限", async () => {
  const pending: Array<() => void> = [];
  let running = 0,
    max = 0;
  let completed!: () => void;
  const finished = new Promise<void>((resolve) => (completed = resolve));
  const updates: PlatformScan[] = [];
  const doctor = new PlatformDoctor(
    {
      processes: async () => [],
      probe: async (platform) => {
        running++;
        max = Math.max(max, running);
        await new Promise<void>((resolve) => pending.push(resolve));
        running--;
        return classifyPlatform(
          platform.id,
          [sample({ httpStatus: 200 })],
          "系统网络",
          200,
        );
      },
    },
    (scan) => {
      updates.push(scan);
      if (scan.status === "completed") completed();
    },
  );
  const initial = doctor.start();
  assert.equal(initial.status, "running");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(running, 4);
  assert.equal(doctor.start().id, initial.id);
  while (doctor.current().status === "running") {
    pending.splice(0).forEach((resolve) => resolve());
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await finished;
  assert.equal(max, 4);
  assert.equal(
    doctor.current().results.filter((r) => r.status === "reachable").length,
    14,
  );
  assert.throws(() => doctor.start("not-a-platform"));
  assert.throws(() => doctor.start("chatgpt"), /30 秒/);
  const stopped = new PlatformDoctor(
    {
      processes: async () => [],
      probe: async (platform) => {
        await new Promise<void>((resolve) => pending.push(resolve));
        return classified(200);
      },
    },
    () => {},
  );
  stopped.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  stopped.stop();
  pending.splice(0).forEach((resolve) => resolve());
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopped.current().status, "cancelled");
  assert.ok(stopped.current().results.every((r) => r.status === "cancelled"));
});
test("读取进程失败不会阻断平台入口检查", async () => {
  let done!: () => void;
  const completed = new Promise<void>((resolve) => (done = resolve));
  const doctor = new PlatformDoctor(
    {
      processes: async () => {
        throw new Error("permission");
      },
      probe: async (p) => classified(200),
    },
    (scan) => {
      if (scan.status === "completed") done();
    },
  );
  doctor.start("chatgpt");
  await completed;
  assert.match(
    doctor.current().detectionError!,
    /平台入口(?:检查|测试)仍可继续/,
  );
});
