import { decideFileRules } from "./file-rule-guard";
/**
 * Hook entrypoint bundled to dist-electron/guard.cjs. Agent tools spawn it as
 *   <runtime> guard.cjs --tool <id> --data <dir>
 * with the PreToolUse payload on stdin. It prints the deny JSON shared by
 * Codex / Claude Code / ZCode / DSH and always exits 0 so a guard crash never
 * breaks the agent (fail-open is recorded as an "error" event).
 */
import fs from "node:fs";
import path from "node:path";
import {
  decide,
  defaultPolicy,
  hookOutput,
  logDecision,
  summarizePayload,
  type GuardPolicyFile,
} from "./guard-protocol";
const args = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const tool = flag("tool") ?? "unknown";
const dataDir =
  flag("data") ?? path.join(process.cwd(), ".network-lens-security");
const source =
  process.env.NETWORK_LENS_GUARD_SOURCE === "self_check"
    ? "self_check"
    : undefined;
const loadPolicy = (): GuardPolicyFile => {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(dataDir, "policy.json"), "utf8"),
    );
    if (parsed && parsed.version === 1 && Array.isArray(parsed.rules))
      return parsed;
  } catch {}
  return defaultPolicy();
};
const readStdin = async () => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error("操作载荷超过 2MB");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
};
const main = async () => {
  const raw = await readStdin();
  const payload = raw.trim() ? JSON.parse(raw) : {};
  const input = summarizePayload(payload, tool);
  const policy = loadPolicy();
  const paused = fs.existsSync(path.join(dataDir, "paused"));
  const baseDecision = paused
    ? {
        decision: "allow" as const,
        operation: decide(input, { ...policy, rules: [] }).operation,
      }
    : decide(input, policy);
  const fileDecision = decideFileRules(dataDir, input);
  const decision =
    baseDecision.decision === "deny"
      ? baseDecision
      : fileDecision || baseDecision;
  try {
    logDecision(dataDir, decision, input, {
      source:
        source ?? (decision.decision === "deny" ? "real_block" : "real_allow"),
    });
  } catch {}
  process.stdout.write(JSON.stringify(hookOutput(decision)) + "\n");
};
main().catch((error) => {
  try {
    logDecision(
      dataDir,
      {
        decision: "allow",
        operation: "guard",
        reason: `判定脚本异常，已放行：${String(error).slice(0, 200)}`,
      },
      { tool },
      { source: "error" },
    );
  } catch {}
  process.stdout.write("{}\n");
});
