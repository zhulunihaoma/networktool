// Isolated desktop verification: fixtures only; tool config changes disabled.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const root = path.resolve(import.meta.dirname, ".."),
  require = createRequire(path.join(root, "package.json"));
const { _electron, expect } = require("@playwright/test"),
  runtime = require("electron");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "nl-file-desktop-"));
const directory = path.join(temp, "fixtures"),
  data = path.join(temp, "data"),
  home = path.join(temp, "home");
await fs.mkdir(directory);
await fs.mkdir(home);
const filename = path.join(directory, "customer.csv");
const original =
  "email=demo@example.com\napi_key=fixture-only-value\nphone=13812345678\nname=Demo\n";
await fs.writeFile(filename, original);
const env = {
  ...process.env,
  NETWORK_LENS_DATA_DIR: data,
  NETWORK_LENS_TEST_HOME: home,
  NETWORK_LENS_AUTO_PROTECT: "0",
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await _electron.launch({ executablePath: runtime, args: [root], env });
  const page = await app.firstWindow(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.getByRole("button", { name: "安全中心", exact: true }).click();
  await page.getByRole("tab", { name: "文件策略", exact: true }).click();
  const board = page.getByRole("region", { name: "文件权限工作台" });
  // The workbench uses a named generic wrapper; select the visible instance.
  const area = page.locator(".fp-workbench:visible").first();
  await expect(
    area.getByRole("heading", { name: "让文件有边界，让工作继续" }),
  ).toBeVisible();
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [directory],
    });
  }, directory);
  await area
    .getByRole("button", { name: "选择项目或目录", exact: true })
    .click();
  await area.getByRole("button", { name: "确认并设置", exact: true }).click();
  await area.getByRole("button", { name: "本地处理任务", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "当前策略尚未发布" }),
  ).toHaveCount(0);
  await area
    .getByRole("button", { name: "文件发现与策略", exact: true })
    .click();
  await area.getByRole("button", { name: "确认并设置", exact: true }).click();
  await area
    .getByRole("button", { name: "办公资料 · 按需确认", exact: true })
    .click();
  await expect(
    area.getByRole("button", { name: "确认发布策略", exact: true }),
  ).toBeDisabled();
  await area
    .getByRole("button", { name: "试运行当前草稿", exact: true })
    .click();
  await expect(area.getByText("影响预览 · v0 → v1")).toBeVisible();
  await page.screenshot({
    path: path.join(temp, "policy.png"),
    fullPage: true,
  });
  await area.getByRole("button", { name: "确认发布策略", exact: true }).click();
  await page
    .getByRole("dialog", { name: "确认发布文件策略？" })
    .getByRole("button", { name: "确认", exact: true })
    .click();
  await expect(
    area.getByRole("button", { name: "确认发布策略", exact: true }),
  ).toBeDisabled();
  const saved = await page.evaluate(() => window.networkLens.fileWorkspace());
  assert.equal(saved.scopes[0].policies[0].read, "ask");
  assert.equal(saved.workflow.hook.state, "published");
  const child = spawnSync(
    runtime,
    [
      path.join(data, "security", "guard.cjs"),
      "--tool",
      "codex",
      "--data",
      path.join(data, "security"),
    ],
    {
      input: JSON.stringify({
        tool_name: "Read",
        tool_input: { file_path: filename },
        cwd: directory,
      }),
      encoding: "utf8",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      timeout: 10000,
    },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(
    JSON.parse(child.stdout).hookSpecificOutput.permissionDecision,
    "deny",
  );
  await area.getByRole("button", { name: "本地处理任务", exact: true }).click();
  async function approve() {
    await area
      .getByRole("button", { name: "仅授权这个任务", exact: true })
      .first()
      .click();
    const dialog = page.getByRole("dialog", { name: "仅授权这一个本地任务" });
    await dialog.getByLabel("授权原因").fill("仅验证临时测试文件");
    await dialog
      .getByRole("button", { name: "确认单次授权", exact: true })
      .click();
    await area
      .getByRole("button", { name: "执行已授权任务", exact: true })
      .first()
      .click();
  }
  await area
    .getByRole("button", { name: "读取并预览文本", exact: true })
    .click();
  await expect(area.getByText("待授权 · 未读取")).toBeVisible();
  await approve();
  const preview = page.getByRole("dialog", { name: "本地文本预览" });
  await expect(preview.locator("pre")).toContainText("fixture-only-value");
  await preview
    .getByRole("button", { name: "关闭预览并清除显示内容", exact: true })
    .click();
  await expect(area.getByText("本地处理完成", { exact: true })).toHaveCount(1);
  await area
    .getByRole("button", { name: "生成本地脱敏副本", exact: true })
    .click();
  await approve();
  const redacted = page.getByRole("dialog", { name: "审阅本地脱敏副本" });
  await expect(redacted.locator("pre")).not.toContainText("fixture-only-value");
  await expect(redacted.locator("pre")).not.toContainText("demo@example.com");
  await page.screenshot({
    path: path.join(temp, "redacted.png"),
    fullPage: true,
  });
  const output = path.join(temp, "redacted-copy.txt");
  await app.evaluate(({ dialog }, output) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: output });
  }, output);
  await redacted.getByRole("checkbox").check();
  await redacted
    .getByRole("button", { name: "选择新位置保存副本", exact: true })
    .click();
  await expect(redacted).not.toBeVisible();
  assert.ok(
    !(await fs.readFile(output, "utf8")).includes("fixture-only-value"),
  );
  assert.equal(await fs.readFile(filename, "utf8"), original);
  await area.getByRole("button", { name: "授权与记录", exact: true }).click();
  await expect(area.getByText(/已消费/)).toHaveCount(2);
  await area
    .getByRole("button", { name: "文件发现与策略", exact: true })
    .click();
  await fs.writeFile(filename, original + "updated\n");
  await area.getByRole("button", { name: "重新扫描", exact: true }).click();
  await expect(area.getByText("版本待确认 · 原规则保留")).toBeVisible();
  await area.getByRole("button", { name: "重新确认版本", exact: true }).click();
  await page
    .getByRole("dialog", { name: "重新确认文件版本？" })
    .getByRole("button", { name: "确认", exact: true })
    .click();
  await expect(area.getByText("已配置策略", { exact: true })).toBeVisible();
  const recovered = await page.evaluate(() =>
    window.networkLens.fileWorkspace(),
  );
  assert.equal(recovered.scopes[0].policies[0].revision, 2);
  await fs.unlink(path.join(data, "security", "file-policy-snapshot.json"));
  const missing = spawnSync(
    runtime,
    [
      path.join(data, "security", "guard.cjs"),
      "--tool",
      "codex",
      "--data",
      path.join(data, "security"),
    ],
    {
      input: JSON.stringify({
        tool_name: "Read",
        tool_input: { file_path: filename },
        cwd: directory,
      }),
      encoding: "utf8",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      timeout: 10000,
    },
  );
  assert.equal(
    JSON.parse(missing.stdout).hookSpecificOutput.permissionDecision,
    "deny",
  );
  await area.getByRole("button", { name: "覆盖与健康", exact: true }).click();
  await expect(area.getByText(/文件规则快照缺失、损坏/)).toBeVisible({
    timeout: 12000,
  });
  await area
    .getByRole("button", { name: "重新下发并核验", exact: true })
    .click();
  await expect(
    area.getByText(/当前文件规则快照已写入并回读一致/),
  ).toBeVisible();
  assert.equal(await fs.readFile(filename, "utf8"), original + "updated\n");
  await area.getByRole("button", { name: "保护工作台", exact: true }).click();
  await page.screenshot({
    path: path.join(temp, "overview.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 960, height: 900 });
  await page.screenshot({
    path: path.join(temp, "narrow.png"),
    fullPage: true,
  });
  assert.ok(await area.evaluate((e) => e.scrollWidth <= e.clientWidth + 2));
  assert.deepEqual(errors, []);
  console.log(
    "PASS: 正式 Electron 界面选择目录、真实扫描、试运行发布、打包钩子拒绝、单次授权、本地读取/脱敏回执、原件不变、新副本保存、记录与窄屏布局。",
  );
  console.log("Isolated screenshots and fixtures: " + temp);
} finally {
  await app?.close();
}
