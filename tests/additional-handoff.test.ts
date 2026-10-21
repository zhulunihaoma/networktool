import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { workBuddyMessages } from "../electron/core/workbuddy-history";
import { zcodeVisible } from "../electron/core/zcode-history";
import { dshMessages } from "../electron/core/dsh-history";
import { copilotMessages, CopilotCodeHistory } from "../electron/core/copilot-code-history";
import { LocalHandoffHistory, importedText, nativeFile, type HistoryRow } from "../electron/core/local-handoff-history";
import { discoverHandoffTools } from "../electron/core/handoff-tools";
import { WisCodeHistory } from "../electron/core/wiscode-history";
import { sanitizer } from "../src/shared/handoff";

const id = "12345678-1234-4234-8234-123456789abc";
const text = (text: string) => ({ type: "text", text });
const lines = (...rows: unknown[]) => rows.map(r => JSON.stringify(r)).join("\n");
async function fixture(run: (home: string) => Promise<void>) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "additional-handoff-"));
  try { await run(home); } finally { await fs.rm(home, { recursive: true, force: true }); }
}
async function put(home: string, relative: string, data: unknown) {
  const file = path.join(home, relative); await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof data === "string" ? data : JSON.stringify(data)); return file;
}
test("WorkBuddy keeps committed main-chat text, deduplicates identities later, excludes tools and reasoning", () => {
  const messages = workBuddyMessages(lines(
    { type: "message", role: "user", sessionId: id, id: "u", content: [text("继续"), { type: "image", data: "PRIVATE" }] },
    { type: "message", role: "assistant", sessionId: id, id: "a", content: [text("答案"), { type: "thinking", text: "PRIVATE" }] },
    { type: "message", role: "user", sessionId: id, isSidechain: true, content: "PRIVATE" },
    { type: "function_call_result", content: "PRIVATE" }, { type: "reasoning", content: "PRIVATE" },
  ), id);
  assert.deepEqual(messages.map(m => m.text), ["继续", "答案"]);
  assert.throws(() => workBuddyMessages(lines({ type: "message", role: "user", sessionId: "other" }), id), /身份/);
  assert.throws(() => workBuddyMessages(lines({ type: "message" }) + "\n{bad", id));
});
test("ZCode excludes reminders, synthetic input and hidden runtime messages", () => {
  assert(zcodeVisible({ role: "assistant", semantics: { uiVisibility: "visible", kind: "assistant_response" } }));
  for (const data of [{ role: "user", synthetic: true }, { role: "user", semantics: { transcriptVisibility: "hidden" } }, { role: "assistant", metadata: { visibility: "hidden" } }, { role: "tool" }]) assert(!zcodeVisible(data));
});
test("DeepSeek Harness imports committed messages once, not chunks or injected context", () => {
  const raw = lines(
    { type: "session", id: `session-${id}`, version: 4 },
    { type: "user/message", data: { id: "u", source: { kind: "user" }, content: [text("继续任务")] } },
    { type: "user/message", data: { source: { kind: "agent-instructions" }, content: [text("PRIVATE")] } },
    { type: "assistant/chunk", data: { text: "PRIVATE" } },
    { type: "assistant/message", data: { message: { id: "a", content: [text("已完成"), { type: "reasoning", text: "PRIVATE" }] } } },
    { type: "text-chunks", data: { texts: ["PRIVATE"] } }, { type: "request/header", data: { token: "PRIVATE" } },
  );
  assert.deepEqual(dshMessages(raw, id).map(m => m.text), ["继续任务", "已完成"]);
  assert.throws(() => dshMessages(raw.replace('"version":4', '"version":99'), id), /版本/);
  assert.throws(() => dshMessages(raw.replace('"version":4', '"version":4,"delegationDepth":1'), id), /子代理/);
  assert.throws(() => dshMessages(raw, "other"), /身份/);
});
test("Copilot Code classifies user feedback and omits tool, API and duplicate completion events", () => {
  const messages = copilotMessages([
    { type: "say", say: "text", text: "用户任务" }, { type: "say", say: "text", text: "回复" },
    { type: "say", say: "user_feedback", text: "继续" }, { type: "say", say: "reasoning", text: "PRIVATE" },
    { type: "ask", ask: "tool", text: "PRIVATE" }, { type: "say", say: "api_req_started", text: "PRIVATE" },
    { type: "say", say: "completion_result", text: "结果" }, { type: "ask", ask: "completion_result", text: "结果" },
    { type: "say", say: "text", text: "未提交", partial: true },
  ]);
  assert.deepEqual(messages.map(m => [m.role, m.text]), [["user", "用户任务"], ["assistant", "回复"], ["user", "继续"], ["assistant", "结果"]]);
});
test("native imports redact known token forms, deduplicate messages and fail rather than truncate", () => {
  const task = { id, title: "测试", directory: "", updated: 0 };
  const data = importedText("WorkBuddy", task, [{ role: "user", text: "token=secret ark-12345678-1234-1234-1234-123456789abc-secretValue", id: "u" }, { role: "user", text: "duplicate", id: "u" }]);
  assert.equal(data.messageCount, 1); assert.doesNotMatch(data.transcript, /secret|duplicate/);
  assert(data.warnings.some(w => w.includes("未提供项目")));
  assert.throws(() => importedText("ZCode", task, [{ role: "assistant", text: "x".repeat(120001) }]), /未截断/);
  assert.throws(() => importedText("ZCode", task, []), /没有可读取/);
  assert.equal(sanitizer().clean("ark-12345678-1234-1234-1234-123456789abc-keyvalue"), "[已脱敏]");
});
class FakeHistory extends LocalHandoffHistory {
  values: HistoryRow[] = Array.from({ length: 61 }, (_, n) => ({ task: { id: String(n), title: `聊天 ${n}`, directory: n === 0 ? "/old-project" : "/new-project", updated: n } }));
  constructor() { super("WorkBuddy"); }
  async rows() { return this.values; }
  protected async read(row: HistoryRow) { return importedText(this.source, row.task, [{ role: "user", text: "请求" }]); }
}
test("all-history project filtering and search precede pagination, cursors are scoped, imports recheck removal", async () => {
  const history = new FakeHistory(), first = await history.browse();
  assert.equal(first.tasks.length, 50); assert.equal(first.total, 61); assert(first.nextCursor);
  await assert.rejects(history.importSession("0"), /列表/);
  const second = await history.browse({ cursor: first.nextCursor }); assert.equal(second.tasks.length, 11);
  assert.equal((await history.importSession("0")).source, "WorkBuddy");
  const old = first.projects.find(p => p.name === "old-project")!;
  assert.equal((await history.browse({ projectId: old.id })).tasks.length, 1);
  await assert.rejects(history.browse({ cursor: first.nextCursor }), /分页/);
  assert.equal((await history.browse({ search: "聊天 0" })).tasks[0].id, "0");
  history.values = history.values.filter(r => r.task.id !== "0");
  await assert.rejects(history.importSession("0"), /移除/);
});
test("native file reader rejects symlinks outside the source and oversized records", async () => fixture(async home => {
  const file = await put(home, "source/entry.json", "test");
  const outside = await put(home, "outside.json", "private");
  await fs.symlink(outside, path.join(home, "source/link.json"));
  await assert.rejects(nativeFile(path.join(home, "source/link.json"), path.join(home, "source")), /超出/);
  await assert.rejects(nativeFile(file, path.join(home, "source"), 2), /上限/);
}));
test("Copilot Code records are scoped to known roots and selected task IDs", async () => fixture(async home => {
  await put(home, `.roo-cline/globalStorage/ultra-ai.copilotcodepro/tasks/${id}/ui_messages.json`, [{ type: "say", say: "text", text: "本地任务" }]);
  const history = new CopilotCodeHistory(home), page = await history.browse();
  assert.equal(page.tasks.length, 1); assert.equal(page.tasks[0].directory, "");
  assert.equal((await history.importSession(id)).messageCount, 1);
  await assert.rejects(history.importSession("../../secret"), /列表/);
}));
test("WisCode managed Claude profiles stay separate and work without a Codex engine", async () => fixture(async home => {
  await put(home, `.wiscode/claude-agents/projects/project/${id}.jsonl`, lines(
    { type: "user", sessionId: id, cwd: "/demo", message: { content: "WisCode 请求" } },
    { type: "assistant", sessionId: id, message: { content: [text("回复")] } },
  ));
  const history = new WisCodeHistory(home), page = await history.browse();
  assert.equal(page.tasks[0].id, `claude:${id}`);
  const result = await history.importSession(page.tasks[0].id); assert.equal(result.source, "WisCode"); assert.equal(result.messageCount, 2);
}));
test("discovery distinguishes installed tools, history-only tools and unsupported source formats", async () => fixture(async home => {
  await put(home, `.workbuddy/workbuddy.db`, "fixture");
  await fs.mkdir(path.join(home, ".gemini"));
  const result = await discoverHandoffTools(home, async () => ({ tools: [{ productId: "zcode", location: "/app/ZCode", confirmed: true, source: "test", role: "host" }, { productId: "vscode", location: "/app/Code", confirmed: true, source: "test", role: "host" }] }));
  assert.equal(result.find(t => t.id === "ZCode")?.installed, true);
  assert.equal(result.find(t => t.id === "WorkBuddy")?.historyFound, true);
  assert.equal(result.find(t => t.id === "WorkBuddy")?.installed, false);
  assert.equal(result.find(t => t.id === "VSCode")?.readable, false);
  assert.equal(result.find(t => t.id === "GeminiCLI")?.historyFound, false);
  assert(!result.some(t => t.id === "Cursor"));
}));
