import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { AppUpdater, parseUpdateManifest } from "../electron/core/app-update";
import {
  compareAppVersions,
  UPDATE_SOURCES,
  updateAssetURL,
  type AppRelease,
  type AppUpdateState,
  type UpdateSource,
} from "../src/shared/app-update";

const payload = Buffer.from("synthetic-installer-bytes");
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function release(version = "0.4.0", platform = "win32-x64"): AppRelease {
  const name = platform.startsWith("win32")
    ? "Network Lens Setup.exe"
    : "Network Lens.zip";
  return {
    version,
    publishedAt: "2026-10-21T00:00:00.000Z",
    notes: "更新说明 <script>inert</script>",
    assets: {
      [platform]: {
        name,
        size: payload.length,
        sha256: sha(payload),
        urls: {
          gitee: updateAssetURL("gitee", version, name),
          github: updateAssetURL("github", version, name),
        },
      },
    },
  };
}
const manifest = (value: AppRelease | null) =>
  Response.json({ schemaVersion: 1, release: value });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function setup(
  t: { after(fn: () => unknown): void },
  handler: (
    url: string,
    source: UpdateSource,
    signal: AbortSignal,
  ) => Promise<Response> | Response,
  extra: Partial<ConstructorParameters<typeof AppUpdater>[0]> = {},
) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "networktool-update-test-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls: string[] = [],
    states: AppUpdateState[] = [],
    reveals: string[] = [];
  const updater = new AppUpdater({
    version: "0.3.0",
    platform: "win32-x64",
    directory,
    publish: (state) => states.push(state),
    reveal: (file) => reveals.push(file),
    fetch: async (input, init) => {
      const url = String(input);
      calls.push(url);
      const source = url.includes("gitee.com") ? "gitee" : "github";
      return handler(url, source, init?.signal as AbortSignal);
    },
    ...extra,
  });
  return { updater, directory, calls, states, reveals };
}
function pendingUntilAbort(signal: AbortSignal): Promise<Response> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
  });
}

test("stable and prerelease version comparison is numeric and never treats build metadata as an upgrade", () => {
  assert.ok(compareAppVersions("0.10.0", "0.9.9") > 0);
  assert.ok(compareAppVersions("1.0.0", "1.0.0-beta.9") > 0);
  assert.ok(compareAppVersions("1.0.0-beta.10", "1.0.0-beta.2") > 0);
  assert.ok(compareAppVersions("1.0.0-beta", "1.0.0-beta.1") < 0);
  assert.equal(compareAppVersions("v1.0.0+local", "1.0.0"), 0);
  assert.throws(() => compareAppVersions("main", "1.0.0"));
});

test("manifest rejects arbitrary download URLs, platform substitution, traversal and nonstable releases", () => {
  const good = { schemaVersion: 1, release: release() };
  assert.deepEqual(parseUpdateManifest(good), good);
  for (const change of [
    (r: AppRelease) => {
      r.assets["win32-x64"].urls.github = "https://evil.invalid/app.exe";
    },
    (r: AppRelease) => {
      r.assets["win32-x64"].urls.gitee = updateAssetURL(
        "gitee",
        "0.5.0",
        r.assets["win32-x64"].name,
      );
    },
    (r: AppRelease) => {
      r.assets["win32-x64"].name = "../app.exe";
    },
    (r: AppRelease) => {
      r.assets["win32-x64"].name = "app.zip";
    },
    (r: AppRelease) => {
      r.version = "0.4.0-beta";
    },
    (r: AppRelease) => {
      r.assets["win32-x64"].size = 0;
    },
  ]) {
    const r = release();
    change(r);
    assert.throws(() => parseUpdateManifest({ schemaVersion: 1, release: r }));
  }
});

