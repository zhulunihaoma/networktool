import test from "node:test";
import assert from "node:assert/strict";
import { captureHandoffExport } from "../electron/core/handoff-cli";

test("large JSON remains complete when a CLI exits immediately after writing stdout", async () => {
  const raw = await captureHandoffExport(process.execPath, ["-e", 'process.stdout.write(JSON.stringify({payload:"x".repeat(256*1024)}));process.exit(0)']);
  assert.equal(JSON.parse(raw).payload.length, 256 * 1024);
});

test("oversized exports and nonzero exits are rejected, never imported partially", async () => {
  await assert.rejects(captureHandoffExport(process.execPath, ["-e", 'process.stdout.write("x".repeat(4096))'], { maxBytes: 1024 }), /大小限制/);
  await assert.rejects(captureHandoffExport(process.execPath, ["-e", 'process.stdout.write("partial");process.exit(1)']), /未正常完成/);
});

test("hung exports are terminated within the configured timeout", async () => {
  await assert.rejects(captureHandoffExport(process.execPath, ["-e", 'setInterval(()=>{},1000)'], { timeoutMs: 100 }), /超时/);
});
