import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { HandoffManager } from "../electron/core/handoff";

const data = (id = "ses_demo") => JSON.stringify({ info: { id, title: "未完成任务", directory: "/project" }, messages: [{ info: { id: "msg_1", sessionID: id, role: "user" }, parts: [{ type: "text", text: "继续测试" }] }] });
test("only listed sessions are exported; fixed argv, no shell inputs", async () => {
  const calls: string[][] = [];
  const manager = new HandoffManager(async (args) => { calls.push(args); return args[0] === "session" ? JSON.stringify([{ id: "ses_demo", title: "任务", directory: "/project", updated: 42 }]) : data(); });
  await assert.rejects(manager.importSession("ses_other"), /列表/);
  assert.equal((await manager.list())[0].updated, 42);
  assert.equal((await manager.importSession("ses_demo")).id, "ses_demo");
  assert.deepEqual(calls[1], ["export", "ses_demo", "--pure"]);
  await assert.rejects(manager.importSession("; touch /tmp/pwn"), /列表/);
});
test("preview is one-use and invalidated on reimport; duplicate does not append", () => {
  const manager = new HandoffManager();
  manager.importRaw(data());
  const first = manager.prepare("完成测试", "WisCode");
  assert.match(first.content, /WisCode/);
  assert.throws(() => manager.consume("fake"), /过期/);
  assert.throws(() => manager.consume(first.token, () => { throw new Error("clipboard unavailable"); }), /clipboard unavailable/);
  assert.equal(manager.consume(first.token), first.content);
  assert.throws(() => manager.consume(first.token), /过期/);
  const second = manager.prepare("继续", "WisCode");
  assert.match(manager.importRaw(data()).warnings.join(" "), /不会累加/);
  assert.throws(() => manager.consume(second.token), /过期/);
  assert.throws(() => manager.prepare(" ", "WisCode"), /目标/);
});
test("bounded file import and malformed import keep last valid source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "handoff-test-"));
  try {
    const file = path.join(root, "task.json");
    const manager = new HandoffManager();
    await writeFile(file, data());
    assert.equal((await manager.importFile(file)).id, "ses_demo");
    await symlink(file, path.join(root, "link.json"));
    await assert.rejects(manager.importFile(path.join(root, "link.json")), /普通/);
    if (process.platform !== "win32") {
      const fifo = path.join(root, "fifo.json");
      execFileSync("mkfifo", [fifo]);
      await assert.rejects(manager.importFile(fifo), /普通/);
    }
    await writeFile(file, "invalid");
    await assert.rejects(manager.importFile(file), /JSON/);
    assert.match(manager.prepare("继续", "WisCode").content, /ses_demo/);
    await writeFile(file, " ".repeat(8 * 1024 * 1024 + 1));
    await assert.rejects(manager.importFile(file), /8 MB/);
    await assert.rejects(manager.importFile(root));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("session mismatch rejected; concurrent reads prevented", async () => {
  let release!: (s: string) => void;
  const manager = new HandoffManager(() => new Promise(resolve => release = resolve));
  const listing = manager.list();
  await assert.rejects(manager.list(), /正在进行/);
  release(JSON.stringify([{ id: "ses_demo" }])); await listing;
  const importing = manager.importSession("ses_demo");
  release(data("ses_wrong"));
  await assert.rejects(importing, /不一致/);
});
