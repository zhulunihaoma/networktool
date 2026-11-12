import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  ADAPTERS,
  applyChanges,
  type AdapterContext,
} from "../electron/security/adapters";
function fixture(): AdapterContext {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nl-adapters-"));
  const script = path.join(home, "guard.cjs");
  fs.writeFileSync(script, "// fixture");
  return {
    home,
    backupDir: path.join(home, "backups"),
    guard: {
      runtime: process.execPath,
      env: {},
      script,
      dataDir: path.join(home, "data"),
    },
  };
}
test("各适配器合并、备份及移除自己的配置", () => {
  for (const tool of ["codex", "claude", "zcode", "opencode", "dsh"] as const) {
    const ctx = fixture();
    const adapter = ADAPTERS.find((a) => a.tool === tool)!;
    const directory = {
      codex: ".codex",
      claude: ".claude",
      zcode: ".zcode/cli",
      opencode: ".config/opencode",
      dsh: ".dsh/profiles/desktop",
    }[tool];
    fs.mkdirSync(path.join(ctx.home, directory), { recursive: true });
    if (tool === "claude")
      fs.writeFileSync(
        path.join(ctx.home, directory, "settings.json"),
        JSON.stringify({
          example: 123,
          hooks: {
            PreToolUse: [
              {
                matcher: "Read",
                hooks: [{ type: "command", command: "echo existing" }],
              },
            ],
          },
        }),
      );
    if (tool === "dsh")
      fs.writeFileSync(
        path.join(ctx.home, directory, "cordis.patch.yml"),
        "- id: existing\n  name: example\n",
      );
    const enable = adapter.planEnable(ctx);
    assert.ok(enable.length, tool);
    if (tool === "dsh") {
      const patch = enable.find((c) => c.path.endsWith("cordis.patch.yml"))!;
      const rows = parseYaml(patch.after!);
      assert.ok(
        rows.some((r: any) =>
          r.insert?.some(
            (v: any) => v.name === "@deepseek-ai/dsh-hooks-claude-code",
          ),
        ),
      );
    }
    applyChanges(enable, ctx.backupDir);
    assert.notEqual(adapter.detect(ctx).state, "off", tool);
    const disable = adapter.planDisable(ctx);
    assert.ok(disable.length, tool);
    applyChanges(disable, ctx.backupDir, Date.now() + 1);
    assert.equal(adapter.detect(ctx).state, "off", tool);
    if (tool === "claude") {
      const result = JSON.parse(
        fs.readFileSync(
          path.join(ctx.home, directory, "settings.json"),
          "utf8",
        ),
      );
      assert.equal(result.example, 123);
      assert.equal(
        result.hooks.PreToolUse[0].hooks[0].command,
        "echo existing",
      );
    }
    if (tool === "dsh")
      assert.match(
        fs.readFileSync(
          path.join(ctx.home, directory, "cordis.patch.yml"),
          "utf8",
        ),
        /id: existing/,
      );
  }
});
test("预览后的外部修改禁止覆盖", () => {
  const ctx = fixture();
  fs.mkdirSync(path.join(ctx.home, ".codex"));
  const adapter = ADAPTERS[0];
  const changes = adapter.planEnable(ctx);
  fs.writeFileSync(changes[0].path, "external");
  assert.throws(() => applyChanges(changes, ctx.backupDir), /重新预览/);
  assert.equal(fs.readFileSync(changes[0].path, "utf8"), "external");
});
test("多文件修改中途失败会恢复已经写入的文件与原权限", () => {
  const ctx = fixture();
  const a = path.join(ctx.home, "a"),
    b = path.join(ctx.home, "b");
  fs.writeFileSync(a, "before", { mode: 0o640 });
  fs.writeFileSync(b, "external");
  assert.throws(
    () =>
      applyChanges(
        [
          {
            path: a,
            action: "update",
            detail: "fixture",
            before: "before",
            after: "after",
          },
          {
            path: b,
            action: "update",
            detail: "fixture",
            before: "expected",
            after: "new",
          },
        ],
        ctx.backupDir,
      ),
    /重新预览/,
  );
  assert.equal(fs.readFileSync(a, "utf8"), "before");
  assert.equal(fs.statSync(a).mode & 0o777, 0o640);
  assert.equal(fs.readFileSync(b, "utf8"), "external");
});
