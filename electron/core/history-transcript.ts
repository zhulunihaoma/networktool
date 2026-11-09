/** Read visible conversation text from the immutable archive, never a byte prefix.
 * Text is neither summarized nor clipped. Non-dialogue fields and binary assets
 * are not materialized. The original native archive remains the source of truth.
 */
import { createHash } from "node:crypto";
import type { HandoffSource } from "../../src/shared/handoff-api";
import {
  JsonStreamValidator,
  type JsonObserver,
  type JsonPath,
} from "./history-json";
import { fileChunks, object, str } from "./history-io";

interface Message {
  role: "user" | "assistant";
  text: string;
  id: string;
  time: number;
  order: number;
  flavor: string;
  input: string;
}
const metadata = new Set([
  "source",
  "name",
  "type",
  "role",
  "id",
  "uuid",
  "key",
  "kind",
  "channel",
  "visibility",
  "transcriptVisibility",
  "message_id",
  "messageID",
  "messageId",
  "uiVisibility",
  "requestId",
  "created",
  "timestamp",
  "created_at",
  "time_created",
  "createdAt",
  "created_at_ms",
  "ts",
  "seq",
  "sequence",
  "rollout_ordinal",
  "synthetic",
  "ignored",
  "isMeta",
  "partial",
  "say",
  "origin",
]);
const textFields = new Set([
  "text",
  "content",
  "message",
  "last_agent_message",
]);
const textTypes = new Set(["text", "input_text", "output_text"]);
function visible(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((p) =>
      object(p) &&
      textTypes.has(p.type) &&
      !p.ignored &&
      !p.synthetic &&
      typeof p.text === "string"
        ? [p.text]
        : [],
    )
    .join("\n");
}
function timestamp(r: Record<string, any>): number {
  const v =
    r.created_at_ms ??
    r.timestamp ??
    r.time_created ??
    r.created_at ??
    r.createdAt ??
    r.ts ??
    r.time?.created;
  const n = typeof v === "number" ? v : Date.parse(str(v));
  return Number.isFinite(n) && n > 0 ? (n < 100_000_000_000 ? n * 1000 : n) : 0;
}

