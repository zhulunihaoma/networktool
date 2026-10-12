import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "package.json"));
const { _electron, expect } = require("@playwright/test");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "network-lens-skill-"));
const shots = process.env.NETWORK_LENS_SKILL_SHOTS_DIR || path.join(root, "docs/screenshots");
let app;
try {
  app = await _electron.launch({
    executablePath: require("electron"),
    args: [root],
    env: { ...process.env, NETWORK_LENS_DATA_DIR: path.join(temporary, "data") },
    timeout: 30000,
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Skill 中心", exact: true }).click();
  await page.getByRole("heading", { name: "Skill 中心", exact: true }).waitFor();

  // 进入 Skill 中心即扫描，无需再点击开始；后续仍可手动刷新。
  await expect(page.getByRole("button", { name: /开始扫描/ })).toHaveCount(0);
  await page.getByRole("button", { name: /重新扫描/ }).waitFor({ timeout: 40000 });

  const rows = page.locator(".skill-row");
  await expect.poll(async () => rows.count(), { timeout: 40000 }).toBeGreaterThan(0);
  const total = await page.getByText(/已发现 \d+ 个 Skill/).innerText();
  console.log("scan:", total, "rows:", await rows.count());

  await page.getByRole("button", { name: "重新扫描", exact: true }).click();
  await expect(page.getByRole("button", { name: "重新扫描", exact: true })).toBeEnabled({ timeout: 40000 });
  await expect.poll(async () => rows.count(), { timeout: 40000 }).toBeGreaterThan(0);

  // 离开后再次进入，自动读取最新目录。
  await page.getByRole("button", { name: "偏好设置", exact: true }).click();
  await page.getByRole("button", { name: "Skill 中心", exact: true }).click();
  await expect(page.getByRole("button", { name: "重新扫描", exact: true })).toBeEnabled({ timeout: 40000 });
  await expect.poll(async () => rows.count(), { timeout: 40000 }).toBeGreaterThan(0);

  // 表头与内容列必须左对齐且同列宽
  const align = await page.evaluate(() => {
    const head = [...document.querySelectorAll(".skill-table-head > *")];
    // 只取第一行：所有行共用同一 grid 模板，逐行比对会把 87 行全部收进数组
    const row = [...document.querySelector(".skill-row").children];
    const name = document.querySelector(".skill-name");
    return {
      headAlign: head.map((n) => getComputedStyle(n).textAlign),
      // 复选框等表单控件的 text-align 被 UA 样式表强制为 start，且不渲染文字，不参与对齐断言
      rowAlign: row
        .filter((n) => !["INPUT", "SELECT"].includes(n.tagName))
        .map((n) => getComputedStyle(n).textAlign),
      nameJustify: getComputedStyle(name).justifyContent,
      headCols: head.map((n) => Math.round(n.getBoundingClientRect().x)),
      rowCols: row.map((n) => Math.round(n.getBoundingClientRect().x)),
      firstTextColDelta: Math.round(
        head[1].getBoundingClientRect().x - row[1].getBoundingClientRect().x,
      ),
      tableW: Math.round(document.querySelector(".skill-table").getBoundingClientRect().width),
      panelW: Math.round(document.querySelector(".skill-list").getBoundingClientRect().width),
      headText: name.querySelector("span")?.getBoundingClientRect().x ?? 0,
    };
  });
  assert.deepEqual([...new Set(align.headAlign)], ["left"], "head left");
  assert.deepEqual([...new Set(align.rowAlign)], ["left"], "row left");
  assert.notEqual(align.nameJustify, "center", "skill-name not centered");
  assert.deepEqual(align.headCols, align.rowCols, "columns share x offset");
  assert.equal(align.firstTextColDelta, 0, "name column aligns with its header");
  // panel 左右各 1px 边框计入 getBoundingClientRect，容差放宽到边框宽度
  assert.ok(Math.abs(align.tableW - align.panelW) <= 2, "table fills panel");
  console.log("align:", JSON.stringify(align));

  // 密度与可见性：长列表必须内滚且提醒不能被推到表格之下
  const density = await page.evaluate(() => {
    const panel = document.querySelector(".skill-list").getBoundingClientRect();
    const table = document.querySelector(".skill-table");
    const tr = table.getBoundingClientRect();
    const row = document.querySelector(".skill-row").getBoundingClientRect();
    const notice = document.querySelector(".skill-notice")?.getBoundingClientRect();
    const controls = [...document.querySelectorAll(".skill-toolbar > *")].map((n) =>
      Math.round(n.getBoundingClientRect().height),
    );
    const head = document.querySelector(".skill-table-head");
    return {
      tableH: Math.round(tr.height),
      innerScroll: table.scrollHeight > table.clientHeight,
      rowH: Math.round(row.height),
      noticeBelowTable: notice ? Math.round(notice.y - tr.y) : null,
      controlH: controls,
      headPosition: getComputedStyle(head).position,
      panelBottomGap: Math.round(panel.bottom - tr.bottom),
    };
  });
  assert.ok(density.rowH <= 80, `row too tall: ${density.rowH}`);
  assert.ok(density.innerScroll, "long list should scroll inside the panel");
  assert.ok(density.tableH <= 620, `table too tall: ${density.tableH}`);
  assert.ok(
    density.noticeBelowTable === null || density.noticeBelowTable < 0,
    "notice must sit above the table, not below 8k rows",
  );
  assert.equal(density.headPosition, "sticky", "table head sticky");
  assert.ok(
    Math.max(...density.controlH) - Math.min(...density.controlH) <= 3,
    `toolbar controls uneven: ${density.controlH}`,
  );
  assert.ok(density.panelBottomGap <= 3, "table flush with panel bottom");
  console.log("density:", JSON.stringify(density));

  await fs.mkdir(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, "skill-list.png") });

  // 行内单项复制：只打开现有检查弹窗，并明确只选择当前 Skill
  await rows.first().locator(".skill-row-copy").click();
  const singleDialog = page.getByRole("dialog");
  await expect(singleDialog).toBeVisible();
  await expect(singleDialog.getByText("已选择 1 个 Skill", { exact: false })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(singleDialog).toHaveCount(0);

  // 选择 → 复制弹窗
  await rows.first().locator('input[type="checkbox"]').check();
  const copyBtn = page.getByRole("button", { name: /复制（1）/ });
  await expect(copyBtn).toBeEnabled();
  await copyBtn.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("复制前检查")).toBeVisible();
  const targetValue = await dialog.locator("select").inputValue();
  assert.ok(targetValue, "copy target prefilled");
  await page.screenshot({ path: path.join(shots, "skill-copy-modal.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // 详情抽屉
  await page.locator(".skill-name").first().click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("摘要来自", { exact: false })).toHaveCount(0);
  await expect(dialog.getByText("运行能力未验证")).toBeVisible();
  await page.screenshot({ path: path.join(shots, "skill-detail.png") });
  await dialog.getByRole("button", { name: "复制这个 Skill", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("已选择 1 个 Skill", { exact: false })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // 搜索 + 来源过滤可达空态
  await page.locator(".skill-toolbar input").fill("zzz-不存在的技能");
  await expect(page.getByText("没有匹配的 Skill")).toBeVisible();
  await page.locator(".skill-toolbar input").fill("");
  await expect.poll(async () => rows.count()).toBeGreaterThan(0);

  // 窄屏无横向溢出
  await page.setViewportSize({ width: 1024, height: 760 });
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    "no page-level horizontal overflow",
  );
  await page.screenshot({ path: path.join(shots, "skill-narrow.png") });

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ verifiedAt: new Date().toISOString(), rows: await rows.count(), align, errors }, null, 2));
} finally {
  if (app) await app.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
