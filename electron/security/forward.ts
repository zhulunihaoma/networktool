/**
 * Log forwarding: ships the chained security log to the platform it belongs to.
 *
 * Runs in the main process, never in the guard: the PreToolUse hook must answer
 * in milliseconds and must never fail because a network call is slow, so the
 * guard only appends locally and this module catches up afterwards.
 *
 * Delivery is at-least-once. A small state file records the byte offset and the
 * last shipped row hash, so a restart resumes instead of duplicating, and a
 * rotated log does not re-send history. Nothing here is required for the local
 * product to work: when forwarding is off, no code path is touched.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import dgram from "node:dgram";
import tls from "node:tls";
import { request } from "node:https";
import { request as httpRequest } from "node:http";
import type {
  ForwardSettings,
  ForwardStats,
  ForwardTarget,
} from "../../src/shared/security";
import { eventsFile, type GuardEventLine } from "./guard-protocol";

const STATE = "forward-state.json";
const OUTBOX = "forward-outbox.ndjson";
const MAX_CHUNK = 500;
const MAX_BUFFER = 4_000_000;

interface ForwardState {
  /** Byte offset already shipped in the current log file. */
  offset: number;
  /** Hash of the last shipped row; guards against re-reading a rotated file. */
  lastHash: string;
  /** Rows that failed to send, kept for the next attempt. */
  pending?: ForwardRecord[];
  lastError?: string;
  lastSentAt?: number;
  sent: number;
  failed: number;
}

export interface ForwardRecord {
  /** Contract version, so the platform can evolve the schema. */
  schema: "ai-guard.event/v1";
  /** Where this event came from. */
  product: "360ai-box";
  machine: string;
  user: string;
  event: GuardEventLine;
}

const readState = (file: string): ForwardState => {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed.offset === "number")
      return {
        offset: parsed.offset,
        lastHash: typeof parsed.lastHash === "string" ? parsed.lastHash : "",
        pending: Array.isArray(parsed.pending) ? parsed.pending : [],
        lastError: typeof parsed.lastError === "string" ? parsed.lastError : undefined,
        lastSentAt: typeof parsed.lastSentAt === "number" ? parsed.lastSentAt : undefined,
        sent: Number(parsed.sent) || 0,
        failed: Number(parsed.failed) || 0,
      };
  } catch {}
  return { offset: 0, lastHash: "", pending: [], sent: 0, failed: 0 };
};

const writeState = (file: string, state: ForwardState) => {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
};

