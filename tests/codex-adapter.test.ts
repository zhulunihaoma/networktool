import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexHistory } from "../electron/core/codex-history";
import { CodexRpcError, type CodexReadClient, type CodexReadMethod } from "../electron/core/codex-app-server";
import { catalogProjects, projectForThread, readCodexIndex, type CodexIndex, type CodexProject, type IndexedCodexThread } from "../electron/core/codex-local-index";

const id = "12345678-1234-4234-8234-123456789abc";
const other = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const project: CodexProject = { id: "shop", name: "自定义项目名称", directories: ["/private/tmp/shop_agent"], aliases: ["old-shop"], registered: true };
const snapshot = (threads: IndexedCodexThread[] = [], projects = [project]): CodexIndex => ({ threads, projects, hasDatabase: true, warnings: [] });
const thread = (extra: Record<string, unknown> = {}) => ({ id, name: "真实客户端标题", preview: "不应覆盖名称", cwd: project.directories[0], updatedAt: 123, source: "vscode", threadSource: "user", historyMode: "paginated", path: "/unused/current.jsonl", ...extra });
function factory(run: (method: CodexReadMethod, params: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>) {
  return async (): Promise<CodexReadClient> => ({ call: async (method, params) => run(method, params), close() {} });
}
const itemUser = (id: string, text: string) => ({ id, type: "userMessage", content: [{ type: "text", text }] });
const itemAgent = (id: string, text: string) => ({ id, type: "agentMessage", text });

test("a project is queried independently of the global recent page; aliases and official titles are preserved", async () => {
  const calls: Record<string, unknown>[] = [];
  const history = new CodexHistory("/test/sessions", { index: async () => snapshot(), client: factory((method, params) => {
    assert.equal(method, "thread/list"); calls.push(params);
    return params.cwd ? { data: [thread(), thread(), thread({ id: other, source: { subagent: { other: "guardian" } }, threadSource: "guardian_review" })], nextCursor: null } : { data: [thread({ id: other, cwd: "/newer/project" })], nextCursor: "page-2" };
  }) });
  const first = await history.browse();
  assert.equal(first.tasks[0].id, other);
  assert.ok(first.nextCursor);
  const scoped = await history.browse({ projectId: "shop" });
  assert.equal(scoped.tasks.length, 1);
  assert.equal(scoped.tasks[0].title, "真实客户端标题");
  assert.equal(scoped.tasks[0].projectId, "shop");
  assert.equal(calls[1].cwd, "/private/tmp/shop_agent");
  assert.equal(calls[1].useStateDbOnly, true);
  assert.deepEqual(calls[1].sourceKinds, ["cli", "vscode"]);
  assert.equal(scoped.projects[0].name, "自定义项目名称");
  assert.equal(scoped.origin, "codex-app-server");
  await assert.rejects(history.browse({ projectId: "shop", cursor: first.nextCursor }), /分页已失效/);
});

test("pagination keeps imported IDs valid, deduplicates page overlap and rejects cross-project cursors", async () => {
  const history = new CodexHistory("/test/sessions", { index: async () => snapshot(), client: factory((method, params) => {
    if (method === "thread/list") return params.cursor ? { data: [thread({ id: other })], nextCursor: null } : { data: [thread()], nextCursor: "next" };
    if (method === "thread/read") return { thread: thread({ id: params.threadId }) };
    return { data: [], nextCursor: null };
  }) });
  const first = await history.browse();
  const second = await history.browse({ cursor: first.nextCursor });
  assert.equal(second.tasks[0].id, other);
  assert.equal((await history.importSession(id)).id, id);
  await assert.rejects(history.browse({ cursor: first.nextCursor, projectId: "shop" }), /分页已失效/);
});

test("official paginated history is read in order, only visible messages are transferred, and secrets are redacted", async () => {
  const calls: string[] = [];
  const history = new CodexHistory("/test/sessions", { index: async () => snapshot(), client: factory((method, params) => {
    calls.push(method);
    if (method === "thread/list") return { data: [thread()], nextCursor: null };
    if (method === "thread/read") return { thread: thread({ name: "最新名称", path: "/unused/newest.jsonl" }) };
    assert.equal(params.itemsView, "full"); assert.equal(params.sortDirection, "asc");
    return params.cursor ? { data: [{ items: [itemUser("u2", "下一步"), itemAgent("a2", "后续回复")] }], nextCursor: null } : { data: [{ items: [itemUser("u1", "先处理 token=private-fixture-token"), { id: "tool", type: "commandExecution", output: "tool-private" }, { id: "thought", type: "reasoning", text: "private-reasoning" }, itemAgent("a1", "已经完成前段")] }], nextCursor: "older-next" };
  }) });
  await history.list();
  const imported = await history.importSession(id);
  assert.equal(imported.title, "最新名称"); assert.equal(imported.messageCount, 4);
  assert(imported.transcript.indexOf("先处理") < imported.transcript.indexOf("下一步"));
  assert.doesNotMatch(imported.transcript, /private-fixture-token|tool-private|private-reasoning/);
  assert.ok(imported.redactions > 0);
  assert.deepEqual(calls, ["thread/list", "thread/read", "thread/turns/list", "thread/turns/list"]);
});

test("a paginated thread never silently falls back to an old rollout when history APIs fail", async () => {
  const history = new CodexHistory("/test/sessions", { index: async () => snapshot(), client: factory(method => {
    if (method === "thread/list") return { data: [thread()], nextCursor: null };
    if (method === "thread/read") return { thread: thread() };
    throw new CodexRpcError(-32601, method);
  }) });
  await history.list();
  await assert.rejects(history.importSession(id), /接口不可用/);
});

test("repeated history cursors and oversized history fail rather than returning partial context", async () => {
  let oversized = false;
  const history = new CodexHistory("/test/sessions", { index: async () => snapshot(), client: factory(method => {
    if (method === "thread/list") return { data: [thread()], nextCursor: null };
    if (method === "thread/read") return { thread: thread() };
    return { data: [{ items: [itemAgent("a", oversized ? "x".repeat(120001) : "reply")] }], nextCursor: "repeat" };
  }) });
  await history.list();
  await assert.rejects(history.importSession(id), /游标重复/);
  oversized = true;
  await assert.rejects(history.importSession(id), /120000/);
});

test("local index fallback rereads the canonical rollout path at import time", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-adapter-"));
  try {
    const sessions = path.join(home, "sessions"); await fs.mkdir(sessions);
    const file = path.join(sessions, "current.jsonl"), newer = path.join(sessions, "newer.jsonl");
    const content = (text: string) => [JSON.stringify({ type: "session_meta", payload: { id, cwd: "/project" } }), JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: text } })].join("\n") + "\n";
    await fs.writeFile(file, content("旧正文")); await fs.writeFile(newer, content("最新正文"));
    const row: IndexedCodexThread = { id, title: "索引标题", directory: "/project", updated: 1, file, historyMode: "legacy", sourceKind: "vscode", threadSource: "user" };
    const history = new CodexHistory(sessions, { index: async () => snapshot([row], []), client: factory(() => { throw new Error("unavailable"); }) });
    const result = await history.browse();
    assert.equal(result.origin, "codex-local-index"); assert.ok(result.warnings.length);
    row.file = newer;
    assert.match((await history.importSession(id)).transcript, /最新正文/);
    row.historyMode = "paginated";
    await assert.rejects(history.importSession(id), /分页历史/);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test("registered projects with no chats survive, legacy null project IDs match roots, nested roots prefer the closest project", () => {
  const empty = { ...project, id: "empty", name: "空项目", aliases: [], directories: ["/empty"] };
  const nested = { ...project, id: "nested", aliases: [], directories: ["/private/tmp/shop_agent/sub"] };
  const task = { id, title: "task", directory: "/private/tmp/shop_agent", updated: 0 };
  const catalog = catalogProjects([project, empty, nested], [task], true);
  assert.equal(catalog.find(p => p.id === "empty")!.count, 0);
  assert.equal(projectForThread(task, catalog)!.id, "shop");
  assert.equal(projectForThread({ ...task, directory: "/elsewhere", projectId: "old-shop" }, catalog)!.id, "shop");
  assert.equal(projectForThread({ ...task, directory: "/private/tmp/shop_agent/sub/child" }, catalog)!.id, "nested");
});

