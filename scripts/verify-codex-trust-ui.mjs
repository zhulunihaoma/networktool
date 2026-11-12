// UI/IPC smoke with controlled responses; real Codex integration is a separate test.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "package.json"));
const { _electron } = require("@playwright/test");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nl-trust-ui-"));
const env = { ...process.env, NETWORK_LENS_DATA_DIR: path.join(directory, "data"), NETWORK_LENS_AUTO_PROTECT: "0" };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await _electron.launch({ executablePath: require("electron"), args: [root], env });
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  const overview = await page.evaluate(() => window.networkLens.security.securityOverview());
  overview.tools = overview.tools.filter(t => t.tool === "codex");
  Object.assign(overview.tools[0], { installed: true, canToggle: true, state: "needs_trust", note: "点击信任此防护即可完成" });
  await app.evaluate(({ ipcMain }, initial) => {
    globalThis.__trustUiCalls = 0;
    ipcMain.removeHandler("security-overview");
    ipcMain.handle("security-overview", () => initial);
    ipcMain.removeHandler("security-trust-codex");
    ipcMain.handle("security-trust-codex", async () => {
      globalThis.__trustUiCalls++;
      initial.tools[0].state = "enabled";
      initial.tools[0].note = "信任已保存，请重新打开 Codex 会话加载";
      return { message: "信任已保存，无需在 Codex 内操作。请重新打开 Codex 会话加载防护。", overview: initial };
    });
  }, overview);
  await page.getByRole("button", { name: "安全中心", exact: true }).click();
  await page.getByRole("tab", { name: "防护开关", exact: true }).click();
  await page.getByRole("button", { name: "信任此防护", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "信任已保存" }).waitFor();
  await page.getByRole("button", { name: "信任此防护", exact: true }).waitFor({ state: "detached" });
  assert.equal(await app.evaluate(() => globalThis.__trustUiCalls), 1);
  await page.getByRole("button", { name: "关闭", exact: true }).waitFor();
  await page.getByRole("button", { name: "规则自检", exact: true }).waitFor();
  assert.deepEqual(errors, []);
  const screenshot = path.join(directory, "codex-trust.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  console.log("PASS: 信任按钮通过真实 preload/IPC 调用一次，成功消息显示、状态刷新、按钮消失，关闭和自检仍可用，无页面异常。界面使用受控响应，真实 Codex 信任由独立集成测试验证。");
  console.log(`截图：${screenshot}`);
} finally { if (app) await app.close(); }
