import fs from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function createUpdateManifest({
  version,
  assets,
  notes = "",
  publishedAt = new Date().toISOString(),
}) {
  if (!/^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/.test(version))
    throw new Error("只支持稳定版版本号，例如 0.4.0。");
  if (notes.length > 16000 || !Number.isFinite(Date.parse(publishedAt)))
    throw new Error("更新说明过长或发布时间无效。");
  const sources = JSON.parse(
    await fs.readFile(path.join(root, "updates/sources.json"), "utf8"),
  );
  const entries = {};
  const names = new Set();
  for (const [platform, file] of assets) {
    if (
      !/^(win32|darwin|linux)-(x64|arm64)$/.test(platform) ||
      entries[platform]
    )
      throw new Error(`平台无效或重复：${platform}`);
    const name = path.basename(file);
    const extensions = platform.startsWith("win32-")
      ? [".exe"]
      : platform.startsWith("darwin-")
        ? [".zip", ".dmg"]
        : [".AppImage", ".deb", ".rpm", ".tar.gz"];
    if (
      !/^[\w ()+.-]{1,180}$/.test(name) ||
      name.startsWith(".") ||
      !extensions.some((ext) => name.endsWith(ext)) ||
      names.has(name)
    )
      throw new Error(`安装包名称、平台或重名检查失败：${name}`);
    names.add(name);
    const stat = await fs.lstat(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size < 1 ||
      stat.size > 1024 * 1024 * 1024
    )
      throw new Error(`安装包必须是 1 B 至 1 GB 的普通文件：${file}`);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    entries[platform] = {
      name,
      size: stat.size,
      sha256: hash.digest("hex"),
      urls: Object.fromEntries(
        Object.entries(sources).map(([id, source]) => [
          id,
          `${source.repository}/releases/download/v${version}/${encodeURIComponent(name)}`,
        ]),
      ),
    };
  }
  if (!Object.keys(entries).length)
    throw new Error("至少提供一个平台的安装包。");
  return {
    schemaVersion: 1,
    release: {
      version,
      publishedAt: new Date(publishedAt).toISOString(),
      notes,
      assets: entries,
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const pkg = JSON.parse(
    await fs.readFile(path.join(root, "package.json"), "utf8"),
  );
  let version = pkg.version,
    output = path.join(root, "release/stable.json"),
    notes = "";
  const assets = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i],
      value = args[++i];
    if (!value) throw new Error(`缺少 ${flag} 参数。`);
    if (flag === "--version") version = value;
    else if (flag === "--output") output = path.resolve(value);
    else if (flag === "--notes") notes = await fs.readFile(value, "utf8");
    else if (flag === "--asset") {
      const file = args[++i];
      if (!file) throw new Error("用法：--asset win32-x64 安装包路径");
      assets.push([value, path.resolve(file)]);
    } else throw new Error(`未知参数：${flag}`);
  }
  const manifest = await createUpdateManifest({ version, assets, notes });
  await fs.mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(manifest, null, 2) + "\n", {
      flag: "wx",
    });
    await fs.rename(temporary, output);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  console.log(
    `已生成 ${output}；请先将同一批安装包上传到两边 v${version} 发行版，核对后再发布此清单。`,
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
