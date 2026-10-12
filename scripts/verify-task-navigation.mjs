import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "package.json"));
const { _electron, expect } = require("@playwright/test");
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "network-lens-tasks-"),
);
const env = { ...process.env, NETWORK_LENS_DATA_DIR: temporary };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await _electron.launch({
    executablePath: require("electron"),
    args: [root],
    env,
  });
  const page = await app.firstWindow();
  await page.getByRole("heading", { name: "网络检查", exact: true }).waitFor();
  // Replace probes with a deterministic fixture in this isolated instance.
  await page.evaluate(() => window.networkLens.stopProviders());
  await app.evaluate(({ ipcMain }) => {
    const fixture = { id: "auto-fixture", status: "idle", results: [], endpointIds: [] };
    globalThis.providerFixture = { calls: 0, scopes: [], scan: fixture };
    ipcMain.removeHandler("providers");
    ipcMain.handle("providers", () => fixture);
    ipcMain.removeHandler("scan-providers");
    ipcMain.handle("scan-providers", (_event, id) => {
      globalThis.providerFixture.calls++;
      globalThis.providerFixture.scopes.push(id ?? "all");
      fixture.status = "running";
      return fixture;
    });
    ipcMain.removeHandler("stop-providers");
    ipcMain.handle("stop-providers", () => {
      fixture.status = "cancelled";
      return fixture;
    });
  });
  await page.reload();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const home = () =>
    page.getByRole("button", { name: "本机应用", exact: true }).click();
  await page.getByRole("heading", { name: "网络检查", exact: true }).waitFor();
  await expect(page.locator(".sidebar nav > button").first()).toHaveText("网络检查");
  await expect(page.locator(".installed-tools")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "停止检查", exact: true })).toBeVisible();
  assert.deepEqual(await app.evaluate(() => ({
    calls: globalThis.providerFixture.calls,
    scopes: globalThis.providerFixture.scopes,
  })), { calls: 1, scopes: ["all"] });
  await page.getByRole("button", { name: "停止检查", exact: true }).click();
  await expect(page.getByRole("heading", { name: "检查已停止，已完成结果保留" })).toBeVisible();
  await home();
  await page
    .getByRole("heading", { name: "本机应用", exact: true })
    .waitFor();
  await expect(page.locator(".task-card")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "刷新识别", exact: true }),
  ).toBeEnabled({ timeout: 30000 });
  const platformScan = await page.evaluate(() =>
    window.networkLens.platforms(),
  );
  assert.equal(platformScan.status, "idle");
  assert.equal(
    (await page.evaluate(() => window.networkLens.providers())).status,
    "cancelled",
  );
  await fs.mkdir(path.join(root, "docs/screenshots"), { recursive: true });
  await page.screenshot({
    path: path.join(root, "docs/screenshots/task-home.png"),
  });
  await page.getByRole("button", { name: "网络检查", exact: true }).click();
  await page.locator(".triage-toggle").click();
  await expect(page.locator(".triage-toggle")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await home();
  await page
    .locator(".installed-card")
    .first()
    .getByRole("button", { name: "检查相关模型服务", exact: true })
    .click();
  await expect(page.locator(".tool-network-context")).toContainText(
    "建议不是已读取的应用配置",
  );
  assert.ok(
    await page
      .locator(".tool-network-context")
      .evaluate((node) => node.getBoundingClientRect().top >= 0),
  );
  assert.equal(
    (await page.evaluate(() => window.networkLens.providers())).status,
    "cancelled",
  );
  assert.equal(await app.evaluate(() => globalThis.providerFixture.calls), 1);
  await page.screenshot({
    path: path.join(root, "docs/screenshots/task-network.png"),
  });
  await page
    .getByRole("button", { name: "返回应用列表并在原工具复测", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "本机应用", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "文件策略与审计", exact: true }).click();
  await expect(page.getByRole("note")).toContainText("不能监控、阻止");
  await home();
  // Fail only the isolated test instance's IPC, never the production implementation.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("platforms");
    ipcMain.handle("platforms", () => {
      throw new Error("fixture-platform-load-failed");
    });
  });
  await page
    .getByRole("button", { name: "文件策略与审计", exact: true })
    .click();
  await home();
  await expect(page.getByRole("alert")).toContainText(
    "fixture-platform-load-failed",
  );
  await expect(
    page.getByRole("button", { name: "刷新识别", exact: true }),
  ).toBeVisible();
  await app.evaluate(({ ipcMain }, scan) => {
    ipcMain.removeHandler("platforms");
    ipcMain.handle("platforms", () => scan);
  }, platformScan);
  await page.getByRole("button", { name: "重试加载", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("scan-providers");
    ipcMain.handle("scan-providers", () => {
      throw new Error("fixture-provider-check-failed");
    });
  });
  await page.getByRole("button", { name: "网络检查", exact: true }).click();
  await page.locator(".tool-health").first().getByRole("button", { name: "重新检查", exact: true }).click();
  await expect(page.locator(".persistent-error")).toContainText(
    "fixture-provider-check-failed",
  );
  await page.waitForTimeout(6200);
  await expect(page.locator(".persistent-error")).toBeVisible();
  await page.getByRole("button", { name: "关闭错误提示", exact: true }).click();
  await expect(page.locator(".persistent-error")).toHaveCount(0);
  const providerScan = await page.evaluate(() =>
    window.networkLens.providers(),
  );
  providerScan.status = "completed";
  providerScan.results = [
    {
      providerId: "openai",
      endpointId: "openai-api",
      effectiveUrl: "https://api.openai.com",
    },
    {
      providerId: "anthropic",
      endpointId: "anthropic-api",
      effectiveUrl: "https://api.anthropic.com",
    },
  ].map((value) => ({
    ...value,
    status: "auth_required",
    urlSource: "default",
    summary: "fixture",
    suggestion: "在原工具中复测",
    route: "系统网络",
    evidence: [],
    httpStatus: 401,
    checkedAt: Date.now(),
  }));
  await app.evaluate(({ ipcMain }, scan) => {
    ipcMain.removeHandler("providers");
    ipcMain.handle("providers", () => scan);
    ipcMain.removeHandler("copy-provider-result");
    ipcMain.handle("copy-provider-result", () => undefined);
  }, providerScan);
  await home();
  await page.getByRole("button", { name: "网络检查", exact: true }).click();
  const firstResult = page
    .locator(".tool-card")
    .filter({
      has: page.getByRole("heading", { name: "OpenAI", exact: true }),
    });
  const secondResult = page
    .locator(".tool-card")
    .filter({
      has: page.getByRole("heading", { name: "Anthropic", exact: true }),
    });
  await firstResult
    .getByRole("button", { name: "复制结果给 IT", exact: true })
    .click();
  await expect(
    firstResult.getByRole("button", { name: "已复制", exact: true }),
  ).toBeVisible();
  await expect(
    secondResult.getByRole("button", { name: "复制结果给 IT", exact: true }),
  ).toBeVisible();
  await expect(
    firstResult.getByRole("button", { name: "复制结果给 IT", exact: true }),
  ).toBeVisible({ timeout: 5000 });
  const overview = await page.evaluate(() => window.networkLens.overview());
  overview.sessions = [
    {
      id: "fixture-session",
      name: "fixture-record",
      target: "https://example.test",
      status: "completed",
      started: Date.now(),
      mode: "diagnose",
      findings: [],
    },
  ];
  await app.evaluate(({ ipcMain }, value) => {
    ipcMain.removeHandler("overview");
    ipcMain.handle("overview", () => value);
    ipcMain.removeHandler("remove");
    ipcMain.handle("remove", () => {
      throw new Error("fixture-delete-failed");
    });
  }, overview);
  await page.reload();
  await page.getByRole("heading", { name: "网络检查", exact: true }).waitFor();
  await page.getByRole("button", { name: "诊断历史", exact: true }).click();
  await page
    .getByRole("button", { name: "删除 fixture-record", exact: true })
    .click();
  await page.getByRole("button", { name: "删除记录", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator(".persistent-error")).toContainText(
    "fixture-delete-failed",
  );
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "关闭错误提示", exact: true }).click();
  await home();
  await page.setViewportSize({ width: 1024, height: 720 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: path.join(root, "docs/screenshots/task-home-narrow.png"),
  });
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("overview");
    ipcMain.handle("overview", () => {
      throw new Error("fixture-overview-load-failed");
    });
  });
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("fixture-overview-load-failed");
  await app.evaluate(({ ipcMain }, value) => {
    ipcMain.removeHandler("overview");
    ipcMain.handle("overview", () => value);
  }, overview);
  await page.getByRole("button", { name: "重试加载", exact: true }).click();
  await page.getByRole("heading", { name: "网络检查", exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        networkFirstNavigation: true,
        separateApplications: true,
        toolContext: true,
        automaticFullProviderProbe: true,
        noRestartOnNavigation: true,
        stopAutomaticProbe: true,
        noAutomaticWebProbe: true,
        expandedTriage: true,
        loadFailureRecovery: true,
        overviewFailureRecovery: true,
        persistentError: true,
        copyFeedbackIsolation: true,
        deleteFailurePreservesDialog: true,
        narrowLayout: true,
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  await app?.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