test("explicit project assignments take precedence over a coinciding working directory", async () => {
  const assigned = { ...project, id: "assigned", directories: ["/different-root"], aliases: [] };
  const history = new CodexHistory("/test/sessions", { index: async () => snapshot([], [project, assigned]), client: factory(() => ({ data: [thread({ projectId: "assigned" })], nextCursor: null })) });
  assert.equal((await history.browse({ projectId: "shop" })).tasks.length, 0);
});

test("legacy Desktop project registrations retain custom names and multiple roots without a database", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-projects-"));
  try {
    await fs.writeFile(path.join(home, ".codex-global-state.json"), JSON.stringify({ "local-projects": { p: { id: "p", name: "显示名称", rootPaths: ["/a", "/b"] } } }));
    const snapshot = await readCodexIndex(home);
    assert.equal(snapshot.projects.length, 1); assert.equal(snapshot.projects[0].name, "显示名称");
    assert.deepEqual(snapshot.projects[0].directories, ["/a", "/b"]);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test("legacy duplicate rollout files do not inflate counts and Guardian review is excluded", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-legacy-"));
  const root = path.join(home, "sessions"), day = path.join(root, "2026", "10", "20");
  try {
    await fs.mkdir(day, { recursive: true });
    const meta = (id: string, source: unknown = "vscode") => JSON.stringify({ type: "session_meta", payload: { id, cwd: "/project", source } });
    const ask = (text: string) => JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: text } });
    const old = path.join(day, "rollout-old.jsonl"), latest = path.join(day, "rollout-resumed.jsonl");
    await fs.writeFile(old, meta(id) + "\n" + ask("旧正文") + "\n");
    await fs.utimes(old, 1, 1);
    await fs.writeFile(latest, meta(id) + "\n" + ask("最新正文") + "\n");
    await fs.writeFile(path.join(day, "rollout-guardian.jsonl"), meta(other, { subagent: { other: "guardian" } }) + "\n" + ask("internal prompt") + "\n");
    await fs.writeFile(path.join(home, "session_index.jsonl"), JSON.stringify({ id, thread_name: "客户端真实名称" }) + "\n");
    const history = new CodexHistory(root, { client: null });
    const page = await history.browse();
    assert.equal(page.tasks.length, 1); assert.equal(page.tasks[0].title, "客户端真实名称");
    const data = await history.importSession(id);
    assert.equal(data.title, "客户端真实名称"); assert.match(data.transcript, /最新正文/); assert.doesNotMatch(data.transcript, /旧正文|internal prompt/);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
