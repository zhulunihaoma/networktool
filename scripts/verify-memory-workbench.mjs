import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "package.json"));
const { _electron, expect } = require("@playwright/test");
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "network-lens-memory-ui-"),
);
const home = path.join(temporary, "home");
const sources = new Map();
const put = async (relative, text) => {
  const file = path.join(home, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
  sources.set(file, text);
};
let app;
try {
  await put(
    ".codex/memories/MEMORY.md",
    "# 本地记忆\n## 用户偏好\n- 使用中文沟通\n- 修改前明确范围\n## 项目知识\n- [缓存说明](topic.md)\n- 保留原文行号\n## 历史决策\n- 首期只读导入\n- 保留证据引用\n",
  );
  await put(
    ".codex/memories/memory_summary.md",
    "# 记忆总览\n- 总览中独有的内容也应保留。\n",
  );
  await put(
    ".codex/memories/preferences.md",
    "# 协作说明\n## User preferences\n- **先说结论**，再解释原因。\n- 控制修改范围。\n  适用场景：处理当前任务时。\n  示例：保留其他未提交改动。\n",
  );
  await put(
    ".codex/memories/topic.md",
    "# 缓存说明\n- 来源文件变化后刷新索引\n- token=private-test-token\n- <img src=x onerror=alert(1)>\n\n" +
      Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 段额外内容。\n\n`).join(
        "",
      ),
  );
  await put(
    ".claude/projects/example/memory/MEMORY.md",
    "# Claude 真实来源\n## 项目约定\n- 沿用当前目录约定\n",
  );
  await put(".gemini/GEMINI.md", "# Gemini 真实来源\n- 候选需要审核\n");
  await put(
    ".cursor/rules/example.mdc",
    "---\nalwaysApply: true\n---\n# Cursor 真实规则\n- 使用既有组件\n",
  );
  await put(
    ".config/opencode/AGENTS.md",
    "# OpenCode 真实指令\n- 保留覆盖顺序\n",
  );
  await put("project/AGENTS.md", "# 项目共享约定\n- 测试项目前缀\n");
  await put("custom/extra.md", "# 自定义记忆\n- 只对当前 Agent 可见\n");
  const bootstrap = path.join(temporary, "bootstrap.cjs");
  await fs.writeFile(
    bootstrap,
    `const {app,dialog,net}=require('electron');app.setAppPath(${JSON.stringify(root)});app.setPath('home',${JSON.stringify(home)});net.fetch=async()=>{throw new Error('UI fixture: network disabled')};let choices=[${JSON.stringify(path.join(home, "project"))},${JSON.stringify(path.join(home, "custom"))}];dialog.showOpenDialog=async()=>choices.length?{canceled:false,filePaths:[choices.shift()]}:{canceled:true,filePaths:[]};require(${JSON.stringify(path.join(root, "dist-electron/main.cjs"))});`,
  );
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
  const page = await app.firstWindow(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByRole("button", { name: "记忆工作台", exact: true }).click();
  await expect(page.locator(".memory-file")).toHaveCount(4);
  await expect(
    page.getByRole("button", { name: "内容总览", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".memory-directory")).toContainText(
    "memory_summary.md",
  );
  await expect(page.locator(".memory-directory")).toContainText(
    "preferences.md",
  );
  await expect(page.locator(".memory-directory")).toContainText("topic.md");
  const fileLayout = await page
    .locator(".memory-file")
    .first()
    .evaluate((button) => {
      const heading = button.querySelector("strong").getBoundingClientRect();
      const path = button.querySelector("code").getBoundingClientRect();
      return { headingBottom: heading.bottom, pathTop: path.top };
    });
  assert(fileLayout.pathTop >= fileLayout.headingBottom);
  await expect(
    page.locator(".memory-reading-card").filter({ hasText: "先说结论" }),
  ).toBeVisible();
  await expect(
    page.locator(".memory-reading-card").filter({ hasText: "来源文件变化后" }),
  ).toBeVisible();
  const before = await page.locator(".memory-reading-card").count();
  await page
    .locator(".memory-reading-card")
    .filter({ hasText: "先说结论" })
    .click();
  await expect(page.locator(".memory-readable-text")).toHaveText(
    "先说结论，再解释原因。",
  );
  await expect(page.locator(".memory-original pre")).toContainText(
    "**先说结论**",
  );
  await expect(page.locator(".memory-file[data-linked=true] code")).toHaveText(
    "memories/preferences.md",
  );
  await page.locator(".memory-source-link").click();
  await expect(page.locator(".memory-file[data-linked=true]")).toBeFocused();
  assert.equal(await page.locator(".memory-reading-card").count(), before);
  await page
    .locator(".memory-file")
    .filter({ hasText: "preferences.md" })
    .click();
  await expect(page.locator(".memory-reading-card")).toHaveCount(2);
  await expect(page.locator(".memory-original pre")).toContainText(
    "# 协作说明",
  );
  await page
    .locator(".memory-reading-card")
    .filter({ hasText: "控制修改范围" })
    .click();
  await expect(page.locator(".memory-context")).toContainText([
    "协作偏好",
    "适用场景：处理当前任务时。",
  ]);
  await expect(page.locator(".memory-example")).toContainText(
    "示例：保留其他未提交改动。",
  );
  await page.locator(".memory-all").click();
  await page
    .locator(".memory-reading-card")
    .filter({ hasText: "保留原文行号" })
    .click();
  await expect(page.locator(".memory-origin")).toContainText("原文第 7 行");
  await page.screenshot({ path: path.join(temporary, "memory-desktop.png") });
  await page
    .locator(".memory-reading-card")
    .filter({ hasText: "缓存说明" })
    .click();
  await page
    .getByRole("button", { name: "引用 · 缓存说明", exact: true })
    .click();
  await expect(page.locator(".memory-detail h2")).toHaveText("缓存说明");
  await expect(page.locator(".memory-original pre")).toContainText(
    "第 12 段额外内容。",
  );
  await page
    .getByRole("button", { name: "被引用于 · 缓存说明", exact: true })
    .click();
  await expect(page.locator(".memory-original pre")).toHaveText(
    "- [缓存说明](topic.md)",
  );
  const topic = await page.evaluate(() => window.networkLens.memories("codex"));
  assert(!JSON.stringify(topic).includes("private-test-token"));
  const group = page.locator(".memory-reading-group").filter({
    has: page.getByRole("heading", { name: "缓存说明", exact: true }),
  });
  await group.getByRole("button", { name: /展开更多内容/ }).click();
  assert((await group.locator(".memory-reading-card").count()) > 2);
  assert.equal(await page.locator(".memory-page img").count(), 0);
  await page.getByRole("button", { name: "关系地图", exact: true }).click();
  await expect(
    page.locator(".memory-node.entry").filter({ hasText: "保留原文行号" }),
  ).toBeVisible();
  await page
    .locator(".memory-node.entry")
    .filter({ hasText: "保留原文行号" })
    .click();
  await expect(page.locator(".memory-detail h2")).toHaveText("保留原文行号");
  await expect(page.locator(".memory-wires path.selected")).toHaveCount(1);
  await page.screenshot({ path: path.join(temporary, "memory-map.png") });
  await page
    .locator(".memory-node.group")
    .filter({ hasText: "协作偏好" })
    .click();
  await expect(
    page.getByRole("button", { name: "内容总览", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".memory-reading-group")).toHaveCount(1);
  await page.getByRole("button", { name: /展开更多内容/ }).click();
  assert.equal(await page.locator(".memory-reading-card").count(), 4);
  await page.locator(".memory-all").click();
  for (const [label, expected] of [
    ["Claude Code", "Claude 真实来源"],
    ["Gemini CLI", "Gemini 真实来源"],
    ["Cursor", "Cursor 真实规则"],
    ["OpenCode", "OpenCode 真实指令"],
  ]) {
    await page.getByRole("tab", { name: label, exact: true }).click();
    await expect(page.locator(".memory-directory")).toContainText(expected);
    if (label === "Cursor") {
      await page.getByText("文档元信息与触发条件", { exact: true }).click();
      await expect(page.locator(".memory-frontmatter pre")).toContainText(
        "alwaysApply: true",
      );
    }
  }
  await page.getByRole("button", { name: "选择项目", exact: true }).click();
  await expect(
    page.locator(".memory-file").filter({ hasText: "项目共享约定" }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "添加记忆目录", exact: true }).click();
  await expect(
    page.locator(".memory-file").filter({ hasText: "自定义记忆" }),
  ).toHaveCount(1);
  await page.getByRole("tab", { name: "Codex", exact: true }).click();
  await expect(page.locator(".memory-directory")).toContainText(
    "preferences.md",
  );
  assert.equal(
    await page
      .locator(".memory-file")
      .filter({ hasText: "自定义记忆" })
      .count(),
    0,
  );
  await page
    .locator(".memory-file")
    .filter({ hasText: "preferences.md" })
    .click();
  await page.getByRole("button", { name: "选择项目", exact: true }).click();
  await expect(page.locator(".memory-file[aria-pressed=true]")).toContainText(
    "preferences.md",
  );
  await page.getByRole("tab", { name: "Codex", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "Claude Code", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".memory-directory")).toContainText(
    "Claude 真实来源",
  );
  await page.getByRole("tab", { name: "Codex", exact: true }).click();
  await page.getByRole("button", { name: "关系地图", exact: true }).click();
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "刷新", exact: true }),
  ).toBeEnabled();
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(
    page.getByRole("button", { name: "下一组记忆", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "下一组记忆", exact: true }).click();
  await expect(
    page.locator(".memory-node.group").filter({ hasText: "历史决策" }),
  ).toBeVisible();
  const layout = await page.evaluate(() => ({
    width: innerWidth,
    content: document.documentElement.scrollWidth,
    nodes: [...document.querySelectorAll(".memory-node")].map((n) => {
      const r = n.getBoundingClientRect();
      return { left: r.left, right: r.right };
    }),
  }));
  assert(layout.content <= layout.width);
  assert(layout.nodes.every((n) => n.left >= 0 && n.right <= layout.width));
  const dimensions = await page.locator(".memory-canvas").evaluate((n) => ({
    width: n.clientWidth,
    svg: Number(n.querySelector("svg").getAttribute("viewBox").split(" ")[2]),
  }));
  assert(Math.abs(dimensions.width - dimensions.svg) < 1);
  await page.getByRole("button", { name: "内容总览", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "内容总览", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".memory-canvas")).toHaveCount(0);
  await page.screenshot({ path: path.join(temporary, "memory-narrow.png") });
  const valid = await page.evaluate(async () => {
    try {
      await window.networkLens.memories("invalid");
      return false;
    } catch {
      return true;
    }
  });
  assert(valid);
  await page.getByRole("tab", { name: "Gemini CLI", exact: true }).click();
  await expect(page.locator(".memory-directory")).toContainText(
    "Gemini 真实来源",
  );
  const geminiSource = path.join(home, ".gemini/GEMINI.md");
  await fs.rm(geminiSource);
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "未发现 Gemini CLI 的可读取内容" }),
  ).toBeVisible();
  await fs.writeFile(geminiSource, sources.get(geminiSource));
  for (const [file, text] of sources)
    assert.equal(await fs.readFile(file, "utf8"), text);
  assert.deepEqual(errors, []);
  const shots = process.env.NETWORK_LENS_MEMORY_SHOTS_DIR;
  if (shots) {
    await fs.mkdir(shots, { recursive: true });
    for (const name of [
      "memory-desktop.png",
      "memory-map.png",
      "memory-narrow.png",
    ])
      await fs.copyFile(path.join(temporary, name), path.join(shots, name));
  }
  console.log(
    "PASS: real Electron/preload/IPC, cross-file reading, visible file directory, source location, original/reading separation, file text, use cases from source only, expanded topics, relation graph, reference round trip, five Agent tabs, native directories/cancellation, refresh/resize, keyboard, missing data, redaction and unchanged sources; no renderer errors.",
  );
} finally {
  if (app) await app.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
