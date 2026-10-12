import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { SkillScanner } from "../electron/core/skills";

const metadata = 'interface:\ndisplay_name: "Repair fixture"\nshort_description: "Fixture"\ndefault_prompt: "Use fixture"\npolicy:\n  allow_implicit_invocation: false\ndependencies:\n  tools: []\ncustom-field: retained\n';
async function fixture(root = ".codex/skills") {
  const home = await mkdtemp(path.join(os.tmpdir(), "skill-auto-repair-"));
  const source = path.join(home, root, "helper");
  await mkdir(path.join(source, "agents"), { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: helper\ndescription: Test helper\n---\n# Helper\n");
  await writeFile(path.join(source, "agents/openai.yaml"), metadata);
  await writeFile(path.join(source, "helper.sh"), "#!/bin/sh\necho fixture\n");
  await chmod(path.join(source, "helper.sh"), 0o755);
  const scanner = new SkillScanner(home, [], async () => ({ check: { label: "发现", state: "unverified", detail: "Fixture does not run a CLI" } }));
  const id = (await scanner.scan()).items.find(item => item.path === source)!.id;
  return { home, source, scanner, id };
}

for (const [target, folder] of [["wiscode", ".wiscode/skills"], ["opencode", ".config/opencode/skills"]]) {
  test(`${target}: automatically repairs the copy, verifies planned hashes and leaves every source unchanged`, async () => {
    const { home, source, scanner, id } = await fixture();
    try {
      const preview = await scanner.preview([id], target);
      assert.equal(preview.items[0].status, "ready");
      assert.match(preview.items[0].changes.join("\n"), /自动修复 interface/);
      const [result] = await scanner.copy([id], target, preview.token, false);
      assert.equal(result.status, "copied");
      const destination = path.join(home, folder, "helper");
      const copied = parse(await readFile(path.join(destination, "agents/openai.yaml"), "utf8"));
      assert.equal(copied.interface.display_name, "Repair fixture");
      assert.equal(copied.policy.allow_implicit_invocation, false);
      assert.equal(copied["custom-field"], "retained");
      assert.deepEqual(copied.dependencies.tools, []);
      assert.equal(await readFile(path.join(source, "agents/openai.yaml"), "utf8"), metadata);
      for (const file of ["SKILL.md", "helper.sh"]) assert.equal(await readFile(path.join(destination, file), "utf8"), await readFile(path.join(source, file), "utf8"));
      assert.equal((await stat(path.join(destination, "helper.sh"))).mode & 0o111, 0o111);
      assert.notEqual(result.verification!.sourceHash, result.verification!.destinationHash);
      assert.equal(result.verification!.expectedHash, result.verification!.destinationHash);
      assert.ok(result.verification!.checks.some(check => check.label === "自动修复" && check.state === "passed"));
      const repeated = await scanner.preview([id], target);
      assert.equal(repeated.items[0].status, "skipped");
      assert.match(repeated.items[0].reason!, /预期内容一致/);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
}

test("an existing raw copy is backed up and repaired instead of incorrectly skipped", async () => {
  const { home, source, scanner, id } = await fixture();
  try {
    const destination = path.join(home, ".wiscode/skills/helper");
    await mkdir(path.join(destination, "agents"), { recursive: true });
    await writeFile(path.join(destination, "agents/openai.yaml"), metadata);
    await writeFile(path.join(destination, "SKILL.md"), await readFile(path.join(source, "SKILL.md")));
    await writeFile(path.join(destination, "helper.sh"), await readFile(path.join(source, "helper.sh")));
    await chmod(path.join(destination, "helper.sh"), 0o755);
    const preview = await scanner.preview([id], "wiscode");
    assert.equal(preview.items[0].status, "update");
    const [result] = await scanner.copy([id], "wiscode", preview.token);
    assert.equal(result.status, "copied");
    assert.equal(await readFile(path.join(result.backup!, "agents/openai.yaml"), "utf8"), metadata);
    assert.ok(parse(await readFile(path.join(destination, "agents/openai.yaml"), "utf8")).interface);
    assert.equal(await readFile(path.join(source, "agents/openai.yaml"), "utf8"), metadata);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("source changes after repair preview abort installation and same-location copies do not repair the source", async () => {
  const { home, source, scanner, id } = await fixture(".agents/skills");
  try {
    const same = await scanner.preview([id], "codex");
    assert.equal(same.items[0].status, "skipped");
    await scanner.copy([id], "codex", same.token);
    assert.equal(await readFile(path.join(source, "agents/openai.yaml"), "utf8"), metadata);
    const preview = await scanner.preview([id], "wiscode");
    await writeFile(path.join(source, "agents/openai.yaml"), metadata.replace("Use fixture", "New prompt"));
    const [result] = await scanner.copy([id], "wiscode", preview.token);
    assert.equal(result.status, "failed");
    assert.match(result.message, /源文件.*变化/);
    await assert.rejects(() => stat(path.join(home, ".wiscode/skills/helper")), /ENOENT/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("external sidecar dependencies are not silently rewritten", async () => {
  const { home, source, scanner, id } = await fixture();
  try {
    const external = path.join(home, "shared-metadata.yaml");
    await writeFile(external, metadata);
    await rm(path.join(source, "agents/openai.yaml"));
    await symlink(external, path.join(source, "agents/openai.yaml"));
    const preview = await scanner.preview([id], "wiscode");
    assert.equal(preview.items[0].status, "blocked");
    assert.equal(await readFile(external, "utf8"), metadata);
  } finally { await rm(home, { recursive: true, force: true }); }
});
