import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  discoverMacBundles,
  discoverCLIs,
  cliDirectories,
  nativeClaudeVersion,
} from "../electron/core/tool-discovery";
import { ToolRegistry } from "../electron/core/tool-registry";
import {
  compareVersions,
  checkToolUpdate,
  initialUpdate,
} from "../electron/core/tool-updates";
import type { ToolInstall } from "../src/shared/assistant";
function fixtureTool(props: Partial<ToolInstall> = {}): ToolInstall {
  return {
    id: "1",
    productId: "opencode",
    name: "OpenCode",
    version: "1.18.15",
    location: "/fixture",
    sources: [],
    pinned: false,
    lastSeen: 0,
    processKeys: [],
    identityStatus: "installed_confirmed",
    components: [
      {
        id: "host",
        name: "OpenCode",
        version: "1.18.15",
        role: "host",
        runtime: "local",
        adapterStatus: "unknown",
        features: [],
      },
    ],
    ...props,
  };
}
function store() {
  const data = new Map<string, unknown>();
  return {
    assistant<T>(key: string, fallback: T): T {
      return structuredClone((data.get(key) as T) || fallback);
    },
    putAssistant(key: string, value: unknown) {
      data.set(key, structuredClone(value));
    },
  };
}
test("未运行、改名、嵌套及应用链接按 Bundle ID 识别，同一应用只保留一个记录，冲突名称不能冒充", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nl-apps-"));
  try {
    const apps = path.join(home, "Applications");
    await fs.mkdir(apps);
    const specs: [string, string, string][] = [
      ["ChatGPT.app", "com.openai.codex", "26.930.31730"],
      ["Tools/Renamed.app", "ai.opencode.desktop", "1.18.34"],
      ["WisCode.app", "unrelated.publisher", "9.0.0"],
    ];
    const infos = new Map<string, Record<string, unknown>>();
    for (const [relative, id, version] of specs) {
      const p = path.join(apps, relative);
      await fs.mkdir(path.join(p, "Contents/MacOS"), { recursive: true });
      await fs.writeFile(
        path.join(p, "Contents/MacOS", "binary"),
        "not executable",
      );
      infos.set(await fs.realpath(p), {
        CFBundleIdentifier: id,
        CFBundleShortVersionString: version,
        CFBundleExecutable: "binary",
      });
    }
    await fs.symlink(
      path.join(apps, "Tools/Renamed.app"),
      path.join(apps, "OpenCode.app"),
    );
    const result = await discoverMacBundles([apps], async (p) =>
      infos.get(await fs.realpath(p))!,
    );
    assert.equal(result.tools.length, 3);
    assert.equal(
      result.tools.find((t) => t.productId === "codex")?.version,
      "26.930.31730",
    );
    assert.equal(
      result.tools.find((t) => t.productId === "opencode")?.confirmed,
      true,
    );
    assert.equal(
      result.tools.find((t) => t.productId === "wiscode")?.confirmed,
      false,
    );
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
test("NVM 非当前 Node、常见目录与 PATH CLI 独立发现，manifest/bin 不一致不能提升身份", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nl-cli-"));
  try {
    const prefix = path.join(home, ".nvm/versions/node/v20.0.0"),
      pkg = path.join(prefix, "lib/node_modules/opencode-ai"),
      bin = path.join(prefix, "bin");
    await fs.mkdir(bin, { recursive: true });
    await fs.mkdir(path.join(pkg, "bin"), { recursive: true });
    await fs.writeFile(path.join(pkg, "bin/opencode.exe"), "not executed");
    await fs.writeFile(
      path.join(pkg, "package.json"),
      JSON.stringify({
        name: "opencode-ai",
        version: "1.18.15",
        bin: { opencode: "bin/opencode.exe" },
      }),
    );
    await fs.symlink(
      path.join(pkg, "bin/opencode.exe"),
      path.join(bin, "opencode"),
    );
    const dirs = await cliDirectories(home, "");
    assert.ok(dirs.includes(bin));
    assert.ok(dirs.includes(path.join(home, ".local/bin")));
    const found = await discoverCLIs(dirs, home);
    assert.equal(found.length, 1);
    assert.equal(found[0].confirmed, true);
    assert.equal(found[0].version, "1.18.15");
    await fs.writeFile(
      path.join(pkg, "package.json"),
      JSON.stringify({
        name: "opencode-ai",
        version: "99.0.0",
        bin: { opencode: "wrong" },
      }),
    );
    const changed = await discoverCLIs([bin], home);
    assert.equal(changed[0].confirmed, false);
    assert.equal(changed[0].version, undefined);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
test("Claude 原生启动器必须和对应版本文件一致，不能按保留文件名推测当前版本", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nl-native-"));
  try {
    const root = path.join(home, ".local/share/claude/versions"),
      binary = path.join(home, ".local/bin/claude");
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(path.dirname(binary), { recursive: true });
    await fs.writeFile(path.join(root, "2.1.20"), "old version");
    await fs.writeFile(path.join(root, "2.1.30"), "new version");
    await fs.writeFile(binary, "new version");
    assert.equal(await nativeClaudeVersion(binary, home), "2.1.30");
    await fs.writeFile(binary, "custom file");
    assert.equal(await nativeClaudeVersion(binary, home), undefined);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
test("版本数字、预发布和构建信息正确比较；未知版本不宣称最新", () => {
  assert.equal(compareVersions("1.9.0", "1.10.0"), -1);
  assert.equal(compareVersions("v2.0.0-rc.2", "2.0.0-rc.10"), -1);
  assert.equal(compareVersions("2.0.0-rc.2", "2.0.0"), -1);
  assert.equal(compareVersions("1.2.3+build1", "1.2.3+build2"), 0);
  assert.equal(compareVersions("26.930.31730", "26.924.1621"), 1);
  assert.equal(compareVersions("unknown", "1.2.3"), undefined);
  assert.equal(compareVersions("9007199254740993.1", "1.0"), undefined);
});
test("更新区分桌面和 CLI 发布源；只读公开元数据并处理旧、新、未知和失败", async () => {
  let calls = 0;
  const request = async (url: string, init: RequestInit) => {
    calls++;
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
    assert.ok(!url.includes("/fixture"));
    return new Response(
      JSON.stringify({
        tag_name: "v1.18.34",
        prerelease: false,
        draft: false,
        assets: [{ name: "opencode-desktop-mac-arm64.dmg" }],
      }),
    );
  };
  assert.equal(
    (await checkToolUpdate(fixtureTool(), request)).status,
    "available",
  );
  assert.equal(
    (await checkToolUpdate(fixtureTool({ version: "1.18.34" }), request))
      .status,
    "current",
  );
  assert.equal(
    (await checkToolUpdate(fixtureTool({ version: "1.19.0" }), request)).status,
    "installed_newer",
  );
  assert.equal(
    (await checkToolUpdate(fixtureTool({ version: undefined }), request))
      .status,
    "unknown",
  );
  const before = calls;
  assert.equal(
    (
      await checkToolUpdate(
        fixtureTool({ identityStatus: "candidate" }),
        request,
      )
    ).status,
    "unknown",
  );
  assert.equal(calls, before);
  assert.equal(
    initialUpdate(fixtureTool({ productId: "claude-desktop" })).status,
    "manual",
  );
  const cli = fixtureTool({
    components: [{ ...fixtureTool().components[0], role: "cli" }],
  });
  const result = await checkToolUpdate(cli, async (url) => {
    assert.ok(url.startsWith("https://registry.npmjs.org/"));
    return new Response(JSON.stringify({ version: "1.18.34" }));
  });
  assert.equal(result.status, "available");
  const failed = await checkToolUpdate(fixtureTool(), async () => {
    throw new Error("secret /private/path");
  });
  assert.equal(failed.status, "error");
  assert.ok(!failed.message.includes("/private/path"));
  assert.equal(failed.latestVersion, undefined);
});
test("坏格式、桌面资产缺失、预发布和过大元数据不能形成更新结论", async () => {
  for (const body of [
    JSON.stringify({ tag_name: "wat" }),
    JSON.stringify({ tag_name: "1.19.0", assets: [] }),
    JSON.stringify({ tag_name: "1.19.0", prerelease: true }),
    "x".repeat(1024 * 1024 + 1),
  ])
    assert.equal(
      (await checkToolUpdate(fixtureTool(), async () => new Response(body)))
        .status,
      "error",
    );
});
test("更新查询串行于安装扫描、保存不覆盖同时置顶，版本变更清除旧更新判断", async () => {
  let version = "1.0.0",
    release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  const registry = new ToolRegistry(
    store(),
    async () => [],
    async () => ({
      tools: [
        {
          productId: "opencode",
          location: "/fixture",
          version,
          role: "host",
          source: "fixture",
          confirmed: true,
        },
      ],
      limitations: [],
    }),
    async (t) => {
      await wait;
      return {
        status: "available",
        installedVersion: t.version,
        latestVersion: "2.0.0",
        message: "fixture",
      };
    },
  );
  const first = await registry.scan(),
    id = first.installs[0].id;
  const check = registry.checkUpdates();
  assert.equal(registry.current().checkingUpdates, true);
  assert.throws(() => registry.scan(), /等待/);
  registry.pin(id, true);
  release();
  const result = await check;
  assert.equal(result.installs[0].pinned, true);
  assert.equal(result.installs[0].update?.status, "available");
  version = "2.0.0";
  const next = await registry.scan();
  assert.equal(next.installs[0].id, id);
  assert.equal(next.installs[0].update?.status, "not_checked");
});

test("WorkBuddy 只从官方发布标题取得版本，不把脚本内或依赖版本当更新", async () => {
  const tool = fixtureTool({ productId: "workbuddy", version: "5.3.13" });
  const html =
    '<script>version="99.99.99"</script><h2 id="release">5.3.14 版本发布 🚀</h2><h2>5.3.9 版本发布</h2><p>dependency 99.0.0</p>';
  const result = await checkToolUpdate(tool, async (url) => {
    assert.equal(url, "https://www.codebuddy.cn/docs/workbuddy/Changelog");
    return new Response(html);
  });
  assert.equal(result.status, "available");
  assert.equal(result.latestVersion, "5.3.14");
  assert.equal(
    (
      await checkToolUpdate(
        tool,
        async () => new Response('<script>version="99.99.99"</script>'),
      )
    ).status,
    "error",
  );
});

test("扩展更新按真实 ID 和平台过滤稳定版本，忽略预发布和其他平台，未知扩展不联网", async () => {
  const { checkExtensionUpdate } =
    await import("../electron/core/extension-updates");
  const component = {
    ...fixtureTool().components[0],
    role: "extension" as const,
    extensionId: "anthropic.claude-code",
    targetPlatform: "darwin-arm64",
    version: "2.1.278",
  };
  let called = 0;
  const result = await checkExtensionUpdate(component, async (url, init) => {
    called++;
    assert.equal(
      url,
      "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery",
    );
    assert.equal(init.method, "POST");
    assert.equal(init.credentials, "omit");
    const body = JSON.parse(init.body as string);
    assert.equal(body.filters[0].criteria[0].value, "anthropic.claude-code");
    return new Response(
      JSON.stringify({
        results: [
          {
            extensions: [
              {
                publisher: { publisherName: "Anthropic" },
                extensionName: "claude-code",
                versions: [
                  { version: "9.0.0", targetPlatform: "win32-x64" },
                  {
                    version: "2.2.0",
                    targetPlatform: "darwin-arm64",
                    properties: [
                      {
                        key: "Microsoft.VisualStudio.Code.PreRelease",
                        value: "true",
                      },
                    ],
                  },
                  { version: "2.1.289", targetPlatform: "darwin-arm64" },
                ],
              },
            ],
          },
        ],
      }),
    );
  });
  assert.equal(result.status, "available");
  assert.equal(result.latestVersion, "2.1.289");
  const before = called;
  assert.equal(
    (
      await checkExtensionUpdate(
        { ...component, extensionId: "untrusted.agent" },
        async () => {
          called++;
          throw new Error();
        },
      )
    ).status,
    "manual",
  );
  assert.equal(called, before);
  assert.equal(
    (
      await checkExtensionUpdate(
        component,
        async () =>
          new Response(
            JSON.stringify({
              results: [
                {
                  extensions: [
                    {
                      publisher: { publisherName: "other" },
                      extensionName: "claude-code",
                      versions: [{ version: "99.0.0" }],
                    },
                  ],
                },
              ],
            }),
          ),
      )
    ).status,
    "error",
  );
});

test("扩展发行者大小写归一化，保留版本独立展示且未声明启用状态", async () => {
  const { discoverExtensions } = await import("../electron/core/tool-registry");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nl-extensions-"));
  try {
    for (const version of ["2.1.283", "2.1.288"]) {
      const directory = path.join(
        home,
        ".vscode/extensions",
        `anthropic.claude-code-${version}-darwin-arm64`,
      );
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(
        path.join(directory, "package.json"),
        JSON.stringify({
          publisher: "Anthropic",
          name: "claude-code",
          version,
          __metadata: { targetPlatform: "darwin-arm64" },
        }),
      );
    }
    const components = await discoverExtensions("vscode", home);
    assert.equal(components.length, 2);
    assert.deepEqual(
      new Set(components.map((c) => c.version)),
      new Set(["2.1.283", "2.1.288"]),
    );
    assert.ok(
      components.every(
        (c) =>
          c.extensionId === "anthropic.claude-code" &&
          c.targetPlatform === "darwin-arm64",
      ),
    );
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("重复安装共享一次发布查询，来源预算和时间预算有明确上限", async () => {
  const { scopedUpdateFetch } = await import("../electron/core/tool-updates");
  let calls = 0;
  const signal = new AbortController();
  const request = scopedUpdateFetch(
    async () => {
      calls++;
      return new Response("public metadata");
    },
    signal.signal,
    1,
  );
  const [a, b] = await Promise.all([
    request("https://example.test/a", {}),
    request("https://example.test/a", {}),
  ]);
  assert.equal(await a.text(), "public metadata");
  assert.equal(await b.text(), "public metadata");
  assert.equal(calls, 1);
  await assert.rejects(request("https://example.test/b", {}), /来源预算/);
  signal.abort();
  await assert.rejects(request("https://example.test/a", {}), /时间预算/);
});
