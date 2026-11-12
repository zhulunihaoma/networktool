import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logDecision, eventsFile } from "../electron/security/guard-protocol";
import { timeline } from "../electron/security/timeline";
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "nl-timeline-"));
const write = (d: string) => {
  const base = { tool: "codex", project: "/p", toolName: "Bash" };
  logDecision(d, { decision: "deny", ruleId: "protected_branch", reason: "x", operation: "Bash: git push origin main" }, base, { source: "real_block" });
  logDecision(d, { decision: "allow", operation: "Bash: ls" }, base, { source: "real_allow" });
  logDecision(d, { decision: "deny", ruleId: "credential_read", reason: "y", operation: "self-check: cat .env" }, base, { source: "self_check" });
};
test("时间线按来源分开计数并可筛选", () => {
  const d = dir();
  write(d);
  const all = timeline(d);
  assert.equal(all.total, 3);
  assert.equal(all.counts.real_block, 1);
  assert.equal(all.counts.self_check, 1);
  assert.equal(all.chain.status, "ok");
  assert.equal(timeline(d, { source: "real_block" }).events.length, 1);
  assert.equal(timeline(d, { query: "git push" }).events[0].ruleId, "protected_branch");
  assert.ok(!("hash" in all.events[0]));
});
test("篡改或删除记录会被哈希链发现", () => {
  const d = dir();
  write(d);
  const file = eventsFile(d);
  const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
  fs.writeFileSync(file, [lines[0], lines[2]].join("\n") + "\n");
  assert.equal(timeline(d).chain.status, "broken");
  fs.writeFileSync(file, lines.join("\n").replace("protected_branch", "nothing_here") + "\n");
  assert.equal(timeline(d).chain.status, "broken");
});
test("空目录与损坏行不会抛错", () => {
  const d = dir();
  assert.equal(timeline(d).chain.status, "empty");
  fs.writeFileSync(eventsFile(d), "not-json\n");
  assert.equal(timeline(d).chain.status, "broken");
});
