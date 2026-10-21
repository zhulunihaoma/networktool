import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  UPDATE_SOURCES,
  UPDATE_SOURCE_IDS,
  compareAppVersions,
  updateAssetURL,
  type AppRelease,
  type AppUpdateState,
  type UpdateAsset,
  type UpdatePreference,
  type UpdateSource,
  type UpdateSourceResult,
} from "../../src/shared/app-update";

const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024;
const assetSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(180)
      .regex(/^[\w ()+.-]+$/)
      .refine(
        (name) =>
          !name.startsWith(".") &&
          /\.(exe|dmg|zip|AppImage|deb|rpm|tar\.gz)$/.test(name),
      ),
    size: z.number().int().positive().max(MAX_PACKAGE_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    urls: z.object({ gitee: z.string(), github: z.string() }).strict(),
  })
  .strict();
const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    release: z
      .object({
        version: z
          .string()
          .regex(/^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/),
        publishedAt: z.string().datetime(),
        notes: z.string().max(16000),
        assets: z
          .record(
            z.string().regex(/^(win32|darwin|linux)-(x64|arm64)$/),
            assetSchema,
          )
          .refine((a) => Object.keys(a).length > 0),
      })
      .strict()
      .nullable(),
  })
  .strict();

export function parseUpdateManifest(raw: unknown) {
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) throw new Error("版本信息格式不正确，请联系发布者。");
  const release = parsed.data.release;
  if (release)
    for (const [platform, asset] of Object.entries(release.assets)) {
      const extensions = platform.startsWith("win32-")
        ? [".exe"]
        : platform.startsWith("darwin-")
          ? [".zip", ".dmg"]
          : [".AppImage", ".deb", ".rpm", ".tar.gz"];
      if (!extensions.some((ext) => asset.name.endsWith(ext)))
        throw new Error("安装包与运行平台不匹配。");
      for (const source of UPDATE_SOURCE_IDS) {
        if (
          asset.urls[source] !==
          updateAssetURL(source, release.version, asset.name)
        )
          throw new Error("安装包地址不属于此版本的官方仓库。");
      }
    }
  return parsed.data;
}

function validRemote(url: string, source: UpdateSource) {
  const parsed = new URL(url);
  const host = parsed.hostname;
  const allowed =
    source === "gitee"
      ? host === "gitee.com" || host === "foruda.gitee.com"
      : host === "github.com" ||
        host === "raw.githubusercontent.com" ||
        host === "release-assets.githubusercontent.com" ||
        host === "objects.githubusercontent.com";
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== "443") ||
    !allowed
  )
    throw new Error("更新地址重定向到了未授权的站点。");
}

interface UpdateOptions {
  version: string;
  platform: string;
  directory: string;
  fetch: typeof fetch;
  preference?: UpdatePreference;
  persistPreference?: (source: UpdatePreference) => void;
  publish?: (state: AppUpdateState) => void;
  reveal?: (file: string) => void;
  openExternal?: (url: string) => Promise<void>;
  timeoutMs?: number;
}

