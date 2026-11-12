import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexAdapter, applyChanges, hookCommand, type AdapterContext } from "../electron/security/adapters";
import { trustCodexGuard, hasCurrentCodexTrust, CodexTrustClient, CODEX_GUARD_MATCHER, type TrustRpc } from "../electron/security/codex-trust";
import { SecurityCenter } from "../electron/security/center";
import * as doctor from "../electron/security/doctor";

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nl-codex-trust-"));
  const dataDir = path.join(home, "security");
  fs.mkdirSync(path.join(home, ".codex"));
  fs.mkdirSync(dataDir);
  const script = path.join(dataDir, "guard.cjs");
  fs.writeFileSync(script, "// isolated guard fixture\n");
  const ctx: AdapterContext = { home, backupDir: path.join(dataDir, "backups"),
    guard: { runtime: process.execPath, env: {}, script, dataDir } };
  fs.writeFileSync(path.join(home, ".codex/config.toml"), '# keep this comment\napproval_policy = "on-request"\n');
  applyChanges(codexAdapter.planEnable(ctx), ctx.backupDir);
  return ctx;
}
function fake(ctx: AdapterContext, options: { failWrite?: boolean; drift?: boolean; wrongCommand?: boolean; unconfirmed?: boolean } = {}) {
  const calls: { method: string; params: Record<string, any> }[] = [];
  let trusted = false, closed = false;
  const source = fs.realpathSync(path.join(ctx.home, ".codex/hooks.json"));
  const hook = { source: "user", sourcePath: source, handlerType: "command", eventName: "preToolUse", matcher: CODEX_GUARD_MATCHER, enabled: true,
    command: options.wrongCommand ? "someone-else" : hookCommand(ctx.guard, "codex"), key: `${source}:pre_tool_use:0:0`, currentHash: `sha256:${"a".repeat(64)}` };
  const client: TrustRpc = {
    async callTrust(method, params) {
      calls.push({ method, params });
      if (method === "hooks/list") return { data: [{ errors: [], hooks: [{ ...hook, trustStatus: trusted && !options.unconfirmed ? "trusted" : "untrusted" }] }] };
      if (method === "config/read") return { layers: [{ name: { type: "user", file: path.join(fs.realpathSync(path.join(ctx.home, ".codex")), "config.toml") }, version: "fixture-version" }] };
      if (options.failWrite) throw new Error("version conflict");
      trusted = true;
      if (options.drift) fs.appendFileSync(ctx.guard.script, "// changed during write");
      // Mirror Codex's persisted shape so the receipt check can verify the saved hash.
      fs.appendFileSync(path.join(ctx.home, ".codex/config.toml"),
        `\n[hooks.state.${JSON.stringify(hook.key)}]\ntrusted_hash = "${hook.currentHash}"\n`);
      return {};
    }, close() { closed = true; },
  };
  return { client, calls, closed: () => closed };
}

test("trust writes only the exact guard hash, backs up config, and invalidates after drift", async () => {
  const ctx = fixture();
  try {
    const server = fake(ctx);
    assert.equal(codexAdapter.detect(ctx).state, "needs_trust");
    const config = fs.readFileSync(path.join(ctx.home, ".codex/config.toml"), "utf8");
    await trustCodexGuard(ctx, hookCommand(ctx.guard, "codex"), async () => server.client);
    const write = server.calls.find(c => c.method === "config/batchWrite")!.params;
    assert.equal(write.expectedVersion, "fixture-version");
    assert.equal(write.edits.length, 1);
    const key = fs.realpathSync(path.join(ctx.home, ".codex/hooks.json")) + ":pre_tool_use:0:0";
    assert.equal(write.edits[0].keyPath, `hooks.state.${JSON.stringify(key)}.trusted_hash`);
    assert.equal(write.edits[0].value, `sha256:${"a".repeat(64)}`);
    const backup = fs.readdirSync(ctx.backupDir).find(f => f.startsWith("codex-trust-"))!;
    assert.equal(fs.readFileSync(path.join(ctx.backupDir, backup), "utf8"), config);
    assert.equal(fs.statSync(path.join(ctx.backupDir, backup)).mode & 0o777, 0o600);
    assert.equal(server.closed(), true);
    assert.equal(hasCurrentCodexTrust(ctx), true);
    assert.equal(codexAdapter.detect(ctx).state, "enabled");
    // Unrelated Codex settings must not drop a valid trust receipt.
    fs.appendFileSync(path.join(ctx.home, ".codex/config.toml"), '\n[projects."/tmp/elsewhere"]\ntrust_level = "trusted"\n');
    assert.equal(hasCurrentCodexTrust(ctx), true);
    fs.appendFileSync(ctx.guard.script, "// changed\n");
    assert.equal(hasCurrentCodexTrust(ctx), false);
    assert.equal(codexAdapter.detect(ctx).state, "needs_trust");
  } finally { fs.rmSync(ctx.home, { recursive: true, force: true }); }
});

