import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "package.json"));
const { _electron } = require("@playwright/test");
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "network-lens-assistant-ui-"),
);
const fixture = path.join(temporary, "project");
await fs.mkdir(fixture);
await fs.writeFile(
  path.join(fixture, ".env"),
  "SECRET=fixture-never-displayed",
);
await fs.writeFile(
  path.join(fixture, "private.key"),
  "fixture-key-never-displayed",
);
let app;
try {
  app = await _electron.launch({
    executablePath: require("electron"),
    args: [root],
    env: {
      ...process.env,
      NETWORK_LENS_DATA_DIR: path.join(temporary, "data"),
    },
    timeout: 30000,
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("button", { name: "本机应用", exact: true }).click();
  await page
    .getByRole("heading", { name: "本机应用", exact: true })
    .waitFor();
  await page.waitForFunction(
    () =>
      !document.querySelector(".installed-tools button.secondary")?.disabled,
  );
  const inventory = await page.evaluate(() => window.networkLens.tools());
  assert.ok(inventory.checkedAt);
  assert.equal(
    (await page.evaluate(() => window.networkLens.platforms())).status,
    "idle",
  );
  await fs.mkdir(path.join(root, "docs/screenshots"), { recursive: true });
  let contextFrozen = false;
  if (
    inventory.installs.some((i) =>
      ["installed_confirmed", "running_confirmed"].includes(i.identityStatus),
    )
  ) {
    await page.getByRole("button", { name: "查看组件与覆盖" }).first().click();
    await page.getByText("网关或供应商 · 未确认", { exact: true }).waitFor();
    await page.screenshot({
      path: path.join(root, "docs/screenshots/installed-tools.png"),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "诊断所选功能", exact: true })
      .click();
    await page
      .getByPlaceholder("例如：api.openai.com 或 https://github.com")
      .fill("https://example.test/");
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await page.getByRole("button", { name: "开始观察", exact: true }).click();
    await page.getByText(/^冻结的工具范围：/).waitFor();
    const diagnosis = await page.evaluate(
      async () => (await window.networkLens.overview()).sessions[0],
    );
    assert.equal(diagnosis.toolContext.feature, "model");
    assert.equal(diagnosis.toolContext.adapterStatus, "unknown");
    assert.equal(diagnosis.toolContext.version, inventory.installs[0].version);
    contextFrozen = true;
    await page.getByRole("button", { name: "取消诊断", exact: true }).click();
    await page.getByRole("button", { name: "本机应用", exact: true }).click();
    await page.getByRole("button", { name: "查看组件与覆盖" }).first().click();
    await page.getByRole("button", { name: "文件保护", exact: true }).click();
    await page
      .getByRole("button", { name: "设置文件范围与策略", exact: true })
      .click();
  } else
    await page
      .getByRole("button", { name: "文件策略与审计", exact: true })
      .click();
  await page.getByRole("heading", { name: "文件策略与访问记录" }).waitFor();
  // Replace only the native picker in this isolated verification instance. Production still uses the picker.
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [directory],
    });
  }, fixture);
  await page.getByRole("button", { name: "选择项目或目录" }).click();
  await page.getByRole("button", { name: /^\.env 环境配置/ }).click();
  await page
    .getByRole("combobox", { name: "读取策略", exact: true })
    .selectOption("allow");
  await page.getByRole("button", { name: "保存策略", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "策略已保存" }).waitFor();
  await page.getByRole("button", { name: "修改自检", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "策略自检：修改禁止" })
    .waitFor();
  const workspace = await page.evaluate(() =>
    window.networkLens.fileWorkspace(),
  );
  assert.equal(workspace.coverage.canBlockToolAccess, false);
  assert.equal(workspace.scopes[0].policies[0].read, "allow");
  assert.equal(workspace.scopes[0].policies[0].write, "deny");
  assert.equal(workspace.scopes[0].policies[0].disclose, "deny");
  assert.equal(workspace.alerts.length, 1);
  const previewBeforeAcknowledge = await page.evaluate(() =>
    window.networkLens.previewFileAudit(undefined, "json"),
  );
  assert.ok(
    !(await page.locator("body").innerText()).includes(
      "fixture-never-displayed",
    ),
  );
  const rejected = await page.evaluate(async () => {
    const workspace = await window.networkLens.fileWorkspace();
    const scope = workspace.scopes[0],
      candidate = scope.candidates[0];
    const results = [];
    try {
      await window.networkLens.saveFilePolicy(
        scope.id,
        {
          resourceId: candidate.id,
          read: "allow",
          write: "allow",
          disclose: "allow",
          enabled: true,
          path: "/tmp/unauthorized",
        },
        0,
      );
    } catch {
      results.push("arbitrary-path");
    }
    try {
      await window.networkLens.evaluateFilePolicy(
        scope.id,
        candidate.id,
        "shell",
      );
    } catch {
      results.push("unknown-operation");
    }
    try {
      await window.networkLens.saveFilePolicy(
        scope.id,
        {
          resourceId: candidate.id,
          read: "allow",
          write: "allow",
          disclose: "allow",
          enabled: true,
        },
        0,
      );
    } catch {
      results.push("stale-revision");
    }
    return results;
  });
  assert.deepEqual(rejected, [
    "arbitrary-path",
    "unknown-operation",
    "stale-revision",
  ]);
  await fs.mkdir(path.join(root, "docs/screenshots"), { recursive: true });
  await page.screenshot({
    path: path.join(root, "docs/screenshots/file-policies.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "自检提醒 (1)", exact: true }).click();
  await page.getByRole("button", { name: "确认提醒", exact: true }).click();
  await page.getByRole("button", { name: "已确认", exact: true }).waitFor();
  const staleRejected = await page.evaluate(async (digest) => {
    try {
      await window.networkLens.exportFileAudit(undefined, digest, "json");
      return false;
    } catch {
      return true;
    }
  }, previewBeforeAcknowledge.digest);
  assert.equal(staleRejected, true);
  await page.getByRole("button", { name: "审计时间线", exact: true }).click();
  await page
    .getByRole("combobox", { name: "按操作筛选审计" })
    .selectOption("write");
  await page.getByText("修改 · 策略自检拒绝", { exact: true }).waitFor();
  await page.screenshot({
    path: path.join(root, "docs/screenshots/file-audit.png"),
    fullPage: true,
  });
  await app.evaluate(
    ({ dialog }, filename) => {
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: filename,
      });
    },
    path.join(temporary, "audit.md"),
  );
  await page
    .getByRole("button", { name: "预览脱敏审计报告", exact: true })
    .click();
  const shownReport = await page.locator(".report-preview").innerText();
  assert.ok(
    !shownReport.includes(fixture) &&
      !shownReport.includes("private.key") &&
      !shownReport.includes("fixture-never-displayed"),
  );
  await page
    .getByRole("button", { name: "选择位置并保存", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "审计报告已保存" })
    .waitFor();
  assert.equal(
    await fs.readFile(path.join(temporary, "audit.md"), "utf8"),
    shownReport,
  );
  await page.setViewportSize({ width: 1024, height: 720 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  const result = {
    verifiedAt: new Date().toISOString(),
    mode: "native-electron-fixture",
    platform: process.platform,
    discovered: inventory.installs.map((i) => ({
      productId: i.productId,
      status: i.identityStatus,
      version: i.version,
    })),
    scopeCount: workspace.scopes.length,
    candidates: workspace.scopes[0].candidates.length,
    separatePolicies: true,
    fileContentsNotDisplayed: true,
    canBlockToolAccess: false,
    contextFrozen,
    exportPreviewMatchesSavedFile: true,
    staleAuditPreviewRejected: staleRejected,
    rejected,
    errors,
  };
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(root, "docs/validation/ASSISTANT-UI-result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (app) await app.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
