/** Isolated UI acceptance: local fixtures, no network, restore every clipboard format. */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const root = path.resolve(import.meta.dirname, ".."),
  require = createRequire(path.join(root, "package.json"));
const { _electron, expect } = require("@playwright/test");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-guidance-"));
const home = path.join(temporary, "home"),
  output = path.join(temporary, "exports with spaces");
await fs.mkdir(home, { recursive: true });
await fs.mkdir(output);
const source = path.join(temporary, "conversation.json"),
  manual = path.join(temporary, "requirements.txt");
await fs.writeFile(manual, "任务进度：37，下一步加 5。");
await fs.writeFile(
  source,
  JSON.stringify({
    info: {
      id: "ses_guidance",
      title: "任务接续体验验收",
      directory: "/fixture/project",
    },
    messages: [
      {
        info: { id: "msg_guidance", role: "user" },
        parts: [
          { type: "text", text: "从 37 继续，接下来加 5。" },
          {
            type: "file",
            filename: "requirements.txt",
            mime: "text/plain",
            url: `data:text/plain;base64,${Buffer.from("任务进度：37，下一步加 5。").toString("base64")}`,
          },
        ],
      },
    ],
  }),
);
const bootstrap = path.join(temporary, "bootstrap.cjs");
await fs.writeFile(
  bootstrap,
  `const {app,dialog,net}=require('electron');app.setAppPath(${JSON.stringify(root)});app.setPath('home',${JSON.stringify(home)});net.fetch=async()=>{throw new Error('network disabled')};dialog.showOpenDialog=async(_window,opts)=>{if(opts.properties.includes('openDirectory')){if(globalThis.cancelExport){globalThis.cancelExport=false;return {canceled:true,filePaths:[]}}return {canceled:false,filePaths:[${JSON.stringify(output)}]}}return {canceled:false,filePaths:[opts.title.includes('补充')?${JSON.stringify(manual)}:${JSON.stringify(source)}]}};require(${JSON.stringify(path.join(root, "dist-electron/main.cjs"))});`,
);
const env = {
  ...process.env,
  HOME: home,
  PATH: "/usr/bin:/bin",
  NETWORK_LENS_DATA_DIR: path.join(temporary, "data"),
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.NETWORK_LENS_DEV;
let app;
try {
  app = await _electron.launch({
    executablePath: require("electron"),
    args: [bootstrap],
    env,
  });
  const page = await app.firstWindow(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "任务接续", exact: true }).click();
  await expect(page.getByRole("button", { name: "识别本机工具" })).toBeEnabled({
    timeout: 30000,
  });
  await expect(
    page.getByRole("region", { name: "任务接续使用方法" }),
  ).toContainText("自动复制到剪贴板");
  await page.screenshot({ path: path.join(temporary, "guide.png") });
  await app.evaluate(async ({ clipboard, ClipboardItem }) => {
    globalThis.guidanceClipboard = await Promise.all(
      (await clipboard.read())
        .filter((i) => i.types.length)
        .map(
          async (i) =>
            new ClipboardItem(
              Object.fromEntries(
                await Promise.all(
                  i.types.map(async (t) => [t, await i.getType(t)]),
                ),
              ),
            ),
        ),
    );
  });
  await page.getByRole("button", { name: "导入 JSON", exact: true }).click();
  const dialog = page.getByRole("dialog"),
    pack = dialog.getByRole("checkbox", { name: /同时打包附件/ });
  await expect(dialog).toContainText("可打包 1 条");
  await expect(dialog.getByRole("checkbox", { name: /本次接续目标/ })).toHaveCount(0);
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 1024, height: 720 },
    { width: 1024, height: 600 },
    { width: 700, height: 720 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(
      dialog.getByRole("button", { name: "生成接续预览" }),
    ).toBeInViewport({ ratio: 1 });
    await expect(
      dialog.getByRole("button", { name: "需要带附件？点此选择" }),
    ).toBeInViewport({ ratio: 1 });
    const bounds = await dialog.evaluate((e) => ({
      width: e.clientWidth,
      scroll: e.scrollWidth,
      right: e.getBoundingClientRect().right,
      viewport: innerWidth,
    }));
    assert(
      bounds.scroll <= bounds.width + 1 && bounds.right <= bounds.viewport,
      JSON.stringify(bounds),
    );
    await page.screenshot({
      path: path.join(
        temporary,
        `configure-${viewport.width}-${viewport.height}.png`,
      ),
    });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await dialog.getByRole("button", { name: "需要带附件？点此选择" }).click();
  await expect(pack).toBeInViewport({ ratio: 1 });
  await pack.check();
  await expect(dialog.getByRole("note")).toContainText("无需搬动文件");
  await dialog.getByRole("button", { name: "生成接续预览" }).click();
  const exportButton = dialog.getByRole("button", {
    name: "导出附件并复制",
    exact: true,
  });
  await dialog.getByRole("checkbox", { name: /已检查所选附件/ }).uncheck();
  await expect(exportButton).toBeDisabled();
  await dialog.getByRole("checkbox", { name: /已检查所选附件/ }).check();
  await app.evaluate(() => {
    globalThis.cancelExport = true;
  });
  const beforeCancel = await app.evaluate(({ clipboard }) =>
    clipboard.readText(),
  );
  await exportButton.click();
  await expect(exportButton).toBeEnabled();
  assert.equal((await fs.readdir(output)).length, 0);
  assert.equal(
    await app.evaluate(({ clipboard }) => clipboard.readText()),
    beforeCancel,
  );
  // Fail only the isolated IPC once: saving must survive a failed automatic copy.
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get("handoff-copy");
    ipcMain.removeHandler("handoff-copy");
    ipcMain.handle("handoff-copy", (...args) => {
      ipcMain.removeHandler("handoff-copy");
      ipcMain.handle("handoff-copy", original);
      throw new Error("fixture clipboard unavailable");
    });
  });
  await exportButton.click();
  await expect(dialog.getByRole("alert")).toContainText(
    "附件包已保存，但自动复制失败",
  );
  assert.equal((await fs.readdir(output)).length, 1);
  await dialog
    .getByRole("button", { name: "复制接续内容与附件路径", exact: true })
    .click();
  await expect(dialog.locator(".handoff-success")).toBeInViewport({ ratio: 1 });
  const prompt = await dialog.locator(".handoff-prompt").innerText();
  assert.equal(
    await app.evaluate(({ clipboard }) => clipboard.readText()),
    prompt,
  );
  assert(prompt.includes(path.join(output, (await fs.readdir(output))[0])));
  await expect(dialog).not.toContainText("尚需复制说明");
  await page.screenshot({
    path: path.join(temporary, "copied-after-retry.png"),
  });
  // A second export exercises the normal one-click export + automatic copy path.
  await dialog.getByRole("button", { name: "调整内容", exact: true }).click();
  await dialog.getByRole("button", { name: "生成接续预览" }).click();
  await dialog
    .getByRole("button", { name: "导出附件并复制", exact: true })
    .click();
  await expect(
    dialog.getByRole("heading", { name: "接续内容已复制", exact: true }),
  ).toBeVisible();
  assert.equal((await fs.readdir(output)).length, 2);
  assert.equal(
    await app.evaluate(({ clipboard }) => clipboard.readText()),
    await dialog.locator(".handoff-prompt").innerText(),
  );
  await page.screenshot({
    path: path.join(temporary, "copied-automatically.png"),
  });
  await dialog.getByRole("button", { name: "调整内容", exact: true }).click();
  await pack.uncheck();
  await dialog.getByRole("button", { name: "生成接续预览" }).click();
  await dialog
    .getByRole("button", { name: "确认并复制接续内容", exact: true })
    .click();
  await expect(dialog.locator(".handoff-success")).toContainText(
    "接续内容已复制到剪贴板",
  );
  // Empty selections continue as text, without requiring a toggle or an empty export.
  await dialog.getByRole("button", { name: "完成", exact: true }).click();
  await fs.writeFile(source, JSON.stringify({
    info: { id: "ses_empty", title: "无附件会话", directory: "/fixture/project" },
    messages: [{ info: { id: "msg_empty", role: "user" }, parts: [{ type: "text", text: "继续文字任务。" }] }],
  }));
  await page.getByRole("button", { name: "导入 JSON", exact: true }).click();
  await expect(dialog).toContainText("可打包 0 条");
  await expect(pack).toBeEnabled();
  await pack.check();
  await expect(dialog.locator(".handoff-attachments")).toContainText("本次只复制文字，无需导出附件");
  const generate = dialog.getByRole("button", { name: "生成接续预览" });
  await expect(generate).toBeEnabled();
  await generate.click();
  await expect(dialog.locator(".handoff-prompt")).toContainText("不导出附件包");
  await expect(dialog.getByRole("button", { name: "导出附件并复制", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "确认并复制接续内容", exact: true }).click();
  assert.equal((await fs.readdir(output)).length, 2);
  await dialog.getByRole("button", { name: "调整内容", exact: true }).click();
  await expect(pack).toBeChecked();
  await dialog.getByRole("button", { name: "补充文件", exact: true }).click();
  await expect(dialog).toContainText("可打包 1 条");
  await expect(pack).toBeChecked();
  await expect(generate).toBeEnabled();
  await generate.click();
  await expect(dialog.locator(".handoff-prompt")).toContainText("继续未完成任务");
  await expect(dialog.getByRole("button", { name: "导出附件并复制", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "关闭接续弹窗", exact: true }).click();
  await fs.writeFile(source, JSON.stringify({
    info: { id: "ses_partial", title: "部分附件缺失", directory: "/fixture/project" },
    messages: [{ info: { id: "msg_partial", role: "user" }, parts: [
      { type: "text", text: "继续处理文档。" },
      { type: "file", filename: "available.txt", url: "data:text/plain;base64,aGVsbG8=" },
      { type: "file", filename: "missing.pdf", url: "https://example.invalid/missing.pdf" },
    ] }],
  }));
  await page.getByRole("button", { name: "导入 JSON", exact: true }).click();
  await expect(dialog).toContainText("可打包 1 条");
  await pack.check();
  await expect(dialog.getByRole("checkbox", { name: /我了解存在/ })).toHaveCount(0);
  await expect(generate).toBeEnabled();
  await generate.click();
  await expect(dialog.locator(".handoff-prompt")).toContainText("missing.pdf");
  await expect(dialog.locator(".handoff-prompt")).toContainText("附件缺口");
  await expect(dialog.getByRole("button", { name: "导出附件并复制", exact: true })).toBeEnabled();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        passed: true,
        evidence: temporary,
        checks: [
          "four viewport layouts",
          "cancel preserves files and clipboard",
          "save survives copy failure",
          "retry copies same export",
          "automatic copy includes path with spaces",
          "text-only copy",
          "empty attachment selection copies text without export",
          "manual supplement resumes attachment export",
          "partial attachments preview without confirmation",
          "goal included without a fixed checkbox",
          "no renderer errors",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  if (app) {
    await app
      .evaluate(async ({ clipboard }) => {
        if (globalThis.guidanceClipboard?.length)
          await clipboard.write(globalThis.guidanceClipboard);
        else if (globalThis.guidanceClipboard) clipboard.clear();
      })
      .catch(() => {});
    await app.close();
  }
}
