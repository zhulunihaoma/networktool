import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SecurityCenter } from "../electron/security/center";
import * as doctor from "../electron/security/doctor";
import { logDecision } from "../electron/security/guard-protocol";
import { timeline } from "../electron/security/timeline";
import { securityScore } from "../src/shared/security-score";
import { SCORE_BASE, SCORE_MIN, type Finding, type ToolStatus } from "../src/shared/security";

const setup = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nl-overview-"));
  const dataDir = path.join(home, "security");
  fs.mkdirSync(dataDir, { recursive: true });
  const script = path.join(dataDir, "guard.cjs");
  fs.writeFileSync(script, 'process.stdout.write("{}\\n")');
  const center = new SecurityCenter({
    home,
    dataDir,
    guard: { runtime: process.execPath, env: {}, script, dataDir },
    doctor,
    autoProtect: false,
  });
  return { home, dataDir, center };
};

test("同类百条只扣一次、按最高级别扣分；实证加分、下限和满分可核对", () => {
  const finding = (id: string, category: Finding["category"], level: Finding["level"] = "high"): Finding => ({
    id, category, level, tool: "codex", title: id, evidence: "fixture", why: "fixture", fix: "fixture",
  });
  const chain = { status: "ok" as const, checked: 1 };
  const doctorReport = { at: 1, findings: [], scanned: [{ tool: "codex" as const, files: 1 }], ignored: [] };
  const tool = (state: ToolStatus["state"]): ToolStatus => ({ tool: "codex", name: "Codex", installed: true, canToggle: true, autoProtect: "on", state, mechanism: "hook", blocked: 0, checked: 0 });
  const one = securityScore([finding("one", "permission")], [tool("enabled")], doctorReport, chain);
  const many = securityScore(Array.from({ length: 112 }, (_, i) => finding(`${i}`, "permission")), [tool("enabled")], doctorReport, chain);
  assert.equal(one.score, 84);
  assert.equal(many.score, one.score);
  assert.equal(many.scoreItems.filter(i => i.deduction).length, 1);
  assert.match(many.scoreItems[0].reason, /112 个当前问题/);
  const mixed = securityScore([finding("low", "secret", "low"), finding("mid", "secret", "medium"), finding("hi", "secret")], [], undefined, { status: "empty", checked: 0 });
  assert.equal(mixed.scoreItems[0].deduction, 16);
  const worst = securityScore((["permission", "secret", "supply_chain", "network", "integrity"] as const).map(c => finding(c, c)), [], undefined, { status: "broken", checked: 1 });
  assert.equal(worst.score, 30);
  assert.equal(SCORE_BASE + worst.scoreItems.reduce((n, i) => n + (i.bonus ?? 0) - i.deduction, 0), 30);
  assert.equal(worst.scoreItems.filter(i => i.id === "category:integrity").length, 1);
  assert.equal(securityScore([], [tool("enabled")], doctorReport, chain).score, 100);
  assert.equal(securityScore([], [tool("needs_trust")], doctorReport, chain).scoreItems.find(i => i.id === "protection")?.bonus, 0);
  assert.equal(securityScore([], [tool("enabled"), tool("off"), tool("broken")], doctorReport, chain).scoreItems.find(i => i.id === "protection")?.bonus, 3);
  assert.equal(securityScore([], [], { ...doctorReport, findings: [finding("codex:unreadable:file", "integrity")] }, chain).scoreItems.find(i => i.id === "doctor")?.bonus, 0);
});

