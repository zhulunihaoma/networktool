// Isolated app + bundled guard: saved UI settings must affect the next hook call.
// Payloads are inspected only; no commands or sensitive-file reads are executed.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "package.json"));
const { _electron, expect } = require("@playwright/test");
const runtime = require("electron");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nl-policy-ui-"));
const data = path.join(directory, "data");
const home = path.join(directory, "home");
await fs.mkdir(home);
const env = {
  ...process.env,
  NETWORK_LENS_DATA_DIR: data,
  NETWORK_LENS_TEST_HOME: home,
  NETWORK_LENS_AUTO_PROTECT: "0",
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await _electron.launch({ executablePath: runtime, args: [root], env });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 1100 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByRole("button", { name: "安全中心", exact: true }).click();
  await page.getByRole("tab", { name: "操作规则", exact: true }).click();
  const focus = page.getByRole("region", { name: "重点保护清单", exact: true });
  await expect(focus).toBeVisible();
  assert.ok(
    await focus.evaluate(
      (el) =>
        !!(
          el.compareDocumentPosition(
            document.querySelector(".protection-switch-title"),
          ) & Node.DOCUMENT_POSITION_FOLLOWING
        ),
    ),
  );
  const readPolicy = () =>
    page.evaluate(
      async () => (await window.networkLens.security.securityOverview()).policy,
    );
  const initial = await readPolicy();
  await expect(focus.locator(".token-sensitive")).toHaveCount(
    initial.sensitivePaths.length,
  );
  await expect(focus.locator(".token-branch")).toHaveText(
    initial.protectedBranches,
  );
  assert.notEqual(
    await focus
      .locator(".token-sensitive")
      .first()
      .evaluate((el) => getComputedStyle(el).color),
    await focus
      .locator(".token-branch")
      .first()
      .evaluate((el) => getComputedStyle(el).color),
  );
  await focus.screenshot({
    path: path.join(directory, "protection-lists.png"),
  });
  await page.screenshot({
    path: path.join(directory, "operation-rules.png"),
    fullPage: true,
  });
  const edit = async (title, value) => {
    const card = focus.getByRole("region", { name: title, exact: true });
    await card.getByRole("button", { name: "编辑清单", exact: true }).click();
    await card.getByRole("textbox").fill(value);
    await card.getByRole("button", { name: "收起编辑", exact: true }).click();
  };
  const save = async () => {
    await page
      .getByRole("button", { name: "保存防护规则", exact: true })
      .click();
    await expect(
      focus.getByText("已保存的配置", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "保存防护规则", exact: true }),
    ).toBeDisabled();
  };
  const invoke = (toolName, input) => {
    const result = spawnSync(
      runtime,
      [
        path.join(data, "security", "guard.cjs"),
        "--tool",
        "codex",
        "--data",
        path.join(data, "security"),
      ],
      {
        input: JSON.stringify({
          tool_name: toolName,
          tool_input: input,
          cwd: directory,
        }),
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          NETWORK_LENS_GUARD_SOURCE: "self_check",
        },
        encoding: "utf8",
        timeout: 15000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return (
      JSON.parse(result.stdout).hookSpecificOutput?.permissionDecision ??
      "allow"
    );
  };
  assert.equal(invoke("Read", { file_path: "config/prod.vault" }), "allow");
  await edit(
    "敏感文件与后缀",
    [
      ...initial.sensitivePaths,
      "config/*.vault",
      "~/secrets/*.token",
      "*.demo-secret",
    ].join(", "),
  );
  await edit(
    "全局保护分支",
    [...initial.protectedBranches, "stable/demo"].join(", "),
  );
  await edit(
    "全局保护路径",
    [...initial.writeProtectedPaths, "deploy/*.yaml"].join(", "),
  );
  await edit("额外拦截命令", "terraform apply, aws s3 rm");
  await expect(focus.getByText("预览未保存的修改")).toBeVisible();
  assert.equal(
    invoke("Read", { file_path: "config/prod.vault" }),
    "allow",
    "draft is not applied before saving",
  );
  await save();
  const stored = JSON.parse(
    await fs.readFile(path.join(data, "security", "policy.json"), "utf8"),
  );
  assert.ok(stored.sensitivePaths.includes("config/*.vault"));
  for (const [tool, input] of [
    ["Read", { file_path: "config/prod.vault" }],
    [
      "Read",
      { file_path: path.join(os.homedir(), "secrets", "example.token") },
    ],
    ["Read", { file_path: "keys/example.demo-secret" }],
    ["Write", { file_path: "config/prod.vault" }],
    ["Write", { file_path: "deploy/release.yaml" }],
    ["Bash", { command: "git push origin stable/demo" }],
    ["Bash", { command: "pwd && terraform apply -auto-approve" }],
  ])
    assert.equal(invoke(tool, input), "deny", JSON.stringify(input));
  assert.equal(invoke("Bash", { command: "echo terraform apply" }), "allow");
  assert.equal(invoke("Bash", { command: "terraform apply-preview" }), "allow");
  assert.equal(invoke("Read", { file_path: "README.md" }), "allow");
  await page
    .getByRole("checkbox", { name: "保护密钥不被读取", exact: true })
    .uncheck();
  await expect(
    focus.getByText("读取保护：已关闭，不拦截", { exact: true }),
  ).toBeVisible();
  await save();
  assert.equal(invoke("Read", { file_path: "config/prod.vault" }), "allow");
  assert.equal(invoke("Write", { file_path: "config/prod.vault" }), "deny");
  await page
    .getByRole("checkbox", { name: "保护密钥不被读取", exact: true })
    .check();
  await save();
  assert.equal(
    invoke("Read", { file_path: "config/prod.vault" }),
    "deny",
    "next invocation reads updated policy without reinstalling hooks",
  );
  await page.reload();
  await page.getByRole("button", { name: "安全中心", exact: true }).click();
  await page.getByRole("tab", { name: "操作规则", exact: true }).click();
  await expect(
    page.locator(".token-sensitive").filter({ hasText: "config/*.vault" }),
  ).toHaveText("config/*.vault");
  const card = page.getByRole("region", { name: "全局保护分支", exact: true });
  await card.getByRole("button", { name: "编辑清单", exact: true }).click();
  const textbox = card.getByRole("textbox");
  await textbox.fill("main");
  await textbox.press("End");
  await textbox.pressSequentially(", feature/review");
  await expect(textbox).toHaveValue("main, feature/review");
  await card.getByRole("button", { name: "收起编辑", exact: true }).click();
  await expect(card.locator(".token-branch")).toHaveText([
    "main",
    "feature/review",
  ]);
  await page.setViewportSize({ width: 1050, height: 900 });
  assert.ok(
    await focus.evaluate((el) => el.scrollWidth <= el.clientWidth),
    "protection list must wrap in a narrower window",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: 重点清单置顶、标签配色/完整展示、草稿与保存状态、输入分隔符、页面重载持久化、窄窗口换行。",
  );
  console.log(
    "PASS: 页面保存 → IPC → policy.json → 打包守卫：自定义敏感文件/后缀/主目录通配、分支、保护路径和命令真实判定；关闭读取规则放行，重新开启下一次调用立即拦截。未执行载荷命令或读取敏感文件；未改动用户工具配置。",
  );
  console.log(
    `Screenshots: ${path.join(directory, "protection-lists.png")} / ${path.join(directory, "operation-rules.png")}`,
  );
} finally {
  if (app) await app.close();
}
