import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";

// Exercise the real renderer, preload and copier against an isolated home.
const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "package.json"));
const { _electron, expect } = require("@playwright/test");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "network-lens-auto-copy-"));
const home = path.join(temporary, "home");
const sourceRoot = path.join(home, ".wiscode/codex-agents/skills");
const sources = {
  "grill-me": "---\nname: grill-me\ndescription: Ask about a design\ndisable-model-invocation: true\n---\n# Grill me\nAsk about the design.\n",
  direct: "---\nname: direct\ndescription: Direct copy\n---\n# Direct\n",
  convert: "---\nname: convert\ndescription: Convert tools\nallowed-tools: Bash(git:*)\n---\n# Convert\n",
  blocked: "---\nname: blocked\n---\n# Blocked\n",
};
const sidecar = "interface:\n  display_name: Grill me\npolicy:\n  allow_implicit_invocation: false\ndependencies:\n  tools: []\n";
let app;
try {
  for (const [name, content] of Object.entries(sources)) {
    await fs.mkdir(path.join(sourceRoot, name), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, name, "SKILL.md"), content);
  }
  await fs.mkdir(path.join(sourceRoot, "grill-me/agents"));
  await fs.writeFile(path.join(sourceRoot, "grill-me/agents/openai.yaml"), sidecar);
  // Boot production main/preload with an isolated home; do not replace IPC handlers.
  const bootstrap = path.join(temporary, "bootstrap.cjs");
  await fs.writeFile(bootstrap, `const { app } = require("electron"); app.setAppPath(${JSON.stringify(root)}); app.setPath("home", ${JSON.stringify(home)}); require(${JSON.stringify(path.join(root, "dist-electron/main.cjs"))});`);
  const env = { ...process.env, NETWORK_LENS_DATA_DIR: path.join(temporary, "data") };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NETWORK_LENS_DEV;
  app = await _electron.launch({ executablePath: require("electron"), args: [bootstrap], env, timeout: 30000 });
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.evaluate(() => window.networkLens.stopProviders());
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Skill 中心", exact: true }).click();
  const rows = page.locator(".skill-row");
  await expect(rows).toHaveCount(4);
  await rows.filter({ has: page.getByRole("button", { name: /^grill-me/ }) }).locator(".skill-row-copy").click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("select").selectOption("opencode");
  // No check or conversion confirmation click: the modal checks automatically.
  const copy = dialog.getByRole("button", { name: "确认复制（1）", exact: true });
  await expect(copy).toBeEnabled();
  await expect(dialog.locator(".skill-target-presence").getByText(/1 项未发现同名 Skill/)).toBeVisible();
  await expect(dialog.getByText("可原样复制", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /确认修改并复制/ })).toHaveCount(0);
  if (process.env.NETWORK_LENS_SKILL_SHOTS_DIR) {
    await fs.mkdir(process.env.NETWORK_LENS_SKILL_SHOTS_DIR, { recursive: true });
    await dialog.screenshot({ path: path.join(process.env.NETWORK_LENS_SKILL_SHOTS_DIR, "skill-auto-copy.png") });
  }
  await copy.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/已复制 1\/1 项/)).toBeVisible();
  const destination = path.join(home, ".config/opencode/skills");
  const converted = await fs.readFile(path.join(destination, "grill-me/SKILL.md"), "utf8");
  assert.equal(converted, sources["grill-me"]);
  assert.equal(await fs.readFile(path.join(destination, "grill-me/agents/openai.yaml"), "utf8"), sidecar);
  await expect(page.getByText("完整性：通过", { exact: true })).toBeVisible();
  await expect(page.getByText("实际运行：未验证", { exact: true })).toBeVisible();
  if (process.env.NETWORK_LENS_SKILL_SHOTS_DIR) await page.screenshot({ path: path.join(process.env.NETWORK_LENS_SKILL_SHOTS_DIR, "skill-copy-results.png") });

  // Mixed batch: direct + convert count together; existing and blocked skip.
  await page.getByRole("button", { name: "重新扫描", exact: true }).click();
  await expect(page.getByRole("button", { name: "重新扫描", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "WisCode", exact: true }).click();
  await page.getByRole("button", { name: "全选当前结果", exact: true }).click();
  await page.getByRole("button", { name: "复制（4）", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "确认复制（2）", exact: true })).toBeEnabled();
  await expect(dialog.getByText("跳过", { exact: true })).toBeVisible();
  await expect(dialog.getByText("检查未通过", { exact: true })).toBeVisible();
  const blockedRow = dialog.locator(".skill-transfer-row").filter({ hasText: "blocked" });
  await expect(blockedRow.locator("p").first()).toBeVisible();
  await dialog.getByRole("button", { name: "确认复制（2）", exact: true }).click();
  await expect(page.getByText(/已复制 2\/4 项，2 项跳过/)).toBeVisible();
  assert.equal(await fs.readFile(path.join(destination, "convert/SKILL.md"), "utf8"), sources.convert);
  assert.equal(await fs.readFile(path.join(destination, "direct/SKILL.md"), "utf8"), sources.direct);

  await assert.rejects(() => fs.stat(path.join(destination, "blocked")), /ENOENT/);

  // A different same-name target is shown as an update and backed up before replacement.
  await fs.writeFile(path.join(destination, "direct/SKILL.md"), "user edit to preserve\n");
  await rows.filter({ has: page.getByRole("button", { name: /^direct/ }) }).locator(".skill-row-copy").click();
  await expect(dialog.getByText("备份后更新", { exact: true })).toBeVisible();
  await expect(dialog.locator(".skill-target-presence").getByText(/已有 1 项同名 Skill，内容不同/)).toBeVisible();
  await expect(dialog.getByText(/目标内容与源不同/).first()).toBeVisible();
  await dialog.getByRole("button", { name: "确认复制（1）", exact: true }).click();
  await expect(page.getByText(/旧版已备份到/)).toBeVisible();
  const updateRow = page.locator(".skill-results .skill-transfer-row").filter({ hasText: "direct" }).last();
  const backupPath = await updateRow.locator(".skill-path").last().textContent();
  assert.ok(backupPath);
  assert.equal(await fs.readFile(path.join(backupPath, "SKILL.md"), "utf8"), "user edit to preserve\n");
  assert.equal(await fs.readFile(path.join(destination, "direct/SKILL.md"), "utf8"), sources.direct);

  // The rendered cleanup flow moves the exact installed item and restores it without overwriting.
  await page.getByRole("button", { name: "重新扫描", exact: true }).click();
  await expect(page.getByRole("button", { name: "重新扫描", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "OpenCode", exact: true }).click();
  const directRow = rows.filter({ has: page.getByRole("button", { name: /^direct/ }) });
  await directRow.getByRole("button", { name: "移入回收区 direct" }).click();
  await expect(dialog.getByText("暂无清理建议", { exact: true })).toBeVisible();
  await expect(dialog.getByText(path.join(destination, "direct"))).toBeVisible();
  if (process.env.NETWORK_LENS_SKILL_SHOTS_DIR) await dialog.screenshot({ path: path.join(process.env.NETWORK_LENS_SKILL_SHOTS_DIR, "skill-delete-preview.png") });
  await dialog.getByRole("button", { name: "确认移入回收区（1）" }).click();
  await expect(dialog).toHaveCount(0);
  await assert.rejects(() => fs.stat(path.join(destination, "direct")), /ENOENT/);
  await expect(page.getByText(/本次清理结果：1 项已移入回收区/)).toBeVisible();
  if (process.env.NETWORK_LENS_SKILL_SHOTS_DIR) await page.screenshot({ path: path.join(process.env.NETWORK_LENS_SKILL_SHOTS_DIR, "skill-trash-results.png") });
  await page.locator(".skill-restore-button").click();
  await expect(page.getByText(/已恢复 direct 到/)).toBeVisible();
  assert.equal(await fs.readFile(path.join(destination, "direct/SKILL.md"), "utf8"), sources.direct);

  for (const [name, content] of Object.entries(sources)) assert.equal(await fs.readFile(path.join(sourceRoot, name, "SKILL.md"), "utf8"), content);
  assert.equal(await fs.readFile(path.join(sourceRoot, "grill-me/agents/openai.yaml"), "utf8"), sidecar);

  // A malformed optional interface is repaired automatically in the target copy.
  const repairSource = path.join(sourceRoot, "repair");
  const repairMetadata = 'interface:\ndisplay_name: "Repair"\nshort_description: "Repair fixture"\ndefault_prompt: "Use repair"\npolicy:\n  allow_implicit_invocation: false\n';
  await fs.mkdir(path.join(repairSource, "agents"), { recursive: true });
  await fs.writeFile(path.join(repairSource, "SKILL.md"), "---\nname: repair\ndescription: Repair fixture\n---\n# Repair\n");
  await fs.writeFile(path.join(repairSource, "agents/openai.yaml"), repairMetadata);
  await page.getByRole("button", { name: "重新扫描", exact: true }).click();
  await expect(page.getByRole("button", { name: "重新扫描", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "WisCode", exact: true }).click();
  await rows.filter({ has: page.getByRole("button", { name: /^repair / }) }).locator(".skill-row-copy").click();
  await dialog.locator("select").selectOption("wiscode");
  await expect(dialog.getByText("自动修复后复制", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "确认复制（1）", exact: true })).toBeEnabled();
  if (process.env.NETWORK_LENS_SKILL_SHOTS_DIR) await dialog.screenshot({ path: path.join(process.env.NETWORK_LENS_SKILL_SHOTS_DIR, "skill-auto-repair.png") });
  await dialog.getByRole("button", { name: "确认复制（1）", exact: true }).click();
  await expect(page.getByText("自动修复：通过", { exact: true })).toBeVisible();
  const repairedMetadata = await fs.readFile(path.join(home, ".wiscode/skills/repair/agents/openai.yaml"), "utf8");
  assert.match(repairedMetadata, /interface:\n  display_name:/);
  assert.match(repairedMetadata, /policy:\n  allow_implicit_invocation: false/);
  assert.equal(await fs.readFile(path.join(repairSource, "agents/openai.yaml"), "utf8"), repairMetadata);
  assert.deepEqual(errors, []);
  console.log("Verified: automatic preview and metadata repair, exact block reason, mixed batch, original copy, same-name backup update, cleanup preview and restore, source preservation; no renderer errors.");
} finally {
  if (app) await app.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
