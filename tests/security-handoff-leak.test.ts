import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import {
  AttachmentSet,
  bindAttachments,
  redactAttachment,
} from "../electron/core/handoff-attachments";
import { HandoffManager } from "../electron/core/handoff";
import {
  credentialAttachmentRule,
  type HandoffSecurityEvent,
} from "../src/shared/handoff-attachments";
import type { HandoffImport } from "../src/shared/handoff";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
  "base64",
);
// Fake fixtures assembled at runtime; not real credentials.
const fakeKey = ["sk", "proj", "A".repeat(24)].join("-");
const fakePem = ["-----BEGIN", "OPENSSH PRIVATE KEY-----\nAAAA\n-----END", "OPENSSH PRIVATE KEY-----\n"].join(" ");
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
const source = (): HandoffImport => ({
  id: "session", title: "fixture", directory: "/project/demo", transcript: "继续",
  warnings: [], messageCount: 1, redactions: 0,
});
const raw = (parts: unknown[]) => JSON.stringify({
  info: { id: "ses_leak", title: "fixture", directory: "/project/demo" },
  messages: [{ info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "继续" }, ...parts] }],
});
function unzip(b: Buffer) {
  const out = new Map<string, Buffer>();
  let n = 0;
  while (b.readUInt32LE(n) === 0x04034b50) {
    const size = b.readUInt32LE(n + 18), len = b.readUInt16LE(n + 26), extra = b.readUInt16LE(n + 28);
    const start = n + 30 + len + extra;
    out.set(b.subarray(n + 30, n + 30 + len).toString(), inflateRawSync(b.subarray(start, start + size)));
    n = start + size;
  }
  return out;
}
async function tmp(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-leak-"));
  try { await run(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test("credential file names are recognised, ordinary documents are not", () => {
  for (const name of [".env", ".env.local", "prod.env", "server.pem", "tls.key", "cert.p12", "id_rsa", "id_ed25519",
    "/Users/a/.ssh/config", "/Users/a/.aws/credentials", "auth.json", "credentials.json", "gcp-credentials.yaml",
    ".npmrc", ".pypirc", ".netrc", ".git-credentials", "secrets.yaml", "/Users/a/.docker/config.json"])
    assert(credentialAttachmentRule(name), name);
  for (const name of ["README.md", "screen.png", "environment.md", "keyboard.txt", "credentials-guide.md",
    "package.json", "id_rsa.md", "report.pdf", "author.json"])
    assert.equal(credentialAttachmentRule(name), undefined, name);
});

test("credential attachments are refused at scan, not selectable, and reported once", async () => {
  const events: HandoffSecurityEvent[] = [];
  const d = source();
  bindAttachments(d, [
    { name: ".env", data: b64(`API_KEY=${fakeKey}\n`), base64: true, mime: "text/plain", messageId: "m1" },
    { name: "notes.txt", data: b64(fakePem), base64: true, mime: "text/plain", messageId: "m1" },
    { name: "id_ed25519", unsupported: true, messageId: "m1" },
    { name: "screen.png", data: b64(png), base64: true, messageId: "m1" },
  ]);
  const set = new AttachmentSet(d, (e) => events.push(e));
  const scan = await set.inspect();
  assert.deepEqual(scan.entries.map((e) => e.status), ["blocked", "blocked", "blocked", "ready"]);
  assert.equal(scan.entries[0].name, ".env");
  assert.equal(scan.security?.blocked.length, 3);
  assert.match(scan.security!.blocked[1].reason, /私钥/);
  assert(scan.entries.filter((e) => e.status === "blocked").every((e) => e.size === 0 && !e.sha256 && /已拒绝打包/.test(e.note)));
  assert.equal(events.length, 3);
  assert(events.every((e) => e.decision === "deny" && e.operation === "handoff.attachment.pack" && e.ruleId?.startsWith("handoff.credential.") && e.project === "/project/demo"));
  assert(!JSON.stringify(events).includes(fakeKey));
  // A tampered renderer selection that includes a refused id fails in the main process.
  assert.throws(() => set.selection({ attachmentScanToken: scan.token, attachmentIds: [scan.entries[0].id, scan.entries[3].id], allowPartialAttachments: true }), /已拒绝打包/);
  // Refused files are intentionally excluded and do not force the "partial export" confirmation.
  const ok = set.selection({ attachmentScanToken: scan.token, attachmentIds: [scan.entries[3].id] });
  assert.equal(ok.files.length, 1);
  assert.deepEqual(ok.files[0].bytes, png);
  await set.inspect();
  assert.equal(events.length, 3, "rescan does not duplicate the same timeline event");
});

test("text attachments are redacted with the transcript sanitizer before packaging; binaries stay intact", async () => {
  const text = `部署说明\nAuthorization: Bearer abcdefghijklmnop\ntoken=${fakeKey}\n联系 ops@example.com\n`;
  const r = redactAttachment(Buffer.from(text), "text/plain");
  assert(r.text && r.hits >= 3);
  assert(!r.bytes.toString().includes(fakeKey));
  assert.match(r.bytes.toString(), /部署说明/);
  assert.equal(redactAttachment(png, "image/png").hits, 0);
  assert.equal(redactAttachment(Buffer.from(`%PDF-1.4 token=${fakeKey}`), "application/pdf").text, false);
  assert.equal(redactAttachment(Buffer.from(`%PDF-1.4 token=${fakeKey}`)).text, false, "magic bytes beat missing MIME");
  const plain = redactAttachment(Buffer.from("没有密钥"), "text/plain");
  assert.equal(plain.hits, 0);
  assert.equal(plain.text, true);
});

test("manager export packs masked text, records events, keeps refused files out of the ZIP", () => tmp(async (root) => {
  const events: HandoffSecurityEvent[] = [];
  const manager = new HandoffManager(undefined, undefined, undefined, undefined, { onSecurityEvent: (e) => events.push(e) });
  const config = `db: prod\npassword: hunter2-very-secret\napi_key = ${fakeKey}\n`;
  const data = manager.importRaw(raw([
    { type: "file", filename: "deploy.yaml", mime: "text/yaml", url: `data:text/yaml;base64,${b64(config)}` },
    { type: "file", filename: ".env.production", mime: "text/plain", url: `data:text/plain;base64,${b64(`TOKEN=${fakeKey}`)}` },
    { type: "file", filename: "screen.png", mime: "image/png", url: `data:image/png;base64,${b64(png)}` },
  ]));
  const scan = await manager.scanAttachments(data.attachmentSession!);
  const [yaml, env, image] = scan.entries;
  assert.equal(env.status, "blocked");
  assert.equal(yaml.status, "ready");
  assert.equal(yaml.redactions, 2);
  assert.match(yaml.note, /2 处敏感信息已遮盖/);
  assert.doesNotMatch(yaml.note, /未脱敏/);
  assert.deepEqual(scan.security?.redacted, [{ name: "deploy.yaml", hits: 2 }]);
  const preview = manager.prepare("继续部署", "Codex", { includeTranscript: true, includeWorkspace: true, packAttachments: true,
    attachmentScanToken: scan.token, attachmentIds: [yaml.id, image.id] });
  assert.match(preview.content, /防泄露：1 个凭据类文件已拒绝打包/);
  assert.match(preview.content, /共 2 处/);
  assert.doesNotMatch(preview.content, /附件内容未经脱敏/);
  assert(events.some((e) => e.decision === "allow" && e.operation === "handoff.attachment.redact" && /deploy\.yaml/.test(e.reason!)));
  const result = await manager.exportPackage(preview.token, async () => root);
  const zip = unzip(await fs.readFile(result!.path));
  const all = [...zip.values()].map((b) => b.toString("latin1")).join("\n");
  assert(!all.includes(fakeKey), "no key in any ZIP entry");
  assert(!all.includes("hunter2-very-secret"));
  assert(![...zip.keys()].some((n) => /\.env/.test(n)));
  const manifest = JSON.parse(zip.get("manifest.json")!.toString());
  const packedYaml = zip.get(manifest.attachments[0].path)!;
  assert.match(packedYaml.toString(), /db: prod\npassword: \[已脱敏\]/);
  assert.equal(manifest.attachments[0].sha256, createHash("sha256").update(packedYaml).digest("hex"));
  assert.deepEqual(zip.get(manifest.attachments[1].path), png);
  assert.match(manifest.omittedAttachments[0].reason, /已拒绝打包/);
}));

test("manually added credential files and key paths are refused; a throwing callback never changes the outcome", () => tmp(async (root) => {
  const manager = new HandoffManager(undefined, undefined, undefined, undefined, { onSecurityEvent: () => { throw new Error("timeline down"); } });
  const data = manager.importRaw(raw([]));
  await fs.mkdir(path.join(root, ".ssh"));
  const files = [path.join(root, ".env"), path.join(root, ".ssh", "config"), path.join(root, "renamed.txt"), path.join(root, "todo.md")];
  await fs.writeFile(files[0], `KEY=${fakeKey}`);
  await fs.writeFile(files[1], "Host x");
  await fs.writeFile(files[2], fakePem);
  await fs.writeFile(files[3], `- 记得轮换 secret: ${fakeKey}`);
  const scan = (await manager.addAttachments(data.attachmentSession!, async () => files))!;
  assert.deepEqual(scan.entries.map((e) => e.status), ["blocked", "blocked", "blocked", "ready"]);
  assert.equal(scan.entries[3].redactions, 1);
  const preview = manager.prepare("继续", "Codex", { includeTranscript: true, includeWorkspace: true, packAttachments: true,
    attachmentScanToken: scan.token, attachmentIds: [scan.entries[3].id] });
  const result = await manager.exportPackage(preview.token, async () => root);
  const zip = unzip(await fs.readFile(result!.path));
  assert(![...zip.values()].some((b) => b.toString().includes(fakeKey)));
  assert.equal(await fs.readFile(files[3], "utf8"), `- 记得轮换 secret: ${fakeKey}`, "source file is untouched");
}));
