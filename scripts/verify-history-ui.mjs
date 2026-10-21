/** Real Electron/IPC/renderer verification. Isolated sources, no models or clipboard writes. */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  require = createRequire(path.join(root, "package.json"));
const { _electron, expect } = require("@playwright/test");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "history-ui-")),
  home = path.join(temporary, "home"),
  data = path.join(temporary, "data"),
  destination = path.join(temporary, "exports");
await fs.mkdir(destination, { recursive: true });
const bootstrap = path.join(temporary, "bootstrap.cjs");
await fs.writeFile(
  bootstrap,
  `
const {app,net,dialog}=require('electron');const fs=require('node:fs'),path=require('node:path'),{DatabaseSync}=require('node:sqlite');
app.setAppPath(${JSON.stringify(root)});app.setPath('home',${JSON.stringify(home)});app.setPath('userData',${JSON.stringify(data)});
const home=${JSON.stringify(home)};fs.mkdirSync(path.join(home,'.zcode/cli/db'),{recursive:true});fs.mkdirSync(path.join(home,'.zcode/v2'),{recursive:true});
const z=new DatabaseSync(path.join(home,'.zcode/cli/db/db.sqlite'));z.exec("CREATE TABLE session(id TEXT PRIMARY KEY,title TEXT,directory TEXT,time_updated INTEGER,parent_id TEXT);CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT);CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,sequence INTEGER,data TEXT);INSERT INTO session VALUES('session_new','完整上下文测试','/fixture/new',3,NULL),('sess_old','较旧项目','/fixture/old',1,NULL);INSERT INTO message VALUES('u','session_new','{\\\"role\\\":\\\"user\\\"}')");
z.prepare('INSERT INTO part VALUES(?,?,?,?,?)').run('p','session_new','u',1,JSON.stringify({type:'text',text:'UI_FULL_HISTORY_BEGIN'+('X'.repeat(10*1024*1024))+'UI_FULL_HISTORY_END'}));z.close();
const c=new DatabaseSync(path.join(home,'.zcode/v2/tasks-index.sqlite'));c.exec("CREATE TABLE projects(project_id TEXT,host_id TEXT,name TEXT);CREATE TABLE project_roots(project_id TEXT,root_path TEXT);CREATE TABLE tasks(task_id TEXT,title TEXT,workspace_path TEXT,project_id TEXT,host_id TEXT);INSERT INTO projects VALUES('new','local','原生自定义项目'),('empty','local','原生空项目');INSERT INTO project_roots VALUES('new','/fixture/new'),('empty','/fixture/empty');INSERT INTO tasks VALUES('session_new','完整上下文测试','/fixture/new','new','local'),('draft','草稿','/fixture/new','new','local')");c.close();
net.fetch=async()=>{throw new Error('verification network disabled')};dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(destination)}]});
require(${JSON.stringify(path.join(root, "dist-electron/main.cjs"))});
`,
);
let app;
try {
  const env = { ...process.env, HOME: home, NETWORK_LENS_DATA_DIR: data };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NETWORK_LENS_DEV;
  app = await _electron.launch({
    executablePath: require("electron"),
    args: [bootstrap],
    env,
    timeout: 30000,
  });
  const page = await app.firstWindow(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "任务接续", exact: true }).click();
  await expect(page.getByRole("tab", { name: /^ZCode/ })).toBeVisible({
    timeout: 30000,
  });
  await page.getByRole("tab", { name: /^ZCode/ }).click();
  await expect(page.locator(".handoff-task")).toHaveCount(3, {
    timeout: 30000,
  });
  await expect(
    page.getByRole("navigation", { name: "项目分类" }),
  ).toContainText("原生空项目");
  await expect(
    page.getByRole("navigation", { name: "项目分类" }),
  ).toContainText("原生自定义项目");
  await page.getByRole("combobox", { name: "会话类别" }).selectOption("draft");
  await expect(page.locator(".handoff-task")).toHaveCount(1);
  await expect(page.locator(".handoff-task-title")).toHaveText("草稿");
  await page.getByRole("combobox", { name: "会话类别" }).selectOption("");
  await page
    .getByRole("button", { name: "完整上下文测试", exact: true })
    .click();
  const dialog = page.getByRole("dialog"),
    context = dialog.getByRole("region", { name: "完整上下文" });
  await expect(context).toBeVisible({ timeout: 30000 });
  await expect(context).toContainText("10.00 MB");
  await expect(context.locator("pre")).toContainText("UI_FULL_HISTORY_BEGIN");
  assert(
    (await context.locator("pre").innerText()).length < 132000,
    "IPC must page the raw context",
  );
  await context.getByRole("button", { name: "下一片段" }).click();
  await expect(context.locator("pre")).not.toContainText(
    "UI_FULL_HISTORY_BEGIN",
  );
  await context.getByRole("button", { name: "上一片段" }).click();
  await expect(context.locator("pre")).toContainText("UI_FULL_HISTORY_BEGIN");
  await expect(
    context.getByRole("button", { name: "导出完整上下文", exact: true }),
  ).toBeDisabled();
  await context.getByRole("checkbox").check();
  await context
    .getByRole("button", { name: "导出完整上下文", exact: true })
    .click();
  await expect(context.getByRole("status")).toContainText("已导出", {
    timeout: 30000,
  });
  const dirs = await fs.readdir(destination);
  assert.equal(dirs.length, 1);
  const manifest = JSON.parse(
    await fs.readFile(path.join(destination, dirs[0], "manifest.json"), "utf8"),
  );
  assert(manifest.bytes > 8 * 1024 * 1024);
  assert.equal(
    (await fs.stat(path.join(destination, dirs[0], "context.txt"))).size,
    manifest.bytes,
  );
  await dialog.getByRole("button", { name: "接力此会话" }).click();
  await expect(
    dialog.getByRole("button", { name: "生成接力预览" }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "生成接力预览" }).click();
  await expect(dialog.locator(".handoff-prompt")).toContainText("SHA-256");
  await expect(dialog.locator(".handoff-prompt")).toContainText(
    path.join(destination, dirs[0]),
  );
  await expect(
    dialog.getByRole("button", { name: "确认并复制接力内容" }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "关闭接力弹窗" }).click();
  await page.screenshot({
    path: path.join(temporary, "history-full-index.png"),
  });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        passed: true,
        checks: [
          "native registered/empty projects",
          "session_ and sess_ IDs",
          "draft classification",
          "10 MB native context through real IPC",
          "bounded context pages",
          "raw export requires review",
          "full export and hash metadata",
          "handoff points to full package",
          "copy still requires review",
          "no model calls or clipboard writes",
        ],
        output: temporary,
      },
      null,
      2,
    ),
  );
} finally {
  if (app) await app.close();
}
