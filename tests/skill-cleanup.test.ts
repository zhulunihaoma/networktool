import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SkillScanner } from "../electron/core/skills";
import { attachSkillUsage } from "../electron/core/skill-usage";
import type { SkillItem } from "../src/shared/skills";

async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "network-lens-cleanup-"));
  const root = path.join(home, ".config/opencode/skills");
  await mkdir(root, { recursive: true });
  const add = async (name: string, content = `---\nname: ${name}\ndescription: Fixture\n---\n# ${name}\n`) => {
    const directory = path.join(root, name);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "SKILL.md"), content);
    return directory;
  };
  return { home, root, add };
}

test("broken top-level links explain the path and only the link is moved", async () => {
  const { home, root, add } = await fixture();
  try {
    const good = await add("good");
    const broken = path.join(root, "missing");
    await symlink("no-target", broken);
    const scanner = new SkillScanner(home);
    const scan = await scanner.scan();
    const item = scan.items.find(row => row.path === broken)!;
    assert.ok(item, JSON.stringify(scan.roots));
    assert.equal(item.kind, "broken-link");
    assert.equal(item.cleanup?.level, "cleanup");
    assert.match(item.description, /已失效/);
    const preview = await scanner.previewDelete([item.id]);
    assert.equal(preview.items[0].status, "ready");
    const [result] = await scanner.deleteSkills([item.id], preview.token);
    assert.equal(result.status, "trashed");
    await assert.rejects(() => stat(broken), /ENOENT/);
    assert.equal((await stat(good)).isDirectory(), true);
    assert.equal((await scanner.scan()).trash.length, 1);
    await scanner.restoreSkill(result.trashId!);
    assert.equal((await scanner.scan()).items.find(row => row.path === broken)?.kind, "broken-link");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a changed Skill is not moved after preview, and restore never overwrites", async () => {
  const { home, add } = await fixture();
  try {
    const location = await add("demo");
    const scanner = new SkillScanner(home);
    const item = (await scanner.scan()).items.find(row => row.path === location)!;
    const first = await scanner.previewDelete([item.id]);
    await writeFile(path.join(location, "SKILL.md"), "changed after preview\n");
    const [stale] = await scanner.deleteSkills([item.id], first.token);
    assert.equal(stale.status, "failed");
    assert.match(stale.message, /发生变化/);
    const second = await scanner.previewDelete([item.id]);
    const [moved] = await scanner.deleteSkills([item.id], second.token);
    assert.equal(moved.status, "trashed");
    assert.equal(await readFile(path.join(home, ".network-lens/skill-trash", moved.trashId!, "item/SKILL.md"), "utf8"), "changed after preview\n");
    await mkdir(location);
    await assert.rejects(() => scanner.restoreSkill(moved.trashId!), /未覆盖/);
    await rm(location, { recursive: true });
    await scanner.restoreSkill(moved.trashId!);
    assert.equal(await readFile(path.join(location, "SKILL.md"), "utf8"), "changed after preview\n");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("batch cleanup moves only checked entries and each can be restored", async () => {
  const { home, add } = await fixture();
  try {
    const first = await add("first");
    const second = await add("second");
    const scanner = new SkillScanner(home);
    const ids = (await scanner.scan()).items.filter(row => [first, second].includes(row.path)).map(row => row.id);
    assert.equal(ids.length, 2);
    const preview = await scanner.previewDelete(ids);
    assert.deepEqual(preview.items.map(row => row.status), ["ready", "ready"]);
    const results = await scanner.deleteSkills(ids, preview.token);
    assert.deepEqual(results.map(row => row.status), ["trashed", "trashed"]);
    await assert.rejects(() => scanner.deleteSkills(ids, preview.token), /失效/);
    assert.equal((await scanner.scan()).trash.length, 2);
    for (const row of results) await scanner.restoreSkill(row.trashId!);
    assert.equal((await scanner.scan()).trash.length, 0);
    assert.equal((await stat(first)).isDirectory(), true);
    assert.equal((await stat(second)).isDirectory(), true);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("nested skills and custom roots are blocked, same-tool duplicates are suggestions only", async () => {
  const { home, root, add } = await fixture();
  try {
    const parent = await add("parent");
    const nested = path.join(parent, "nested");
    await mkdir(nested);
    await writeFile(path.join(nested, "SKILL.md"), "# Nested\n");
    const primary = await add("duplicate", "# Same\n");
    const legacy = path.join(home, ".opencode/skills/duplicate");
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(legacy, "SKILL.md"), await readFile(path.join(primary, "SKILL.md")));
    const differentTool = path.join(home, ".cursor/skills/duplicate");
    await mkdir(differentTool, { recursive: true });
    await writeFile(path.join(differentTool, "SKILL.md"), await readFile(path.join(primary, "SKILL.md")));
    const custom = path.join(home, "other/custom");
    await mkdir(custom, { recursive: true });
    await writeFile(path.join(custom, "SKILL.md"), "# Custom\n");
    const scanner = new SkillScanner(home, [path.join(home, "other")]);
    const scan = await scanner.scan();
    const canonicalCustom = await realpath(custom);
    assert.equal(scan.items.find(row => row.path === legacy)?.cleanup?.level, "consider");
    assert.equal(scan.items.find(row => row.path === differentTool)?.cleanup?.level, "keep");
    assert.equal(scan.items.find(row => row.path === canonicalCustom)?.cleanup?.deletable, false);
    const parentId = scan.items.find(row => row.path === parent)!.id;
    const customId = scan.items.find(row => row.path === canonicalCustom)!.id;
    const preview = await scanner.previewDelete([parentId, customId]);
    assert.deepEqual(preview.items.map(row => row.status), ["blocked", "blocked"]);
    assert.match(preview.items[0].reason!, /独立 Skill/);
    assert.match(preview.items[1].reason!, /直接子目录|不在已核实/);
    assert.equal((await stat(root)).isDirectory(), true);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("usage only reports an exact observed SKILL.md read", async () => {
  const { home, add } = await fixture();
  try {
    const location = await add("demo");
    const item: SkillItem = { id: "one", name: "demo", description: "", features: [], source: "Codex", scope: "", path: location, warnings: [] };
    await attachSkillUsage(home, [item]);
    assert.equal(item.usage?.status, "unknown");
    const codexLocation = path.join(home, ".agents/skills/demo");
    await mkdir(codexLocation, { recursive: true });
    await writeFile(path.join(codexLocation, "SKILL.md"), "# Demo\n");
    const codexItem: SkillItem = { ...item, path: codexLocation };
    const logs = path.join(home, ".codex/sessions/2026/10/11");
    await mkdir(logs, { recursive: true });
    const line = (cmd: string, timestamp: string) => JSON.stringify({ type: "response_item", timestamp, payload: { type: "function_call", name: "functions.exec_command", arguments: JSON.stringify({ cmd }) } });
    await writeFile(path.join(logs, "rollout-fixture.jsonl"), [
      line(`echo ${codexLocation}/SKILL.md`, "2026-10-10T12:00:00Z"),
      line(`cat ${codexLocation}/SKILL.md`, "2026-10-11T12:00:00Z"),
    ].join("\n"));
    await attachSkillUsage(home, [codexItem]);
    assert.equal(codexItem.usage?.status, "observed-read");
    assert.equal(codexItem.usage?.lastObservedAt, "2026-10-11T12:00:00.000Z");
  } finally { await rm(home, { recursive: true, force: true }); }
});
