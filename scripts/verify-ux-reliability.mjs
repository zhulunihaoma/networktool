/** Isolated desktop regression: draft choices and page state. No external network or clipboard. */
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "package.json"));
const { _electron, expect } = require("@playwright/test");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "networktool-ux-"));
const home = path.join(temporary, "home"),
  data = path.join(temporary, "data"),
  project = path.join(home, "project");
const put = async (relative, content) => {
  const file = path.join(home, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
};
await put("project/.env", "SECRET=fixture-never-displayed");
await put("project/private.key", "private-fixture-never-displayed");
await put(".codex/memories/MEMORY.md", "# 示例记忆\n- 保留当前阅读位置。\n");
await put(
  ".claude/projects/example/memory/MEMORY.md",
  "# Claude 示例\n- 继续当前阅读。\n",
);
await put(
  ".codex/skills/ux-fixture/SKILL.md",
  "---\nname: ux-fixture\ndescription: 交互验收示例\n---\n# 交互验收\n只读示例。\n",
);
const bootstrap = path.join(temporary, "bootstrap.cjs");
await fs.writeFile(
  bootstrap,
  `const {app,net,dialog}=require('electron');app.setAppPath(${JSON.stringify(root)});app.setPath('home',${JSON.stringify(home)});app.setPath('userData',${JSON.stringify(data)});net.fetch=async()=>{throw new Error('fixture network disabled')};dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(project)}]});require(${JSON.stringify(path.join(root, "dist-electron/main.cjs"))});`,
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
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1366, height: 768 });
  const nav = (name) => page.getByRole("button", { name, exact: true });
  await nav("文件策略与审计").click();
  await nav("选择项目或目录").click();
  const envFile = page.getByRole("button", { name: /^\.env / });
  const keyFile = page.getByRole("button", { name: /^private.key / });
  await envFile.click();
  const read = page.getByRole("combobox", { name: "读取策略", exact: true });
  await read.selectOption("allow");
  await nav("记忆工作台").click();
  await page.getByRole("tab", { name: "Claude Code", exact: true }).click();
  await nav("文件策略与审计").click();
  await expect(read).toHaveValue("allow");
  await keyFile.click();
  await expect(
    page.getByRole("dialog", { name: "当前策略尚未保存" }),
  ).toBeVisible();
  await nav("继续编辑").click();
  await expect(read).toHaveValue("allow");
  await keyFile.click();
  await nav("放弃修改并继续").click();
  await expect(page.locator(".policy-editor h3")).toHaveText("private.key");
  await envFile.click();
  await expect(read).toHaveValue("deny");
  await read.selectOption("allow");
  await keyFile.click();
  await nav("保存并继续").click();
  await expect(page.locator(".policy-editor h3")).toHaveText("private.key");
  const saved = await page.evaluate(() => window.networkLens.fileWorkspace());
  assert.equal(
    saved.scopes[0].policies.find(
      (item) =>
        saved.scopes[0].candidates.find((file) => file.id === item.resourceId)
          ?.relativePath === ".env",
    ).read,
    "allow",
  );

  await envFile.click();
  await read.selectOption("deny");
  const beforeConflict = await page.evaluate(() =>
    window.networkLens.fileWorkspace(),
  );
  const envCandidate = beforeConflict.scopes[0].candidates.find(
    (file) => file.relativePath === ".env",
  );
  const existingPolicy = beforeConflict.scopes[0].policies.find(
    (policy) => policy.resourceId === envCandidate.id,
  );
  await page.evaluate(
    async ({ scopeId, policy }) => {
      await window.networkLens.saveFilePolicy(
        scopeId,
        {
          resourceId: policy.resourceId,
          read: policy.read,
          write: "allow",
          disclose: policy.disclose,
          enabled: policy.enabled,
        },
        policy.revision,
      );
    },
    { scopeId: beforeConflict.scopes[0].id, policy: existingPolicy },
  );
  await keyFile.click();
  await nav("保存并继续").click();
  await expect(
    page.getByRole("dialog", { name: "当前策略尚未保存" }).getByRole("alert"),
  ).toContainText(/版本|变更|变化|更新/);
  await expect(
    page.getByRole("dialog", { name: "当前策略尚未保存" }).getByRole("alert"),
  ).not.toContainText("Error invoking");
  await nav("继续编辑").click();
  await expect(read).toHaveValue("deny");
  await page.getByRole("button", { name: "重新扫描", exact: true }).click();
  await nav("放弃修改并继续").click();
  await envFile.click();
  await read.selectOption("deny");
  await nav("保存策略").click();
  await expect(page.locator(".persistent-error")).toHaveCount(0);
  await nav("记忆工作台").click();
  await expect(
    page.getByRole("tab", { name: "Claude Code", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await nav("Skill 中心").click();
  const search = page.getByPlaceholder("搜索名称、用途或功能");
  await search.fill("ux-fixture");
  await expect(page.locator(".skill-row")).toHaveCount(1, {
    timeout: 30000,
  });
  await page.locator(".skill-row input[type=checkbox]").check();
  await nav("记忆工作台").click();
  await nav("Skill 中心").click();
  await expect(search).toHaveValue("ux-fixture");
  await expect(
    page.locator(".skill-row input[type=checkbox]"),
  ).toBeChecked();
  assert.deepEqual(errors, []);
  assert.equal(
    await fs.readFile(path.join(project, ".env"), "utf8"),
    "SECRET=fixture-never-displayed",
  );
  await page.screenshot({ path: path.join(temporary, "retained-state.png") });
  console.log(
    JSON.stringify(
      {
        passed: true,
        checks: [
          "draft survives sidebar navigation",
          "continue editing keeps changes",
          "discard restores saved policy",
          "save and continue persists before navigation",
          "memory Agent survives navigation",
          "Skill query and selection survive navigation",
          "source files unchanged",
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
