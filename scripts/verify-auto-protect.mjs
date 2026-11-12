/**
 * Verify protect-by-default end to end in Electron:
 *  1. isolated profile must never write the real tool configs;
 *  2. explicit opt-in with an isolated home writes hooks, keeps user settings,
 *     is idempotent, and remembers a manual "off".
 *
 * The second phase uses its own temp home passed through
 * NETWORK_LENS_TEST_HOME, so Electron never touches this machine's real ~.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "package.json"));
const { _electron } = require("@playwright/test");
const realFiles = [
  ".claude/settings.json",
  ".codex/hooks.json",
  ".zcode/cli/config.json",
  ".dsh/network-lens-guard.hooks.json",
  ".config/opencode/plugin/network-lens-guard.js",
].map((file) => path.join(os.homedir(), file));

async function hashRealConfigs() {
  return Promise.all(
    realFiles.map(async (file) => {
      try {
        return createHash("sha256")
          .update(await fs.readFile(file))
          .digest("hex");
      } catch {
        return "absent";
      }
    }),
  );
}

async function launch(env) {
  const clean = { ...process.env, ...env };
  delete clean.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    executablePath: require("electron"),
    args: [root],
    env: clean,
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("button", { name: "安全中心", exact: true }).click();
  await page.getByRole("tab", { name: "防护开关", exact: true }).click();
  await page.getByText("默认开启已安装工具的防护", { exact: true }).waitFor();
  return { app, page, errors };
}

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "nl-auto-protect-"));
const before = await hashRealConfigs();
try {
  // Phase 1: isolated data dir, real home. Nothing may be written.
  {
    const { app, page, errors } = await launch({
      NETWORK_LENS_DATA_DIR: path.join(temporary, "isolated"),
    });
    try {
      const result = await page.evaluate(() =>
        window.networkLens.security.securityRunAutoProtect(),
      );
      assert.equal(result.skipped, "isolated");
      assert.deepEqual(
        await hashRealConfigs(),
        before,
        "隔离模式改写了真实配置",
      );
      assert.deepEqual(errors, []);
    } finally {
      await app.close();
    }
    console.log("PASS: 隔离模式不自动写入真实工具配置。");
  }
  // Phase 2: isolated home plus explicit opt-in.
  {
    const home = path.join(temporary, "home");
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    const settings = path.join(home, ".claude", "settings.json");
    await fs.writeFile(
      settings,
      JSON.stringify({
        env: { KEEP: "1" },
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "kept" }] },
          ],
        },
      }),
    );
    const { app, page, errors } = await launch({
      HOME: home,
      NETWORK_LENS_TEST_HOME: home,
      NETWORK_LENS_DATA_DIR: path.join(temporary, "data"),
      NETWORK_LENS_AUTO_PROTECT: "1",
    });
    try {
      const merged = JSON.parse(await fs.readFile(settings, "utf8"));
      assert.equal(merged.env.KEEP, "1", "原设置被破坏");
      assert.ok(
        merged.hooks.PreToolUse.some((group) =>
          group.hooks.some((hook) =>
            String(hook.command).includes("network-lens-guard"),
          ),
        ),
        "启动时未自动写入钩子",
      );
      const again = await page.evaluate(() =>
        window.networkLens.security.securityRunAutoProtect(),
      );
      assert.deepEqual(again.enabled, [], "重复执行不应重写配置");
      const result = await page.evaluate(() =>
        window.networkLens.security.securityRunAutoProtect(),
      );
      assert.equal(result.failed.length, 0);
      assert.deepEqual(errors, []);
    } finally {
      await app.close();
    }
    assert.deepEqual(await hashRealConfigs(), before, "真实配置被改写");
    console.log("PASS: 默认开启保留原配置、幂等，且不改写真实用户配置。");
  }
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
