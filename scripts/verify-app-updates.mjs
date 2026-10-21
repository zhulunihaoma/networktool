import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "package.json"));
const { _electron, expect } = require("@playwright/test");
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "networktool-update-ui-"),
);
const home = path.join(temporary, "home");
await fs.mkdir(home, { recursive: true });
const sources = JSON.parse(
  await fs.readFile(path.join(root, "updates/sources.json"), "utf8"),
);
const packageInfo = JSON.parse(
  await fs.readFile(path.join(root, "package.json"), "utf8"),
);
const bytes = Buffer.from("fixture-package-".repeat(1000));
const bootstrap = path.join(temporary, "bootstrap.cjs");
await fs.writeFile(
  bootstrap,
  `
const {app,net,shell}=require('electron');
app.setAppPath(${JSON.stringify(root)});app.setPath('home',${JSON.stringify(home)});
const sources=${JSON.stringify(sources)},bytes=Buffer.from(${JSON.stringify(bytes.toString("base64"))},'base64');
globalThis.updateFixture={mode:'normal',calls:[],revealed:[],opened:[]};
shell.showItemInFolder=file=>globalThis.updateFixture.revealed.push(file);
shell.openExternal=async url=>{globalThis.updateFixture.opened.push(url)};
net.fetch=async(input,init)=>{
 const url=String(input),f=globalThis.updateFixture,source=url.includes('gitee.com')?'gitee':'github';
 f.calls.push(url);
 if(url===sources[source].manifest){
   if(f.mode==='offline')return new Response('',{status:503});
   if(f.mode==='empty')return Response.json({schemaVersion:1,release:null});
   const platform=f.mode==='unsupported'?(process.platform==='linux'?'win32-arm64':'linux-arm64'):process.platform+'-'+process.arch;
   const name='Network-Lens-fixture'+(platform.startsWith('win32')?'.exe':platform.startsWith('darwin')?'.zip':'.AppImage');
   const version=source==='gitee'?'8.0.0':'9.0.0';
   return Response.json({schemaVersion:1,release:{version,notes:'双源更新测试说明 <img src=x onerror=alert(1)>',publishedAt:'2026-10-21T00:00:00.000Z',assets:{[platform]:{name,size:bytes.length,sha256:${JSON.stringify(createHash("sha256").update(bytes).digest("hex"))},urls:Object.fromEntries(Object.entries(sources).map(([id,s])=>[id,s.repository+'/releases/download/v'+version+'/'+name]))}}}});
 }
 if(url.includes('/releases/download/')){
   if(source==='gitee')return new Response('login',{headers:{'content-type':'text/html'}});
   if(f.mode==='slow'){
     return new Response(new ReadableStream({start(c){c.enqueue(bytes.subarray(0,100));init.signal.addEventListener('abort',()=>c.error(new Error('cancelled')),{once:true})}}));
   }
   return new Response(bytes,{headers:{'content-length':String(bytes.length),'content-type':'application/zip'}});
 }
 return new Response('',{status:503});
};
require(${JSON.stringify(path.join(root, "dist-electron/main.cjs"))});
`,
);
let app;
const errors = [];
const launch = async () => {
  const env = {
    ...process.env,
    HOME: home,
    NETWORK_LENS_DATA_DIR: path.join(temporary, "data"),
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
  await page.setViewportSize({ width: 1360, height: 1000 });
  await page.getByRole("button", { name: "偏好设置", exact: true }).click();
  await expect(page.locator(".app-update-version")).toContainText(
    `v${packageInfo.version}`,
  );
  return page;
};
try {
  let page = await launch();
  const panel = () => page.locator(".app-updates");
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await expect(panel().getByRole("status")).toContainText("发现新版本 v9.0.0");
  await expect(panel().locator(".app-update-sources")).toContainText("v8.0.0");
  await panel().getByText("查看更新说明", { exact: true }).click();
  await expect(panel().locator("details p")).toContainText(
    "<img src=x onerror=alert(1)>",
  );
  assert.equal(await panel().locator("details img").count(), 0);
  assert.equal(
    (
      await app.evaluate(() =>
        globalThis.updateFixture.calls.filter((url) =>
          url.includes("/releases/download/"),
        ),
      )
    ).length,
    0,
  );
  await page.getByRole("button", { name: "下载新版本", exact: true }).click();
  await expect(panel().getByRole("status")).toContainText(
    "安装包已下载并通过完整性校验",
  );
  await expect(panel().getByLabel("下载切换记录")).toContainText("Gitee");
  await expect(panel().getByLabel("安装包下载进度")).toHaveAttribute(
    "value",
    "100",
  );
  await page.getByRole("button", { name: "打开下载位置", exact: true }).click();
  await expect
    .poll(() => app.evaluate(() => globalThis.updateFixture.revealed.length))
    .toBe(1);
  const file = await app.evaluate(() => globalThis.updateFixture.revealed[0]);
  assert.deepEqual(await fs.readFile(file), bytes);
  const downloads = await app.evaluate(() =>
    globalThis.updateFixture.calls.filter((url) =>
      url.includes("/releases/download/"),
    ),
  );
  assert.equal(downloads.length, 2);
  assert.ok(downloads.every((url) => url.includes("/v9.0.0/")));
  await page.getByRole("button", { name: "Gitee 发行版", exact: true }).click();
  await expect
    .poll(() => app.evaluate(() => globalThis.updateFixture.opened.length))
    .toBe(1);
  assert.equal(
    await app.evaluate(() => globalThis.updateFixture.opened[0]),
    sources.gitee.repository + "/releases",
  );
  await page.getByLabel("应用更新下载源").selectOption("github");
  await expect(panel().getByRole("status")).toContainText("下载源已保存");
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await expect(panel().getByRole("status")).toContainText("发现新版本");
  await expect(panel().locator(".app-update-sources > div")).toHaveCount(1);
  await app.evaluate(() => {
    globalThis.updateFixture.mode = "slow";
  });
  await page.getByRole("button", { name: "下载新版本", exact: true }).click();
  await expect(panel().getByRole("status")).toContainText("GitHub 下载");
  await expect(page.getByLabel("应用更新下载源")).toBeDisabled();
  await expect(panel().getByLabel("安装包下载进度")).not.toHaveAttribute(
    "value",
    "0",
  );
  await page.getByRole("button", { name: "取消下载", exact: true }).click();
  await expect(panel().getByRole("status")).toContainText("已取消下载");
  const updateDirectory = path.join(temporary, "data", "updates");
  const partials = (
    await fs.readdir(updateDirectory, { recursive: true })
  ).filter((name) => name.endsWith(".part"));
  assert.deepEqual(partials, []);
  await app.evaluate(() => {
    globalThis.updateFixture.mode = "offline";
  });
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await expect(panel().getByRole("status")).toContainText("未能获取版本信息");
  await expect(panel().getByLabel("更新源状态")).toContainText("503");
  await app.evaluate(() => {
    globalThis.updateFixture.mode = "empty";
  });
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await expect(panel().getByRole("status")).toContainText("尚未提供");
  await app.evaluate(() => {
    globalThis.updateFixture.mode = "unsupported";
  });
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await expect(panel().getByRole("status")).toContainText("当前系统和架构");
  assert.equal(
    await panel()
      .getByRole("button", { name: "下载新版本", exact: true })
      .count(),
    0,
  );
  const invalidRejected = await page.evaluate(async () => {
    try {
      await window.networkLens.setAppUpdateSource("untrusted");
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(invalidRejected, true);
  await app.evaluate(() => {
    globalThis.updateFixture.mode = "normal";
  });
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await expect(panel().getByRole("status")).toContainText("发现新版本");
  await page.screenshot({
    path: path.join(temporary, "app-updates-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1024, height: 800 });
  await panel().scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(temporary, "app-updates-narrow.png"),
    fullPage: true,
  });
  assert.equal(
    await panel().evaluate((el) => el.scrollWidth > el.clientWidth + 1),
    false,
  );
  await app.close();
  app = undefined;
  page = await launch();
  await expect(page.getByLabel("应用更新下载源")).toHaveValue("github");
  await page.getByLabel("应用更新下载源").selectOption("auto");
  await expect(page.locator(".app-updates").getByRole("status")).toContainText(
    "下载源已保存",
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        passed: true,
        checks: [
          "real Electron IPC",
          "mirror version comparison",
          "no automatic download",
          "download failover",
          "checksum and bytes",
          "progress",
          "manual source",
          "cancel mid-stream",
          "offline and unpublished",
          "unsupported architecture",
          "IPC validation",
          "preference survives restart",
          "release page",
          "inert release notes",
          "desktop and narrow layout",
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