export class AppUpdater {
  private value: AppUpdateState;
  private selected?: AppRelease;
  private downloaded?: { file: string; asset: UpdateAsset };
  private controller?: AbortController;
  private running = false;
  constructor(private options: UpdateOptions) {
    this.value = {
      currentVersion: options.version,
      platform: options.platform,
      preference: options.preference ?? "auto",
      status: "idle",
      sources: [],
      message: "检查新版本，下载后手动安装。",
      received: 0,
      total: 0,
      attempts: [],
    };
  }
  state() {
    return structuredClone(this.value);
  }
  private publish(patch: Partial<AppUpdateState>) {
    Object.assign(this.value, patch);
    this.options.publish?.(this.state());
    return this.state();
  }
  private requireIdle() {
    if (this.running) throw new Error("更新操作正在进行，请先完成或取消。");
  }
  setSource(source: UpdatePreference) {
    this.requireIdle();
    this.options.persistPreference?.(source);
    this.selected = undefined;
    this.downloaded = undefined;
    return this.publish({
      preference: source,
      status: "idle",
      sources: [],
      release: undefined,
      activeSource: undefined,
      checkedAt: undefined,
      received: 0,
      total: 0,
      attempts: [],
      message: "下载源已保存，请重新检查更新。",
    });
  }
  private order(): UpdateSource[] {
    return this.value.preference === "auto"
      ? [...UPDATE_SOURCE_IDS]
      : [this.value.preference];
  }
  private async request(
    url: string,
    source: UpdateSource,
    signal: AbortSignal,
  ): Promise<Response> {
    for (let count = 0; count <= 5; count++) {
      signal.throwIfAborted();
      validRemote(url, source);
      const response = await this.options.fetch(url, {
        signal,
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        headers: {
          Accept: "application/octet-stream, application/json",
          "User-Agent": "Network-Lens-Updater",
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new Error("下载站点没有返回有效跳转地址。");
        url = new URL(location, url).href;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 404)
          throw new Error("尚未找到更新文件（404），发布者可能尚未同步。");
        throw new Error(`更新站点返回 HTTP ${response.status}。`);
      }
      return response;
    }
    throw new Error("更新地址跳转次数过多。");
  }
  private async readManifest(source: UpdateSource, signal: AbortSignal) {
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(),
      this.options.timeoutMs ?? 8000,
    );
    try {
      const response = await this.request(
        UPDATE_SOURCES[source].manifest,
        source,
        AbortSignal.any([signal, timeout.signal]),
      );
      const reader = response.body?.getReader();
      if (!reader) throw new Error("更新站点没有返回版本信息。");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 256 * 1024) throw new Error("版本信息超过大小限制。");
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      let json: unknown;
      try {
        json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new Error("站点返回的不是版本信息，可能需要登录或验证。");
      }
      return parseUpdateManifest(json).release;
    } catch (error) {
      if (timeout.signal.aborted && !signal.aborted)
        throw new Error("连接更新源超时，请重试或切换下载源。");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async check() {
    this.requireIdle();
    this.running = true;
    const controller = (this.controller = new AbortController());
    this.selected = undefined;
    this.downloaded = undefined;
    this.publish({
      status: "checking",
      message: "正在检查版本信息…",
      sources: [],
      release: undefined,
      activeSource: undefined,
      attempts: [],
      received: 0,
      total: 0,
    });
    try {
      const results = await Promise.all(
        this.order().map(async (source) => {
          try {
            const release = await this.readManifest(source, controller.signal);
            const report: UpdateSourceResult = {
              source,
              status: release ? "ok" : "empty",
              version: release?.version,
              message: release
                ? `已获取 v${release.version}`
                : "尚未发布安装包",
            };
            return { release, report };
          } catch (error) {
            return {
              release: null,
              report: {
                source,
                status: "error",
                message:
                  error instanceof Error ? error.message : "无法连接更新源。",
              } as UpdateSourceResult,
            };
          }
        }),
      );
      controller.signal.throwIfAborted();
      const sources = results.map((r) => r.report);
      const releases = results
        .flatMap((r) => (r.release ? [r.release] : []))
        .sort((a, b) => compareAppVersions(b.version, a.version));
      const release = releases[0];
      if (!release)
        return this.publish({
          checkedAt: Date.now(),
          sources,
          status: sources.every((s) => s.status === "error")
            ? "error"
            : "unpublished",
          message: sources.every((s) => s.status === "error")
            ? "未能获取版本信息，请重试或查看发行版页面。"
            : "发布者尚未提供可下载的新版本。",
        });
      const asset = release.assets[this.options.platform];
      // A mirror may lag, but the same version/platform must never name different bytes.
      if (
        asset &&
        releases.some(
          (r) =>
            r.version === release.version &&
            r.assets[this.options.platform] &&
            (r.assets[this.options.platform].sha256 !== asset.sha256 ||
              r.assets[this.options.platform].size !== asset.size ||
              r.assets[this.options.platform].name !== asset.name),
        )
      )
        return this.publish({
          status: "error",
          checkedAt: Date.now(),
          sources,
          message: "两边同一版本的安装包信息不一致，请等待发布者完成同步。",
        });
      this.selected = release;
      const newer =
        compareAppVersions(release.version, this.options.version) > 0;
      return this.publish({
        checkedAt: Date.now(),
        sources,
        release: {
          version: release.version,
          notes: release.notes,
          publishedAt: release.publishedAt,
          fileName: asset?.name,
          size: asset?.size,
        },
        status: !newer ? "current" : asset ? "available" : "unsupported",
        message: !newer
          ? "暂无可用更新。"
          : asset
            ? `发现新版本 v${release.version}。`
            : "新版本尚未提供当前系统和架构的安装包。",
      });
    } catch (error) {
      return this.publish({
        status: controller.signal.aborted ? "cancelled" : "error",
        message: controller.signal.aborted
          ? "已取消检查。"
          : error instanceof Error
            ? error.message
            : "检查更新失败。",
      });
    } finally {
      this.running = false;
      this.controller = undefined;
    }
  }
  cancel() {
    this.controller?.abort();
  }
  async download() {
    this.requireIdle();
    const release = this.selected;
    const asset = release?.assets[this.options.platform];
    if (
      !release ||
      !asset ||
      compareAppVersions(release.version, this.options.version) <= 0
    )
      throw new Error("请先检查并选择可用的新版本。");
    this.running = true;
    this.downloaded = undefined;
    const controller = (this.controller = new AbortController());
    this.publish({
      status: "downloading",
      attempts: [],
      received: 0,
      total: asset.size,
      message: "正在准备下载安装包…",
    });
    let directory: string | undefined;
    try {
      directory = path.join(this.options.directory, randomUUID());
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const file = path.join(directory, asset.name);
      for (const [index, source] of this.order().entries()) {
        controller.signal.throwIfAborted();
        const attempt = new AbortController();
        const signal = AbortSignal.any([controller.signal, attempt.signal]);
        const deadline = setTimeout(() => attempt.abort(), 15 * 60 * 1000);
        let stall: ReturnType<typeof setTimeout> | undefined;
        const tick = () => {
          clearTimeout(stall);
          stall = setTimeout(
            () => attempt.abort(),
            this.options.timeoutMs ?? 15000,
          );
        };
        let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
          this.publish({
            status: "downloading",
            activeSource: source,
            received: 0,
            message: index
              ? `已切换到 ${UPDATE_SOURCES[source].label}，重新下载同一版本。`
              : `正在从 ${UPDATE_SOURCES[source].label} 下载…`,
          });
          tick();
          const response = await this.request(
            asset.urls[source],
            source,
            signal,
          );
          const length = response.headers.get("content-length");
          const type = response.headers.get("content-type") || "";
          if (/text\/html|application\/json/i.test(type)) {
            await response.body?.cancel();
            throw new Error("站点返回了网页或验证提示，无法下载安装包。");
          }
          if (length && Number(length) !== asset.size) {
            await response.body?.cancel();
            throw new Error("安装包大小与发布信息不符。");
          }
          reader = response.body?.getReader();
          if (!reader) throw new Error("安装包内容为空。");
          handle = await fs.open(file + ".part", "wx", 0o600);
          const hash = createHash("sha256");
          let received = 0,
            lastProgress = 0;
          for (;;) {
            const { done, value } = await reader.read();
            signal.throwIfAborted();
            if (done) break;
            tick();
            received += value.byteLength;
            if (received > asset.size) throw new Error("安装包超过声明大小。");
            hash.update(value);
            // FileHandle.write may complete only part of a chunk.
            for (let offset = 0; offset < value.byteLength;) {
              const { bytesWritten } = await handle.write(
                value,
                offset,
                value.byteLength - offset,
              );
              if (!bytesWritten) throw new Error("无法写入下载文件。");
              offset += bytesWritten;
            }
            if (Date.now() - lastProgress > 100) {
              this.publish({ received });
              lastProgress = Date.now();
            }
          }
          this.publish({
            status: "verifying",
            received,
            message: "正在校验安装包完整性…",
          });
          if (received !== asset.size || hash.digest("hex") !== asset.sha256)
            throw new Error("安装包校验失败，文件不完整或内容已改变。");
          signal.throwIfAborted();
          await handle.sync();
          await handle.close();
          handle = undefined;
          await fs.rename(file + ".part", file);
          this.downloaded = { file, asset };
          return this.publish({
            status: "ready",
            received,
            message: "安装包已下载并通过完整性校验，请打开下载位置后手动安装。",
          });
        } catch (error) {
          if (controller.signal.aborted) throw error;
          const message = attempt.signal.aborted
            ? "连接或下载超时。"
            : error instanceof Error
              ? error.message
              : "下载失败。";
          this.publish({
            attempts: [...this.value.attempts, { source, message }],
          });
        } finally {
          clearTimeout(deadline);
          clearTimeout(stall);
          attempt.abort();
          await reader?.cancel().catch(() => {});
          await handle?.close().catch(() => {});
          await fs.rm(file + ".part", { force: true }).catch(() => {});
        }
      }
      return this.publish({
        status: "error",
        message: "安装包下载失败，请重试、切换下载源或查看发行版页面。",
      });
    } catch (error) {
      return this.publish({
        status: controller.signal.aborted ? "cancelled" : "error",
        message: controller.signal.aborted
          ? "已取消下载，未完成的文件已清理。"
          : error instanceof Error
            ? error.message
            : "下载失败。",
      });
    } finally {
      if (!this.downloaded && directory)
        await fs
          .rm(directory, { recursive: true, force: true })
          .catch(() => {});
      this.running = false;
      this.controller = undefined;
    }
  }
  async reveal() {
    this.requireIdle();
    const download = this.downloaded;
    if (!download || this.value.status !== "ready")
      throw new Error("请先完成安装包下载。");
    const stat = await fs.lstat(download.file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size !== download.asset.size
    )
      throw new Error("下载文件已改变，请重新下载。");
    const handle = await fs.open(download.file, "r");
    try {
      const hash = createHash("sha256");
      for await (const chunk of handle.createReadStream({ autoClose: false }))
        hash.update(chunk);
      if (hash.digest("hex") !== download.asset.sha256)
        throw new Error("下载文件已改变，请重新下载。");
    } finally {
      await handle.close();
    }
    this.options.reveal?.(download.file);
  }
  async openReleasePage(source: UpdateSource) {
    await this.options.openExternal?.(
      `${UPDATE_SOURCES[source].repository}/releases`,
    );
  }
}
