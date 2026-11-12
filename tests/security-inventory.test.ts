import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  collectInventory,
  diffInventory,
} from "../electron/security/inventory";
import { parseJsonc } from "../electron/security/config-read";
test("配置巡检跨工具发现变化，凭据不会进入清单，失败不会产生空清单", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nl-inventory-"));
  const write = async (name: string, text: string) => {
    await fs.mkdir(path.dirname(path.join(home, name)), { recursive: true });
    await fs.writeFile(path.join(home, name), text);
  };
  try {
    await write(
      ".codex/config.toml",
      '[mcp_servers.example]\ncommand = "npx"\nargs = ["server@1.0.0"]\n[mcp_servers.example.env]\nTOKEN = "never-show-12345"\n',
    );
    await write(
      ".config/opencode/opencode.jsonc",
      '{// comment\n"mcp":{"remote":{"url":"https://example.test/mcp?token=never-show-12345"}},}',
    );
    const baseline = await collectInventory(home);
    assert.ok(baseline.some((i) => i.tool === "codex" && i.kind === "mcp"));
    assert.ok(!JSON.stringify(baseline).includes("never-show-12345"));
    await write(
      ".config/opencode/opencode.jsonc",
      '{"mcp":{"remote":{"url":"https://new.test/mcp"},"added":{"command":["npx","server@2.0.0"]}}}',
    );
    const diff = diffInventory(baseline, await collectInventory(home), 123);
    assert.ok(diff.changed.some((i) => i.name === "remote"));
    assert.ok(diff.added.some((i) => i.name === "added"));
    await fs.unlink(path.join(home, ".codex/config.toml"));
    assert.ok(
      diffInventory(baseline, await collectInventory(home)).removed.some(
        (i) => i.tool === "codex",
      ),
    );
    await write(".config/opencode/opencode.jsonc", "broken");
    await assert.rejects(collectInventory(home), /解析失败/);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
test("JSONC 保留字符串中的 URL 和逗号", () => {
  assert.deepEqual(
    parseJsonc('{"url":"https://a.test/a,}",/* hello */"a":[1,2,],}'),
    { url: "https://a.test/a,}", a: [1, 2] },
  );
});
