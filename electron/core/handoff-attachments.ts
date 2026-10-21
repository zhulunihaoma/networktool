/** Source-specific inert attachment extraction. Never fetch URLs or infer attachments from prose/tool output. */
import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { sanitizer, type HandoffImport } from "../../src/shared/handoff";
import type {
  HandoffAttachment,
  HandoffAttachmentScan,
  HandoffAttachmentSelection,
  HandoffPackageSummary,
} from "../../src/shared/handoff-attachments";

type Obj = Record<string, unknown>;
const obj = (v: unknown): v is Obj =>
  !!v && typeof v === "object" && !Array.isArray(v);
const mimeType = (value: string | undefined) =>
  value && /^[a-z0-9!#$&^_.+-]{1,80}\/[a-z0-9!#$&^_.+-]{1,80}$/i.test(value)
    ? value.toLowerCase()
    : "application/octet-stream";
const str = (v: unknown) => (typeof v === "string" ? v : "");
export interface AttachmentCandidate {
  name?: string;
  mime?: string;
  messageId: string;
  origin?: HandoffAttachment["origin"];
  data?: string;
  base64?: boolean;
  file?: string;
  root?: string;
  imageOnly?: boolean;
  artifact?: { root: string; key: string; session: string };
  digest?: string;
  note?: string;
  unsupported?: boolean;
}
const registry = new WeakMap<
  HandoffImport,
  { candidates: AttachmentCandidate[]; complete: boolean }
>();
export function bindAttachments<T extends HandoffImport>(
  data: T,
  candidates: AttachmentCandidate[],
  complete = true,
): T {
  registry.set(data, { candidates, complete });
  return data;
}
export function transferAttachments<T extends HandoffImport>(
  from: HandoffImport,
  to: T,
): T {
  const value = registry.get(from);
  if (value) registry.set(to, value);
  return to;
}
export const ATTACHMENT_LIMITS = {
  file: 16 * 1024 * 1024,
  total: 64 * 1024 * 1024,
  count: 128,
} as const;
const safeName = (s: string) =>
  sanitizer()
    .clean(path.basename(s.replace(/\\/g, "/")))
    .replace(/[\x00-\x1f\x7f/:*?"<>|]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 150) || "attachment";
function imageMime(b: Buffer): string | undefined {
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a$/.test(b.subarray(0, 6).toString())) return "image/gif";
  if (
    b.subarray(0, 4).toString() === "RIFF" &&
    b.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  if (b.subarray(0, 2).toString() === "BM") return "image/bmp";
  return undefined;
}
function decode(data: string, base64: boolean, mime?: string) {
  let value = data;
  if (data.startsWith("data:")) {
    const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(data);
    if (!match) throw new Error("附件编码不受支持。");
    mime = match[1] || mime;
    base64 = !!match[2];
    value = match[3];
  }
  if (value.length > ATTACHMENT_LIMITS.file * 4 + 100)
    throw new Error("单个附件超过 16 MB。");
  let bytes: Buffer;
  if (base64) {
    if (
      !value ||
      value.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
    )
      throw new Error("附件 Base64 数据损坏。");
    bytes = Buffer.from(value, "base64");
    if (bytes.toString("base64") !== value)
      throw new Error("附件 Base64 校验失败。");
  } else {
    const out: number[] = [];
    for (let i = 0; i < value.length;) {
      if (value[i] === "%") {
        if (!/^[\da-f]{2}$/i.test(value.slice(i + 1, i + 3)))
          throw new Error("附件 URL 编码损坏。");
        out.push(parseInt(value.slice(i + 1, i + 3), 16));
        i += 3;
      } else {
        const point = value.codePointAt(i)!;
        out.push(...Buffer.from(String.fromCodePoint(point)));
        i += point > 65535 ? 2 : 1;
      }
    }
    bytes = Buffer.from(out);
  }
  if (bytes.length > ATTACHMENT_LIMITS.file)
    throw new Error("单个附件超过 16 MB。");
  return {
    bytes,
    mime: imageMime(bytes) || mimeType(mime),
  };
}
async function readFile(file: string, root?: string) {
  if (!path.isAbsolute(file)) throw new Error("附件不是绝对路径。");
  if (root) {
    const relative = path.relative(
      await fs.realpath(root),
      await fs.realpath(file),
    );
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new Error("附件路径超出来源存储目录。");
  }
  const handle = await fs.open(
    file,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW || 0) |
      (constants.O_NONBLOCK || 0),
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > ATTACHMENT_LIMITS.file
    )
      throw new Error("附件不是普通文件或超过 16 MB。");
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (
      length !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.size !== stat.size
    )
      throw new Error("附件读取时发生变化，请重新扫描。");
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}
async function artifactFile(a: NonNullable<AttachmentCandidate["artifact"]>) {
  if (
    !/^[A-Za-z0-9_-]{1,120}$/.test(a.session) ||
    !/^[A-Za-z0-9_.-]{1,180}$/.test(a.key)
  )
    throw new Error("artifact 引用无效。");
  // ZCode can retain an artifact in a producer session used by the current chat.
  const candidates: string[] = [];
  let budget = 0;
  for (const folder of await fs.readdir(a.root, { withFileTypes: true })) {
    if (++budget > 5000) throw new Error("artifact 扫描超过预算。");
    if (!folder.isDirectory() || folder.isSymbolicLink()) continue;
    for (const entry of await fs.readdir(path.join(a.root, folder.name), {
      withFileTypes: true,
    })) {
      if (++budget > 5000) throw new Error("artifact 扫描超过预算。");
      if (
        entry.isFile() &&
        !entry.isSymbolicLink() &&
        (entry.name === a.key ||
          entry.name.includes(`-${a.key}`) ||
          entry.name.startsWith(`${a.key}-`))
      )
        candidates.push(path.join(a.root, folder.name, entry.name));
    }
  }
  if (candidates.length !== 1)
    throw new Error(
      candidates.length
        ? "artifact 对应多个对象，需手动补充。"
        : "附件对象已移除，需手动补充。",
    );
  return readFile(candidates[0], a.root);
}
export class AttachmentSet {
  private candidates: AttachmentCandidate[];
  private complete: boolean;
  private scan?: HandoffAttachmentScan;
  private payloads = new Map<string, Buffer>();
  constructor(data: HandoffImport) {
    const known = registry.get(data);
    this.candidates = known?.candidates || [];
    this.complete = !!known?.complete;
  }
  addFiles(files: string[]) {
    if (files.length + this.candidates.length > ATTACHMENT_LIMITS.count)
      throw new Error("最多处理 128 条附件记录。");
    this.candidates.push(
      ...files.map((file) => ({
        file,
        name: path.basename(file),
        messageId: "手动补充",
        origin: "manual" as const,
        note: "用户补充的当前本地文件；不是历史快照。",
      })),
    );
  }
  async inspect(): Promise<HandoffAttachmentScan> {
    this.payloads.clear();
    this.scan = undefined;
    const entries: HandoffAttachment[] = [],
      warnings: string[] = [];
    let total = 0;
    const complete =
      this.complete && this.candidates.length <= ATTACHMENT_LIMITS.count;
    if (!this.complete)
      warnings.push("来源附件结构未能全部确认，不能视为没有附件。");
    if (this.candidates.length > ATTACHMENT_LIMITS.count)
      warnings.push(
        `共有 ${this.candidates.length} 条附件记录，超过 128 条扫描上限；另有 ${this.candidates.length - ATTACHMENT_LIMITS.count} 条未扫描。`,
      );
    for (const c of this.candidates.slice(0, ATTACHMENT_LIMITS.count)) {
      const item: HandoffAttachment = {
        id: randomUUID(),
        name: safeName(
          c.name || (c.file ? path.basename(c.file) : "attachment"),
        ),
        mime: mimeType(c.mime),
        size: 0,
        status: "ready",
        note:
          c.note ||
          "来自会话保存的数据，可能经过来源工具转换；附件内容未脱敏。",
        messageId: sanitizer().clean(c.messageId).slice(0, 160),
        origin: c.origin || "stored",
      };
      try {
        if (c.unsupported) {
          item.status = "unsupported";
          item.note = c.note || "仅有文件引用或远程地址，请手动补充原文件。";
        } else {
          let result;
          if (c.data !== undefined) result = decode(c.data, !!c.base64, c.mime);
          else {
            const raw = c.artifact
              ? await artifactFile(c.artifact)
              : c.file
                ? await readFile(c.file, c.root)
                : undefined;
            if (!raw) throw new Error("未找到可读取的附件数据。");
            result =
              raw.subarray(0, 5).toString() === "data:" && c.artifact
                ? decode(raw.toString("utf8"), false, c.mime)
                : {
                    bytes: raw,
                    mime:
                      imageMime(raw) || c.mime || "application/octet-stream",
                  };
          }
          if (c.imageOnly && !imageMime(result.bytes))
            throw new Error("图片引用未对应可识别的图片，请手动补充。");
          const hash = createHash("sha256").update(result.bytes).digest("hex");
          if (c.digest && c.digest !== hash)
            throw new Error("附件内容校验失败。");
          if (total + result.bytes.length > ATTACHMENT_LIMITS.total)
            throw new Error(
              "附件合计超过 64 MB，此附件未纳入；请缩小范围或手动补充。",
            );
          item.size = result.bytes.length;
          item.sha256 = hash;
          item.mime = mimeType(result.mime);
          if (c.mime && c.mime !== result.mime)
            item.note =
              "已按实际图片格式纠正来源元数据；导出保存的数据，可能与原图不同。";
          const extension: Record<string, string> = {
            "image/png": ".png",
            "image/jpeg": ".jpg",
            "image/webp": ".webp",
            "image/gif": ".gif",
            "image/bmp": ".bmp",
          };
          if (
            extension[item.mime] &&
            !item.name.toLowerCase().endsWith(extension[item.mime])
          )
            item.name = safeName(
              item.name.replace(/\.[a-z0-9]{1,8}$/i, "") + extension[item.mime],
            );
          total += item.size;
          this.payloads.set(item.id, result.bytes);
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        item.status = code === "ENOENT" ? "missing" : "error";
        item.note =
          code === "ENOENT"
            ? "附件文件已移除或缓存已清理，请手动补充。"
            : error instanceof Error && !code
              ? error.message
              : "附件不可读取，请手动补充。";
      }
      entries.push(item);
    }
    return (this.scan = { token: randomUUID(), entries, complete, warnings });
  }
  selection(options: HandoffAttachmentSelection) {
    const scan = this.scan;
    if (!scan || scan.token !== options.attachmentScanToken)
      throw new Error("附件清单已变更，请重新生成预览。");
    const ids = options.attachmentIds || [];
    if (!ids.length || new Set(ids).size !== ids.length)
      throw new Error("请至少选择一个可打包附件。");
    const selected = ids.map((id) => scan.entries.find((e) => e.id === id));
    if (
      selected.some(
        (e) => !e || e.status !== "ready" || !this.payloads.has(e.id),
      )
    )
      throw new Error("所选附件不可用，请重新扫描。");
    const entries = selected as HandoffAttachment[];
    const incomplete =
      !scan.complete || scan.entries.some((e) => e.status !== "ready");
    if (incomplete && !options.allowPartialAttachments)
      throw new Error("存在无法恢复或未确认的附件，请明确确认仅导出可用部分。");
    const summary: HandoffPackageSummary = {
      entries,
      bytes: entries.reduce((n, e) => n + e.size, 0),
      omitted: scan.entries.length - entries.length,
      complete: !incomplete && scan.entries.length === entries.length,
    };
    return {
      summary,
      omittedEntries: scan.entries.filter((e) => !ids.includes(e.id)),
      warnings: scan.warnings,
      files: entries.map((e, i) => ({
        name: `attachments/${String(i + 1).padStart(3, "0")}-${e.name}`,
        bytes: this.payloads.get(e.id)!,
      })),
    };
  }
}
export function contentAttachments(
  content: unknown,
  messageId: string,
  context: { home?: string; kind?: "workbuddy" | "dsh" | "zcode" } = {},
): AttachmentCandidate[] {
  if (!Array.isArray(content)) return [];
  return content.filter(obj).flatMap((part): AttachmentCandidate[] => {
    const type = str(part.type),
      mime = str(part.mime) || str(part.media_type),
      name = str(part.filename) || str(part.name);
    const common = { messageId, mime, name };
    if (
      type === "image_blob_ref" &&
      (context.kind !== "workbuddy" || !context.home)
    )
      return [{ ...common, unsupported: true }];
    if (type === "image_blob_ref")
      return [
        {
          ...common,
          name: str(part.original_filename),
          mime: str(part.mime),
          file: str(part.blob_path),
          root: context.home
            ? path.join(context.home, ".workbuddy")
            : undefined,
          imageOnly: true,
        },
      ];
    if (
      (type === "image" || type === "file") &&
      obj(part.attachment) &&
      context.kind === "dsh"
    ) {
      const a = part.attachment,
        id = str(a.attachmentId),
        digest = /^sha256:([a-f0-9]{64})$/.exec(id)?.[1];
      if (!digest || !context.home)
        return [
          {
            ...common,
            unsupported: true,
            note: "当前附件存储版本无法识别，请手动补充。",
          },
        ];
      const root = path.join(context.home, ".dsh/attachments/v1/objects");
      return [
        {
          messageId,
          name: str(a.name),
          mime: str(a.mediaType),
          root,
          file: path.join(root, digest.slice(0, 2), digest),
          digest,
          imageOnly: type === "image",
        },
      ];
    }
    if ((type === "image" || type === "document") && obj(part.source)) {
      const source = part.source;
      if (source.type === "base64" && typeof source.data === "string")
        return [
          {
            ...common,
            mime: str(source.media_type),
            data: source.data,
            base64: true,
            imageOnly: type === "image",
          },
        ];
      return [{ ...common, unsupported: true }];
    }
    if (
      type === "file" ||
      type === "image" ||
      type === "input_image" ||
      type === "localImage"
    ) {
      let url = str(part.url) || str(part.image_url) || str(part.path);
      if (obj(part.image_url)) url = str(part.image_url.url);
      if (url.startsWith("data:"))
        return [{ ...common, data: url, imageOnly: type !== "file" }];
      if (url.startsWith("zcode-artifact:") && context.home) {
        try {
          const u = new URL(url);
          return [
            {
              ...common,
              artifact: {
                root: path.join(context.home, ".zcode/cli/artifacts"),
                key: decodeURIComponent(u.pathname.slice(1)),
                session: u.hostname,
              },
              imageOnly: mime.startsWith("image/"),
            },
          ];
        } catch {
          return [{ ...common, unsupported: true }];
        }
      }
      if (type === "localImage" && path.isAbsolute(url))
        return [
          {
            ...common,
            file: url,
            imageOnly: true,
            origin: "local-image",
            note: "当前路径中的图片，不保证是原始上传版本；附件内容未脱敏。",
          },
        ];
      return [
        {
          ...common,
          origin: "reference",
          unsupported: true,
          note: "会话只保留文件引用或远程地址；请通过“补充文件”选择原文件。",
        },
      ];
    }
    if (
      /image|attachment|document|file/i.test(type) &&
      !["tool_result", "tool_use"].includes(type)
    )
      return [
        {
          ...common,
          unsupported: true,
          note: "附件结构尚未适配，请手动补充。",
        },
      ];
    return [];
  });
}
export function claudeAttachmentCandidates(
  records: Obj[],
): AttachmentCandidate[] {
  return records
    .filter(
      (r) =>
        !r.isSidechain &&
        !r.parentSessionId &&
        r.type === "user" &&
        obj(r.message),
    )
    .flatMap((r) =>
      contentAttachments((r.message as Obj).content, str(r.uuid) || "用户消息"),
    );
}
export function openCodeAttachmentCandidates(
  value: unknown,
  home?: string,
): AttachmentCandidate[] {
  if (!obj(value) || !Array.isArray(value.messages)) return [];
  return value.messages
    .filter(obj)
    .filter((m) => obj(m.info) && m.info.role === "user")
    .flatMap((m) =>
      contentAttachments(
        m.parts,
        str((m.info as Obj).id),
        home ? { home, kind: "zcode" } : {},
      ),
    );
}
/** Minimal standard UTF-8 ZIP. No shell commands, symlinks, absolute names, ZIP64 or executable bits. */
export function attachmentZip(
  files: { name: string; bytes: Buffer }[],
): Buffer {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  const names = new Set<string>();
  for (const file of files) {
    if (
      !/^(?:attachments\/)?[^/\\]+$/.test(file.name) ||
      file.name.split("/").some((p) => p === ".." || p === ".") ||
      names.has(file.name)
    )
      throw new Error("无效附件包文件名。");
    names.add(file.name);
    const name = Buffer.from(file.name),
      compressed = deflateRawSync(file.bytes);
    let crc = 0xffffffff;
    for (const byte of file.bytes) {
      crc ^= byte;
      for (let i = 0; i < 8; i++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x800, 6);
    h.writeUInt16LE(8, 8);
    h.writeUInt16LE(0x21, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(compressed.length, 18);
    h.writeUInt32LE(file.bytes.length, 22);
    h.writeUInt16LE(name.length, 26);
    local.push(h, name, compressed);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(0x21, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(compressed.length, 20);
    c.writeUInt32LE(file.bytes.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += h.length + name.length + compressed.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}
