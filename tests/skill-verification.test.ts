import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SkillScanner } from "../electron/core/skills";
import { checkSkillResources, matchDiscoveredSkill, type SkillDiscovery } from "../electron/core/skill-verification";

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "skill-verification-"));
  const source = path.join(home, ".claude/skills/demo");
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, "SKILL.md"), "---\nname: demo\ndescription: helper\n---\n# Demo\n");
  return { home, source };
}
test("resource checker detects missing files, ignores fenced examples and does not traverse external paths", async () => {
  const { home, source } = await fixture();
  try {
    const checks = await checkSkillResources(source, '[missing](references/missing.md)\n[outside](../../outside.md)\n```md\n[example](fake.md)\n```\n[web](https://example.com)');
    assert.equal(checks.length, 2);
    assert.equal(checks[0].state, "failed");
    assert.equal(checks[1].state, "unverified");
    await fs.appendFile(path.join(source, "SKILL.md"), '[missing](references/missing.md)');
    const scanner = new SkillScanner(home);
    const ids = [(await scanner.scan()).items[0].id];
    const preview = await scanner.preview(ids, "opencode");
    assert.equal(preview.items[0].status, "blocked");
    await scanner.copy(ids, "opencode", preview.token);
    await assert.rejects(() => fs.stat(path.join(home, ".config/opencode/skills/demo")), /ENOENT/);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
test("OpenCode discovery must match both name and real target path", async () => {
  const document = path.join(os.tmpdir(), "expected/SKILL.md");
  const check = { label: "发现", state: "passed" as const, detail: "CLI 返回" };
  const discovery: SkillDiscovery = { check, entries: [{ name: "demo", location: document }] };
  assert.equal((await matchDiscoveredSkill(discovery, "demo", document)).state, "passed");
  assert.equal((await matchDiscoveredSkill(discovery, "demo", document + "-other")).state, "failed");
  assert.equal((await matchDiscoveredSkill(discovery, "missing", document)).state, "failed");
  assert.equal((await matchDiscoveredSkill({ check: { ...check, state: "unverified" } }, "demo", document)).state, "unverified");
});
test("copy triggers discovery once, reports it independently from execution and backs up existing differences", async () => {
  const { home, source } = await fixture();
  try {
    let calls = 0;
    const document = path.join(home, ".config/opencode/skills/demo/SKILL.md");
    const scanner = new SkillScanner(home, [], async () => {
      calls++;
      await fs.access(document);
      return { check: { label: "OpenCode 实际发现", state: "passed", detail: "fixture" }, entries: [{ name: "demo", location: document }] };
    });
    const ids = [(await scanner.scan()).items[0].id];
    const preview = await scanner.preview(ids, "opencode");
    assert.equal(calls, 0);
    const [row] = await scanner.copy(ids, "opencode", preview.token, true);
    assert.equal(calls, 1);
    assert.ok(row.verification?.sourceHash);
    assert.equal(row.verification?.sourceHash, row.verification?.destinationHash);
    assert.ok(row.verification?.checks.some(c => c.label === "OpenCode 实际发现" && c.state === "passed"));
    assert.ok(row.verification?.checks.some(c => c.label === "实际运行" && c.state === "unverified"));
    await fs.appendFile(document, "user change");
    const different = await scanner.preview(ids, "opencode");
    assert.equal(different.items[0].status, "update");
    assert.match(different.items[0].reason!, /内容与源不同/);
    assert.notEqual(different.items[0].verification?.sourceHash, different.items[0].verification?.destinationHash);
    const [updated] = await scanner.copy(ids, "opencode", different.token);
    assert.equal(updated.status, "copied");
    assert.ok(updated.backup);
    assert.match(await fs.readFile(document, "utf8"), /# Demo/);
    assert.match(await fs.readFile(path.join(updated.backup!, "SKILL.md"), "utf8"), /user change/);
    assert.doesNotMatch(await fs.readFile(path.join(source, "SKILL.md"), "utf8"), /user change/);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
test("probe failure leaves successful copy intact and never claims runtime passed", async () => {
  const { home } = await fixture();
  try {
    const scanner = new SkillScanner(home, [], async () => { throw new Error("probe failed"); });
    const ids = [(await scanner.scan()).items[0].id];
    const [row] = await scanner.copy(ids, "opencode", (await scanner.preview(ids, "opencode")).token);
    assert.equal(row.status, "copied");
    assert.equal(row.verification?.checks.at(-1)?.state, "unverified");
    await fs.access(path.join(home, ".config/opencode/skills/demo/SKILL.md"));
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
