import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ToolRegistry } from "../electron/core/tool-registry";
import { FilePolicies, scanCandidates } from "../electron/core/file-policies";
import { sortTools, type ToolInstall } from "../src/shared/assistant";
import { Store } from "../electron/core/store";
import { NETWORK_GUIDANCE, repairEligibility } from "../src/shared/adapters";
function memoryStore() {
  const data = new Map<string, unknown>();
  return {
    assistant<T>(name: string, fallback: T): T {
      return structuredClone((data.get(name) as T) || fallback);
    },
    putAssistant(name: string, value: unknown) {
      data.set(name, structuredClone(value));
    },
  };
}
const tool = (id: string, props: Partial<ToolInstall> = {}): ToolInstall => ({
  id,
  productId: id,
  name: id,
  identityStatus: "installed_confirmed",
  location: id,
  sources: [],
  components: [],
  processKeys: [],
  lastSeen: 0,
  pinned: false,
  ...props,
});
test("已安装优先，置顶不被问题排序挤走，名称候选不提升为安装确认", () => {
  const list = [
    tool("candidate", { identityStatus: "candidate", pinned: true }),
    tool("running", { processKeys: ["key"] }),
    tool("issue"),
    tool("pin", { pinned: true }),
  ];
  assert.deepEqual(
    sortTools(list, ["issue"]).map((t) => t.id),
    ["pin", "issue", "running", "candidate"],
  );
});
test("官方资料不替代版本实测，适配草案和未知版本均不能启用修复", () => {
  for (const profile of NETWORK_GUIDANCE) {
    assert.equal(profile.releaseState, "draft");
    assert.equal(repairEligibility(profile.productId).allowed, false);
    assert.equal(
      repairEligibility(profile.productId, "999.0.0").allowed,
      false,
    );
    assert.ok(profile.source.url.startsWith("https://"));
  }
});
test("工具诊断引用只解析真实记录；未知组件与消失实例不能伪造冻结上下文", async () => {
  const registry = new ToolRegistry(
    memoryStore(),
    async () => [
      {
        pid: 3,
        ppid: 0,
        name: "codex",
        imagePath: "/verified/codex",
        key: "b:3:time",
        created: "time",
        relation: "candidate",
      },
    ],
    async () => ({
      tools: [
        {
          productId: "codex",
          location: "/verified/codex",
          executable: "/verified/codex",
          version: "1.0",
          role: "cli",
          source: "fixture",
          confirmed: true,
        },
      ],
      limitations: [],
    }),
  );
  const snapshot = await registry.scan(),
    selected = snapshot.installs[0];
  assert.equal(selected.identityStatus, "running_confirmed");
  assert.deepEqual(selected.processKeys, ["b:3:time"]);
  const context = registry.diagnosisContext({
    installId: selected.id,
    componentId: selected.components[0].id,
    feature: "model",
  });
  assert.equal(context.version, "1.0");
  assert.equal(context.adapterStatus, "unknown");
  assert.ok(!JSON.stringify(context).includes("/verified"));
  assert.throws(
    () =>
      registry.diagnosisContext({
        installId: selected.id,
        componentId: randomUUID(),
        feature: "model",
      }),
    /失效/,
  );
});
test("安装版本更新复用 ID，多安装保持独立，通用 node 不归属工具，消失保留历史", async () => {
  let version = "1.0",
    present = true;
  const registry = new ToolRegistry(
    memoryStore(),
    async () => [
      {
        pid: 1,
        ppid: 0,
        name: "node",
        key: "b:1:time",
        created: "time",
        relation: "candidate",
      },
    ],
    async () => ({
      tools: present
        ? [
            {
              productId: "codex",
              location: "/verified/codex",
              version,
              role: "cli",
              source: "fixture",
              confirmed: true,
            },
            {
              productId: "codex",
              location: "/other/codex",
              role: "cli",
              source: "fixture",
              confirmed: false,
            },
          ]
        : [],
      limitations: [],
    }),
  );
  const first = await registry.scan();
  assert.equal(first.installs.length, 2);
  assert.equal(first.installs[0].identityStatus, "installed_confirmed");
  assert.equal(first.installs[1].identityStatus, "candidate");
  assert.ok(
    first.installs.every(
      (i) =>
        !i.processKeys.length && i.components[0].adapterStatus === "unknown",
    ),
  );
  await registry.pin(first.installs[0].id, true);
  version = "2.0";
  const second = await registry.scan();
  assert.equal(second.installs[0].id, first.installs[0].id);
  assert.equal(second.installs[0].version, "2.0");
  assert.equal(second.installs[0].pinned, true);
  present = false;
  assert.ok(
    (await registry.scan()).installs.every((i) => i.identityStatus === "stale"),
  );
});
test("重复发现请求复用一次扫描，扫描时不接受置顶或冻结诊断范围", async () => {
  let release!: () => void,
    calls = 0;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const registry = new ToolRegistry(
    memoryStore(),
    async () => [],
    async () => {
      calls++;
      await ready;
      return { tools: [], limitations: [] };
    },
  );
  const first = registry.scan(),
    second = registry.scan();
  assert.equal(calls, 1);
  assert.equal(registry.current().scanning, true);
  assert.throws(() => registry.pin(randomUUID(), true), /等待/);
  assert.throws(
    () =>
      registry.diagnosisContext({
        installId: randomUUID(),
        componentId: randomUUID(),
        feature: "model",
      }),
    /等待/,
  );
  release();
  assert.deepEqual(await first, await second);
  assert.equal(registry.current().scanning, false);
});
test("元数据扫描跳过符号链接和生成目录，标记多硬链接，预算截断与取消可见", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nl-files-"));
  try {
    await fs.writeFile(path.join(directory, ".env"), "SECRET=never-read");
    await fs.link(
      path.join(directory, ".env"),
      path.join(directory, "linked.key"),
    );
    await fs.mkdir(path.join(directory, "node_modules"));
    await fs.writeFile(
      path.join(directory, "node_modules", ".env"),
      "not scanned",
    );
    await fs.symlink(os.tmpdir(), path.join(directory, "escape"));
    const scan = await scanCandidates(directory, new AbortController().signal);
    assert.deepEqual(
      scan.candidates.map((c) => c.relativePath),
      [".env", "linked.key"],
    );
    assert.ok(scan.candidates.every((c) => c.unsupported));
    assert.equal(scan.skipped, 2);
    assert.ok(!JSON.stringify(scan).includes("never-read"));
    const truncated = await scanCandidates(
      directory,
      new AbortController().signal,
      { entries: 1, candidates: 1, depth: 1, milliseconds: 1000 },
    );
    assert.equal(truncated.truncated, true);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(scanCandidates(directory, controller.signal));
    await assert.rejects(
      scanCandidates(
        path.join(directory, "escape"),
        new AbortController().signal,
      ),
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
test("读改发送分别授权，更新冲突不覆盖，策略自检不执行访问或宣布全机阻断", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nl-policy-"));
  try {
    await fs.writeFile(path.join(directory, ".env"), "secret-body");
    const files = new FilePolicies(memoryStore());
    const scanned = await files.scan(directory);
    assert.equal(scanned.scanning, false);
    assert.equal(scanned.coverage.canBlockToolAccess, false);
    assert.ok(!("root" in scanned.scopes[0]));
    const scope = scanned.scopes[0],
      resourceId = scope.candidates[0].id;
    files.save(
      scope.id,
      {
        resourceId,
        read: "allow",
        write: "deny",
        disclose: "ask",
        enabled: true,
      },
      0,
    );
    assert.equal(
      (await files.evaluate(scope.id, resourceId, "read")).decision,
      "allow",
    );
    assert.equal(
      (await files.evaluate(scope.id, resourceId, "write")).decision,
      "deny",
    );
    assert.equal(
      (await files.evaluate(scope.id, resourceId, "disclose")).decision,
      "ask",
    );
    assert.throws(
      () =>
        files.save(
          scope.id,
          {
            resourceId,
            read: "allow",
            write: "allow",
            disclose: "allow",
            enabled: true,
          },
          0,
        ),
      /已被更新/,
    );
    assert.equal(files.workspace().scopes[0].policies[0].write, "deny");
    await files.evaluate(scope.id, resourceId, "write");
    assert.equal(files.workspace().alerts.length, 1);
    assert.equal(files.workspace().alerts[0].count, 2);
    files.acknowledge(files.workspace().alerts[0].id);
    assert.equal(files.workspace().scopes[0].policies[0].write, "deny");
    const events = files.audit({}).events;
    assert.equal(events[0].source, "policy_validation");
    assert.ok(!JSON.stringify(events).includes("secret-body"));
    assert.equal(
      await fs.readFile(path.join(directory, ".env"), "utf8"),
      "secret-body",
    );
    const report = files.report(scope.id, "json");
    assert.ok(
      !report.content.includes(directory) &&
        !report.content.includes(".env") &&
        !report.content.includes("secret-body"),
    );
    const payload = JSON.parse(report.content);
    assert.equal(payload.events[0].bytes_returned, null);
    assert.equal(payload.events[0].model_receipt, null);
    const priorAlias = payload.events[0].object;
    await files.evaluate(scope.id, resourceId, "write");
    assert.equal(
      JSON.parse(files.report(scope.id, "json").content).events[0].object,
      priorAlias,
    );
    assert.notEqual(files.report(scope.id, "json").digest, report.digest);
    await assert.rejects(
      files.evaluate(scope.id, randomUUID(), "read"),
      /失效/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
test("重新扫描不复用被替换文件授权，keyset 审计分页没有重复或缺段", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nl-rescan-"));
  try {
    const file = path.join(directory, ".env");
    await fs.writeFile(file, "first");
    const files = new FilePolicies(memoryStore());
    const scope = (await files.scan(directory)).scopes[0],
      resourceId = scope.candidates[0].id;
    files.save(
      scope.id,
      {
        resourceId,
        read: "allow",
        write: "deny",
        disclose: "deny",
        enabled: true,
      },
      0,
    );
    for (let i = 0; i < 103; i++)
      await files.evaluate(scope.id, resourceId, "read");
    const first = files.audit({}),
      second = files.audit({ cursor: first.nextCursor });
    assert.equal(first.events.length, 100);
    assert.equal(
      new Set([...first.events, ...second.events].map((e) => e.seq)).size,
      105,
    );
    await fs.writeFile(file + ".tmp", "replacement");
    await fs.rename(file + ".tmp", file);
    assert.equal(
      (await files.evaluate(scope.id, resourceId, "read")).decision,
      "deny",
    );
    const rescanned = await files.rescan(scope.id);
    assert.notEqual(rescanned.scopes[0].candidates[0].id, resourceId);
    assert.equal(rescanned.scopes[0].policies.length, 0);
    assert.ok(rescanned.scopes[0].warnings.some((w) => w.includes("重新确认")));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
test("持久化失败不能在内存中假装策略已生效；重启恢复安装和文件策略", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nl-state-"));
  try {
    const filename = path.join(directory, "data.sqlite");
    const store = new Store(
      filename,
      path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"),
    );
    await store.init();
    store.putAssistant("tools", { version: 1 });
    await fs.mkdir(filename + ".tmp");
    assert.throws(() => store.putAssistant("tools", { version: 2 }));
    assert.deepEqual(store.assistant("tools", {}), { version: 1 });
    await fs.rmdir(filename + ".tmp");
    const next = new Store(
      filename,
      path.resolve("node_modules/sql.js/dist/sql-wasm.wasm"),
    );
    await next.init();
    assert.deepEqual(next.assistant("tools", {}), { version: 1 });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
test("手动敏感候选限制在批准范围，符号链接和越界被拒绝，重新扫描保留指定类型", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nl-manual-"));
  try {
    await fs.writeFile(path.join(directory, "budget.csv"), "private-content");
    await fs.symlink(
      path.join(directory, "budget.csv"),
      path.join(directory, "link.csv"),
    );
    const files = new FilePolicies(memoryStore()),
      scope = (await files.scan(directory)).scopes[0];
    const workspace = await files.addCandidate(
      scope.id,
      path.join(directory, "budget.csv"),
    );
    assert.equal(workspace.scopes[0].candidates.length, 1);
    assert.ok(!JSON.stringify(workspace).includes("private-content"));
    await assert.rejects(
      files.addCandidate(scope.id, path.join(directory, "link.csv")),
      /不支持/,
    );
    await assert.rejects(
      files.addCandidate(
        scope.id,
        path.resolve(directory, "..", "outside.csv"),
      ),
      /范围/,
    );
    assert.equal(
      (await files.rescan(scope.id)).scopes[0].candidates[0].relativePath,
      "budget.csv",
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
