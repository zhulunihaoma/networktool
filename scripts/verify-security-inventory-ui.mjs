// Real Electron IPC with temporary tool configurations; never writes user configs.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "package.json"));
const { _electron, expect } = require("@playwright/test");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nl-inventory-ui-"));
const home = path.join(directory, "home");
const data = path.join(directory, "data");
const baselinePath = path.join(data, "security", "inventory.json");
const write = async (name, value) => {
  const file = path.join(home, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    typeof value === "string" ? value : JSON.stringify(value),
  );
};
await write(".claude.json", {
  mcpServers: {
    changed: { url: "https://before.example.test/mcp" },
    removed: { command: "npx", args: ["example-server"] },
  },
});
await write(".config/opencode/opencode.json", {
  baseURL: "https://before.example.test/v1",
});
const env = {
  ...process.env,
  NETWORK_LENS_DATA_DIR: data,
  NETWORK_LENS_TEST_HOME: home,
  NETWORK_LENS_AUTO_PROTECT: "0",
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
const errors = [];
const open = async () => {
  app = await _electron.launch({
    executablePath: require("electron"),
    args: [root],
    env,
  });
  const page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.getByRole("button", { name: "安全中心", exact: true }).click();
  await page.getByRole("tab", { name: "变更巡检", exact: true }).click();
  return page;
};
try {
  let page = await open();
  let panel = page.locator(".inventory-panel");
  await expect(panel.getByLabel("能发现哪些变化")).toBeVisible();
  await expect(panel.getByLabel("使用步骤")).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "将当前配置设为新基线" }),
  ).toHaveCount(0);
  await panel
    .getByRole("button", { name: "建立配置基线", exact: true })
    .click();
  await expect(
    panel.getByText("与基线相比，未发现配置变化", { exact: true }),
  ).toBeVisible();
  await panel.screenshot({ path: path.join(directory, "baseline.png") });
  const originalBaseline = await fs.readFile(baselinePath, "utf8");
  await write(".claude.json", {
    mcpServers: {
      changed: { url: "https://after.example.test/mcp" },
      added: { command: "npx", args: ["new-server"] },
    },
  });
  await write(".config/opencode/opencode.json", {
    baseURL: "https://after.example.test/v1",
    plugin: ["example-plugin"],
  });
  await panel
    .getByRole("button", { name: "检查配置变化", exact: true })
    .click();
  await expect(
    panel.getByText("有 7 项配置变化待核对", { exact: true }),
  ).toBeVisible();
  await expect(panel.locator(".inventory-item")).toHaveCount(7);
  await panel.getByLabel("筛选工具").selectOption("claude");
  await expect(panel.locator(".inventory-item")).toHaveCount(4);
  await expect(
    panel.getByText("https://after.example.test/mcp", { exact: true }),
  ).toBeVisible();
  await panel.getByLabel("筛选工具").selectOption("all");
  const update = () =>
    panel
      .getByRole("button", { name: "将当前配置设为新基线", exact: true })
      .click();
  await update();
  await expect(
    page.getByRole("dialog", { name: "确认更新配置基线？" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "继续核对", exact: true }).click();
  assert.equal(await fs.readFile(baselinePath, "utf8"), originalBaseline);
  await expect(
    panel.getByRole("button", { name: "将当前配置设为新基线", exact: true }),
  ).toBeFocused();
  await panel.screenshot({ path: path.join(directory, "changes.png") });
  for (const width of [1920, 1366, 1280, 900]) {
    await page.setViewportSize({ width, height: 1080 });
    assert.ok(
      await panel.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      `panel overflows at ${width}`,
    );
  }
  await panel.screenshot({ path: path.join(directory, "narrow.png") });
  await write(".claude.json", "{broken");
  await panel
    .getByRole("button", { name: "检查配置变化", exact: true })
    .click();
  await expect(panel.getByRole("alert")).toContainText("检查未完成");
  await expect(panel.getByRole("alert")).toContainText(
    "下方保留上次成功检查的结果",
  );
  await expect(
    panel.getByRole("button", { name: "将当前配置设为新基线", exact: true }),
  ).toBeDisabled();
  assert.equal(await fs.readFile(baselinePath, "utf8"), originalBaseline);
  await write(".claude.json", {
    mcpServers: { changed: { url: "https://after.example.test/mcp" } },
  });
  await panel.getByRole("button", { name: "重试检查", exact: true }).click();
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await update();
  await page.getByRole("button", { name: "确认更新基线", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    panel.getByText("与基线相比，未发现配置变化", { exact: true }),
  ).toBeVisible();
  assert.notEqual(await fs.readFile(baselinePath, "utf8"), originalBaseline);
  await app.close();
  app = undefined;
  page = await open();
  panel = page.locator(".inventory-panel");
  await expect(
    panel.getByText("与基线相比，未发现配置变化", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "建立配置基线", exact: true }),
  ).toHaveCount(0);
  await fs.unlink(path.join(home, ".claude.json"));
  await fs.unlink(path.join(home, ".config/opencode/opencode.json"));
  await panel
    .getByRole("button", { name: "检查配置变化", exact: true })
    .click();
  await expect(panel.getByText(/有 \d+ 项配置变化待核对/)).toBeVisible();
  await update();
  await page.getByRole("button", { name: "确认更新基线", exact: true }).click();
  await expect(
    panel.getByText("未读取到受支持的配置项", { exact: true }),
  ).toBeVisible();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: 首次引导、真实配置差异、工具筛选、基线确认/取消、焦点恢复、失败保留与重试、重启恢复、空配置提示、窄屏布局；无页面异常。",
  );
  console.log(`截图：${directory}`);
} finally {
  if (app) await app.close();
}