/** Read only new complete lines; a partial trailing line waits for next time. */
function readNewLines(file: string, offset: number): { rows: string[]; offset: number } {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    // A shorter file means rotation or truncation: start over rather than skip.
    const start = offset > size ? 0 : offset;
    const length = size - start;
    if (length <= 0) return { rows: [], offset: start };
    const buffer = Buffer.alloc(Math.min(length, MAX_BUFFER));
    const read = fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, read).toString("utf8");
    const cut = text.lastIndexOf("\n");
    // No newline yet: the writer is mid-append, keep the offset where it was.
    if (cut < 0) return { rows: [], offset: start };
    const complete = text.slice(0, cut + 1);
    return {
      rows: complete.split("\n").filter(Boolean),
      offset: start + Buffer.byteLength(complete, "utf8"),
    };
  } catch {
    return { rows: [], offset };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const envelope = (line: string): ForwardRecord | undefined => {
  try {
    const event = JSON.parse(line) as GuardEventLine;
    if (!event || typeof event.hash !== "string" || typeof event.at !== "number")
      return undefined;
    return {
      schema: "ai-guard.event/v1",
      product: "360ai-box",
      machine: os.hostname(),
      user: os.userInfo().username,
      event,
    };
  } catch {
    return undefined;
  }
};

/** RFC5424 payload; the structured data carries the labels the SIEM filters on. */
function syslogLine(event: GuardEventLine): string {
  const severity = event.decision === "deny" ? 4 : 6;
  const facility = 13; // security/audit
  const pri = facility * 8 + severity;
  const time = new Date(event.at).toISOString();
  const host = os.hostname().replace(/[^\w.-]/g, "") || "-";
  const app = "ai-guard";
  const level = event.facts?.level ?? "-";
  const rule = event.ruleId ?? "-";
  const msg = [
    `tool=${event.tool}`,
    `decision=${event.decision}`,
    `source=${event.source}`,
    `rule=${rule}`,
    `level=${level}`,
    `project=${event.project || "-"}`,
    `session=${event.sessionId || "-"}`,
    `hash=${event.hash}`,
  ].join(" ");
  return `<${pri}>1 ${time} ${host} ${app} - - [ai-guard@360 ruletag="${rule}" leveltag="${level}" decision="${event.decision}"] ${msg}`;
}

async function sendUdp(target: ForwardTarget, lines: string[]): Promise<void> {
  const socket = dgram.createSocket("udp4");
  try {
    await new Promise<void>((resolve, reject) => {
      socket.send(lines.join("\n"), target.port, target.host, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  } finally {
    socket.close();
  }
}

async function sendTcp(
  target: ForwardTarget,
  lines: string[],
  useTls: boolean,
): Promise<void> {
  const payload = lines.join("\n") + "\n";
  await new Promise<void>((resolve, reject) => {
    const socket = useTls
      ? tls.connect(
          { host: target.host, port: target.port, rejectUnauthorized: true },
          () => socket.write(payload, () => socket.end()),
        )
      : require("node:net").connect({ host: target.host, port: target.port }, () =>
          socket.write(payload, () => socket.end()),
        );
    socket.setTimeout(8000, () => socket.destroy(new Error("外送连接超时")));
    socket.on("error", reject);
    socket.on("close", () => resolve());
  });
}

async function sendHttp(target: ForwardTarget, records: ForwardRecord[]): Promise<void> {
  const body = JSON.stringify({ schema: "ai-guard.batch/v1", records });
  if (!target.url) throw new Error("HTTP 外送缺少地址");
  const url = new URL(target.url);
  const send = url.protocol === "https:" ? request : httpRequest;
  await new Promise<void>((resolve, reject) => {
    const req = send(
      url,
      {
        method: "POST",
        timeout: 8000,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...(target.token ? { authorization: `Bearer ${target.token}` } : {}),
        },
      },
      (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300)
          resolve();
        else reject(new Error(`平台返回 ${res.statusCode}`));
      },
    );
    req.on("timeout", () => req.destroy(new Error("外送请求超时")));
    req.on("error", reject);
    req.end(body);
  });
}

export interface ForwarderOptions {
  dataDir: string;
}

export class Forwarder {
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(private options: ForwarderOptions) {}

  private get stateFile() {
    return path.join(this.options.dataDir, STATE);
  }

  /** Replay the local log to a single NDJSON file; no network, no settings needed. */
  exportNdjson(limit = 20000): { path: string; rows: number } {
    const file = path.join(this.options.dataDir, OUTBOX);
    const source = eventsFile(this.options.dataDir);
    let text = "";
    try {
      text = fs.readFileSync(source, "utf8");
    } catch {}
    const rows = text.split("\n").filter(Boolean).slice(-limit);
    fs.writeFileSync(file, rows.join("\n") + (rows.length ? "\n" : ""), {
      mode: 0o600,
    });
    return { path: file, rows: rows.length };
  }

  stats(): ForwardStats {
    const state = readState(this.stateFile);
    return {
      sent: state.sent,
      pending: state.pending?.length ?? 0,
      ...(state.lastSentAt ? { lastSentAt: state.lastSentAt } : {}),
      ...(state.lastError ? { lastError: state.lastError } : {}),
    };
  }

  /** Ship everything new. Returns how many rows left the machine. */
  async flush(settings: ForwardSettings): Promise<{ sent: number; error?: string }> {
    if (!settings.enabled || this.running) return { sent: 0 };
    this.running = true;
    const state = readState(this.stateFile);
    try {
      const read = readNewLines(eventsFile(this.options.dataDir), state.offset);
      const fresh = read.rows
        .map(envelope)
        .filter((r): r is ForwardRecord => !!r && r.event.hash !== state.lastHash);
      const batch = [...(state.pending ?? []), ...fresh];
      if (!batch.length) {
        if (read.offset !== state.offset)
          writeState(this.stateFile, { ...state, offset: read.offset });
        return { sent: 0 };
      }
      const targets = (settings.targets ?? []).filter((t) => t.enabled);
      if (!targets.length) return { sent: 0 };
      let shipped = 0;
      for (const chunk of chunkOf(batch, MAX_CHUNK)) {
        for (const target of targets) await this.deliver(target, chunk, settings);
        shipped += chunk.length;
      }
      writeState(this.stateFile, {
        offset: read.offset,
        lastHash: batch[batch.length - 1]?.event.hash ?? state.lastHash,
        pending: [],
        sent: state.sent + shipped,
        failed: state.failed,
        lastSentAt: Date.now(),
      });
      return { sent: shipped };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Keep the offset unchanged so the same rows are retried next tick.
      writeState(this.stateFile, {
        ...state,
        lastError: message.slice(0, 300),
        failed: state.failed + 1,
      });
      return { sent: 0, error: message };
    } finally {
      this.running = false;
    }
  }

  private async deliver(
    target: ForwardTarget,
    records: ForwardRecord[],
    settings: ForwardSettings,
  ) {
    if (target.kind === "http") return sendHttp(target, records);
    if (target.kind === "udp")
      return sendUdp(target, records.map((r) => syslogLine(r.event)));
    if (target.kind === "tcp" || target.kind === "tls")
      return sendTcp(
        target,
        records.map((r) => syslogLine(r.event)),
        target.kind === "tls",
      );
    throw new Error(`不支持的外送类型：${target.kind}`);
  }

  /** Start the periodic catch-up loop; safe to call more than once. */
  start(settings: ForwardSettings, intervalMs = 15_000) {
    this.stop();
    if (!settings.enabled) return;
    this.timer = setInterval(() => {
      void this.flush(settings);
    }, Math.max(5_000, intervalMs));
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

const chunkOf = <T,>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};
