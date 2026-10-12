import { spawn } from "node:child_process";
import { build } from "esbuild";
import { createServer } from "vite";
import electron from "electron";
await build({
  entryPoints: ["electron/main.ts"],
  outfile: "dist-electron/main.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron", "sql.js"],
  sourcemap: true,
});
await build({
  entryPoints: ["electron/preload.ts"],
  outfile: "dist-electron/preload.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
});
const server = await createServer();
await server.listen();
// 当 ELECTRON_RUN_AS_NODE=1 时，Electron 二进制会退化成纯 Node 运行，
// 此时 require("electron") 返回的是可执行文件路径字符串而不是 API 对象，
// 主进程会因 app 为 undefined 而立即崩溃。从 Electron 派生的 shell
// （例如编辑器内置终端）启动时会继承该变量，这里显式剔除。
const childEnv = { ...process.env, NETWORK_LENS_DEV: "1" };
delete childEnv.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ["."], {
  stdio: "inherit",
  env: childEnv,
});
const close = async () => {
  child.kill();
  await server.close();
  process.exit();
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
child.on("exit", close);
