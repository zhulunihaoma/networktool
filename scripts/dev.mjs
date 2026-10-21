import { spawn } from "node:child_process";
import { once } from "node:events";
import { context } from "esbuild";
import { createServer } from "vite";
import electron from "electron";
import { electronBuildOptions } from "./electron-build.mjs";

const server = await createServer();
const childEnv = { ...process.env, NETWORK_LENS_DEV: "1" };
delete childEnv.ELECTRON_RUN_AS_NODE;
let child,
  builder,
  closing = false,
  listening = false;
let restartQueue = Promise.resolve();
let firstResolve, firstReject;
const firstBuild = new Promise((resolve, reject) => {
  firstResolve = resolve;
  firstReject = reject;
});
void firstBuild.catch(() => {});

async function stopChild() {
  const previous = child;
  child = undefined;
  if (
    !previous?.pid ||
    previous.exitCode !== null ||
    previous.signalCode !== null
  )
    return;
  const exited = once(previous, "exit");
  previous.kill();
  const timer = setTimeout(() => previous.kill("SIGKILL"), 5000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}
function startChild() {
  if (closing) return;
  const current = (child = spawn(electron, ["."], {
    stdio: "inherit",
    env: childEnv,
  }));
  current.on("error", (error) => {
    console.error(error);
    void close(1);
  });
  current.on("exit", (code) => {
    if (child === current && !closing) void close(code ?? 0);
  });
}
async function close(code = 0) {
  if (closing) return;
  closing = true;
  await restartQueue.catch(() => {});
  await stopChild();
  await builder?.dispose();
  await server.close();
  process.exit(code);
}
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());

try {
  builder = await context({
    ...electronBuildOptions,
    plugins: [
      {
        name: "restart-electron-after-build",
        setup(build) {
          build.onEnd((result) => {
            if (result.errors.length) {
              firstReject(
                new Error("Electron 编译失败，请修复错误后重新启动。"),
              );
              return;
            }
            firstResolve();
            if (!listening || closing) return;
            restartQueue = restartQueue.then(async () => {
              if (closing) return;
              await stopChild();
              if (!closing) {
                console.log(
                  "[desktop] 主进程 / preload 已重新编译，重启 Electron。",
                );
                startChild();
              }
            });
            void restartQueue.catch((error) => {
              console.error(error);
              void close(1);
            });
          });
        },
      },
    ],
  });
  await builder.watch();
  await firstBuild;
  if (!closing) {
    await server.listen();
    listening = true;
    startChild();
  }
} catch (error) {
  console.error(error);
  await close(1);
}
