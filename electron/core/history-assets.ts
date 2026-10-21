/** Extract explicit native attachment records, never prose paths or remote URLs. */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import type { JsonObserver, JsonPath } from "./history-json";
import type { HistoryRecord } from "../../src/shared/history";
import { fileChunks, walk, exists } from "./history-io";
interface Value {
  sample: string;
  length: number;
  file?: string;
}
interface Node {
  fields: Record<string, Value>;
  path: JsonPath;
  captured?: boolean;
}
interface Candidate {
  origin: string;
  name?: string;
  mime?: string;
  file?: string;
  root?: string;
  encoded?: string;
  encoding?: "uri" | "base64";
  digest?: string;
  artifact?: { key: string; session: string };
  reason?: string;
}
export interface ArchivedAsset {
  origin: string;
  name: string;
  mime: string;
  status: "present" | "unavailable";
  bytes?: number;
  sha256?: string;
  path?: string;
  reason?: string;
}
const fields = new Set([
  "type",
  "mime",
  "mimeType",
  "media_type",
  "mediaType",
  "name",
  "filename",
  "original_filename",
  "blob_path",
  "path",
  "attachmentId",
  "url",
  "uri",
  "image_url",
  "data",
  "dataUrl",
  "data_url",
  "backupFileName",
  "originalUrl",
  "artifactUri",
]);
const key = (p: JsonPath) => JSON.stringify(p);
export class HistoryAssets implements JsonObserver {
  private nodes = new Map<string, Node>();
  private values = new Map<string, Value>();
  private queue: { file: string; text: string }[] = [];
  private candidates: Candidate[] = [];
  private origin = "";
  private record = 0;
  private temporaries = new Set<string>();
  constructor(
    private folder: string,
    private task: HistoryRecord,
    private home: string,
  ) {}
  checkpoint() {
    return this.candidates;
  }
  restore(value: unknown) {
    if (Array.isArray(value)) this.candidates = value as Candidate[];
  }
  private storeRoot(kind: "zcode" | "workbuddy" | "dsh") {
    if (this.task.locator.engine === kind) {
      if (kind === "zcode" && this.task.locator.database)
        return path.resolve(path.dirname(this.task.locator.database), "../..");
      if (kind === "workbuddy" && this.task.locator.database)
        return path.dirname(this.task.locator.database);
      if (kind === "dsh" && this.task.locator.files?.[0])
        return this.task.locator.files[0].root;
    }
    return path.join(this.home, `.${kind}`);
  }
  private mark(p: JsonPath) {
    for (let n = p.length; n >= 0; n--) {
      const node = this.nodes.get(key(p.slice(0, n)));
      if (node) node.captured = true;
    }
  }
  private mediaPosition(p: JsonPath) {
    return (
      !p.length ||
      (typeof p.at(-1) === "number" &&
        ["content", "parts", "images"].includes(String(p.at(-2))))
    );
  }
  input(origin: string) {
    this.origin = origin;
    this.record = 0;
  }
  object(p: JsonPath, end: boolean) {
    if (!end) {
      this.nodes.set(key(p), { fields: {}, path: p });
      return;
    }
    const node = this.nodes.get(key(p));
    if (node) this.inspect(node);
    this.nodes.delete(key(p));
    if (!p.length) this.record++;
  }
  stringStart(p: JsonPath) {
    const field = String(p.at(-1));
    if (
      !fields.has(field) &&
      !(typeof p.at(-1) === "number" && p.includes("images"))
    )
      return false;
    const value: Value = { sample: "", length: 0 };
    if (
      [
        "url",
        "uri",
        "image_url",
        "data",
        "dataUrl",
        "data_url",
        "originalUrl",
        "artifactUri",
      ].includes(field) ||
      typeof p.at(-1) === "number"
    ) {
      value.file = path.join(this.folder, "strings", `${randomUUID()}.txt`);
      this.temporaries.add(value.file);
    }
    this.values.set(key(p), value);
    return true;
  }
  stringChunk(p: JsonPath, text: string, end: boolean) {
    const v = this.values.get(key(p));
    if (!v) return;
    v.sample +=
      v.sample.length < 4096 ? text.slice(0, 4096 - v.sample.length) : "";
    v.length += text.length;
    if (v.file) this.queue.push({ file: v.file, text });
    if (end) {
      const node = this.nodes.get(key(p.slice(0, -1)));
      if (node) node.fields[String(p.at(-1))] = v;
      if (typeof p.at(-1) === "number" && p.includes("images")) {
        if (v.sample.startsWith("data:"))
          this.candidates.push({
            origin: `${this.origin}#${this.record}:${key(p)}`,
            encoded: v.file,
            encoding: "uri",
          });
        else if (v.sample)
          this.candidates.push({
            origin: `${this.origin}#${this.record}:${key(p)}`,
            reason: "来源仅保留图片引用，历史原件尚不可取得。",
          });
      }
      this.values.delete(key(p));
    }
  }
  private inspect(node: Node) {
    const f = node.fields,
      s = (k: string) => f[k]?.sample || "",
      type = s("type"),
      origin = `${this.origin}#${this.record}:${key(node.path)}`;
    if (node.path.at(-1) === "metadata" && (f.artifactUri || f.originalUrl)) {
      const parent = this.nodes.get(key(node.path.slice(0, -1)));
      if (parent) parent.fields.nativeUrl = f.artifactUri || f.originalUrl;
    }
    // MCP image content stores Base64 directly on the image node.
    if (
      type === "image" &&
      f.data?.file &&
      s("mimeType").startsWith("image/") &&
      this.mediaPosition(node.path)
    ) {
      this.mark(node.path);
      this.candidates.push({
        origin,
        encoded: f.data.file,
        encoding: "base64",
        mime: s("mimeType"),
        name: s("filename"),
      });
      return;
    }
    if (
      type === "base64" &&
      f.data?.file &&
      ((node.path.at(-1) === "source" &&
        this.mediaPosition(node.path.slice(0, -1))) ||
        this.mediaPosition(node.path))
    ) {
      this.mark(node.path);
      this.candidates.push({
        origin,
        encoded: f.data.file,
        encoding: "base64",
        mime: s("media_type") || s("mime"),
        name: s("filename"),
      });
      return;
    }
    if (type === "image_blob_ref" && this.mediaPosition(node.path)) {
      const root = this.storeRoot("workbuddy");
      this.mark(node.path);
      this.candidates.push({
        origin,
        file: path.isAbsolute(s("blob_path"))
          ? s("blob_path")
          : path.join(root, s("blob_path")),
        root,
        name: s("original_filename"),
        mime: s("mime"),
      });
      return;
    }
    if (/^sha256:[a-f0-9]{64}$/i.test(s("attachmentId"))) {
      const digest = s("attachmentId").slice(7).toLowerCase(),
        root = path.join(this.storeRoot("dsh"), "attachments/v1/objects");
      this.mark(node.path);
      this.candidates.push({
        origin,
        file: path.join(root, digest.slice(0, 2), digest),
        root,
        digest,
        mime: s("mediaType"),
        name: s("name"),
      });
      return;
    }
    if (f.backupFileName) {
      const filename = s("backupFileName"),
        rootRef = this.task.locator.files?.find((f) =>
          f.root.endsWith(`${path.sep}projects`),
        ),
        root =
          this.task.locator.engine === "workbuddy"
            ? path.join(this.storeRoot("workbuddy"), "file-history")
            : rootRef
              ? path.join(path.dirname(rootRef.root), "file-history")
              : path.join(this.home, ".claude/file-history");
      if (path.basename(filename) === filename) {
        const id = rootRef
          ? path.basename(rootRef.path, ".jsonl")
          : this.task.nativeId;
        this.mark(node.path);
        this.candidates.push({
          origin,
          file: path.join(root, id, filename),
          root,
          name: filename,
        });
      } else this.candidates.push({ origin, reason: "历史文件备份名称无效。" });
      return;
    }
    const url =
      f.nativeUrl || f.uri || f.url || f.image_url || f.dataUrl || f.data_url;
    if (
      url &&
      this.mediaPosition(node.path) &&
      (/^(?:image|file|document|input_image|localImage)$/.test(type) ||
        f.dataUrl ||
        f.data_url)
    ) {
      if (url.sample.startsWith("data:")) {
        this.candidates.push({
          origin,
          encoded: url.file,
          encoding: "uri",
          mime: s("mime"),
          name: s("filename") || s("name"),
        });
        return;
      }
      if (url.sample.startsWith("zcode-artifact:")) {
        try {
          const u = new URL(url.sample),
            artifact = {
              key: decodeURIComponent(u.pathname.slice(1)),
              session: u.hostname,
            };
          this.candidates.push({
            origin,
            artifact,
            name: s("filename") || s("name"),
            mime: s("mime"),
          });
        } catch {
          this.candidates.push({ origin, reason: "来源 artifact 引用损坏。" });
        }
        return;
      }
      let local = "";
      try {
        local = url.sample.startsWith("file:")
          ? fileURLToPath(url.sample)
          : path.isAbsolute(url.sample)
            ? url.sample
            : "";
      } catch {}
      const roots = [
        path.join(this.storeRoot("zcode"), "tmp/paste-attachments"),
        path.join(this.storeRoot("zcode"), "cli/artifacts"),
      ];
      const root =
        local &&
        roots.find((r) => {
          const rel = path.relative(r, local);
          return (
            rel !== ".." &&
            !rel.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(rel)
          );
        });
      if (root) {
        this.candidates.push({
          origin,
          file: local,
          root,
          name: s("filename") || s("name"),
          mime: s("mime"),
        });
        return;
      }
      this.candidates.push({
        origin,
        name: s("filename") || s("name"),
        mime: s("mime"),
        reason:
          "仅有外部地址或当前文件路径，无法证明历史附件原件；未自动访问远程地址。",
      });
      return;
    }
    if (type === "localImage" && f.path && this.mediaPosition(node.path)) {
      this.candidates.push({
        origin,
        reason: "来源仅保留本机图片路径，需补充并核对历史原件。",
      });
      return;
    }
    if (
      ["image", "file", "document", "input_image"].includes(type) &&
      this.mediaPosition(node.path) &&
      !url &&
      !node.captured
    )
      this.candidates.push({
        origin,
        reason: "附件记录存在，但当前格式未提供可核验的原件定位。",
      });
  }
  async flush() {
    const queued = this.queue.splice(0);
    if (!queued.length) return;
    await fs.mkdir(path.join(this.folder, "strings"), {
      recursive: true,
      mode: 0o700,
    });
    for (const item of queued)
      await fs.appendFile(item.file, item.text, { mode: 0o600 });
  }
  private async *decoded(file: string, encoding: "uri" | "base64") {
    let header = "",
      ready = encoding === "base64",
      base64 = encoding === "base64",
      pending = "",
      percent = "";
    for await (const b of fileChunks(file, path.dirname(file))) {
      let text = b.toString("utf8");
      if (!ready) {
        header += text;
        const comma = header.indexOf(",");
        if (comma < 0) {
          if (header.length > 4096) throw new Error("附件数据 URI 头部无效。");
          continue;
        }
        const h = header.slice(0, comma);
        if (!/^data:[^,]*$/i.test(h)) throw new Error("附件数据 URI 无效。");
        base64 = /;base64$/i.test(h);
        text = header.slice(comma + 1);
        header = "";
        ready = true;
      }
      if (base64) {
        pending += text.replace(/[\r\n\t ]/g, "");
        if (!/^[A-Za-z0-9+/=]*$/.test(pending))
          throw new Error("附件 Base64 损坏。");
        const length = Math.max(0, Math.floor(pending.length / 4) * 4 - 4);
        if (length) {
          const chunk = pending.slice(0, length);
          if (chunk.includes("=")) throw new Error("附件 Base64 提前结束。");
          yield Buffer.from(chunk, "base64");
          pending = pending.slice(length);
        }
      } else {
        text = percent + text;
        percent = "";
        const out: number[] = [];
        for (let i = 0; i < text.length;) {
          if (text[i] === "%") {
            if (i + 2 >= text.length) {
              percent = text.slice(i);
              break;
            }
            if (!/^[a-f0-9]{2}$/i.test(text.slice(i + 1, i + 3)))
              throw new Error("附件 URL 编码损坏。");
            out.push(parseInt(text.slice(i + 1, i + 3), 16));
            i += 3;
          } else {
            const cp = text.codePointAt(i)!;
            out.push(...Buffer.from(String.fromCodePoint(cp)));
            i += cp > 65535 ? 2 : 1;
          }
        }
        if (out.length) yield Buffer.from(out);
      }
    }
    if (!ready || percent) throw new Error("附件编码不完整。");
    if (base64 && pending) {
      if (pending.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(pending))
        throw new Error("附件 Base64 尾部损坏。");
      const b = Buffer.from(pending, "base64");
      if (b.toString("base64") !== pending)
        throw new Error("附件 Base64 校验失败。");
      yield b;
    }
  }
  async finish(signal?: AbortSignal): Promise<ArchivedAsset[]> {
    await this.flush();
    const results: ArchivedAsset[] = [];
    await fs.mkdir(path.join(this.folder, "attachments"), {
      recursive: true,
      mode: 0o700,
    });
    for (const c of this.candidates) {
      signal?.throwIfAborted();
      const entry: ArchivedAsset = {
        origin: c.origin,
        name: c.name || "attachment",
        mime: c.mime || "application/octet-stream",
        status: "unavailable",
      };
      let temporary: string | undefined;
      try {
        if (c.reason) throw new Error(c.reason);
        if (c.artifact) {
          const a = c.artifact;
          if (
            path.basename(a.key) !== a.key ||
            a.key === "." ||
            a.key === ".." ||
            !a.key ||
            !a.session
          )
            throw new Error("artifact 引用无效。");
          const root = path.join(this.storeRoot("zcode"), "cli/artifacts"),
            matches: string[] = [];
          for await (const f of walk(root))
            if (
              path.basename(f) === a.key ||
              path.basename(f).includes(`-${a.key}`) ||
              path.basename(f).startsWith(`${a.key}-`)
            ) {
              matches.push(f);
              if (matches.length > 1) break;
            }
          if (matches.length !== 1)
            throw new Error(
              matches.length
                ? "artifact 对应多个对象，需核对原件。"
                : "artifact 原件已移除或未下载。",
            );
          c.file = matches[0];
          c.root = root;
        }
        if (!c.encoded && (!c.file || !c.root))
          throw new Error("附件缺少已验证的来源定位。");
        temporary = path.join(
          this.folder,
          "attachments",
          `${randomUUID()}.partial`,
        );
        const out = await fs.open(temporary, "wx", 0o600),
          digest = createHash("sha256");
        let bytes = 0;
        try {
          const chunks = c.encoded
            ? this.decoded(c.encoded, c.encoding!)
            : fileChunks(c.file!, c.root!);
          for await (const b of chunks) {
            signal?.throwIfAborted();
            let offset = 0;
            while (offset < b.length) {
              const r = await out.write(b, offset, b.length - offset);
              if (!r.bytesWritten) throw new Error("附件落盘不完整。");
              offset += r.bytesWritten;
            }
            digest.update(b);
            bytes += b.length;
          }
        } finally {
          await out.close();
        }
        const sha = digest.digest("hex");
        if (c.digest && sha !== c.digest)
          throw new Error("附件内容哈希与来源引用不一致。");
        const relative = `attachments/${sha}.bin`,
          dest = path.join(this.folder, relative);
        if (await exists(dest)) await fs.rm(temporary);
        else await fs.rename(temporary, dest);
        temporary = undefined;
        Object.assign(entry, {
          status: "present",
          bytes,
          sha256: sha,
          path: relative,
        });
      } catch (e) {
        if (signal?.aborted) throw e;
        entry.reason = e instanceof Error ? e.message : "附件不可读取";
        if (temporary) await fs.rm(temporary, { force: true });
      }
      results.push(entry);
    }
    await fs.rm(path.join(this.folder, "strings"), {
      recursive: true,
      force: true,
    });
    return results;
  }
}
