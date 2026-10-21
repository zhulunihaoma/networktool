/** Isolated eight-source attachment acceptance: no real chats, network or model calls. */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const root = path.resolve(import.meta.dirname, ".."),
  require = createRequire(path.join(root, "package.json"));
const { _electron, expect } = require("@playwright/test");
const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "network-attachment-ui-"),
  ),
  home = path.join(temporary, "home"),
  output = path.join(temporary, "exports");
const id = "12345678-1234-4234-8234-123456789abc";
const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
    "base64",
  ),
  url = `data:image/png;base64,${png.toString("base64")}`;
const hash = createHash("sha256").update(png).digest("hex"),
  originals = new Map();
const put = async (relative, value) => {
  const file = path.join(home, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const data = Buffer.isBuffer(value)
    ? value
    : typeof value === "string"
      ? Buffer.from(value)
      : Buffer.from(JSON.stringify(value));
  await fs.writeFile(file, data);
  originals.set(file, data);
  return file;
};
const lines = (...rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const base = { sessionId: id, cwd: "/fixture/project" },
  image = {
    type: "image",
    source: {
      type: "base64",
      media_type: "image/png",
      data: png.toString("base64"),
    },
  };
let app;
try {
  await fs.mkdir(output, { recursive: true });
  const blob = await put(".workbuddy/storage/screenshot.png", png);
  await put(
    `.workbuddy/projects/demo/${id}.jsonl`,
    lines(
      {
        type: "message",
        role: "user",
        id: "u1",
        sessionId: id,
        content: [
          { type: "input_text", text: "继续附件任务：起点 37，再加 5。" },
          ...["截图.png", "同一图片.png"].map((name) => ({
            type: "image_blob_ref",
            blob_path: blob,
            mime: "image/png",
            original_filename: name,
          })),
          {
            type: "image_blob_ref",
            blob_path: path.join(home, ".workbuddy/storage/missing.png"),
            mime: "image/png",
            original_filename: "已清理截图.png",
          },
          {
            type: "file",
            url: "/historical/spec.pdf",
            filename: "需求文档.pdf",
          },
        ],
      },
      {
        type: "message",
        role: "assistant",
        id: "a1",
        sessionId: id,
        content: [{ type: "text", text: "接下来核对图片和文档。" }],
      },
    ),
  );
  await put(
    `.claude/projects/demo/${id}.jsonl`,
    lines({
      type: "user",
      uuid: "claude-u",
      ...base,
      message: {
        role: "user",
        content: [{ type: "text", text: "继续图片任务" }, image],
      },
    }),
  );
  await put(
    `.wiscode/claude-agents/projects/demo/${id}.jsonl`,
    lines({
      type: "user",
      uuid: "wis-u",
      ...base,
      message: {
        role: "user",
        content: [{ type: "text", text: "继续图片任务" }, image],
      },
    }),
  );
  await put(
    `.codex/sessions/2026/10/21/rollout-${id}.jsonl`,
    lines(
      {
        type: "session_meta",
        payload: {
          id,
          cwd: base.cwd,
          source: "vscode",
          timestamp: "2026-10-21T00:00:00Z",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          id: "codex-u",
          content: [
            { type: "input_text", text: "继续图片任务" },
            { type: "input_image", image_url: url },
          ],
        },
      },
    ),
  );
  await put(
    `.roo-cline/globalStorage/ultra-ai.copilotcodepro/tasks/${id}/ui_messages.json`,
    [
      { type: "say", say: "text", text: "继续图片任务", images: [url] },
      {
        type: "say",
        say: "completion_result",
        text: "准备继续",
        images: [url],
      },
    ],
  );
  const artifact = path.join(home, ".zcode/cli/artifacts/session_producer");
  await fs.mkdir(artifact, { recursive: true });
  await put(
    ".zcode/cli/artifacts/session_producer/cache-tool-result-image.txt",
    url,
  );
  const dshFolder = path.join(home, ".dsh/sessions/demo/session-" + id);
  await fs.mkdir(dshFolder, { recursive: true });
  const dshRaw = lines(
    { type: "session", id: "session-" + id, version: 4 },
    {
      type: "user/message",
      seq: 1,
      data: {
        id: "dsh-u",
        source: { kind: "user" },
        content: [
          { type: "text", text: "继续图片任务" },
          {
            type: "image",
            attachment: {
              attachmentId: "sha256:" + hash,
              mediaType: "image/png",
              name: "DSH截图.png",
              bytes: png.length,
            },
          },
        ],
      },
    },
  );
  await put(
    ".dsh/attachments/v1/objects/" + hash.slice(0, 2) + "/" + hash,
    png,
  );
  await put(
    ".dsh/storages/session_projcache/sessions/session-" + id + ".json",
    {
      record: {
        identity: { cwd: base.cwd, createdAt: 1 },
        rows: {
          sessionListMetadata: { val: { blank: false, lastPromptAt: 2 } },
          title: { val: "DSH图片任务" },
          subagent: { val: {} },
        },
      },
    },
  );
  const json = await put("export.json", {
    info: { id: "ses_fixture", title: "OpenCode图片任务", directory: base.cwd },
    messages: [
      {
        info: { id: "open-u", role: "user" },
        parts: [
          { type: "text", text: "继续图片任务" },
          {
            type: "file",
            mime: "image/png",
            filename: "OpenCode截图.png",
            url,
          },
        ],
      },
    ],
  });
  const manual = await put("manual.txt", "附件补充：起点 37，再加 5。");
  const setup = `const fs=require('node:fs'),path=require('node:path'),{DatabaseSync}=require('node:sqlite');
 const db=(rel,schema)=>{const p=path.join(${JSON.stringify(home)},rel);fs.mkdirSync(path.dirname(p),{recursive:true});const d=new DatabaseSync(p);d.exec(schema);return d};
 const w=db('.workbuddy/workbuddy.db','CREATE TABLE sessions(id TEXT,cwd TEXT,title TEXT,updated_at INTEGER,deleted_at INTEGER)');w.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(${JSON.stringify(id)},'/fixture/project','附件接力验证',2,null);w.close();
 const z=db('.zcode/cli/db/db.sqlite','CREATE TABLE session(id TEXT,title TEXT,directory TEXT,time_updated INTEGER,parent_id TEXT);CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT);CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,time_created INTEGER,data TEXT)');
 z.prepare('INSERT INTO session VALUES(?,?,?,?,?)').run('sess_fixture','ZCode图片任务','/fixture/project',2,null);z.prepare('INSERT INTO message VALUES(?,?,?,?)').run('z-u','sess_fixture',1,JSON.stringify({role:'user'}));for(const [i,p]of [{type:'text',text:'继续图片任务'},{type:'file',mime:'image/jpeg',filename:'原始.jpg',url:'zcode-artifact://sess_fixture/tool-result-image'}].entries())z.prepare('INSERT INTO part VALUES(?,?,?,?,?)').run('p'+i,'z-u','sess_fixture',i,JSON.stringify(p));z.close();
 fs.writeFileSync(${JSON.stringify(path.join(dshFolder, "session.v4.jsonl.zstd"))},Buffer.concat(${JSON.stringify(dshRaw)}.split('\\n').filter(Boolean).map(l=>require('node:zlib').zstdCompressSync(Buffer.from(l+'\\n')))));
 `;
  const bootstrap = path.join(temporary, "bootstrap.cjs");
  await fs.writeFile(
    bootstrap,
    `const{app,dialog,net}=require('electron');app.setAppPath(${JSON.stringify(root)});app.setPath('home',${JSON.stringify(home)});${setup}net.fetch=async()=>{throw new Error('network disabled')};dialog.showOpenDialog=async(_window,opts)=>{if(opts.properties.includes('openDirectory')){if(globalThis.cancelExport){globalThis.cancelExport=false;return{canceled:true,filePaths:[]}}return{canceled:false,filePaths:[${JSON.stringify(output)}]}}return{canceled:false,filePaths:[opts.title.includes('补充')?${JSON.stringify(manual)}:${JSON.stringify(json)}]}};require(${JSON.stringify(path.join(root, "dist-electron/main.cjs"))});`,
  );
  const env = {
    ...process.env,
    HOME: home,
    PATH: "/usr/bin:/bin",
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
  const page = await app.firstWindow(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "任务接续", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "识别本机工具", exact: true }),
  ).toBeEnabled({ timeout: 30000 });
  const report = [];
  for (const source of [
    "OpenCode",
    "Codex",
    "ClaudeCode",
    "WorkBuddy",
    "ZCode",
    "WisCode",
    "DeepSeekHarness",
    "CopilotCode",
  ]) {
    const result = await page.evaluate(async (source) => {
      const api = window.networkLens;
      const imported =
        source === "OpenCode"
          ? await api.chooseHandoffFile()
          : await (async () => {
              const list = await api.browseSourceTasks(source);
              if (!list.tasks.length)
                throw new Error("fixture missing " + source);
              return api.importSourceTask(list.tasks[0].id, source);
            })();
      const scan = await api.scanHandoffAttachments(imported.attachmentSession);
      return {
        source,
        ready: scan.entries.filter((e) => e.status === "ready").length,
        unavailable: scan.entries.filter((e) => e.status !== "ready").length,
        complete: scan.complete,
        leakedBinary: JSON.stringify(scan).includes("base64"),
        hashes: scan.entries
          .filter((e) => e.status === "ready")
          .map((e) => e.sha256),
      };
    }, source);
    assert.equal(
      result.ready,
      source === "WorkBuddy" ? 2 : 1,
      JSON.stringify(result),
    );
    assert(!result.leakedBinary);
    assert(result.hashes.every((h) => h === hash));
    report.push(result);
  }
  await app.evaluate(async ({ clipboard, ClipboardItem }) => {
    globalThis.attachmentClipboardBackup = await Promise.all(
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
  await page.getByRole("tab", { name: /^WorkBuddy/ }).click();
  await expect(page.locator(".handoff-task")).toHaveCount(1);
  await page.getByRole("button", { name: "接力", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("可打包 2 条");
  await expect(dialog).toContainText("无法恢复 2 条");
  const pack = dialog.getByRole("checkbox", { name: /同时打包附件/ });
  await expect(pack).not.toBeChecked();
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 1280, height: 800 },
    { width: 1024, height: 720 },
    { width: 1024, height: 600 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(pack).toBeInViewport({ ratio: 1 });
    await expect(
      dialog.getByRole("button", { name: "补充文件", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    const firstScreen = await dialog
      .locator(".handoff-dialog-body")
      .evaluate((body) => {
        const bounds = body.getBoundingClientRect(),
          toggle = body
            .querySelector(".handoff-pack-toggle")
            .getBoundingClientRect();
        return {
          scrollTop: body.scrollTop,
          top: toggle.top,
          bottom: toggle.bottom,
          visibleTop: bounds.top,
          visibleBottom: bounds.bottom,
        };
      });
    assert.equal(firstScreen.scrollTop, 0, "new dialog must open at the top");
    assert(
      firstScreen.top >= firstScreen.visibleTop &&
        firstScreen.bottom <= firstScreen.visibleBottom,
      JSON.stringify({ viewport, ...firstScreen }),
    );
    if (viewport.height === 1000 || viewport.height === 720)
      await page.screenshot({
        path: path.join(
          temporary,
          `attachments-first-screen-${viewport.width}.png`,
        ),
      });
  }
  await expect(dialog.locator(".handoff-attachment-list")).toHaveCount(0);
  await dialog.locator(".handoff-attachment-issues summary").click();
  await expect(dialog.locator(".handoff-attachment-issues")).toContainText(
    "已清理截图.png",
  );
  await dialog.locator(".handoff-attachment-issues summary").click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await pack.check();
  await expect(
    dialog.getByRole("checkbox", { name: /我了解存在/ }),
  ).not.toBeChecked();
  await expect(
    dialog.getByRole("button", { name: "生成接力预览" }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "补充文件", exact: true }).click();
  await expect(dialog).toContainText("可打包 3 条");
  await expect(dialog).toContainText("manual.txt");
  await dialog.getByRole("checkbox", { name: /我了解存在/ }).check();
  await dialog.locator(".handoff-attachments").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(temporary, "attachments-configure-1440.png"),
  });
  await dialog.getByRole("button", { name: "生成接力预览" }).click();
  await expect(dialog.locator(".handoff-package-summary")).toContainText(
    "已选 3 条",
  );
  const exportButton = dialog.getByRole("button", {
    name: "确认并导出附件接力包",
    exact: true,
  });
  await expect(exportButton).toBeDisabled();
  for (const name of [
    /原任务已停止/,
    /已确认目标工具/,
    /已检查全文/,
    /已检查所选附件/,
  ])
    await dialog.getByRole("checkbox", { name }).check();
  await app.evaluate(() => {
    globalThis.cancelExport = true;
  });
  await exportButton.click();
  await expect(exportButton).toBeEnabled();
  assert.equal((await fs.readdir(output)).length, 0);
  await exportButton.click();
  await expect(
    dialog.getByRole("heading", { name: "附件包已导出" }),
  ).toBeVisible();
  const zip = path.join(output, (await fs.readdir(output))[0]);
  // Independent ZIP implementation checks CRC, Unicode filenames, hashes and dedup, and reads relay data as a destination would.
  const checked = JSON.parse(
    execFileSync(
      "/usr/bin/python3",
      [
        "-c",
        `import zipfile,json,hashlib,sys
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 m=json.loads(z.read('manifest.json'))
 assert len(m['attachments'])==3 and len(m['omittedAttachments'])==2 and m['complete']==False
 assert len([n for n in z.namelist() if n.startswith('attachments/')])==2
 for a in m['attachments']: assert hashlib.sha256(z.read(a['path'])).hexdigest()==a['sha256']
 assert '37'.encode() in z.read('handoff.md')
 assert '37'.encode() in z.read(m['attachments'][2]['path'])
 print(json.dumps({'files':len(z.namelist()),'attachments':len(m['attachments']),'omitted':m['omitted'],'relayResult':37+5}))`,
        zip,
      ],
      { encoding: "utf8" },
    ),
  );
  assert.equal(checked.relayResult, 42);
  await dialog
    .getByRole("button", { name: "复制说明与附件包路径", exact: true })
    .click();
  await expect(dialog).toContainText("已复制，接下来粘贴到");
  const prompt = await dialog.locator(".handoff-prompt").innerText();
  assert.equal(
    await app.evaluate(async ({ clipboard }) => clipboard.readText()),
    prompt,
  );
  assert(prompt.includes(zip));
  await page.screenshot({
    path: path.join(temporary, "attachments-exported-1440.png"),
  });
  await dialog.getByRole("button", { name: "调整内容", exact: true }).click();
  await pack.uncheck();
  await dialog.getByRole("button", { name: "生成接力预览" }).click();
  await expect(dialog.locator(".handoff-package-summary")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "确认并复制接力内容", exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "调整内容", exact: true }).click();
  await page.setViewportSize({ width: 1024, height: 720 });
  await dialog.locator(".handoff-attachments").scrollIntoViewIfNeeded();
  const bounds = await dialog.evaluate((e) => ({
    width: e.clientWidth,
    scroll: e.scrollWidth,
    right: e.getBoundingClientRect().right,
    viewport: innerWidth,
  }));
  assert(bounds.scroll <= bounds.width + 1);
  assert(bounds.right <= bounds.viewport);
  await page.screenshot({
    path: path.join(temporary, "attachments-configure-1024.png"),
  });
  for (const [file, data] of originals)
    assert.deepEqual(await fs.readFile(file), data, "source mutated");
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(temporary, "report.json"),
    JSON.stringify({ sources: report, archive: checked, zip, errors }, null, 2),
  );
  console.log(
    JSON.stringify(
      { evidence: temporary, sources: report, archive: checked, errors },
      null,
      2,
    ),
  );
} finally {
  if (app) {
    await app
      .evaluate(async ({ clipboard }) => {
        if (globalThis.attachmentClipboardBackup)
          await clipboard.write(globalThis.attachmentClipboardBackup);
      })
      .catch(() => {});
    await app.close().catch(() => {});
  }
}
