import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "package.json"));
const { _electron, expect } = require("@playwright/test");
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "network-lens-drawer-"),
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
  await expect(
    page.getByRole("button", { name: "刷新识别", exact: true }),
  ).toBeEnabled({ timeout: 30000 });
  const card = page.locator(".installed-card").first();
  const action = card.getByRole("button", { name: "查看组件与覆盖" });
  const selection = card.locator(".tool-card-select");
  const dialog = page.getByRole("dialog");
  await card.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  const beforeHover = await card.evaluate(
    (node) => getComputedStyle(node).boxShadow,
  );
  await card.hover();
  await expect
    .poll(() => card.evaluate((node) => getComputedStyle(node).boxShadow))
    .not.toBe(beforeHover);
  // The card surface selects and opens details; pinning remains independent.
  await card.locator("p").first().click();
  await expect(selection).toHaveAttribute("aria-pressed", "true");
  await expect(dialog).toBeVisible();
  await expect(page.locator(".installed-card.selected")).toHaveCount(1);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const pin = card.getByRole("button", { name: /置顶/ });
  const pinned = await pin.getAttribute("aria-pressed");
  await pin.click();
  await expect(pin).toHaveAttribute(
    "aria-pressed",
    pinned === "true" ? "false" : "true",
  );
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "刷新识别", exact: true }),
  ).toBeEnabled();
  await pin.click();
  await expect(pin).toHaveAttribute("aria-pressed", pinned);

  await action.click();
  await expect(dialog).toBeVisible();
  await expect(action).toHaveAttribute("aria-expanded", "true");
  await expect(
    dialog.getByRole("button", { name: "关闭", exact: true }),
  ).toBeFocused();
  await expect
    .poll(async () => {
      const bounds = await dialog.boundingBox();
      return Math.abs(
        bounds.x + bounds.width - (await page.evaluate(() => innerWidth)),
      );
    })
    .toBeLessThan(1);
  assert.equal(
    await page.evaluate(() => document.body.style.overflow),
    "hidden",
  );
  const focusables = dialog.locator(
    'button:enabled, a[href], input:enabled, select:enabled, textarea:enabled, summary, [tabindex="0"]',
  );
  await focusables.last().focus();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "关闭", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(focusables.last()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(action).toBeFocused();
  await expect(card).toHaveClass(/selected/);
  assert.equal(await page.evaluate(() => document.body.style.overflow), "");

  await action.click();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await action.click();
  await page.locator(".drawer-backdrop").click({ position: { x: 20, y: 400 } });
  await expect(dialog).toHaveCount(0);

  const second = page.locator(".installed-card").nth(1);
  await second.locator(".tool-card-select").focus();
  await page.keyboard.press("Enter");
  await expect(second.locator(".tool-card-select")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(selection).toHaveAttribute("aria-pressed", "false");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await action.focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await page.setViewportSize({ width: 1024, height: 720 });
  const scroll = await page
    .locator(".tool-drawer-content")
    .evaluate((node) => ({
      height: node.clientHeight,
      content: node.scrollHeight,
      width: node.clientWidth,
      scrollWidth: node.scrollWidth,
    }));
  assert.ok(scroll.content > scroll.height);
  assert.ok(scroll.scrollWidth <= scroll.width);
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await fs.mkdir(path.join(root, "docs/screenshots"), { recursive: true });
  await page.screenshot({
    path: path.join(root, "docs/screenshots/tool-drawer.png"),
  });

  await dialog
    .getByRole("button", { name: "诊断所选功能", exact: true })
    .click();
  await expect(page.locator(".tool-drawer")).toHaveCount(0);
  await expect(dialog).toHaveCount(1);
  await expect(
    dialog.getByRole("button", { name: "关闭", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  assert.equal(await page.evaluate(() => document.body.style.overflow), "");

  await action.click();
  await dialog.getByRole("button", { name: "文件保护", exact: true }).click();
  await dialog
    .getByRole("button", { name: "设置文件范围与策略", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "文件策略与访问记录" }),
  ).toBeVisible();
  await expect(dialog).toHaveCount(0);
  assert.equal(await page.evaluate(() => document.body.style.overflow), "");
  assert.deepEqual(errors, []);
  const result = {
    verifiedAt: new Date().toISOString(),
    mode: "native-electron-isolated-data",
    hoverFeedback: true,
    pointerAndKeyboardSelection: true,
    independentPinAction: true,
    rightDrawer: true,
    escapeBackdropAndCloseButton: true,
    focusTrapAndRestore: true,
    selectedStateRetained: true,
    narrowViewportScroll: scroll,
    diagnosisAndFileNavigation: true,
    errors,
  };
  await fs.mkdir(path.join(root, "docs/validation"), { recursive: true });
  await fs.writeFile(
    path.join(root, "docs/validation/TOOL-DRAWER-result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (app) await app.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
