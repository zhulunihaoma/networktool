import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { FileWorkflow, redactLocalText } from "../electron/core/file-workflow";
import { decideFileRules } from "../electron/security/file-rule-guard";
import type { FileDraft } from "../src/shared/file-workflow";

test("重叠范围按拒绝优先；试运行显示最终决定而非单条允许", async () =>
  fixture(async (f) => {
    const nested = path.join(f.dir, "nested");
    await fs.mkdir(nested);
    await fs.writeFile(path.join(nested, "customer.sql"), "fixture");
    const parent = (await f.files.rescan(f.scopeId)).scopes.find(
      (s) => s.id === f.scopeId,
    )!;
    const parentFile = parent.candidates.find(
      (c) => c.relativePath === path.join("nested", "customer.sql"),
    )!;
    await publish({ ...f, resourceId: parentFile.id }, { read: "deny" });
    const child = (await f.files.scan(nested)).scopes.find(
      (s) => s.id !== parent.id,
    )!;
    const trial = await f.files.trial(
      child.id,
      {
        resourceId: child.candidates[0].id,
        read: "allow",
        write: "allow",
        delete: "allow",
        disclose: "allow",
        enabled: true,
      },
      0,
    );
    assert.equal(
      trial.checks.find((c) => c.operation === "read")!.after,
      "deny",
    );
    await f.files.publish(trial.id);
    const r = await f.files.start(child.id, child.candidates[0].id, "preview");
    assert.equal(r.task.status, "denied");
    assert.equal(r.content, undefined);
  }));

test("工作流报告保留回执与关联编号，排除正文和授权原因", async () =>
  fixture(async (f) => {
    await publish(f);
    const t = await f.files.start(f.scopeId, f.resourceId, "preview");
    await f.files.grant(t.task.id, "PRIVATE-APPROVAL-REASON");
    await f.files.run(t.task.id);
    const report = f.files.report(f.scopeId, "json");
    assert.ok(!report.content.includes("PRIVATE-APPROVAL-REASON"));
    assert.ok(!report.content.includes("example-secret"));
    assert.ok(!report.content.includes(f.dir));
    const payload = JSON.parse(report.content);
    assert.equal(payload.workflow.tasks[0].id, t.task.id);
    assert.equal(payload.workflow.tasks[0].status, "completed");
    assert.equal(payload.workflow.tasks[0].model_receipt, null);
  }));
