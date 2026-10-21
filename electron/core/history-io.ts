/** Reads conversation stores only. Source databases are never migrated or repaired. */
import fs from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const object = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
export const str = (v: unknown): string => (typeof v === "string" ? v : "");
export const missing = (e: unknown) =>
  ["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code || "");
export const identifier = (s: string) => {
  if (!/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(s)) throw new Error("无效来源表名。");
  return `"${s}"`;
};
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export async function entries(root: string) {
  try {
    const s = await fs.lstat(root);
    if (!s.isDirectory() || s.isSymbolicLink())
      throw new Error("来源目录不是普通目录。");
    return (await fs.readdir(root, { withFileTypes: true })).filter(
      (e) => !e.isSymbolicLink(),
    );
  } catch (e) {
    if (missing(e)) return [];
    throw e;
  }
}
export async function* walk(root: string): AsyncGenerator<string> {
  for (const e of await entries(root)) {
    const f = path.join(root, e.name);
    if (e.isDirectory()) yield* walk(f);
    else if (e.isFile()) yield f;
  }
}
export async function exists(file: string) {
  try {
    const s = await fs.lstat(file);
    return !s.isSymbolicLink() && s.isFile();
  } catch (e) {
    if (missing(e)) return false;
    throw e;
  }
}
export async function json(file: string): Promise<any> {
  return JSON.parse(await fs.readFile(file, "utf8"));
}
export function tables(db: DatabaseSync) {
  return new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => String(r.name)),
  );
}
export function columns(db: DatabaseSync, table: string) {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${identifier(table)})`)
      .all()
      .map((r) => String(r.name)),
  );
}
export function signature(s: import("node:fs").Stats) {
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
}

/** Copy committed DB+WAL only when read-only SQLite cannot open its shared-memory sidecar.
 * A stable pair is required; immutable=1 is never used (it would discard the WAL).
 */
export async function sourceDatabase<T>(
  file: string,
  run: (db: DatabaseSync) => T | Promise<T>,
): Promise<T> {
  const st = await fs.lstat(file);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1)
    throw new Error("来源数据库不是普通文件。");
  const { DatabaseSync } = await import("node:sqlite");
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN");
    db.prepare("SELECT COUNT(*) FROM sqlite_master").get();
  } catch (e) {
    try {
      db?.close();
    } catch {}
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "history-db-"));
    try {
      const files = [
        file,
        ...((await exists(`${file}-wal`)) ? [`${file}-wal`] : []),
      ];
      const before = await Promise.all(files.map((f) => fs.lstat(f)));
      if (before.some((s) => !s.isFile() || s.isSymbolicLink()))
        throw new Error("来源 WAL 不是普通文件。");
      for (const f of files)
        await fs.copyFile(f, path.join(scratch, path.basename(f)));
      for (let i = 0; i < files.length; i++)
        if (signature(before[i]) !== signature(await fs.lstat(files[i])))
          throw new Error("来源数据库在快照时变化，请刷新重试。");
      if (!files.includes(`${file}-wal`) && (await exists(`${file}-wal`)))
        throw new Error("来源 WAL 在快照时创建，请刷新重试。");
      const copy = new DatabaseSync(path.join(scratch, path.basename(file)));
      try {
        copy.exec("PRAGMA query_only=ON; BEGIN");
        return await run(copy);
      } finally {
        copy.close();
      }
    } finally {
      await fs.rm(scratch, { recursive: true, force: true });
    }
  }
  try {
    return await run(db);
  } finally {
    db.close();
  }
}

/** Bounded metadata reads do not decide whether a large history exists. */
export async function head(file: string, bytes = 128 * 1024) {
  const f = await fs.open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
  );
  try {
    const s = await f.stat();
    if (!s.isFile()) throw new Error("来源不是普通文件。");
    const b = Buffer.alloc(Math.min(s.size, bytes));
    const r = await f.read(b, 0, b.length, 0);
    return b.subarray(0, r.bytesRead).toString("utf8");
  } finally {
    await f.close();
  }
}
export function headRecords(raw: string): Record<string, any>[] {
  return raw.split("\n").flatMap((line) => {
    try {
      const r = JSON.parse(line);
      return object(r) ? [r] : [];
    } catch {
      return [];
    }
  });
}
export async function* fileChunks(
  file: string,
  root: string,
): AsyncGenerator<Buffer> {
  const base = await fs.realpath(root),
    resolved = await fs.realpath(file),
    relative = path.relative(base, resolved);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error("历史文件超出来源目录。");
  const f = await fs.open(
    file,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW || 0) |
      (constants.O_NONBLOCK || 0),
  );
  try {
    const before = await f.stat();
    if (!before.isFile() || before.nlink !== 1)
      throw new Error("历史文件不是普通文件。");
    let offset = 0;
    while (offset < before.size) {
      const b = Buffer.alloc(Math.min(256 * 1024, before.size - offset));
      const { bytesRead } = await f.read(b, 0, b.length, offset);
      if (!bytesRead) throw new Error("历史文件读取不完整。");
      offset += bytesRead;
      yield b.subarray(0, bytesRead);
    }
    if (signature(before) !== signature(await f.stat()))
      throw new Error("历史文件读取期间发生变化，请重试。");
  } finally {
    await f.close();
  }
}
