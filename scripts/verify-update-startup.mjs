import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "package.json"));
const { _electron, expect } = require("@playwright/test");
const pkg = JSON.parse(
  await fs.readFile(path.join(root, "package.json"), "utf8"),
);
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "networktool-update-startup-"),
);
const mainPath = path.join(root, "dist-electron/main.cjs");
const mainSource = await fs.readFile(mainPath, "utf8");
const preload = await fs.readFile(
  path.join(root, "dist-electron/preload.cjs"),
  "utf8",
);
const legacy = preload.replace(
  '.exposeInMainWorld("networkLens", api)',
  '.exposeInMainWorld("networkLens", Object.fromEntries(Object.entries(api).filter(([key]) => key !== "appUpdate")))',
);
assert.notEqual(
  legacy,
  preload,
  "legacy preload fixture must actually remove the update API",
);
const legacyPath = path.join(temporary, "legacy-preload.cjs");
await fs.writeFile(legacyPath, legacy);
const errors = [];
let app;
try {
  for (const mode of ["legacy", "missing-handler", "timeout", "normal"]) {
    const home = path.join(temporary, mode, "home");
    await fs.mkdir(home, { recursive: true });
    const bootstrap = path.join(temporary, `${mode}.cjs`);
    const source =
      mode === "legacy"
        ? mainSource.replace(
            /preload: [^\n]+/,
            `preload: ${JSON.stringify(legacyPath)},`,
          )
        : mainSource;
    if (mode === "legacy") assert.notEqual(source, mainSource);
    await fs.writeFile(
      bootstrap,
      `const {app,net}=require('electron');const Module=require('node:module');app.setAppPath(${JSON.stringify(root)});app.setPath('home',${JSON.stringify(home)});net.fetch=async()=>new Response('',{status:503});const m=new Module(${JSON.stringify(mainPath)});m.filename=${JSON.stringify(mainPath)};m.paths=Module._nodeModulePaths(${JSON.stringify(path.dirname(mainPath))});m._compile(${JSON.stringify(source)},m.filename);`,
    );
    const env = {
      ...process.env,
      HOME: home,
      NETWORK_LENS_DATA_DIR: path.join(temporary, mode, "data"),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NETWORK_LENS_DEV;
    app = await _electron.launch({
      executablePath: require("electron"),
      args: [bootstrap],
      env,
      timeout: 30000,
    });
    const page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    if (mode === "missing-handler" || mode === "timeout") {
      await app.evaluate(({ ipcMain }, hang) => {
        ipcMain.removeHandler("app-update-state");
        if (hang)
          ipcMain.handle("app-update-state", () => new Promise(() => {}));
      }, mode === "timeout");
    }
    await page.getByRole("button", { name: "偏好设置", exact: true }).click();
    const panel = page.locator(".app-updates");
    await expect(panel.locator(".app-update-version")).toContainText(
      `v${pkg.version}`,
      { timeout: 9000 },
    );
    if (mode === "normal") {
      await expect(page.getByLabel("应用更新下载源")).toBeEnabled();
      await page.getByLabel("应用更新下载源").selectOption("gitee");
      await expect(panel.getByRole("status")).toContainText("下载源已保存");
      await page.getByLabel("应用更新下载源").selectOption("github");
      await expect(panel.getByRole("status")).toContainText("下载源已保存");
      await expect(
        panel.getByRole("button", { name: "检查更新", exact: true }),
      ).toBeEnabled();
      await page.screenshot({
        path: path.join(temporary, "startup-fixed.png"),
        fullPage: true,
      });
    } else {
      await expect(panel.getByRole("status")).toContainText("更新服务未连接", {
        timeout: 9000,
      });
      await expect(panel.locator(".app-update-version")).not.toContainText(
        "读取版本中",
      );
      await expect(panel.getByRole("alert")).toContainText("桌面应用");
      await expect(
        panel.getByRole("button", { name: "重新加载界面", exact: true }),
      ).toBeEnabled();
      await expect(page.getByLabel("应用更新下载源")).toBeDisabled();
    }
    await app.close();
    app = undefined;
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        passed: true,
        checks: [
          "legacy preload exact reproduction",
          "missing IPC handler",
          "initialization timeout exits loading state",
          "fallback version",
          "normal version",
          "Gitee and GitHub selection",
          "no renderer errors",
        ],
        artifacts: temporary,
      },
      null,
      2,
    ),
  );
} finally {
  await app?.close();
}
