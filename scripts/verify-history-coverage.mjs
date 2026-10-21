/** Run the native SQLite verifier with the same Node runtime as the desktop app. */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(path.join(root, "package.json"));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "history-verifier-"));
try {
  const file = path.join(temporary, "verify.cjs");
  await require("esbuild").build({
    entryPoints: [path.join(root, "scripts/verify-history-coverage.ts")],
    outfile: file,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "warning",
  });
  const code = await new Promise((resolve, reject) => {
    const child = spawn(require("electron"), [file, ...process.argv.slice(2)], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    child.once("error", reject);
    child.once("exit", resolve);
  });
  process.exitCode = typeof code === "number" ? code : 1;
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