test("automatic check compares both mirrors and download falls back without changing bytes or version", async (t) => {
  const latest = release("0.10.0");
  const { updater, calls, states, reveals } = await setup(t, (url, source) => {
    if (url === UPDATE_SOURCES[source].manifest)
      return manifest(release(source === "gitee" ? "0.9.0" : "0.10.0"));
    return source === "gitee"
      ? new Response("unavailable", { status: 503 })
      : new Response(payload);
  });
  assert.equal((await updater.check()).release?.version, latest.version);
  assert.equal(calls.length, 2); // Checking alone never downloads.
  const done = await updater.download();
  assert.equal(done.status, "ready");
  assert.equal(done.activeSource, "github");
  assert.equal(done.attempts.length, 1);
  assert.equal(calls[2], latest.assets["win32-x64"].urls.gitee);
  assert.equal(calls[3], latest.assets["win32-x64"].urls.github);
  assert.ok(states.some((s) => s.status === "verifying"));
  await updater.reveal();
  assert.deepEqual(await fs.readFile(reveals[0]), payload);
  await fs.writeFile(reveals[0], Buffer.alloc(payload.length, 1));
  await assert.rejects(updater.reveal(), /已改变/);
  assert.equal(reveals.length, 1);
});

test("invalid or unavailable metadata falls back, while all failures never report current", async (t) => {
  const { updater } = await setup(t, (_url, source) =>
    source === "gitee" ? new Response("login html") : manifest(release()),
  );
  let result = await updater.check();
  assert.equal(result.status, "available");
  assert.equal(result.sources[0].status, "error");
  updater.setSource("gitee");
  result = await updater.check();
  assert.equal(result.status, "error");
  assert.equal(result.release, undefined);
  await assert.rejects(updater.download(), /先检查/);
});

test("unpublished, current, local newer and unsupported architectures remain distinct", async (t) => {
  for (const [value, expected] of [
    [null, "unpublished"],
    [release("0.3.0"), "current"],
    [release("0.2.0"), "current"],
    [release("0.4.0", "darwin-arm64"), "unsupported"],
  ] as const) {
    const { updater } = await setup(t, () => manifest(value));
    assert.equal((await updater.check()).status, expected);
    await assert.rejects(updater.download());
  }
});

test("same-version mirror conflicts block a download instead of accepting an arbitrary mirror", async (t) => {
  const { updater } = await setup(t, (_url, source) => {
    const r = release();
    if (source === "github") r.assets["win32-x64"].sha256 = "a".repeat(64);
    return manifest(r);
  });
  assert.equal((await updater.check()).status, "error");
  assert.match(updater.state().message, /不一致/);
  await assert.rejects(updater.download());
});

test("explicit source persists and never silently switches to another source", async (t) => {
  const saved: string[] = [];
  const { updater, calls } = await setup(
    t,
    (url, source) =>
      url === UPDATE_SOURCES[source].manifest
        ? manifest(release())
        : new Response("missing", { status: 404 }),
    { persistPreference: (source) => saved.push(source) },
  );
  updater.setSource("github");
  assert.equal((await updater.check()).status, "available");
  assert.equal((await updater.download()).status, "error");
  assert.deepEqual(saved, ["github"]);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((url) => url.includes("github")));
});

test("a failed preference write leaves the current preference untouched", async (t) => {
  const { updater } = await setup(t, () => manifest(null), {
    persistPreference: () => {
      throw new Error("disk full");
    },
  });
  assert.throws(() => updater.setSource("github"), /disk full/);
  assert.equal(updater.state().preference, "auto");
});

test("corrupted bytes, wrong lengths and HTML downloads all trigger an independently verified retry", async (t) => {
  for (const failure of [
    new Response(Buffer.alloc(payload.length, 42)),
    new Response("short"),
    new Response("login", { headers: { "content-type": "text/html" } }),
    new Response("", { headers: { "content-length": "999" } }),
  ]) {
    const { updater, reveals } = await setup(t, (url, source) =>
      url === UPDATE_SOURCES[source].manifest
        ? manifest(release())
        : source === "gitee"
          ? failure
          : new Response(payload),
    );
    await updater.check();
    assert.equal((await updater.download()).status, "ready");
    assert.equal(updater.state().attempts.length, 1);
    await updater.reveal();
    assert.deepEqual(await fs.readFile(reveals[0]), payload);
  }
});

test("incomplete response bodies restart on the other mirror and leave no partial file", async (t) => {
  const { updater, directory } = await setup(t, (url, source) => {
    if (url === UPDATE_SOURCES[source].manifest) return manifest(release());
    if (source === "github") return new Response(payload);
    let count = 0;
    return new Response(
      new ReadableStream({
        pull(c) {
          if (count++ === 0) c.enqueue(payload.subarray(0, 5));
          else c.error(new Error("connection reset"));
        },
      }),
    );
  });
  await updater.check();
  assert.equal((await updater.download()).status, "ready");
  const dirs = await fs.readdir(directory);
  assert.equal(dirs.length, 1);
  assert.deepEqual(await fs.readdir(path.join(directory, dirs[0])), [
    release().assets["win32-x64"].name,
  ]);
});

