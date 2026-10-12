import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, mkdir, realpath, rm, stat, symlink, writeFile, readFile, readlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SkillScanner } from "../electron/core/skills";

async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "network-lens-skills-"));
  const root = path.join(home, ".wiscode/codex-agents/skills/demo");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "SKILL.md"), "---\nname: demo\ndescription: Local helper\n---\n# Demo\n## Scan\n## Explain\n");
  return { home, root };
}
test("internal symlinks are materialized and executable permission is preserved", async () => {
  const { home, root } = await fixture();
  try {
    const actual = path.join(root, "scripts/actual.sh");
    const alias = path.join(root, "cli/bin/geelib-cli");
    await mkdir(path.dirname(actual), { recursive: true });
    await mkdir(path.dirname(alias), { recursive: true });
    await writeFile(actual, "#!/bin/sh\necho ok\n");
    await chmod(actual, 0o755);
    await symlink(path.relative(path.dirname(alias), actual), alias);
    const scanner = new SkillScanner(home), ids = [(await scanner.scan()).items[0].id];
    const preview = await scanner.preview(ids, "cursor");
    assert.equal(preview.items[0].status, "ready");
    assert.ok(preview.items[0].changes.some(change => change.includes("cli/bin/geelib-cli")));
    const [result] = await scanner.copy(ids, "cursor", preview.token);
    const copied = path.join(home, ".cursor/skills/demo/cli/bin/geelib-cli");
    assert.equal(result.status, "copied");
    assert.equal((await lstat(copied)).isSymbolicLink(), false);
    assert.equal(await readFile(copied, "utf8"), "#!/bin/sh\necho ok\n");
    assert.equal((await stat(copied)).mode & 0o111, 0o111);
    assert.equal((await lstat(alias)).isSymbolicLink(), true, "源 Skill 不应被修改");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("external executable links remain local dependencies and show the exact path", async () => {
  const { home, root } = await fixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), "network-lens-external-dependency-"));
  try {
    const program = path.join(outside, "geelib-cli");
    const link = path.join(root, "cli/bin/geelib-cli");
    await mkdir(path.dirname(link), { recursive: true });
    await writeFile(program, "#!/bin/sh\necho cli\n");
    await chmod(program, 0o755);
    await symlink(program, link);
    const scanner = new SkillScanner(home), ids = [(await scanner.scan()).items[0].id];
    const preview = await scanner.preview(ids, "cursor");
    assert.equal(preview.items[0].status, "ready");
    assert.ok(preview.items[0].warnings.some(warning => warning.includes(program)));
    const [result] = await scanner.copy(ids, "cursor", preview.token);
    const copied = path.join(home, ".cursor/skills/demo/cli/bin/geelib-cli");
    assert.equal(result.status, "copied");
    assert.equal((await lstat(copied)).isSymbolicLink(), true);
    assert.equal(await readlink(copied), await realpath(program));
  } finally { await rm(home, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("broken and cyclic skill links block copying with path-specific reasons", async () => {
  const { home, root } = await fixture();
  try {
    const broken = path.join(root, "references/missing.md");
    await mkdir(path.dirname(broken), { recursive: true });
    await symlink("not-here.md", broken);
    const scanner = new SkillScanner(home), ids = [(await scanner.scan()).items[0].id];
    const missing = await scanner.preview(ids, "cursor");
    assert.equal(missing.items[0].status, "blocked");
    assert.match(missing.items[0].reason!, /references[\\/]missing\.md.*已失效/);
    await rm(broken);
    await symlink(".", path.join(root, "recursive"), "dir");
    const loop = await scanner.preview(ids, "cursor");
    assert.equal(loop.items[0].status, "blocked");
    assert.match(loop.items[0].reason!, /循环引用/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("sensitive-looking filenames alone do not block documentation files", async () => {
  const { home, root } = await fixture();
  try {
    await writeFile(path.join(root, "token-examples.md"), "Use TOKEN_EXAMPLE in this sample; no credential is stored.\n");
    const scanner = new SkillScanner(home), ids = [(await scanner.scan()).items[0].id];
    const preview = await scanner.preview(ids, "cursor");
    assert.equal(preview.items[0].status, "ready");
    const [result] = await scanner.copy(ids, "cursor", preview.token);
    assert.equal(result.status, "copied");
    assert.equal(await readFile(path.join(home, ".cursor/skills/demo/token-examples.md"), "utf8"), "Use TOKEN_EXAMPLE in this sample; no credential is stored.\n");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("credential-like file contents are blocked without echoing the credential", async () => {
  const { home, root } = await fixture();
  try {
    await writeFile(path.join(root, "private-key-example.txt"), "-----BEGIN PRIVATE KEY-----\nfixture-only\n");
    const scanner = new SkillScanner(home), ids = [(await scanner.scan()).items[0].id];
    const preview = await scanner.preview(ids, "cursor");
    assert.equal(preview.items[0].status, "blocked");
    assert.match(preview.items[0].reason!, /private-key-example\.txt.*凭据/);
    assert.doesNotMatch(preview.items[0].reason!, /fixture-only/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("different same-name destination is backed up before update", async () => {
  const { home, root } = await fixture();
  try {
    const scanner = new SkillScanner(home), ids = [(await scanner.scan()).items[0].id];
    const destination = path.join(home, ".cursor/skills/demo");
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, "SKILL.md"), "old user content\n");
    const preview = await scanner.preview(ids, "cursor");
    assert.equal(preview.items[0].status, "update");
    assert.match(preview.items[0].reason!, /先将整个旧目录备份/);
    const [result] = await scanner.copy(ids, "cursor", preview.token);
    assert.equal(result.status, "copied");
    assert.ok(result.backup);
    assert.equal(await readFile(path.join(destination, "SKILL.md"), "utf8"), await readFile(path.join(root, "SKILL.md"), "utf8"));
    assert.equal(await readFile(path.join(result.backup!, "SKILL.md"), "utf8"), "old user content\n");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("same-name selections deduplicate identical content and explain conflicting content", async () => {
  const { home, root } = await fixture();
  try {
    const shared = path.join(home, "shared/demo");
    await mkdir(shared, { recursive: true });
    const original = await readFile(path.join(root, "SKILL.md"), "utf8");
    await writeFile(path.join(shared, "SKILL.md"), original);
    const scanner = new SkillScanner(home, [path.join(home, "shared")]);
    const ids = (await scanner.scan()).items.map(item => item.id);
    assert.equal(ids.length, 2);
    const identical = await scanner.preview(ids, "cursor");
    assert.deepEqual(identical.items.map(item => item.status).sort(), ["ready", "skipped"]);
    const copied = await scanner.copy(ids, "cursor", identical.token);
    assert.deepEqual(copied.map(item => item.status).sort(), ["copied", "skipped"]);

    await writeFile(path.join(shared, "SKILL.md"), original.replace("Local helper", "Different helper"));
    const nextIds = (await scanner.scan()).items.map(item => item.id);
    const conflict = await scanner.preview(nextIds, "roocode");
    assert.ok(conflict.items.some(item => item.status === "blocked" && /多个目录名为 demo.*内容不同/.test(item.reason ?? "")));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("copy preserves executable resources and skips targets appearing after preview", async () => {
  const { home, root } = await fixture();
  try {
    await mkdir(path.join(root, "scripts"));
    const script = path.join(root, "scripts/helper.sh");
    await writeFile(script, "#!/bin/sh\nprintf helper");
    await chmod(script, 0o755);
    const scanner = new SkillScanner(home);
    const ids = [(await scanner.scan()).items[0].id];
    const preview = await scanner.preview(ids, "cursor");
    assert.equal((await scanner.copy(ids, "cursor", preview.token))[0].status, "copied");
    assert.equal((await stat(path.join(home, ".cursor/skills/demo/scripts/helper.sh"))).mode & 0o777, 0o755);
    const conflict = await scanner.preview(ids, "opencode");
    await mkdir(path.join(home, ".config/opencode/skills/demo"), { recursive: true });
    const conflictResult = (await scanner.copy(ids, "opencode", conflict.token))[0];
    assert.equal(conflictResult.status, "failed");
    assert.match(conflictResult.message, /检查后已出现/);
    const changed = await scanner.preview(ids, "roocode");
    await chmod(script, 0o644);
    assert.equal((await scanner.copy(ids, "roocode", changed.token))[0].status, "failed");
  } finally { await rm(home, { recursive: true, force: true }); }
});
test("复制完整保留调用限制和 sidecar 并返回落盘哈希", async () => {
  const { home, root } = await fixture();
  try {
    await mkdir(path.join(root, "agents"), { recursive: true });
    const sidecar = "interface:\n  display_name: Demo\npolicy:\n  allow_implicit_invocation: false\ndependencies:\n  tools: []\n";
    await writeFile(path.join(root, "agents/openai.yaml"), sidecar);
    const source = "---\nname: demo\ndescription: Local helper\ndisable-model-invocation: true\n---\n# Demo\n";
    await writeFile(path.join(root, "SKILL.md"), source);
    const scanner = new SkillScanner(home), ids = [(await scanner.scan()).items[0].id];
    const preview = await scanner.preview(ids, "opencode");
    assert.equal(preview.items[0].status, "ready");
    assert.deepEqual(preview.items[0].changes, []);
    assert.match(preview.items[0].warnings.join("\n"), /完整保留/);
    const result = await scanner.copy(ids, "opencode", preview.token);
    assert.equal(result[0].status, "copied");
    const output = await readFile(path.join(home, ".config/opencode/skills/demo/agents/openai.yaml"), "utf8");
    assert.equal(output, sidecar);
    const convertedSkill = await readFile(path.join(home, ".config/opencode/skills/demo/SKILL.md"), "utf8");
    assert.equal(convertedSkill, source);
    assert.match(result[0].message, /完整性校验/);
    assert.equal(result[0].verification?.sourceHash, result[0].verification?.destinationHash);
    assert.ok(result[0].verification?.checks.some(check => check.label === "实际运行" && check.state === "unverified"));
    assert.equal(await readFile(path.join(root, "SKILL.md"), "utf8"), source);
    assert.equal(await readFile(path.join(root, "agents/openai.yaml"), "utf8"), sidecar);
  } finally { await rm(home, { recursive: true, force: true }); }
});
test("跨工具复制保留预授权声明并报告兼容差异", async () => {
  const { home, root } = await fixture();
  try {
    const source = "---\nname: demo\ndescription: Local helper\nallowed-tools:\n  - Bash(git:*)\n---\nUse scripts/helper.sh\n";
    await writeFile(path.join(root, "SKILL.md"), source);
    const scanner = new SkillScanner(home);
    const ids = [(await scanner.scan()).items[0].id];
    const preview = await scanner.preview(ids, "cursor");
    assert.equal(preview.items[0].status, "ready");
    const result = await scanner.copy(ids, "cursor", preview.token);
    assert.equal(result[0].status, "copied");
    const target = await readFile(path.join(home, ".cursor/skills/demo/SKILL.md"), "utf8");
    assert.equal(target, source);
    assert.match(target, /Use scripts\/helper.sh/);
    assert.equal(await readFile(path.join(root, "SKILL.md"), "utf8"), source);
  } finally { await rm(home, { recursive: true, force: true }); }
});
test("scan covers every installed tool dir and reports registry targets", async () => {
  const { home } = await fixture();
  try {
    // .claude/skills 过去不在扫描范围内，这里验证注册表驱动的新增覆盖
    const extra = path.join(home, ".claude/skills/extra");
    await mkdir(extra, { recursive: true });
    await writeFile(path.join(extra, "SKILL.md"), "---\nname: Extra\n---\n# Extra\n## Review\n");
    const result = await new SkillScanner(home).scan();
    assert.deepEqual(result.items.map((item) => item.name).sort(), ["Extra", "demo"]);
    assert.deepEqual(result.items.find((item) => item.name === "demo")?.features, ["Scan", "Explain"]);
    assert.equal(result.items.find((item) => item.name === "Extra")?.source, "Claude Code");
    assert.deepEqual(result.targets.map((target) => target.id).slice(0, 4), ["wiscode", "agents", "claude", "codex"]);
    assert.deepEqual(result.targets.filter((target) => target.installed).map((target) => target.id), ["wiscode", "claude"]);
    // 未安装的工具不再作为“读取失败目录”打扰用户
    assert.ok(result.roots.every((root) => root.status === "scanned"));
  } finally { await rm(home, { recursive: true, force: true }); }
});
test("copy only uses latest scan and never overwrites", async () => {
  const { home } = await fixture();
  try {
    const scanner = new SkillScanner(home), scan = await scanner.scan();
    const ids = [scan.items[0].id];
    const first = await scanner.copy(ids, "cursor", (await scanner.preview(ids, "cursor")).token);
    assert.equal(first[0].status, "copied");
    // Cursor 本机未安装，但仍可作为复制目标：缺失目录会被创建
    assert.ok((await stat(path.join(home, ".cursor/skills/demo"))).isDirectory());
    const second = await scanner.copy(ids, "cursor", (await scanner.preview(ids, "cursor")).token);
    assert.equal(second[0].status, "skipped");
    assert.equal((await scanner.preview(["malicious-id"], "cursor")).items[0].status, "blocked");
    await assert.rejects(() => scanner.copy(ids, "cursor"), /检查已失效/);
    await assert.rejects(() => scanner.copy([scan.items[0].id], "unknown"));
  } finally { await rm(home, { recursive: true, force: true }); }
});
test("scan follows skill links inside home and refuses links escaping it", async () => {
  const { home } = await fixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), "network-lens-outside-"));
  try {
    const linked = path.join(home, ".wiscode/plugin-cache/linked-skill");
    await mkdir(linked, { recursive: true });
    await writeFile(path.join(linked, "SKILL.md"), "---\nname: Linked\n---\n# Linked\n");
    await symlink(linked, path.join(home, ".wiscode/codex-agents/skills/linked-skill"), "dir");
    const escaped = path.join(outside, "secret-skill");
    await mkdir(escaped, { recursive: true });
    await writeFile(path.join(escaped, "SKILL.md"), "---\nname: Escaped\n---\n# Escaped\n");
    await symlink(escaped, path.join(home, ".wiscode/codex-agents/skills/escaped-skill"), "dir");
    const result = await new SkillScanner(home).scan();
    const names = result.items.map((item) => item.name);
    assert.ok(names.includes("Linked"), "主目录内的链接应被扫描");
    assert.ok(!names.includes("Escaped"), "指向主目录外的链接必须跳过");
    assert.equal(result.items.find((item) => item.name === "Linked")?.path, await realpath(linked));
    assert.ok(result.roots.some((root) => root.message?.includes("主目录外")));
  } finally { await rm(home, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("preview binds selection and complete copies preserve every resource", async () => {
  const { home, root } = await fixture();
  try {
    const source = "---\nname: demo\ndescription: |\n  Local helper\n  with resources\n---\n# Demo\n";
    await writeFile(path.join(root, "SKILL.md"), source);
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets/example.txt"), "keep me");
    const scanner = new SkillScanner(home), scan = await scanner.scan(), ids = [scan.items[0].id];
    const preview = await scanner.preview(ids, "cursor");
    assert.equal(preview.items[0].status, "ready");
    await assert.rejects(() => stat(path.join(home, ".cursor")), /ENOENT/);
    await assert.rejects(() => scanner.copy(ids, "claude", preview.token), /检查已失效/);
    const result = await scanner.copy(ids, "cursor", preview.token);
    assert.equal(result[0].status, "copied");
    assert.match(await readFile(path.join(home, ".cursor/skills/demo/SKILL.md"), "utf8"), /name: demo/);
    assert.equal(await readFile(path.join(root, "SKILL.md"), "utf8"), source);
    assert.equal(await readFile(path.join(home, ".cursor/skills/demo/assets/example.txt"), "utf8"), "keep me");
    await assert.rejects(() => scanner.copy(ids, "cursor", preview.token), /检查已失效/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("content change and scan invalidate confirmed previews", async () => {
  const { home, root } = await fixture();
  try {
    const scanner = new SkillScanner(home), scan = await scanner.scan(), ids = [scan.items[0].id];
    const preview = await scanner.preview(ids, "cursor");
    await writeFile(path.join(root, "new-resource.txt"), "changed");
    const result = await scanner.copy(ids, "cursor", preview.token);
    assert.equal(result[0].status, "failed");
    assert.match(result[0].message, /已变化/);
    await assert.rejects(() => stat(path.join(home, ".cursor/skills/demo")), /ENOENT/);
    const next = await scanner.preview(ids, "cursor");
    await scanner.scan();
    await assert.rejects(() => scanner.copy(ids, "cursor", next.token), /检查已失效/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("unsupported destinations and host-only semantics are blocked without writing", async () => {
  const { home, root } = await fixture();
  try {
    const scanner = new SkillScanner(home), scan = await scanner.scan(), ids = [scan.items[0].id];
    const unknown = await scanner.preview(ids, "trae");
    assert.equal(unknown.items[0].status, "blocked");
    await scanner.copy(ids, "trae", unknown.token);
    await assert.rejects(() => stat(path.join(home, ".trae")), /ENOENT/);
    await writeFile(path.join(root, "SKILL.md"), "---\nname: demo\ndescription: helper\ncontext: fork\n---\n# Demo\n");
    assert.equal((await scanner.preview(ids, "cursor")).items[0].status, "ready");
    await writeFile(path.join(root, "SKILL.md"), "---\nname: demo\nname: demo\ndescription: helper\n---\n");
    assert.match((await scanner.preview(ids, "cursor")).items[0].reason!, /YAML/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("corrected destination rules, license and linked ancestors are enforced", async () => {
  const { home } = await fixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), "network-lens-target-"));
  try {
    const scanner = new SkillScanner(home), scan = await scanner.scan(), ids = [scan.items[0].id];
    assert.equal(scan.targets.find(t => t.id === "codex")?.path, path.join(home, ".agents/skills"));
    assert.equal(scan.targets.find(t => t.id === "roocode")?.path, path.join(home, ".roo/skills"));
    assert.equal((await scanner.preview(ids, "iflow")).items[0].status, "blocked");
    await symlink(outside, path.join(home, ".cursor"), "dir");
    const preview = await scanner.preview(ids, "cursor");
    assert.equal(preview.items[0].status, "blocked");
    await scanner.copy(ids, "cursor", preview.token).catch(() => undefined);
    await assert.rejects(() => stat(path.join(outside, "skills")), /ENOENT/);
  } finally { await rm(home, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("WisCode copies user skills into its shared user directory", async () => {
  const { home, root } = await fixture();
  try {
    const scanner = new SkillScanner(home);
    const scan = await scanner.scan();
    assert.equal(scan.targets.find(target => target.id === "wiscode")?.path, path.join(home, ".wiscode/skills"));
    const ids = [scan.items[0].id];
    const preview = await scanner.preview(ids, "wiscode");
    assert.equal(preview.items[0].status, "ready");
    const [result] = await scanner.copy(ids, "wiscode", preview.token);
    assert.equal(result.status, "copied");
    assert.equal(await readFile(path.join(home, ".wiscode/skills/demo/SKILL.md"), "utf8"), await readFile(path.join(root, "SKILL.md"), "utf8"));
  } finally { await rm(home, { recursive: true, force: true }); }
});

const auditedDestinations: Record<string, string> = {
  wiscode: ".wiscode/skills", agents: ".agents/skills", claude: ".claude/skills",
  codex: ".agents/skills", cursor: ".cursor/skills", windsurf: ".codeium/windsurf/skills",
  copilot: ".copilot/skills", gemini: ".gemini/skills", opencode: ".config/opencode/skills",
  "trae-cn": ".trae-cn/skills", qoder: ".qoder/skills", workbuddy: ".workbuddy/skills", roocode: ".roo/skills",
};
for (const [target, expected] of Object.entries(auditedDestinations)) {
  test(`${target}: copy uses audited user directory even with legacy scan roots present`, async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "audited-skill-target-"));
    try {
      const source = path.join(home, "source/demo");
      await mkdir(source, { recursive: true });
      const text = "---\nname: demo\ndescription: helper\n---\n# Demo\n";
      await writeFile(path.join(source, "SKILL.md"), text);
      for (const old of [".wiscode/codex-agents/skills", ".copilotcode/skills", ".gemini/config/skills", ".roo-cline/skills", ".opencode/skills", ".codex/skills", ".trae/skills"]) {
        await mkdir(path.join(home, old), { recursive: true });
      }
      const scanner = new SkillScanner(home, [path.join(home, "source")]);
      const scan = await scanner.scan();
      const destination = scan.targets.find(item => item.id === target)!;
      assert.equal(destination.path, path.join(home, expected));
      assert.equal(destination.directoryExists, false);
      assert.equal(destination.copySupported, true);
      assert.ok(destination.directorySource?.url);
      const canonicalSource = await realpath(source);
      const ids = [scan.items.find(item => item.path === canonicalSource)!.id];
      const preview = await scanner.preview(ids, target);
      assert.equal(preview.items[0].status, "ready");
      const [result] = await scanner.copy(ids, target, preview.token);
      assert.equal(result.status, "copied");
      assert.equal(result.destination, path.join(home, expected, "demo"));
      assert.equal(await readFile(path.join(result.destination!, "SKILL.md"), "utf8"), text);
      assert.ok(result.activationHint);
      assert.equal(result.verification?.sourceHash, result.verification?.destinationHash);
      assert.ok(result.verification?.checks.some(check => check.label.includes("实际发现") && check.state === "unverified"));
      assert.equal((await scanner.scan()).targets.find(item => item.id === target)?.directoryExists, true);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
}

test("unverified loaders stay scan-only and explain the exact missing evidence", async () => {
  const { home } = await fixture();
  try {
    const scanner = new SkillScanner(home);
    const scan = await scanner.scan(), ids = [scan.items[0].id];
    for (const target of ["trae", "iflow"]) {
      const destination = scan.targets.find(item => item.id === target)!;
      assert.equal(destination.copySupported, false);
      assert.ok(destination.blockedReason);
      const preview = await scanner.preview(ids, target);
      assert.equal(preview.items[0].status, "blocked");
      assert.equal(preview.items[0].reason, destination.blockedReason);
      await scanner.copy(ids, target, preview.token);
      await assert.rejects(() => stat(destination.path), /ENOENT/);
    }
    assert.equal(scan.targets.find(item => item.id === "trae-cn")?.copySupported, true);
  } finally { await rm(home, { recursive: true, force: true }); }
});