test("conflicts, foreign hooks, unconfirmed writes and script drift never claim trust", async () => {
  for (const options of [{ failWrite: true }, { wrongCommand: true }, { drift: true }, { unconfirmed: true }]) {
    const ctx = fixture();
    try {
      const server = fake(ctx, options);
      await assert.rejects(trustCodexGuard(ctx, hookCommand(ctx.guard, "codex"), async () => server.client));
      assert.equal(hasCurrentCodexTrust(ctx), false);
      assert.equal(server.closed(), true);
      if (options.wrongCommand) assert.equal(server.calls.some(c => c.method === "config/batchWrite"), false);
    } finally { fs.rmSync(ctx.home, { recursive: true, force: true }); }
  }
});

test("center serializes repeated trust requests and records configuration evidence separately", async () => {
  const ctx = fixture();
  try {
    const server = fake(ctx);
    const center = new SecurityCenter({ home: ctx.home, dataDir: ctx.guard.dataDir, guard: ctx.guard, doctor, connectCodexTrust: async () => server.client });
    const a = center.trustCodex(), b = center.trustCodex();
    assert.equal(a, b);
    const result = await a;
    assert.equal(result.overview.tools.find(t => t.tool === "codex")?.state, "enabled");
    assert.equal(server.calls.filter(c => c.method === "config/batchWrite").length, 1);
    assert.equal(center.timeline({ source: "real_block" }).events.length, 0);
    assert.ok(center.timeline({ source: "action" }).events.some(e => e.operation === "信任 Codex 安全防护"));
  } finally { fs.rmSync(ctx.home, { recursive: true, force: true }); }
});

const binary = process.env.NETWORK_LENS_TEST_CODEX;
test("real local Codex saves and confirms only our guard trust in an isolated home", { skip: !binary }, async () => {
  const ctx = fixture();
  let client: CodexTrustClient | undefined;
  try {
    const file = path.join(ctx.home, ".codex/hooks.json");
    const root = JSON.parse(fs.readFileSync(file, "utf8"));
    root.hooks.PreToolUse.push({ matcher: "Bash", hooks: [{ type: "command", command: "echo unrelated-hook" }] });
    fs.writeFileSync(file, JSON.stringify(root));
    const connect = async () => {
      client = new CodexTrustClient(binary!, path.join(ctx.home, ".codex"), ["app-server"], 15000);
      await client.initialize();
      return client;
    };
    await trustCodexGuard(ctx, hookCommand(ctx.guard, "codex"), connect);
    assert.equal(hasCurrentCodexTrust(ctx), true);
    const persisted = fs.readFileSync(path.join(ctx.home, ".codex/config.toml"), "utf8");
    assert.match(persisted, /# keep this comment/);
    assert.match(persisted, /approval_policy = "on-request"/);
    assert.equal((persisted.match(/trusted_hash = /g) ?? []).length, 1);
    const second = await connect();
    const list = await second.callTrust("hooks/list", { cwds: [ctx.guard.dataDir] });
    assert.ok(Array.isArray(list.data));
    const hooks = list.data.flatMap((entry: any) => entry.hooks);
    assert.equal(hooks.find((h: any) => h.command === hookCommand(ctx.guard, "codex")).trustStatus, "trusted");
    assert.equal(hooks.find((h: any) => h.command === "echo unrelated-hook").trustStatus, "untrusted");
    // A new process confirms persisted trust, rather than a cached UI state.
  } finally { client?.close(); fs.rmSync(ctx.home, { recursive: true, force: true }); }
});
