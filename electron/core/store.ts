import initSqlJs, { type Database } from "sql.js";
import fs from "node:fs";
import path from "node:path";
import type { Session, Settings } from "../../src/shared/types";
export class Store {
  private db!: Database;
  constructor(
    private filename: string,
    private wasmPath: string,
  ) {}
  async init() {
    const SQL = await initSqlJs({ locateFile: () => this.wasmPath });
    fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    this.db = new SQL.Database(
      fs.existsSync(this.filename) ? fs.readFileSync(this.filename) : undefined,
    );
    this.db.run(
      "PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,started INTEGER NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS sessions_started ON sessions(started); CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY,payload TEXT NOT NULL); PRAGMA user_version=1;",
    );
    this.db.run(
      "CREATE TABLE IF NOT EXISTS assistant_state(name TEXT PRIMARY KEY,payload TEXT NOT NULL);",
    );
    this.flush();
  }
  all(): Session[] {
    const stmt = this.db.prepare(
      "SELECT payload FROM sessions ORDER BY started DESC",
    );
    const rows: Session[] = [];
    while (stmt.step())
      rows.push(JSON.parse(stmt.getAsObject().payload as string));
    stmt.free();
    return rows;
  }
  put(s: Session) {
    this.db.run("INSERT OR REPLACE INTO sessions VALUES(?,?,?,?)", [
      s.id,
      s.started,
      s.status,
      JSON.stringify(s),
    ]);
    this.flush();
  }
  delete(id: string) {
    this.db.run("DELETE FROM sessions WHERE id=?", [id]);
    this.flush();
  }
  settings(): Settings {
    const result = this.db.exec("SELECT payload FROM settings WHERE id=1");
    return result.length
      ? JSON.parse(result[0].values[0][0] as string)
      : { retentionDays: 7, redact: true };
  }
  setSettings(s: Settings) {
    this.db.run("INSERT OR REPLACE INTO settings VALUES(1,?)", [
      JSON.stringify(s),
    ]);
    this.flush();
  }
  assistant<T>(name: string, fallback: T): T {
    const stmt = this.db.prepare(
      "SELECT payload FROM assistant_state WHERE name=?",
    );
    try {
      stmt.bind([name]);
      return stmt.step()
        ? JSON.parse(stmt.getAsObject().payload as string)
        : fallback;
    } finally {
      stmt.free();
    }
  }
  putAssistant(name: string, value: unknown) {
    // Restore the in-memory image as well as leaving the on-disk file untouched on failure.
    const before = this.db.export();
    try {
      this.db.run("INSERT OR REPLACE INTO assistant_state VALUES(?,?)", [
        name,
        JSON.stringify(value),
      ]);
      this.flush();
    } catch (error) {
      const DatabaseClass = this.db.constructor as new (
        bytes: Uint8Array,
      ) => Database;
      this.db.close();
      this.db = new DatabaseClass(before);
      this.db.run("PRAGMA foreign_keys=ON;");
      throw error;
    }
  }
  private flush() {
    const bytes = this.db.export();
    if (bytes.byteLength > 500 * 1024 * 1024)
      throw new Error("STORAGE_FULL：本地记录超过 500 MB，请先删除旧诊断。");
    const temp = this.filename + ".tmp";
    fs.writeFileSync(temp, bytes, { mode: 0o600 });
    const fd = fs.openSync(temp, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, this.filename);
  }
}
