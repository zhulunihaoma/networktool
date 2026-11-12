import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SecurityCenter } from "../electron/security/center";
import * as doctor from "../electron/security/doctor";
import { MARKER } from "../electron/security/adapters";
import { autoProtectAllowed } from "../electron/security/auto-protect";
import {
  decide,
  defaultPolicy,
  summarizePayload,
} from "../electron/security/guard-protocol";
test("项目保护保存、拒绝、事件、例外与恢复形成闭环", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nl-center-"));
  try {
    const project = path.join(home, "project");
    fs.mkdirSync(project);
    const center = new SecurityCenter({
      home,
      dataDir: path.join(home, "security"),
      guard: {
        runtime: process.execPath,
        env: {},
        script: "fixture",
        dataDir: path.join(home, "security"),
      },
      doctor,
    });
    const p = {
      ...center.policy(),
      projects: [
        {
          root: project,
          enabled: true,
          protectedBranches: ["stable"],
          protectedPaths: ["deploy/release.yml"],
        },
      ],
    };
    center.savePolicy(p);
    const input = summarizePayload(
      {
        cwd: project,
        tool_name: "Write",
        tool_input: { file_path: "deploy/release.yml" },
      },
      "codex",
    );
    const denied = decide(input, center.policy());
    assert.equal(denied.ruleId, "protected_path_write");
    assert.equal(denied.decision, "deny");
    assert.equal(
      decide({ ...input, project: home }, center.policy()).decision,
      "allow",
    );
    assert.equal(
      decide(
        { tool: "codex", project, command: "git push origin stable" },
        center.policy(),
      ).decision,
      "deny",
    );
    const event = center.record(denied, input, "real_block");
    center.addException(event.id);
    assert.equal(decide(input, center.policy()).decision, "allow");
    center.removeException(denied.ruleId!, project);
    assert.equal(decide(input, center.policy()).decision, "deny");
    assert.throws(
      () =>
        center.savePolicy({
          ...p,
          projects: [{ ...p.projects[0], protectedPaths: ["../secret"] }],
        }),
      /相对于/,
    );
    assert.equal(center.timeline({}).chain.status, "ok");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
test("标准删除与多ref推送的拦截边界", () => {
  const run = (command: string) =>
    decide({ tool: "codex", command }, defaultPolicy()).decision;
  assert.equal(run("rm -rf /tmp/build"), "allow");
  assert.equal(run('rm -r -f "$HOME"'), "deny");
  assert.equal(run("git push origin main feature/x"), "deny");
  assert.equal(run("git push origin feature/x"), "allow");
  assert.equal(run("cat README.md ~/.codex/auth.json"), "deny");
  assert.equal(run("cat README.md src/App.tsx"), "allow");
});
test("默认开启只补齐已安装工具的防护，保留原配置并记住手动关闭", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nl-auto-"));
  try {
    const dataDir = path.join(home, "security");
    fs.mkdirSync(dataDir, { recursive: true });
    const guardScript = path.join(dataDir, "guard.cjs");
    fs.writeFileSync(guardScript, "fixture", { mode: 0o700 });
    const claudeDir = path.join(home, ".claude");
    fs.mkdirSync(claudeDir);
    const settings = path.join(claudeDir, "settings.json");
    fs.writeFileSync(
      settings,
      JSON.stringify({
        env: { KEEP: "1" },
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "my-hook" }],
            },
          ],
        },
      }),
    );
    fs.mkdirSync(path.join(home, ".codex"));
    const center = new SecurityCenter({
      home,
      dataDir,
      guard: {
        runtime: process.execPath,
        env: {},
        script: guardScript,
        dataDir,
      },
      doctor,
    });
    assert.equal(center.policy().autoProtect, true);
    const result = center.runAutoProtect();
    assert.deepEqual(result.enabled.sort(), ["claude", "codex"]);
    const merged = JSON.parse(fs.readFileSync(settings, "utf8"));
    assert.equal(merged.env.KEEP, "1");
    assert.equal(merged.hooks.PreToolUse.length, 2);
    assert.ok(
      merged.hooks.PreToolUse.some((group: any) =>
        group.hooks.some((h: any) => String(h.command).includes(MARKER)),
      ),
    );
    assert.ok(
      center.timeline({}).events.some((e) => e.operation.includes("自动开启")),
    );
    // Repeated runs are idempotent: already-protected tools are not rewritten.
    assert.deepEqual(center.runAutoProtect().enabled, []);
    // A manual disable is remembered and skipped by later automatic runs.
    const disable = center.preview("disable", "claude");
    void center.apply(disable.token);
    assert.equal(center.policy().toolPreferences?.claude, "off");
    const after = center.runAutoProtect();
    assert.deepEqual(after.enabled, []);
    assert.ok(after.skippedTools.some((s) => s.tool === "claude"));
    // Turning the global switch off stops all automatic writes.
    center.setAutoProtect(false);
    assert.equal(center.runAutoProtect().skipped, "disabled");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