test("评分按类合并列出加扣分依据，当前问题均有具体动作", async () => {
  const { home, center } = setup();
  try {
    let o = center.overview();
    assert.equal(o.scoreItems.find(i => i.id === "doctor")?.bonus, 0);
    assert.ok(o.score >= SCORE_MIN && o.score <= 100);
    fs.mkdirSync(path.join(home, ".codex"));
    fs.writeFileSync(
      path.join(home, ".codex/config.toml"),
      'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n',
    );
    fs.writeFileSync(path.join(home, ".codex/auth.json"), "{}", { mode: 0o644 });
    await center.doctor();
    o = center.overview();
    const adjustment = o.scoreItems.reduce((n, i) => n + (i.bonus ?? 0) - i.deduction, 0);
    assert.equal(o.score, SCORE_BASE + adjustment);
    assert.ok(o.scoreItems.filter(i => i.deduction).every(i => i.findingId));
    // Doctor findings from the fixture home; guard findings depend on which
    // tools are installed on this machine, so they are counted separately.
    const fileHigh = o.findings.filter(
      (f) => f.level === "high" && !f.id.startsWith("guard:"),
    ).length;
    assert.equal(fileHigh, 3);
    assert.match(o.headline, new RegExp(`发现 ${o.openFindings.high} 个高风险问题`));
    // Highest risk first; cards do not claim individual deductions.
    assert.equal(o.findings[0].level, "high");
    for (const f of o.findings) {
      assert.ok(!("deduction" in f), f.id);
      assert.ok(f.action, f.id);
    }
    const perm = o.findings.find((f) => f.autoFix)!;
    assert.equal(perm.action?.kind, "auto_fix");
    const approval = o.findings.find((f) => f.id === "codex:approval")!;
    assert.equal(approval.action?.kind, "reveal");
    assert.equal(approval.path, path.join(home, ".codex/config.toml"));
    assert.ok(approval.steps?.length);
    assert.equal(center.findingPath(approval.id), approval.path);
    assert.equal(center.findingPath("unknown"), undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("暂不处理的问题不扣分且可恢复；一键修复不包含已忽略项", async () => {
  const { home, center } = setup();
  try {
    fs.mkdirSync(path.join(home, ".codex"));
    fs.writeFileSync(path.join(home, ".codex/config.toml"), 'approval_policy = "never"\n');
    fs.writeFileSync(path.join(home, ".codex/auth.json"), "{}", { mode: 0o644 });
    await center.doctor();
    const before = center.overview();
    const perm = before.findings.find((f) => f.autoFix)!;
    center.ignoreFinding(perm.id, true);
    const after = center.overview();
    assert.ok(after.score > before.score);
    assert.ok(!after.scoreItems.some(i => i.id === "category:secret"));
    assert.ok(after.ignoredFindings.some((f) => f.id === perm.id));
    assert.ok(!after.findings.some((f) => f.id === perm.id));
    assert.throws(() => center.preview("fix_all"), /没有可以自动修复/);
    center.ignoreFinding(perm.id, false);
    assert.equal(center.overview().score, before.score);
    assert.equal(center.preview("fix_all").changes.length, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("防护类问题按实时状态计算，开启防护后不再残留旧扣分", async () => {
  const { home, center } = setup();
  try {
    fs.mkdirSync(path.join(home, ".claude"));
    fs.writeFileSync(path.join(home, ".claude/settings.json"), "{}");
    await center.doctor();
    const tool = center.tools().find((t) => t.tool === "claude")!;
    if (!tool.installed || !tool.canToggle) return; // claude binary not detectable here
    let f = center.overview().findings.find((x) => x.id.startsWith("guard:claude"));
    assert.equal(f?.action?.kind, "enable_tool");
    const preview = center.preview("enable", "claude");
    await center.apply(preview.token);
    f = center.overview().findings.find((x) => x.id.startsWith("guard:claude"));
    assert.equal(f, undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("时间线支持多来源与规则筛选，并按规则汇总真实拦截", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "nl-tl-"));
  try {
    const base = { tool: "codex", project: "/p", toolName: "Bash" };
    logDecision(d, { decision: "deny", ruleId: "credential_read", reason: "x", operation: "Bash: cat" }, base, { source: "real_block" });
    logDecision(d, { decision: "deny", ruleId: "credential_read", reason: "x", operation: "Bash: cat" }, base, { source: "real_block" });
    logDecision(d, { decision: "deny", ruleId: "protected_branch", reason: "x", operation: "Bash: git" }, base, { source: "real_block" });
    logDecision(d, { decision: "deny", ruleId: "credential_read", reason: "x", operation: "self" }, base, { source: "self_check" });
    logDecision(d, { decision: "allow", operation: "Bash: ls" }, base, { source: "real_allow" });
    logDecision(d, { decision: "allow", operation: "guard", reason: "err" }, base, { source: "error" });
    const page = timeline(d, { sources: ["real_block", "error"] });
    assert.equal(page.total, 4);
    assert.deepEqual(page.byRule, { credential_read: 2, protected_branch: 1 });
    assert.equal(timeline(d, { sources: ["real_block"], ruleId: "credential_read" }).total, 2);
    assert.equal(timeline(d, { source: "real_allow" }).total, 1);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