function store() {
  const values = new Map<string, unknown>();
  return {
    assistant<T>(name: string, fallback: T): T {
      return structuredClone((values.get(name) as T) || fallback);
    },
    putAssistant(name: string, value: unknown) {
      values.set(name, structuredClone(value));
    },
  };
}
async function fixture(
  run: (f: {
    files: FileWorkflow;
    dir: string;
    security: string;
    scopeId: string;
    resourceId: string;
    filename: string;
    db: ReturnType<typeof store>;
  }) => Promise<void>,
  content = "user=demo\nemail=private@example.com\napi_key=example-secret\nphone=13812345678\n",
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nl-file-workflow-"));
  const security = path.join(dir, "security"),
    filename = path.join(dir, "customer.sql");
  await fs.writeFile(filename, content);
  const db = store(),
    files = new FileWorkflow(
      db,
      path.join(security, "file-policy-snapshot.json"),
    );
  const scope = (await files.scan(dir)).scopes[0];
  try {
    await run({
      files,
      dir,
      security,
      scopeId: scope.id,
      resourceId: scope.candidates.find(
        (c) => c.relativePath === "customer.sql",
      )!.id,
      filename,
      db,
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
async function publish(
  f: { files: FileWorkflow; scopeId: string; resourceId: string },
  input: Partial<FileDraft> = {},
  expected = 0,
) {
  const trial = await f.files.trial(
    f.scopeId,
    {
      resourceId: f.resourceId,
      read: "ask",
      write: "deny",
      delete: "deny",
      disclose: "deny",
      enabled: true,
      ...input,
    },
    expected,
  );
  return f.files.publish(trial.id);
}
test("试运行不改变规则；发布后本地和钩子一致，凭证不能重复发布", async () =>
  fixture(async (f) => {
    const trial = await f.files.trial(
      f.scopeId,
      {
        resourceId: f.resourceId,
        read: "deny",
        write: "deny",
        delete: "deny",
        disclose: "deny",
        enabled: true,
      },
      0,
    );
    assert.equal(trial.checks.length, 4);
    assert.equal(f.files.workspace().scopes[0].policies.length, 0);
    assert.equal(
      decideFileRules(f.security, { tool: "codex", readPaths: [f.filename] }),
      undefined,
    );
    const w = await f.files.publish(trial.id);
    assert.equal(w.workflow!.hook.state, "published");
    assert.equal(w.scopes[0].candidates[0].review, "confirmed");
    assert.equal(
      decideFileRules(f.security, { tool: "codex", readPaths: [f.filename] })
        ?.decision,
      "deny",
    );
    await assert.rejects(f.files.publish(trial.id), /失效/);
    assert.equal(
      (await f.files.start(f.scopeId, f.resourceId, "preview")).task.status,
      "denied",
    );
    assert.equal(f.files.workspace().workflow!.tasks[0].bytes, undefined);
  }));
test("真实读取有回执，双并发只执行一次，本地授权不解除钩子", async () =>
  fixture(async (f) => {
    await publish(f);
    const r = await f.files.start(f.scopeId, f.resourceId, "preview");
    assert.equal(r.task.status, "awaiting_approval");
    assert.equal(r.content, undefined);
    await assert.rejects(f.files.grant(r.task.id, ""), /原因/);
    await f.files.grant(r.task.id, "仅本地测试预览");
    const results = await Promise.allSettled([
      f.files.run(r.task.id),
      f.files.run(r.task.id),
    ]);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    const success = results.find(
      (r) => r.status === "fulfilled",
    ) as PromiseFulfilledResult<Awaited<ReturnType<FileWorkflow["run"]>>>;
    assert.equal(success.value.task.status, "completed");
    assert.match(success.value.content!, /example-secret/);
    assert.equal(f.files.workspace().workflow!.grants[0].status, "used");
    assert.equal((await f.files.run(r.task.id)).content, undefined);
    assert.ok(!JSON.stringify(f.files.workspace()).includes("example-secret"));
    assert.equal(
      decideFileRules(f.security, { tool: "codex", readPaths: [f.filename] })
        ?.decision,
      "deny",
    );
  }));
test("文件变化和对象替换使许可与试运行失效", async () =>
  fixture(async (f) => {
    await publish(f);
    const t = await f.files.start(f.scopeId, f.resourceId, "preview");
    await f.files.grant(t.task.id, "test");
    await fs.writeFile(f.filename, "changed");
    const r = await f.files.run(t.task.id);
    assert.equal(r.task.status, "failed");
    assert.equal(r.content, undefined);
    assert.equal(f.files.workspace().workflow!.grants[0].status, "invalid");
    const w = await f.files.rescan(f.scopeId);
    assert.equal(w.scopes[0].policies.length, 1);
    assert.equal(
      w.scopes[0].candidates.find((c) => c.id === f.resourceId)?.review,
      "stale",
    );
    assert.equal(
      decideFileRules(f.security, { tool: "codex", readPaths: [f.filename] })
        ?.decision,
      "deny",
    );
    await f.files.reconfirm(f.scopeId, f.resourceId);
    const resourceId = w.scopes[0].candidates.find(
      (c) => c.relativePath === "customer.sql",
    )!.id;
    const trial = await f.files.trial(
      f.scopeId,
      {
        resourceId,
        read: "allow",
        write: "deny",
        disclose: "deny",
        enabled: true,
      },
      2,
    );
    await fs.writeFile(f.filename + ".swap", "swapped");
    await fs.rename(f.filename + ".swap", f.filename);
    await assert.rejects(f.files.publish(trial.id), /变化/);
  }));
test("版本冲突不能覆盖；回滚创建新版本并保留任务记录", async () =>
  fixture(async (f) => {
    await publish(f);
    const task = await f.files.start(f.scopeId, f.resourceId, "preview");
    await f.files.grant(task.task.id, "test");
    const trial = await f.files.trial(
      f.scopeId,
      {
        resourceId: f.resourceId,
        read: "allow",
        write: "deny",
        disclose: "deny",
        enabled: true,
      },
      1,
    );
    await publish(f, { read: "deny" }, 1);
    await assert.rejects(f.files.publish(trial.id), /更新/);
    assert.equal(f.files.workspace().workflow!.grants[0].status, "invalid");
    const w = await f.files.rollback(f.scopeId, f.resourceId, 2);
    assert.equal(w.scopes[0].policies[0].revision, 3);
    assert.equal(w.scopes[0].policies[0].read, "ask");
    assert.equal(w.workflow!.tasks.length, 1);
    await assert.rejects(f.files.rollback(f.scopeId, f.resourceId, 2), /更新/);
  }));
test("到期、撤销与应用重启使单次许可失效", async () =>
  fixture(async (f) => {
    await publish(f);
    let t = await f.files.start(f.scopeId, f.resourceId, "preview");
    await f.files.grant(t.task.id, "test");
    const state = f.db.assistant<any>("files", {});
    state.workflow.grants[0].expiresAt = Date.now() - 1;
    f.db.putAssistant("files", state);
    assert.equal(f.files.workspace().workflow!.grants[0].status, "expired");
    assert.equal((await f.files.run(t.task.id)).content, undefined);
    t = await f.files.start(f.scopeId, f.resourceId, "preview");
    await f.files.grant(t.task.id, "test");
    f.files.revoke(f.files.workspace().workflow!.grants[0].id);
    assert.equal((await f.files.run(t.task.id)).content, undefined);
    t = await f.files.start(f.scopeId, f.resourceId, "preview");
    await f.files.grant(t.task.id, "test");
    const restarted = new FileWorkflow(
      f.db,
      path.join(f.security, "file-policy-snapshot.json"),
    );
    assert.equal(restarted.workspace().workflow!.grants[0].status, "invalid");
    assert.equal((await restarted.run(t.task.id)).content, undefined);
  }));
test("脱敏副本不改原件、不入正文日志；副本摘要和版本绑定", async () =>
  fixture(async (f) => {
    await publish(f, { read: "allow" });
    const original = await fs.readFile(f.filename, "utf8");
    const r = await f.files.start(f.scopeId, f.resourceId, "redact");
    assert.equal(r.task.status, "completed");
    assert.ok(r.replacements! >= 3);
    assert.ok(!r.content!.includes("example-secret"));
    assert.ok(!r.content!.includes("private@example.com"));
    assert.equal(await fs.readFile(f.filename, "utf8"), original);
    assert.equal(await f.files.copyContent(r.task.id, r.digest!), r.content);
    await assert.rejects(
      f.files.copyContent(r.task.id, "0".repeat(64)),
      /失效/,
    );
    await fs.writeFile(f.filename, "new");
    await assert.rejects(f.files.copyContent(r.task.id, r.digest!), /变化/);
    assert.ok(!JSON.stringify(f.files.workspace()).includes("example-secret"));
  }));
test("不支持格式或过大文件失败有回执，单次许可不返还", async () => {
  for (const body of ["\0binary", "x".repeat(256 * 1024 + 1)])
    await fixture(async (f) => {
      await publish(f);
      const t = await f.files.start(f.scopeId, f.resourceId, "preview");
      await f.files.grant(t.task.id, "test");
      const r = await f.files.run(t.task.id);
      assert.equal(r.task.status, "failed");
      assert.equal(r.content, undefined);
      assert.equal(f.files.workspace().workflow!.grants[0].status, "used");
    }, body);
});
test("钩子约束读写删除和目录请求；链接对象不会获得本地授权", async () =>
  fixture(async (f) => {
    await publish(f, { read: "deny" });
    for (const input of [
      { command: "cat customer.sql", project: f.dir },
      { command: "rm customer.sql", project: f.dir },
      { paths: [f.filename] },
      { readPaths: [f.dir] },
    ])
      assert.equal(
        decideFileRules(f.security, { tool: "codex", ...input })?.decision,
        "deny",
      );
    await fs.link(f.filename, path.join(f.dir, "alias"));
    assert.equal(
      decideFileRules(f.security, { tool: "codex", readPaths: [f.filename] })
        ?.decision,
      "deny",
    );
    await assert.rejects(
      f.files.start(f.scopeId, f.resourceId, "preview"),
      /变化/,
    );
    await fs.symlink(f.filename, path.join(f.dir, "linked.sql"));
    await assert.rejects(
      f.files.addCandidate(f.scopeId, path.join(f.dir, "linked.sql")),
      /不支持/,
    );
  }));
test("快照损坏与下发失败不误报成功，恢复后回读核验", async () =>
  fixture(async (f) => {
    await publish(f, { read: "allow" });
    const snapshot = path.join(f.security, "file-policy-snapshot.json");
    await fs.unlink(snapshot);
    assert.equal(f.files.workspace().workflow!.hook.state, "error");
    assert.match(f.files.workspace().workflow!.hook.detail, /重新下发/);
    assert.equal(
      decideFileRules(f.security, { tool: "codex", readPaths: [f.filename] })
        ?.decision,
      "deny",
    );
    assert.equal(f.files.retryDeployment().workflow!.hook.state, "published");
    await fs.writeFile(snapshot, "{broken");
    assert.notEqual(f.files.workspace().workflow!.hook.state, "published");
    assert.equal(
      decideFileRules(f.security, { tool: "codex", readPaths: [f.filename] })
        ?.decision,
      "deny",
    );
    f.files.retryDeployment();
    assert.equal(f.files.workspace().workflow!.hook.state, "published");
    await fs.mkdir(snapshot + ".tmp");
    await publish(f, { read: "deny" }, 1);
    assert.equal(f.files.workspace().workflow!.hook.state, "error");
    await fs.rmdir(snapshot + ".tmp");
    assert.equal(f.files.retryDeployment().workflow!.hook.state, "published");
  }));
test("文本脱敏处理私钥整块，保留字段需用户继续审阅", () => {
  const r = redactLocalText(
    "-----BEGIN PRIVATE KEY-----\nDEMO\n-----END PRIVATE KEY-----\n姓名：测试甲\n工资:12000",
  );
  assert.ok(!r.content.includes("DEMO"));
  assert.ok(r.content.includes("姓名：测试甲"));
  assert.ok(r.content.includes("12000"));
});
test("文件消失或被替换时保留路径限制，只有确认新版本后恢复原规则", async () =>
  fixture(async (f) => {
    await publish(f, { read: "allow" });
    await fs.unlink(f.filename);
    const missing = await f.files.rescan(f.scopeId);
    assert.equal(missing.scopes[0].policies.length, 1);
    assert.equal(
      missing.scopes[0].candidates.find((c) => c.id === f.resourceId)?.review,
      "stale",
    );
    assert.equal(
      decideFileRules(f.security, { tool: "codex", readPaths: [f.filename] })
        ?.decision,
      "deny",
    );
    await assert.rejects(f.files.reconfirm(f.scopeId, f.resourceId));
    await fs.writeFile(f.filename, "replacement fixture");
    assert.equal(
      decideFileRules(f.security, { tool: "codex", readPaths: [f.filename] })
        ?.decision,
      "deny",
    );
    const restored = await f.files.reconfirm(f.scopeId, f.resourceId);
    assert.equal(restored.scopes[0].policies[0].revision, 2);
    assert.equal(
      restored.scopes[0].candidates.find((c) => c.id === f.resourceId)?.review,
      "confirmed",
    );
    assert.equal(
      decideFileRules(f.security, { tool: "codex", readPaths: [f.filename] }),
      undefined,
    );
  }));
test("受保护路径被符号链接替换时保持阻断，不能重新确认链接", async () =>
  fixture(async (f) => {
    await publish(f, { read: "allow" });
    const substitute = path.join(f.dir, "other.txt");
    await fs.writeFile(substitute, "fixture");
    await fs.unlink(f.filename);
    await fs.symlink(substitute, f.filename);
    await f.files.rescan(f.scopeId);
    assert.equal(
      decideFileRules(f.security, { tool: "codex", readPaths: [f.filename] })
        ?.decision,
      "deny",
    );
    await assert.rejects(f.files.reconfirm(f.scopeId, f.resourceId), /不支持/);
  }));
test("未初始化的旧版守卫不受新快照要求影响", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "legacy-guard-"));
  try {
    assert.equal(
      decideFileRules(dir, {
        tool: "codex",
        readPaths: [path.join(dir, "fixture.txt")],
      }),
      undefined,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
