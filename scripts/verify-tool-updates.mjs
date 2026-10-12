import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "package.json"));
const { _electron } = require("@playwright/test");
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "network-lens-tools-ui-"),
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
  const page = await app.firstWindow(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByRole("button", { name: "本机应用", exact: true }).click();
  await page
    .getByRole("heading", { name: "本机应用", exact: true })
    .waitFor();
  await page.waitForFunction(
    () =>
      !document.querySelector(".installed-tools .tool-actions button")
        ?.disabled,
    {},
    { timeout: 30000 },
  );
  const inventory = await page.evaluate(() => window.networkLens.tools());
  const installed = inventory.installs.filter((t) =>
    ["installed_confirmed", "running_confirmed"].includes(t.identityStatus),
  );
  const minimum = [
    "codex",
    "claude-desktop",
    "opencode",
    "workbuddy",
    "wiscode",
    "dsh-desktop",
    "deepseek-harness",
    "cc-switch",
    "namiai",
    "vscode",
  ];
  // This machine's real macOS installation evidence. Other environments skip these host-specific assertions.
  if (
    process.platform === "darwin" &&
    (await fs.stat("/Applications/WorkBuddy.app").catch(() => undefined))
  ) {
    for (const id of minimum)
      assert.ok(
        installed.some((t) => t.productId === id),
        `not found: ${id}`,
      );
    assert.ok(
      installed
        .filter((t) => t.productId === "opencode")
        .some((t) => t.components[0].role === "cli"),
    );
    assert.ok(
      installed.filter((t) => t.productId === "claude-code").length >= 2,
    );
  }
  assert.ok(installed.every((t) => t.version));
  assert.ok(
    installed.some(
      (t) =>
        t.identityStatus === "installed_confirmed" && !t.processKeys.length,
    ),
  );
  assert.equal(
    (await page.evaluate(() => window.networkLens.platforms())).status,
    "idle",
  );
  const candidatesBefore = inventory.installs
    .filter((t) => t.identityStatus === "candidate")
    .map((t) => t.id);
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await page
    .getByRole("button", { name: "检查更新", exact: true })
    .waitFor({ state: "visible", timeout: 60000 });
  await page.waitForFunction(
    () =>
      !document.querySelector(".installed-tools .tool-actions button")
        ?.disabled,
    {},
    { timeout: 60000 },
  );
  const result = await page.evaluate(() => window.networkLens.tools());
  assert.ok(result.installs.every((t) => t.update));
  assert.ok(
    result.installs
      .filter((t) => candidatesBefore.includes(t.id))
      .every((t) => t.update.status === "unknown"),
  );
  const confirmed = result.installs.filter((t) =>
    ["installed_confirmed", "running_confirmed"].includes(t.identityStatus),
  );
  assert.ok(confirmed.every((t) => t.update.status !== "not_checked"));
  assert.ok(
    confirmed
      .filter((t) =>
        ["available", "current", "installed_newer"].includes(t.update.status),
      )
      .every(
        (t) => t.update.latestVersion && t.update.checkedAt && t.update.source,
      ),
  );
  const available = confirmed.filter(
    (t) =>
      t.update.status === "available" ||
      t.components.some((c) => c.update?.status === "available"),
  );
  await page
    .getByRole("button", {
      name: `有新版本 (${available.length})`,
      exact: true,
    })
    .click();
  assert.equal(await page.locator(".installed-card").count(), available.length);
  await page.getByRole("button", { name: "已安装", exact: true }).click();
  await page.getByRole("button", { name: "查看组件与覆盖" }).first().click();
  await page
    .getByRole("heading", { name: "版本与更新", exact: true })
    .waitFor();
  await fs.mkdir(path.join(root, "docs/screenshots"), { recursive: true });
  await page.locator(".installed-tools").screenshot({
    path: path.join(root, "docs/screenshots/tool-discovery-updates.png"),
  });
  await page.setViewportSize({ width: 1024, height: 720 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  assert.deepEqual(errors, []);
  const output = {
    verifiedAt: new Date().toISOString(),
    platform: process.platform,
    installedCount: confirmed.length,
    notRunningCount: confirmed.filter((t) => !t.processKeys.length).length,
    tools: result.installs.map((t) => ({
      productId: t.productId,
      role: t.components[0]?.role,
      status: t.identityStatus,
      version: t.version,
      update: t.update,
      components: t.components
        .filter((c) => c.role === "extension")
        .map((c) => ({ name: c.name, version: c.version, update: c.update })),
    })),
    errors,
  };
  await fs.writeFile(
    path.join(root, "docs/validation/TOOL-DISCOVERY-result.json"),
    JSON.stringify(output, null, 2),
  );
  console.log(JSON.stringify(output, null, 2));
} finally {
  if (app) await app.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
