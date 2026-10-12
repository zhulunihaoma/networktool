import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "package.json"));
const { _electron, expect } = require("@playwright/test");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "network-lens-handoff-ui-"));
const file = path.join(directory, "source.json");
await fs.writeFile(file, JSON.stringify({ info: { id: "ses_fixture", title: "UI 接续测试", directory: root }, messages: [{ info: { id: "msg_fixture", role: "user" }, parts: [{ type: "text", text: "测试接续，不运行命令。api_key=example-secret-value" }] }] }));
const env = { ...process.env, NETWORK_LENS_DATA_DIR: directory };
delete env.ELECTRON_RUN_AS_NODE;
let app;
let originalClipboard;
try {
  app = await _electron.launch({ executablePath: require("electron"), args: [root], env });
  const page = await app.firstWindow();
  await page.getByRole("heading", { name: "网络检查", exact: true }).waitFor();
  await page.evaluate(() => window.networkLens.stopProviders());
  originalClipboard = await app.evaluate(({ clipboard }) => clipboard.readText());
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, file);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.getByRole("button", { name: "任务接续", exact: true }).click();
  await expect(page.getByRole("heading", { name: "任务接续", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "生成交接预览" })).toHaveCount(0);
  await page.getByRole("button", { name: "导入导出 JSON" }).click();
  await expect(page.getByText("UI 接续测试", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "生成交接预览" })).toBeDisabled();
  await page.getByLabel("我确认原工具已停止", { exact: false }).check();
  await page.getByLabel("我已在目标工具打开同一工作区", { exact: false }).check();
  await page.getByRole("button", { name: "生成交接预览" }).click();
  const content = await page.locator(".handoff-preview pre").innerText();
  assert.match(content, /已脱敏/); assert.doesNotMatch(content, /example-secret-value/);
  await expect(page.getByRole("button", { name: "确认并复制交接内容" })).toBeDisabled();
  await page.getByLabel("我已检查全文和敏感信息", { exact: false }).check();
  await page.getByRole("button", { name: "确认并复制交接内容" }).click();
  await expect(page.getByRole("button", { name: "已复制，尚未发送", exact: true })).toBeDisabled();
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), content);
  await page.getByRole("button", { name: "本机应用", exact: true }).click();
  await page.getByRole("button", { name: "任务接续", exact: true }).click();
  await expect(page.getByText("UI 接续测试", { exact: true })).toBeVisible();
  await page.getByLabel("本次继续做什么").fill("新目标");
  await expect(page.locator(".handoff-preview")).toHaveCount(0);
  await page.getByRole("button", { name: "生成交接预览" }).click();
  await expect(page.locator(".handoff-preview pre")).toContainText("新目标");
  await page.screenshot({ path: path.join(directory, "handoff.png"), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(`Task handoff Electron checks passed. Screenshot: ${path.join(directory, "handoff.png")}`);
} finally {
  if (app && originalClipboard !== undefined) await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), originalClipboard).catch(() => {});
  if (app) await app.close();
  // Keep only screenshot evidence; remove fixture and isolated user data.
  for (const entry of await fs.readdir(directory)) if (entry !== "handoff.png") await fs.rm(path.join(directory, entry), { recursive: true, force: true });
}