class Conversation implements JsonObserver {
  private root: any;
  private strings = new Map<string, string[]>();
  private input = "database";
  private order = 0;
  private messages: Message[] = [];
  private databaseMessages = new Map<
    string,
    {
      row: any;
      meta: any;
      order: number;
      parts: { text: string; seq: number; order: number }[];
    }
  >();
  private orphanParts = new Map<
    string,
    { text: string; seq: number; order: number }[]
  >();
  private uiStarted = new Set<string>();
  constructor(private source: HandoffSource) {}
  private put(p: JsonPath, value: unknown) {
    if (!p.length) {
      this.root = value;
      return;
    }
    this.root ||= typeof p[0] === "number" ? [] : Object.create(null);
    let node = this.root;
    for (let i = 0; i < p.length - 1; i++) {
      const k = p[i];
      if (!Object.hasOwn(node, k))
        node[k] = typeof p[i + 1] === "number" ? [] : Object.create(null);
      node = node[k];
    }
    // Null-prototype objects keep untrusted JSON keys inert.
    Object.defineProperty(node, p.at(-1)!, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  stringStart(p: JsonPath) {
    const field = String(p.at(-1));
    const capture =
      metadata.has(field) ||
      textFields.has(field) ||
      (field === "value" && p.includes("response")) ||
      (typeof p.at(-1) === "number" && p.at(-2) === "content");
    if (capture) this.strings.set(JSON.stringify(p), []);
    return capture;
  }
  stringChunk(p: JsonPath, text: string, end: boolean) {
    const key = JSON.stringify(p),
      parts = this.strings.get(key);
    if (!parts) return;
    // Only schema metadata is bounded. Visible body strings are never clipped.
    if (metadata.has(String(p.at(-1)))) {
      if (!parts.length) parts.push("");
      if (parts[0].length < 4096)
        parts[0] += text.slice(0, 4096 - parts[0].length);
    } else parts.push(text);
    if (end) {
      this.put(p, parts.join(""));
      this.strings.delete(key);
    }
  }
  scalar(p: JsonPath, value: number | boolean | null) {
    if (
      metadata.has(String(p.at(-1))) &&
      (typeof value !== "number" || Number.isFinite(value))
    )
      this.put(p, value);
  }
  rootEnd() {
    const value = this.root;
    this.root = undefined;
    if (object(value) && value.source === "file-start") {
      this.input = str(value.name);
      return;
    }
    if (object(value) && value.source === "file-end") {
      this.input = "database";
      return;
    }
    this.record(value);
  }
  private add(
    role: unknown,
    text: string,
    r: any = {},
    flavor = "native",
    meta: any = {},
  ) {
    if (
      (role !== "user" && role !== "assistant") ||
      !text.trim() ||
      r.synthetic ||
      r.ignored ||
      r.isMeta ||
      r.partial
    )
      return;
    if (
      ["hidden", "internal"].includes(r.visibility) ||
      r.transcriptVisibility === "hidden"
    )
      return;
    if (
      r.semantics?.uiVisibility === "hidden" ||
      r.semantics?.transcriptVisibility === "hidden" ||
      r.metadata?.visibility === "hidden"
    )
      return;
    if (role === "assistant" && ["analysis", "reasoning"].includes(r.channel))
      return;
    this.messages.push({
      role,
      text,
      id: str(r.id) || str(r.uuid) || str(meta.id),
      time: timestamp(r) || timestamp(meta),
      order: this.order++,
      flavor,
      input: this.input,
    });
  }
  private direct(r: any, flavor: string, meta: any = {}) {
    if (!object(r)) return;
    const role =
      r.role ||
      r.info?.role ||
      (r.type === "user" || r.type === "assistant" ? r.type : undefined);
    this.add(
      role,
      visible(r.content) || visible(r.parts) || str(r.text),
      r,
      flavor,
      meta,
    );
  }
  private record(r: any) {
    if (Array.isArray(r)) {
      for (const item of r) this.record(item);
      return;
    }
    if (!object(r)) return;
    if (typeof r.source === "string" && Object.hasOwn(r, "record")) {
      const v = r.record,
        meta = r.identity || {};
      if (!object(v)) return;
      if (r.source === "message") {
        const id = str(meta.id) || str(v.id);
        if (id)
          this.databaseMessages.set(id, {
            row: v,
            meta,
            order: this.order++,
            parts: this.orphanParts.get(id) || [],
          });
        return;
      }
      if (r.source === "part") {
        if (
          v.type !== "text" ||
          v.synthetic ||
          v.ignored ||
          typeof v.text !== "string"
        )
          return;
        const id =
          str(meta.message_id) || str(v.messageID) || str(v.message_id);
        if (!id) return;
        const part = {
          text: v.text,
          seq: Number(meta.sequence ?? v.sequence ?? meta.seq ?? v.seq) || 0,
          order: this.order++,
        };
        const message = this.databaseMessages.get(id);
        if (message) message.parts.push(part);
        else {
          const parts = this.orphanParts.get(id) || [];
          parts.push(part);
          this.orphanParts.set(id, parts);
        }
        return;
      }
      if (r.source === "session_message") {
        this.direct({ ...v, role: v.role || meta.type }, "opencode-v2", meta);
        return;
      }
      if (r.source === "cursorDiskKV") {
        if (str(meta.key).startsWith("bubbleId:"))
          this.add(
            v.type === 1 ? "user" : v.type === 2 ? "assistant" : v.role,
            str(v.text),
            v,
            "cursor",
            meta,
          );
        else if (str(meta.key).startsWith("composerData:"))
          for (const m of v.conversation || [])
            this.add(
              m.type === 1 ? "user" : m.type === 2 ? "assistant" : m.role,
              str(m.text),
              m,
              "cursor",
              meta,
            );
        return;
      }
      if (r.source === "thread_items" || r.source === "thread_realtime_items") {
        const item = v.item || v;
        if (item.type === "userMessage")
          this.add(
            "user",
            visible(item.content),
            item,
            "codex-projection",
            meta,
          );
        else if (item.type === "agentMessage")
          this.add("assistant", str(item.text), item, "codex-projection", meta);
        else this.direct(item, "codex-projection", meta);
      }
      return;
    }
    if (r.type === "event_msg" && object(r.payload)) {
      const p = r.payload;
      if (p.type === "user_message")
        this.add("user", visible(p.message), p, "codex-event", r);
      else if (p.type === "agent_message")
        this.add("assistant", visible(p.message), p, "codex-event", r);
      return;
    }
    if (r.type === "response_item" && object(r.payload)) {
      if (r.payload.type === "message")
        this.direct(r.payload, "codex-response", r);
      return;
    }
    if (r.type === "user/message") {
      const d = r.data;
      if (
        object(d) &&
        (!d.source?.kind ||
          ["human", "user", "rpc", "cli", "interactive"].includes(
            d.source.kind,
          ))
      )
        this.add("user", visible(d.content), d, "dsh", r);
      return;
    }
    if (r.type === "assistant/message") {
      if (object(r.data?.message))
        this.add(
          "assistant",
          visible(r.data.message.content),
          r.data.message,
          "dsh",
          r,
        );
      return;
    }
    if (r.type === "user" || r.type === "assistant") {
      if (object(r.message))
        this.add(
          r.type,
          visible(r.message.content),
          {
            ...r.message,
            ...r,
            id: r.uuid || r.message.id,
            content: undefined,
          },
          "claude",
        );
      else this.direct(r, "native");
      return;
    }
    if (r.type === "say" && this.source === "CopilotCode") {
      if (r.partial) return;
      const first = !this.uiStarted.has(this.input);
      if (["text", "user_feedback", "completion_result"].includes(r.say)) {
        this.add(
          r.say === "user_feedback" || (r.say === "text" && first)
            ? "user"
            : "assistant",
          str(r.text),
          r,
          "copilot-ui",
        );
        this.uiStarted.add(this.input);
      }
      return;
    }
    if (Array.isArray(r.requests)) {
      for (const request of r.requests) {
        this.add(
          "user",
          str(request.message?.text),
          { id: request.requestId, ...request },
          "vscode",
        );
        const response = Array.isArray(request.response)
          ? request.response
              .filter((p: any) => !p.kind || p.kind === "markdownContent")
              .map((p: any) =>
                typeof p.value === "string" ? p.value : str(p.value?.value),
              )
              .join("\n")
          : "";
        this.add(
          "assistant",
          response,
          { id: `${request.requestId || this.order}:response`, ...request },
          "vscode",
        );
      }
      return;
    }
    if (Array.isArray(r.messages)) {
      for (const m of r.messages) {
        if (m.type === "user" || m.type === "gemini" || m.type === "model")
          this.add(
            m.type === "user" ? "user" : "assistant",
            visible(m.content) || visible(m.parts),
            m,
            "gemini",
          );
        else this.direct(m, "native");
      }
      return;
    }
    this.direct(r, "native");
  }
  finish() {
    for (const { row, meta, order, parts } of this.databaseMessages.values()) {
      const text = parts.length
        ? parts
            .sort((a, b) => a.seq - b.seq || a.order - b.order)
            .map((p) => p.text)
            .join("\n")
        : visible(row.content) || visible(row.parts) || str(row.text);
      const before = this.messages.length;
      this.add(row.role, text, row, "opencode-parts", meta);
      if (this.messages.length > before) this.messages.at(-1)!.order = order;
    }
    let messages = this.messages;
    if (messages.some((m) => m.flavor === "opencode-v2"))
      messages = messages.filter((m) => m.flavor !== "opencode-parts");
    if (messages.some((m) => m.flavor === "copilot-ui"))
      messages = messages.filter((m) => m.flavor === "copilot-ui");
    // Native timestamps order separate SQLite tables; otherwise retain source order.
    if (messages.length && messages.every((m) => m.time))
      messages.sort((a, b) => a.time - b.time || a.order - b.order);
    else messages.sort((a, b) => a.order - b.order);
    const seenIds = new Set<string>(),
      mirrored = new Map<Message, Set<string>>(),
      result: Message[] = [];
    for (const m of messages) {
      const id = m.id ? `${m.role}:${m.id}` : "";
      if (id && seenIds.has(id)) continue;
      if (id) seenIds.add(id);
      const mirror = result
        .slice(-4)
        .find(
          (n) =>
            n.role === m.role &&
            n.text === m.text &&
            !mirrored.get(n)?.has(m.flavor) &&
            (!n.time || !m.time || Math.abs(n.time - m.time) < 10_000) &&
            n.flavor !== m.flavor &&
            n.flavor.startsWith("codex-") &&
            m.flavor.startsWith("codex-"),
        );
      if (mirror) {
        mirrored.get(mirror)!.add(m.flavor);
        continue;
      }
      result.push(m);
      mirrored.set(m, new Set([m.flavor]));
    }
    return {
      text: result
        .map(
          (m, i) =>
            `[${m.role === "user" ? "用户请求原文" : "AI 回复原文"}；第 ${i + 1} 条${m.id ? `；消息 ${JSON.stringify(m.id)}` : ""}]\n${m.text}`,
        )
        .join("\n\n"),
      messageCount: result.length,
      sha256: createHash("sha256")
        .update(result.map((m) => `${m.role}\0${m.text}`).join("\0"))
        .digest("hex"),
    };
  }
}

export async function readConversation(
  file: string,
  root: string,
  source: HandoffSource,
) {
  const conversation = new Conversation(source),
    parser = new JsonStreamValidator(conversation);
  for await (const chunk of fileChunks(file, root)) parser.write(chunk);
  parser.end();
  return conversation.finish();
}
