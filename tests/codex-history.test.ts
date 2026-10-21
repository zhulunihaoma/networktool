import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexHistory } from "../electron/core/codex-history";
import { HandoffManager } from "../electron/core/handoff";

const id = "12345678-1234-4234-8234-123456789abc";
const meta = (sessionId = id) => ({ type: "session_meta", payload: { id: sessionId, cwd: "/project/demo", timestamp: "2026-01-02T03:04:05Z" } });
const user = (message: string) => ({ type: "event_msg", payload: { type: "user_message", message } });
const responseUser = (message: string) => ({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: message }] } });
const lines = (...records: unknown[]) => records.map(row => JSON.stringify(row)).join("\n") + "\n";

test("default discovery uses native Codex history, not OpenCode's CODEX_HOME", () => {
  const history = new CodexHistory();
  assert.equal((history as unknown as { sessionsRoot: string }).sessionsRoot, path.join(os.homedir(), ".codex", "sessions"));
});

async function fixture(run: (history: CodexHistory, file: string, root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-history-test-"));
  const day = path.join(root, "2026", "01", "02");
  await mkdir(day, { recursive: true });
  const file = path.join(day, `rollout-${id}.jsonl`);
  try { await run(new CodexHistory(root), file, root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("lists the project from metadata, filters context, deduplicates mirrored user turns and redacts secrets", async () => fixture(async (history, file) => {
  await writeFile(file, lines(meta(), user("<environment_context>private</environment_context>"),
    user("修复网络检测 token=verysecretvalue"), responseUser("修复网络检测 token=verysecretvalue"),
    { type: "event_msg", payload: { type: "agent_message", message: "已检查 demo@example.com" } },
    { type: "response_item", payload: { type: "function_call", arguments: "secret output" } }));
  const list = await history.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].directory, "/project/demo");
  assert.match(list[0].title, /修复网络检测/);
  assert.doesNotMatch(list[0].title, /verysecretvalue/);
  const imported = await history.importSession(id);
  assert.equal(imported.source, "Codex");
  assert.equal(imported.messageCount, 2);
  assert.doesNotMatch(imported.transcript, /verysecretvalue|demo@example.com|secret output|private/);
  assert.match(imported.transcript, /\[已脱敏\]/);
  assert.ok(imported.redactions >= 2);
}));

test("recognizes legacy and modern user text, with a cwd fallback", async () => fixture(async (history, file) => {
  await writeFile(file, lines({ type: "session_meta", payload: { id } },
    { type: "turn_context", payload: { cwd: "/another/workspace" } },
    { type: "message", role: "user", content: "早期请求" }, responseUser("后续请求")));
  assert.deepEqual((await history.list()).map(x => [x.title, x.directory]), [["早期请求", "/another/workspace"]]);
  assert.equal((await history.importSession(id)).messageCount, 2);
}));

test("AGENTS.md context is not shown as a conversation title or user request", async () => fixture(async (history, file) => {
  await writeFile(file, lines(meta(), user("# AGENTS.md instructions\n<INSTRUCTIONS>\nInternal project rules\n</INSTRUCTIONS>"), user("调整任务接续布局")));
  assert.equal((await history.list())[0].title, "调整任务接续布局");
  const imported = await history.importSession(id);
  assert.equal(imported.messageCount, 1);
  assert.doesNotMatch(imported.transcript, /Internal project rules|AGENTS.md instructions/);
}));

test("a user question mentioning AGENTS.md remains a real request", async () => fixture(async (history, file) => {
  await writeFile(file, lines(meta(), user("# AGENTS.md instructions\n请解释这个文件的作用")));
  assert.match((await history.list())[0].title, /请解释/);
  assert.match((await history.importSession(id)).transcript, /请解释/);
}));

test("rejects changed identity and malformed selected history without importing a partial transcript", async () => fixture(async (history, file) => {
  await writeFile(file, lines(meta(), user("请求")));
  await history.list();
  await writeFile(file, lines(meta("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), user("请求")));
  await assert.rejects(history.importSession(id), /身份已变更/);
  await writeFile(file, lines(meta(), user("请求")) + "{invalid}\n");
  await assert.rejects(history.importSession(id), /记录损坏/);
  await assert.rejects(history.importSession("../../etc/passwd"), /列表/);
}));

test("ignores symlinks and oversized files; rejects replacement with a symlink", async () => fixture(async (history, file, root) => {
  await writeFile(file, lines(meta(), user("请求")));
  const link = path.join(root, "2026", "01", "02", "rollout-linked.jsonl");
  await symlink(file, link);
  assert.equal((await history.list()).length, 1);
  await rm(file);
  await symlink(link, file);
  await assert.rejects(history.importSession(id));
  await rm(file);
  await writeFile(file, lines(meta()) + " ".repeat(8 * 1024 * 1024));
  assert.deepEqual(await history.list(), []);
}));

test("bounded list can show an untitled session while import reads later requests", async () => fixture(async (history, file) => {
  await writeFile(file, lines(meta()) + lines({ type: "event_msg", payload: { type: "token_count", filler: "x".repeat(130 * 1024) } }) + lines(user("稍后出现的请求")));
  assert.equal((await history.list())[0].title, "无标题对话");
  assert.match((await history.importSession(id)).transcript, /稍后出现的请求/);
}));

test("Codex source flows through the manager into a one-use preview", async () => fixture(async (history, file) => {
  await writeFile(file, lines(meta(), user("继续修复"), responseUser("继续修复"), user("继续修复"), responseUser("继续修复")));
  const manager = new HandoffManager(async () => { throw new Error("OpenCode must not be started"); }, history);
  assert.equal((await manager.list("Codex"))[0].id, id);
  await assert.rejects(manager.importSession("ses_demo", "OpenCode"), /列表/);
  const imported = await manager.importSession(id, "Codex");
  assert.equal(imported.messageCount, 2);
  const preview = manager.prepare("核对后继续", "OpenCode");
  assert.match(preview.content, /Codex → OpenCode/);
  assert.equal(manager.consume(preview.token), preview.content);
  assert.throws(() => manager.consume(preview.token), /过期/);
}));