test("unsafe redirects are blocked before contacting the destination", async (t) => {
  for (const location of [
    "http://gitee.com/file.exe",
    "https://evil.invalid/file.exe",
    "https://github.com@evil.invalid/file.exe",
    "https://github.com:444/file.exe",
  ]) {
    const { updater, calls } = await setup(
      t,
      (url, source) =>
        url === UPDATE_SOURCES[source].manifest
          ? manifest(release())
          : new Response(null, { status: 302, headers: { location } }),
      { preference: "gitee" },
    );
    await updater.check();
    assert.equal((await updater.download()).status, "error");
    assert.equal(calls.length, 2);
  }
});

test("approved asset redirects work and loops are bounded", async (t) => {
  const { updater } = await setup(
    t,
    (url, source) => {
      if (url === UPDATE_SOURCES[source].manifest) return manifest(release());
      if (url.startsWith("https://foruda.gitee.com/"))
        return new Response(payload);
      return new Response(null, {
        status: 302,
        headers: {
          location: "https://foruda.gitee.com/fixture.exe?signature=test",
        },
      });
    },
    { preference: "gitee" },
  );
  await updater.check();
  assert.equal((await updater.download()).status, "ready");
  const looping = await setup(
    t,
    (url, source) =>
      url === UPDATE_SOURCES[source].manifest
        ? manifest(release())
        : new Response(null, { status: 302, headers: { location: url } }),
    { preference: "gitee" },
  );
  await looping.updater.check();
  assert.equal((await looping.updater.download()).status, "error");
  assert.ok(looping.calls.length <= 7);
});

test("check timeout permits another source and manual cancellation never starts a fallback", async (t) => {
  const { updater } = await setup(
    t,
    (_url, source, signal) =>
      source === "gitee" ? pendingUntilAbort(signal) : manifest(release()),
    { timeoutMs: 15 },
  );
  assert.equal((await updater.check()).status, "available");
  assert.match(updater.state().sources[0].message, /超时/);
  const begun = deferred();
  const cancelled = await setup(t, (url, source, signal) => {
    if (url === UPDATE_SOURCES[source].manifest) return manifest(release());
    begun.resolve();
    return pendingUntilAbort(signal);
  });
  await cancelled.updater.check();
  const downloading = cancelled.updater.download();
  await begun.promise;
  await assert.rejects(cancelled.updater.check(), /正在进行/);
  assert.throws(() => cancelled.updater.setSource("github"), /正在进行/);
  cancelled.updater.cancel();
  assert.equal((await downloading).status, "cancelled");
  assert.equal(cancelled.calls.length, 3);
  assert.deepEqual(await fs.readdir(cancelled.directory), []);
});

test("metadata cancellation and oversized metadata are explicit failures", async (t) => {
  const begun = deferred();
  const { updater } = await setup(t, (_url, _source, signal) => {
    begun.resolve();
    return pendingUntilAbort(signal);
  });
  const checking = updater.check();
  await begun.promise;
  updater.cancel();
  assert.equal((await checking).status, "cancelled");
  const oversized = await setup(
    t,
    () => new Response(" ".repeat(256 * 1024 + 1)),
  );
  assert.equal((await oversized.updater.check()).status, "error");
});

test("release manifest generator hashes actual bytes and emits consumable fixed-version mirrors", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "networktool-manifest-test-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "Network Lens.exe"),
    output = path.join(directory, "stable.json");
  await fs.writeFile(file, payload);
  execFileSync(process.execPath, [
    "scripts/create-update-manifest.mjs",
    "--version",
    "0.4.0",
    "--asset",
    "win32-x64",
    file,
    "--output",
    output,
  ]);
  const generated = parseUpdateManifest(
    JSON.parse(await fs.readFile(output, "utf8")),
  );
  assert.equal(generated.release?.assets["win32-x64"].sha256, sha(payload));
  assert.equal(generated.release?.assets["win32-x64"].size, payload.length);
  assert.ok(
    generated.release?.assets["win32-x64"].urls.github.includes(
      "v0.4.0/Network%20Lens.exe",
    ),
  );
});
