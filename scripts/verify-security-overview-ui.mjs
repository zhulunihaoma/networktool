// Isolated renderer checks: no application main process, home scans or config writes.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "package.json"));
const { _electron, expect } = require("@playwright/test");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nl-overview-ui-"));
await build({
  stdin: {
    resolveDir: root,
    loader: "tsx",
    contents: `
import React from "react";
import { createRoot } from "react-dom/client";
import SecurityCenter from "./src/SecurityCenter";
import "./src/styles.css";
const finding = {
  id: "example-risk", tool: "codex", category: "secret", level: "high",
  title: "凭据文件权限过宽",
  why: "操作读取登录凭据和私钥，权限过宽可能扩大泄露面。",
  evidence: '{"creator_user_id":"user-example","apiKey":"[REDACTED]","file":"/Users/example/My Project/credentials.json","approval_policy":"never","raw":"<img src=x onerror=alert(1)>"}',
  path: "/Users/example/My Project/credentials.json",
  fix: "检查配置", steps: ["检查 ~/.codex/config.toml 中的 approval_policy 设置", "确认后重新体检"],
  action: {kind: "recheck", label: "重新体检"}
};
const overview = {
  score: 74, level: "attention", headline: "发现 1 个高风险问题，建议及时处理", tools: [],
  findings: [finding], ignoredFindings: [], doctorAt: Date.now(), todayBlocked: 2,
  scoreItems: [{id: "category:secret", title: "密钥暴露", deduction: 16, reason: "同类合并", findingId: finding.id}, {id: "doctor", title: "完成配置体检", deduction: 0, bonus: 5, reason: "已读取配置"}, {id: "chain", title: "安全记录校验", deduction: 0, bonus: 5, reason: "校验通过"}],
  retroScan: {at: Date.now(), scannedFiles: 2, sources: ["Codex"], durationMs: 20, truncated: false, hits: [{id: "retro:codex:test", tool: "codex", sessionId: "session", ruleId: "credential_read", level: "high", evidence: "cat ~/.ssh/id_rsa"}]},
  openFindings: {high: 1, medium: 0, low: 0}, limitations: [], policy: {projects: [], rules: [], protectedBranches: [], writeProtectedPaths: [], blockedCommands: [], sensitivePaths: []},
  scoreHistory: [], stats: { firstEventAt: Date.now() - 86400000, totalChecked: 1518, totalBlocked: 3, toolsWithEvents: 2, byDay: [], byRule: {}, byTool: {}, actions: Array.from({length: 12}, (_, i) => ({at: Date.now() - i * 60000, operation: "体检记录 " + (i + 1), reason: "读取 12 个配置文件，评分 88", tool: "app"})) }
};
const fixture = window.__fixture = { delay: 0, fail: false, calls: 0, errors: [], progress: null, refresh: null, setActions: actions => { overview.stats.actions = actions; fixture.refresh?.(); } };
const service = {
  securityOverview: async () => structuredClone(overview),
  securityLastDoctor: async () => undefined,
  onSecurity: cb => { fixture.refresh = cb; return () => { fixture.refresh = null; }; },
  onSecurityProgress: cb => { fixture.progress = cb; return () => { fixture.progress = null; }; },
  securityDoctor: async () => {
    fixture.calls++;
    fixture.progress?.({kind: "doctor", step: 1, steps: 4, title: "检查配置", found: 0});
    await new Promise(resolve => setTimeout(resolve, fixture.delay));
    fixture.progress?.({kind: "doctor", step: 1, steps: 1, title: "体检完成", found: 1, done: true});
    if (fixture.fail) throw new Error("模拟体检失败");
    return {at: Date.now(), findings: [finding], scanned: [{tool: "codex", files: 12}], ignored: []};
  }
};
createRoot(document.getElementById("root")).render(<div style={{padding: 24}}><SecurityCenter api={{security: service, fileWorkspace: async () => ({scopes: [], coverage: {gaps: []}, alerts: []}), auditEvents: async () => ({events: []})}} onError={text => fixture.errors.push(text)} /></div>);
`,
  },
  outfile: path.join(directory, "fixture.js"),
  bundle: true,
  format: "iife",
  jsx: "automatic",
});
await fs.writeFile(
  path.join(directory, "index.html"),
  '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script></html>',
);
await fs.writeFile(
  path.join(directory, "main.cjs"),
  `
const { app, BrowserWindow } = require("electron");
app.setPath("userData", ${JSON.stringify(path.join(directory, "profile"))});
app.whenReady().then(() => {
  const win = new BrowserWindow({width: 1440, height: 1000, show: false, webPreferences: {contextIsolation: true, nodeIntegration: false}});
  win.loadFile(${JSON.stringify(path.join(directory, "index.html"))});
});
`,
);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await _electron.launch({
    executablePath: require("electron"),
    args: [path.join(directory, "main.cjs")],
    env,
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.reload();
  const historyButton = page.getByRole("button", { name: /^处理记录/ });
  const drawer = page.getByRole("dialog", { name: "处理记录", exact: true });
  await expect(historyButton).toHaveText("处理记录（12）");
  await expect(page.locator(".action-feed")).toHaveCount(0);
  await historyButton.click();
  await expect(drawer).toBeVisible();
  await expect
    .poll(() =>
      drawer.evaluate((el) => Math.round(innerWidth - el.getBoundingClientRect().right)),
    )
    .toBe(0);
  await expect(drawer.locator(".action-feed li")).toHaveCount(12);
  await expect(drawer.locator(".action-feed li").first()).toContainText(
    "体检记录 1",
  );
  await expect(
    drawer.getByRole("button", { name: "关闭", exact: true }),
  ).toBeFocused();
  assert.equal(
    await page.evaluate(() => document.body.style.overflow),
    "hidden",
  );
  const drawerBody = drawer.locator(".modal-body");
  assert.ok(
    await drawerBody.evaluate((el) => el.scrollHeight > el.clientHeight),
    "记录列表可独立滚动",
  );
  await drawerBody.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(drawer.locator(".action-feed li").last()).toBeInViewport();
  await drawerBody.evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({ path: path.join(directory, "action-history.png") });
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(historyButton).toBeFocused();
  assert.notEqual(
    await page.evaluate(() => document.body.style.overflow),
    "hidden",
  );
  await historyButton.click();
  await page
    .locator(".drawer-backdrop")
    .click({ position: { x: 100, y: 100 } });
  await expect(drawer).toHaveCount(0);
  await page.evaluate(() => window.__fixture.setActions([]));
  await expect(historyButton).toHaveText("处理记录（0）");
  await page.setViewportSize({ width: 480, height: 800 });
  await historyButton.click();
  await expect(drawer.getByText("暂无处理记录", { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      drawer.evaluate((el) => Math.round(innerWidth - el.getBoundingClientRect().right)),
    )
    .toBe(0);
  assert.ok((await drawer.boundingBox()).width <= 480, "窄窗口抽屉不溢出");
  await drawer.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(historyButton).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const basis = page.getByRole("button", { name: "评分依据", exact: true });
  try {
    await basis.click({ timeout: 10000 });
  } catch (error) {
    console.error({ errors, body: await page.locator("body").innerText() });
    throw error;
  }
  await expect(
    page.getByRole("heading", { name: "评分是怎么算的" }),
  ).toBeInViewport();
  await expect(basis).toHaveAttribute("aria-expanded", "true");
  assert.equal(await page.locator(".security-hero + #score-basis").count(), 1);
  await expect(page.locator(".score-basis tr.total td").last()).toHaveText(
    "74",
  );
  await basis.click();
  await expect(page.locator("#score-basis")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "检查项与覆盖范围" })).toBeVisible();
  await expect(page.locator(".overview-checks")).toContainText("1 条历史线索 · 不扣分");
  await expect(page.locator("#overview-problems")).not.toContainText("历史会话发现");
  await expect(page.locator("#overview-problems")).toContainText("同类合并计分");
  const evidence = page.locator(".finding-evidence pre");
  await expect(evidence.locator(".highlight-sensitive")).toHaveText([
    "creator_user_id",
    "apiKey",
  ]);
  await expect(evidence.locator(".highlight-path")).toHaveText([
    '"/Users/example/My Project/credentials.json"',
  ]);
  await expect(evidence.locator(".highlight-risk")).toHaveText([
    "approval_policy",
    "never",
  ]);
  await expect(evidence.locator("img")).toHaveCount(0);
  await expect(evidence).toContainText("<img src=x onerror=alert(1)>");
  await expect(page.locator(".finding-path code")).toHaveText(
    "/Users/example/My Project/credentials.json",
  );
  assert.equal(await page.locator(".stat-icon svg").count(), 4);
  assert.notEqual(
    await page
      .locator(".stat-icon-radar svg")
      .evaluate((el) => getComputedStyle(el).animationName),
    "none",
  );

  const recheck = page
    .locator(".hero-actions")
    .getByRole("button", { name: "重新体检", exact: true });
  const active = page.locator(".security-score.is-checking");
  const completed = page.getByText(/^体检完成：/);
  const start = Date.now();
  await recheck.click();
  await expect(active).toHaveAttribute("aria-busy", "true");
  const animation = await active.evaluate(
    (el) => getComputedStyle(el, "::after").animationName,
  );
  assert.equal(animation, "security-spin");
  await expect(page.locator(".checkup-spinner")).toBeVisible();
  await page.waitForTimeout(650);
  await expect(active).toBeVisible(); // backend done:true must not finish the UI early
  await page
    .locator(".hero-actions button.primary")
    .evaluate((el) => el.click());
  assert.equal(await page.evaluate(() => window.__fixture.calls), 1);
  await page.screenshot({ path: path.join(directory, "checking.png") });
  await completed.waitFor();
  assert.ok(Date.now() - start >= 2000, "快速体检至少展示 2 秒");
  await expect(active).toHaveCount(0);
  await expect(recheck).toBeEnabled();

  await page.evaluate(() => {
    window.__fixture.delay = 2400;
  });
  const slow = Date.now();
  await recheck.click();
  await page.waitForTimeout(2100);
  await expect(active).toBeVisible();
  await completed.waitFor();
  assert.ok(Date.now() - slow >= 2400, "慢体检等待真实结果");
  await expect(recheck).toBeEnabled();

  await page.evaluate(() => {
    window.__fixture.delay = 0;
    window.__fixture.fail = true;
  });
  const failed = Date.now();
  await recheck.click();
  await expect(active).toBeVisible();
  await expect(recheck).toBeEnabled();
  assert.ok(Date.now() - failed >= 2000, "失败后也正常结束最短加载状态");
  assert.deepEqual(await page.evaluate(() => window.__fixture.errors), [
    "模拟体检失败",
  ]);
  await expect(active).toHaveCount(0);
  await expect(completed).toHaveCount(0);
  await page.evaluate(() => {
    window.__fixture.fail = false;
  });
  await recheck.click();
  await completed.waitFor();
  await expect(recheck).toBeEnabled();

  await page.screenshot({
    path: path.join(directory, "overview.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 900, height: 800 });
  await basis.click();
  await expect(
    page.getByRole("heading", { name: "评分是怎么算的" }),
  ).toBeInViewport();
  await page.screenshot({ path: path.join(directory, "basis.png") });
  const sizes = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  assert.ok(sizes.scroll <= sizes.width, "窄窗口无横向溢出");
  await page.getByRole("tab", { name: "回溯扫描", exact: true }).click();
  await expect(page.getByRole("heading", { name: "历史线索（1）" })).toBeVisible();
  await expect(page.locator(".retro-hits")).toContainText("复核建议：");
  await expect(page.locator(".retro-hits")).toContainText("仅出现路径不等于泄露");
  await expect(page.locator(".retro-hits button")).toHaveCount(0);
  await expect(page.getByText("作为问题处理", { exact: false })).toHaveCount(0);
  await page.screenshot({ path: path.join(directory, "retro-review.png"), fullPage: true });
  await page.getByRole("tab", { name: "概览", exact: true }).click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await page
      .locator(".stat-icon-radar svg")
      .evaluate((el) => getComputedStyle(el).animationName),
    "none",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: 处理记录按钮、右侧抽屉、完整列表、独立滚动、Esc/遮罩/按钮关闭及焦点恢复、空状态与窄窗口；评分依据在当前视野展开/收起；敏感字段、路径、配置高亮且原文安全显示；四个动态统计图标；体检圆环/按钮动画；至少 2 秒、慢请求、失败恢复及重复点击；窄窗口与减少动画模式；无页面异常。受控响应，未修改真实配置。",
  );
  console.log(`截图目录：${directory}`);
} finally {
  if (app) await app.close();
}
