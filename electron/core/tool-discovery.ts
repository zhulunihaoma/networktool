import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TOOL_PRODUCTS } from "../../src/shared/assistant";
import type { DiscoveredTool } from "./tool-registry";
const execute = promisify(execFile);
export async function readBundleInfo(
  location: string,
): Promise<Record<string, unknown>> {
  const file = path.join(location, "Contents/Info.plist");
  if ((await fs.stat(file)).size > 512 * 1024)
    throw new Error("应用元数据过大");
  const { stdout } = await execute(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", file],
    { timeout: 2000, maxBuffer: 512 * 1024 },
  );
  return JSON.parse(stdout);
}
export async function inspectMacBundle(
  location: string,
  readInfo = readBundleInfo,
): Promise<DiscoveredTool | undefined> {
  const info = await readInfo(location);
  // Bundle identity takes precedence over a renamed app or a conflicting filename.
  const byId = TOOL_PRODUCTS.find((p) =>
    p.bundleIds.includes(String(info.CFBundleIdentifier)),
  );
  const byName = TOOL_PRODUCTS.find((p) =>
    p.apps.some(
      (n) =>
        (n + ".app").toLowerCase() === path.basename(location).toLowerCase(),
    ),
  );
  const product = byId || byName;
  if (!product) return;
  const name = info.CFBundleExecutable;
  let executable: string | undefined;
  if (
    typeof name === "string" &&
    name !== "." &&
    name !== ".." &&
    path.basename(name) === name
  ) {
    const binary = path.join(location, "Contents/MacOS", name);
    try {
      if ((await fs.stat(binary)).isFile())
        executable = await fs.realpath(binary);
    } catch {}
  }
  let channel: string | undefined;
  // Public installation metadata only; never read settings, tokens, history or application code.
  try {
    const productInfo = await smallJSON(
      path.join(location, "Contents/Resources/app/product.json"),
    );
    if (
      typeof productInfo.quality === "string" &&
      ["stable", "insider"].includes(productInfo.quality)
    )
      channel = productInfo.quality;
  } catch {}
  return {
    productId: product.id,
    location: await fs.realpath(location),
    executable,
    version:
      cleanVersion(info.CFBundleShortVersionString) ||
      cleanVersion(info.CFBundleVersion),
    source: `macOS 应用包与 Info.plist（${String(info.CFBundleIdentifier || "标识未知").slice(0, 160)}；${path.basename(location)}）`,
    confirmed: !!byId && !!executable,
    role: "host",
    channel,
  };
}
export function cleanVersion(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length <= 100 &&
    /^[a-zA-Z0-9.+_-]+$/.test(value)
    ? value
    : undefined;
}
export async function smallJSON(file: string): Promise<any> {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 512 * 1024)
    throw new Error("元数据格式或大小不支持");
  return JSON.parse(await fs.readFile(file, "utf8"));
}
export async function discoverMacBundles(
  directories: string[],
  readInfo = readBundleInfo,
) {
  const tools: DiscoveredTool[] = [],
    limitations: string[] = [],
    seen = new Set<string>();
  let examined = 0;
  async function walk(directory: string, depth: number) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        limitations.push("一个应用安装目录无法读取，发现覆盖下降。");
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++examined > 1500) {
        limitations.push("应用目录扫描达到 1500 项预算，部分位置未检查。");
        return;
      }
      const location = path.join(directory, entry.name);
      if (
        entry.name.endsWith(".app") &&
        (entry.isDirectory() || entry.isSymbolicLink())
      ) {
        try {
          const canonical = await fs.realpath(location);
          if (seen.has(canonical)) continue;
          seen.add(canonical);
          const tool = await inspectMacBundle(location, readInfo);
          if (tool) tools.push(tool);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            limitations.push(`应用包 ${entry.name} 元数据未完成核验。`);
        }
      } else if (
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        depth < 2
      ) {
        await walk(location, depth + 1);
      }
    }
  }
  for (const directory of directories) await walk(directory, 0);
  return { tools, limitations: [...new Set(limitations)] };
}
export async function cliDirectories(
  home = os.homedir(),
  environmentPath = process.env.PATH || "",
) {
  const dirs = environmentPath
    .split(path.delimiter)
    .filter((p) => path.isAbsolute(p) && !p.startsWith("\\\\"));
  dirs.push(
    path.join(home, ".local/bin"),
    path.join(home, "bin"),
    path.join(home, ".npm-global/bin"),
    path.join(home, ".opencode/bin"),
    path.join(home, ".bun/bin"),
    path.join(home, ".volta/bin"),
    path.join(home, ".claude/local/node_modules/.bin"),
  );
  if (process.platform === "win32") {
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, "npm"));
  } else dirs.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin");
  for (const root of [
    path.join(home, ".nvm/versions/node"),
    path.join(home, ".local/share/fnm/node-versions"),
  ]) {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      for (const entry of entries.filter((e) => e.isDirectory()).slice(0, 40))
        dirs.push(
          path.join(
            root,
            entry.name,
            root.includes("fnm") ? "installation/bin" : "bin",
          ),
        );
    } catch {}
  }
  return [...new Set(dirs)].slice(0, 200);
}
async function hashBinary(file: string) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 512 * 1024 * 1024)
    throw new Error("二进制校验预算超限");
  const hash = createHash("sha256"),
    stream = createReadStream(file, { signal: AbortSignal.timeout(8000) });
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}
export async function nativeClaudeVersion(
  location: string,
  home: string,
): Promise<string | undefined> {
  const root = path.join(home, ".local/share/claude/versions");
  // Version-named installer files are installation evidence, not an executed --version or publisher signature.
  if (
    path.dirname(location) === root &&
    /^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(path.basename(location))
  )
    return path.basename(location);
  if (location !== path.join(home, ".local/bin/claude")) return;
  const installed = await fs.stat(location);
  let digest: string | undefined;
  const entries = (await fs.readdir(root))
    .filter((n) => /^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(n))
    .slice(0, 40);
  for (const name of entries) {
    const file = path.join(root, name),
      stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== installed.size)
      continue;
    if (stat.dev === installed.dev && stat.ino === installed.ino) return name;
    digest ||= await hashBinary(location);
    if ((await hashBinary(file)) === digest) return name;
  }
}
export async function discoverCLIs(directories: string[], home = os.homedir()) {
  const tools: DiscoveredTool[] = [],
    seen = new Set<string>();
  for (const product of TOOL_PRODUCTS)
    for (const name of product.cli)
      for (const directory of directories) {
        const filenames =
          process.platform === "win32"
            ? [name + ".exe", name + ".cmd", name]
            : [name];
        for (const filename of filenames)
          try {
            const launcher = path.join(directory, filename),
              location = await fs.realpath(launcher);
            if (
              !(await fs.stat(location)).isFile() ||
              seen.has(product.id + location)
            )
              continue;
            seen.add(product.id + location);
            let version: string | undefined,
              confirmed = false,
              source = "已知 CLI 文件名（身份待核验）";
            for (let up = 0; up < 4; up++)
              try {
                const manifestPath = path.resolve(
                  path.dirname(location),
                  ...Array(up).fill(".."),
                  "package.json",
                );
                const manifest = await smallJSON(manifestPath);
                const bin =
                  typeof manifest.bin === "string"
                    ? manifest.bin
                    : manifest.bin?.[name];
                if (
                  product.packageName &&
                  manifest.name === product.packageName &&
                  typeof bin === "string" &&
                  (await fs.realpath(
                    path.resolve(path.dirname(manifestPath), bin),
                  )) === location
                ) {
                  version = cleanVersion(manifest.version);
                  confirmed = true;
                  source = "CLI 路径与 npm 包 manifest/bin 一致";
                  break;
                }
              } catch {}
            if (!confirmed && product.id === "claude-code")
              try {
                version = await nativeClaudeVersion(location, home);
                if (version) {
                  confirmed = true;
                  source =
                    "Claude 原生安装版本文件（启动器与版本文件一致；未核验发布者签名）";
                }
              } catch {}
            tools.push({
              productId: product.id,
              location,
              executable: location,
              version,
              confirmed,
              source,
              role: "cli",
            });
          } catch {}
      }
  return tools;
}