test("自动开启遇到损坏配置只跳过该工具", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nl-auto-bad-"));
  try {
    const dataDir = path.join(home, "security");
    fs.mkdirSync(dataDir, { recursive: true });
    const guardScript = path.join(dataDir, "guard.cjs");
    fs.writeFileSync(guardScript, "fixture", { mode: 0o700 });
    fs.mkdirSync(path.join(home, ".claude"));
    fs.mkdirSync(path.join(home, ".zcode"));
    fs.writeFileSync(
      path.join(home, ".claude", "settings.json"),
      "{ this is not json",
    );
    const center = new SecurityCenter({
      home,
      dataDir,
      guard: {
        runtime: process.execPath,
        env: {},
        script: guardScript,
        dataDir,
      },
      doctor,
    });
    const result = center.runAutoProtect();
    assert.ok(result.failed.some((f) => f.tool === "claude"));
    assert.ok(result.enabled.includes("zcode"));
    assert.equal(
      fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"),
      "{ this is not json",
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
test("隔离数据目录默认不自动写入，显式环境变量优先", () => {
  assert.equal(autoProtectAllowed({}), true);
  assert.equal(
    autoProtectAllowed({ NETWORK_LENS_DATA_DIR: "/tmp/isolated" }),
    false,
  );
  assert.equal(
    autoProtectAllowed({
      NETWORK_LENS_DATA_DIR: "/tmp/isolated",
      NETWORK_LENS_AUTO_PROTECT: "1",
    }),
    true,
  );
  assert.equal(autoProtectAllowed({ NETWORK_LENS_AUTO_PROTECT: "0" }), false);
  assert.equal(
    autoProtectAllowed({ NETWORK_LENS_NO_AUTO_PROTECT: "1" }),
    false,
  );
});
test("保存全局规则不会把用户关闭的默认防护重新打开", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nl-auto-save-"));
  try {
    const dataDir = path.join(home, "security");
    fs.mkdirSync(dataDir, { recursive: true });
    const guardScript = path.join(dataDir, "guard.cjs");
    fs.writeFileSync(guardScript, "fixture", { mode: 0o700 });
    const center = new SecurityCenter({
      home,
      dataDir,
      guard: {
        runtime: process.execPath,
        env: {},
        script: guardScript,
        dataDir,
      },
      doctor,
    });
    center.setAutoProtect(false);
    const { autoProtect: _ignored, ...legacy } = center.policy();
    center.savePolicy(legacy);
    assert.equal(center.policy().autoProtect, false);
    center.savePolicy({ ...legacy, autoProtect: true });
    // Rule-draft saves must not flip protection state: the dedicated action owns it.
    assert.equal(center.policy().autoProtect, false);
    center.setAutoProtect(true);
    assert.equal(center.policy().autoProtect, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
test("隔离配置下即使点立即执行也不写入真实工具配置", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nl-auto-isolated-"));
  try {
    fs.mkdirSync(path.join(home, ".claude"));
    const settings = path.join(home, ".claude", "settings.json");
    fs.writeFileSync(settings, JSON.stringify({ env: { KEEP: "1" } }));
    const original = fs.readFileSync(settings, "utf8");
    const dataDir = path.join(home, "security");
    fs.mkdirSync(dataDir, { recursive: true });
    const guardScript = path.join(dataDir, "guard.cjs");
    fs.writeFileSync(guardScript, "fixture", { mode: 0o700 });
    const center = new SecurityCenter({
      home,
      dataDir,
      guard: {
        runtime: process.execPath,
        env: {},
        script: guardScript,
        dataDir,
      },
      doctor,
      autoProtect: false,
    });
    assert.equal(center.runAutoProtect().skipped, "isolated");
    assert.equal(fs.readFileSync(settings, "utf8"), original);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
test("工具内关闭 hooks 时默认开启不覆盖用户的明确选择", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nl-auto-zcode-"));
  try {
    fs.mkdirSync(path.join(home, ".zcode", "cli"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".zcode", "cli", "config.json"),
      JSON.stringify({ hooks: { enabled: false } }),
    );
    const dataDir = path.join(home, "security");
    fs.mkdirSync(dataDir, { recursive: true });
    const guardScript = path.join(dataDir, "guard.cjs");
    fs.writeFileSync(guardScript, "fixture", { mode: 0o700 });
    const center = new SecurityCenter({
      home,
      dataDir,
      guard: {
        runtime: process.execPath,
        env: {},
        script: guardScript,
        dataDir,
      },
      doctor,
    });
    const result = center.runAutoProtect();
    assert.ok(result.skippedTools.some((s) => s.tool === "zcode"));
    assert.ok(!result.enabled.includes("zcode"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
test("权限修复经预览确认并重新体检，替换文件使旧确认失效", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nl-fix-"));
  try {
    fs.mkdirSync(path.join(home, ".codex"));
    const file = path.join(home, ".codex/auth.json");
    fs.writeFileSync(file, '{"token":"fixture"}', { mode: 0o644 });
    const center = new SecurityCenter({
      home,
      dataDir: path.join(home, "security"),
      guard: {
        runtime: process.execPath,
        env: {},
        script: "fixture",
        dataDir: path.join(home, "security"),
      },
      doctor,
    });
    let report = await center.doctor();
    let finding = report.findings.find((f) => f.autoFix?.path === file)!;
    const stale = center.preview("fix", finding.id);
    fs.renameSync(file, file + ".old");
    fs.writeFileSync(file, "replacement", { mode: 0o644 });
    await assert.rejects(center.apply(stale.token), /已被其他程序修改/);
    assert.equal(fs.statSync(file).mode & 0o777, 0o644);
    report = await center.doctor();
    finding = report.findings.find((f) => f.autoFix?.path === file)!;
    const current = center.preview("fix", finding.id);
    await center.apply(current.token);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(
      !center.lastReport()!.findings.some((f) => f.autoFix?.path === file),
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
