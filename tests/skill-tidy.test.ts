import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SkillScanner } from "../electron/core/skills";

async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "network-lens-tidy-"));
  const add = async (root: string, name: string, body = "# body\n", extra = "") => {
    const directory = path.join(home, root, name);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Fixture ${name}\n---\n${body}`);
    if (extra) await writeFile(path.join(directory, "note.txt"), extra);
    return directory;
  };
  return { home, add };
}

const scenario = (report: Awaited<ReturnType<SkillScanner["tidyReport"]>>, kind: string) =>
  report.scenarios.find(row => row.kind === kind);

test("a plain copy beside the WisCode projection is offered, moved to trash and restorable", async () => {
  const { home, add } = await fixture();
  try {
    const keep = await add(".wiscode/skills", "demo", "# same\n");
    const shadow = await add(".wiscode/codex-agents/skills", "demo", "# same\n");
    const scanner = new SkillScanner(home);
    await scanner.scan();
    const report = await scanner.tidyReport();
    const group = scenario(report, "wiscode-shadow");
    assert.ok(group, JSON.stringify(report.scenarios.map(row => row.kind)));
    assert.equal(group.actions.length, 1);
    const [action] = group.actions;
    assert.equal(action.status, "ready");
    assert.equal(action.keep, keep);
    assert.equal(action.contentMatches, true);
    const [result] = await scanner.applyTidy([action.id], report.token);
    assert.equal(result.status, "done", result.message);
    await assert.rejects(() => stat(shadow), /ENOENT/);
    assert.equal((await stat(keep)).isDirectory(), true);
    // 令牌一次性有效
    await assert.rejects(() => scanner.applyTidy([action.id], report.token), /过期|重新生成/);
    await scanner.restoreSkill(result.trashId!);
    assert.equal((await stat(shadow)).isDirectory(), true);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("permission-only differences count as identical, real differences are warned", async () => {
  const { home, add } = await fixture();
  try {
    await add(".wiscode/skills", "demo", "# same\n");
    const shadow = await add(".wiscode/codex-agents/skills", "demo", "# different\n", "extra\n");
    const { chmod } = await import("node:fs/promises");
    await chmod(path.join(shadow, "SKILL.md"), 0o666);
    const scanner = new SkillScanner(home);
    await scanner.scan();
    const report = await scanner.tidyReport();
    const [action] = scenario(report, "wiscode-shadow")!.actions;
    assert.equal(action.status, "ready");
    assert.equal(action.contentMatches, false);
    assert.match(action.warnings.join("；"), /内容不同/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("an independent copy identical to a nested sub-skill is reported as nested duplicate", async () => {
  const { home, add } = await fixture();
  try {
    const parent = await add(".wiscode/skills", "parent", "# parent\n导航到 parent/skills/sub\n");
    const nested = await add(".wiscode/skills/parent/skills", "sub", "# sub\n");
    const independent = await add(".wiscode/skills", "sub", "# sub\n");
    const scanner = new SkillScanner(home);
    await scanner.scan();
    const report = await scanner.tidyReport();
    const group = scenario(report, "nested-duplicate");
    assert.ok(group);
    const action = group.actions.find(row => row.path === independent)!;
    assert.ok(action, JSON.stringify(group.actions));
    assert.equal(action.keep, nested);
    assert.equal(action.status, "ready");
    assert.match(action.evidence.join("；"), /parent/);
    const [result] = await scanner.applyTidy([action.id], report.token);
    assert.equal(result.status, "done", result.message);
    assert.equal((await stat(parent)).isDirectory(), true);
    assert.equal((await stat(nested)).isDirectory(), true);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("legacy Codex skills migrate to the shared directory and the migration can be reverted", async () => {
  const { home, add } = await fixture();
  try {
    const source = await add(".codex/skills", "legacy", "# legacy\n");
    await mkdir(path.join(home, ".agents/skills"), { recursive: true });
    const scanner = new SkillScanner(home);
    await scanner.scan();
    const report = await scanner.tidyReport();
    const group = scenario(report, "legacy-codex");
    assert.ok(group);
    const action = group.actions.find(row => row.path === source)!;
    assert.equal(action.operation, "move");
    assert.equal(action.destination, path.join(home, ".agents/skills/legacy"));
    const [result] = await scanner.applyTidy([action.id], report.token);
    assert.equal(result.status, "done", result.message);
    await assert.rejects(() => stat(source), /ENOENT/);
    assert.equal(await readFile(path.join(home, ".agents/skills/legacy/SKILL.md"), "utf8").then(text => text.includes("legacy")), true);
    const after = await scanner.tidyReport();
    assert.equal(after.moves.length, 1);
    await scanner.revertMove(after.moves[0].id);
    assert.equal((await stat(source)).isDirectory(), true);
    await assert.rejects(() => stat(path.join(home, ".agents/skills/legacy")), /ENOENT/);
    await assert.rejects(() => scanner.revertMove(after.moves[0].id), /不存在|已撤销/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("legacy skill already present identically in the shared directory is moved to trash instead of migrated", async () => {
  const { home, add } = await fixture();
  try {
    const source = await add(".codex/skills", "same", "# same\n");
    await add(".agents/skills", "same", "# same\n");
    const scanner = new SkillScanner(home);
    await scanner.scan();
    const report = await scanner.tidyReport();
    const action = scenario(report, "legacy-codex")!.actions.find(row => row.path === source)!;
    assert.equal(action.operation, "trash");
    assert.equal(action.contentMatches, true);
    const [result] = await scanner.applyTidy([action.id], report.token);
    assert.equal(result.status, "done", result.message);
    assert.equal((await scanner.scan()).trash.length, 1);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a legacy skill whose shared copy differs is blocked, never overwritten", async () => {
  const { home, add } = await fixture();
  try {
    const source = await add(".codex/skills", "clash", "# old\n");
    const shared = await add(".agents/skills", "clash", "# new\n");
    const scanner = new SkillScanner(home);
    await scanner.scan();
    const report = await scanner.tidyReport();
    const action = scenario(report, "legacy-codex")!.actions.find(row => row.path === source)!;
    assert.equal(action.status, "blocked");
    assert.match(action.reason ?? "", /内容不同/);
    await assert.rejects(() => scanner.applyTidy([action.id], report.token), /不在本次可执行/);
    assert.equal((await readFile(path.join(shared, "SKILL.md"), "utf8")).includes("# new"), true);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("content changed after analysis is rejected instead of moved", async () => {
  const { home, add } = await fixture();
  try {
    await add(".wiscode/skills", "demo", "# same\n");
    const shadow = await add(".wiscode/codex-agents/skills", "demo", "# same\n");
    const scanner = new SkillScanner(home);
    await scanner.scan();
    const report = await scanner.tidyReport();
    const [action] = scenario(report, "wiscode-shadow")!.actions;
    await writeFile(path.join(shadow, "SKILL.md"), "changed after analysis\n");
    const [result] = await scanner.applyTidy([action.id], report.token);
    assert.equal(result.status, "failed");
    assert.match(result.message, /发生变化/);
    assert.equal((await stat(shadow)).isDirectory(), true);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("installer-managed copies are described but never executable", async () => {
  const { home, add } = await fixture();
  try {
    for (const root of [".agents/skills", ".claude/skills"]) {
      await add(root, "managed-skill", "# managed\n");
      await writeFile(path.join(home, root, ".demo-managed-skills.json"), JSON.stringify({ schema: 1, owner: "demo", skills: { "managed-skill": "abc" } }));
    }
    const scanner = new SkillScanner(home);
    await scanner.scan();
    const report = await scanner.tidyReport();
    const group = scenario(report, "managed");
    assert.ok(group);
    assert.equal(group.actions.length, 1);
    assert.equal(group.actions[0].status, "blocked");
    assert.match(group.actions[0].evidence.join("；"), /2 个工具目录/);
    await assert.rejects(() => scanner.applyTidy([group.actions[0].id], report.token), /不在本次可执行/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("version drift updates older copies from the newest version through the copy flow only", async () => {
  const { home, add } = await fixture();
  try {
    const older = await add(".claude/skills", "drift", "# old\n");
    const newest = await add(".wiscode/skills", "drift", "# new\n");
    const { utimes } = await import("node:fs/promises");
    const past = new Date(Date.now() - 86_400_000);
    await utimes(path.join(older, "SKILL.md"), past, past);
    const scanner = new SkillScanner(home);
    await scanner.scan();
    const report = await scanner.tidyReport();
    const group = scenario(report, "version-drift");
    assert.ok(group);
    const action = group.actions.find(row => row.path === older);
    assert.ok(action, JSON.stringify(group.actions));
    assert.equal(action.operation, "sync");
    assert.equal(action.keep, newest);
    assert.equal(action.targetId, "claude");
    assert.ok(action.sourceItemId);
    assert.equal(action.versions?.find(row => row.path === newest)?.newest, true);
    // 不做静默覆盖：sync 项不属于可执行计划
    await assert.rejects(() => scanner.applyTidy([action.id], report.token), /不在本次可执行/);
    assert.equal((await readFile(path.join(older, "SKILL.md"), "utf8")).includes("# old"), true);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("moves are written atomically and listed only for managed directories", async () => {
  const { home, add } = await fixture();
  try {
    await add(".codex/skills", "one", "# one\n");
    const scanner = new SkillScanner(home);
    await scanner.scan();
    const report = await scanner.tidyReport();
    const action = scenario(report, "legacy-codex")!.actions[0];
    await scanner.applyTidy([action.id], report.token);
    const files = await readdir(path.join(home, ".network-lens"));
    assert.ok(files.includes("skill-moves.json"));
    const parsed = JSON.parse(await readFile(path.join(home, ".network-lens/skill-moves.json"), "utf8"));
    assert.equal(parsed.moves.length, 1);
    assert.equal(parsed.moves[0].to, path.join(home, ".agents/skills/one"));
  } finally { await rm(home, { recursive: true, force: true }); }
});
