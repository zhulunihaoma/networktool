import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClaudeHistory } from "../electron/core/claude-history";
import { HandoffManager } from "../electron/core/handoff";

const id = "12345678-1234-4234-8234-123456789abc";
const other = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const text = (value: string) => ({ type: "text", text: value });
const user = (message: string, extra: Record<string, unknown> = {}) => ({
  type: "user", uuid: "u-1", sessionId: id, cwd: "/project/demo", timestamp: "2026-01-02T03:04:05Z", isSidechain: false,
  message: { role: "user", content: [text(message)] }, ...extra,
});
const assistant = (...parts: unknown[]) => ({
  type: "assistant", uuid: "a-1", sessionId: id, timestamp: "2026-01-02T03:04:06Z", isSidechain: false,
  message: { role: "assistant", content: parts },
});
const aiTitle = (title: string) => ({ type: "ai-title", sessionId: id, aiTitle: title });
const lines = (...records: unknown[]) => records.map(row => JSON.stringify(row)).join("\n") + "\n";

test("default discovery uses the native Claude Code projects directory", () => {
  const history = new ClaudeHistory();
  assert.equal((history as unknown as { sessionsRoot: string }).sessionsRoot, path.join(os.homedir(), ".claude", "projects"));
});

async function fixture(run: (history: ClaudeHistory, file: string, root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-history-test-"));
  const project = path.join(root, "-Users-demo-project");
  await mkdir(project, { recursive: true });
  const file = path.join(project, `${id}.jsonl`);
  try { await run(new ClaudeHistory(root), file, root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("lists project and ai-title, redacts secrets, and imports only main-chain text", async () => fixture(async (history, file) => {
  await writeFile(file, lines(
    user("<ide_opened_file>private path</ide_opened_file>"),
    user("修复网络检测 token=verysecretvalue"),
    assistant(text("已检查 demo@example.com"), { type: "thinking", thinking: "private reasoning" }, { type: "tool_use", name: "Bash", input: { cmd: "rm -rf" } }),
    assistant(text("完成"), { type: "tool_result", content: "tool secret output" }),
    user("子代理消息", { isSidechain: true, cwd: "/sub" }),
    aiTitle("网络检测任务"),
  ));
  const list = await history.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].directory, "/project/demo");
  assert.equal(list[0].title, "网络检测任务");
  const imported = await history.importSession(id);
  assert.equal(imported.source, "ClaudeCode");
  assert.equal(imported.messageCount, 3);
  assert.doesNotMatch(imported.transcript, /子代理消息/);
  for (const secret of ["verysecretvalue", "demo@example.com", "private reasoning", "tool secret output", "ide_opened_file"]) {
    assert.ok(!imported.transcript.includes(secret), secret);
  }
  assert.match(imported.transcript, /\[已脱敏\]/);
  assert.ok(imported.redactions >= 2);
}));

test("falls back to the first ordinary user request when no ai-title exists", async () => fixture(async (history, file) => {
  await writeFile(file, lines(user("<local-command-stdout>noise</local-command-stdout>"), user("重构登录流程")));
  const list = await history.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "重构登录流程");
  assert.equal(list[0].directory, "/project/demo");
}));

test("rejects changed identity, malformed records, and path traversal", async () => fixture(async (history, file) => {
  await writeFile(file, lines(user("请求"), assistant(text("回复"))));
  await history.list();
  await writeFile(file, lines(user("请求", { sessionId: other })));
  await assert.rejects(history.importSession(id), /身份已变更/);
  await writeFile(file, lines(user("请求")) + "{invalid}\n");
  await assert.rejects(history.importSession(id), /损坏/);
  await assert.rejects(history.importSession("../../etc/passwd"), /列表/);
}));

test("ignores symlinks and oversized files; rejects symlink replacement on import", async () => fixture(async (history, file, root) => {
  await writeFile(file, lines(user("请求")));
  await symlink(file, path.join(root, "-Users-demo-project", `${other}.jsonl`));
  assert.equal((await history.list()).length, 1);
  await rm(file);
  await symlink(path.join(root, "-Users-demo-project", `${other}.jsonl`), file);
  await assert.rejects(history.importSession(id));
  await rm(file);
  await writeFile(file, lines(user("请求")) + " ".repeat(8 * 1024 * 1024));
  assert.deepEqual(await history.list(), []);
}));

test("Claude Code source flows through the manager into a one-use preview", async () => fixture(async (history, file) => {
  await writeFile(file, lines(user("继续修复"), assistant(text("继续修复")), aiTitle("修复任务")));
  const manager = new HandoffManager(async () => { throw new Error("OpenCode must not be started"); }, undefined, history);
  assert.equal((await manager.list("ClaudeCode"))[0].id, id);
  await assert.rejects(manager.importSession("ses_demo", "OpenCode"), /列表/);
  const imported = await manager.importSession(id, "ClaudeCode");
  assert.equal(imported.source, "ClaudeCode");
  const preview = manager.prepare("核对后继续", "Codex");
  assert.match(preview.content, /ClaudeCode → Codex/);
  assert.equal(manager.consume(preview.token), preview.content);
}));
