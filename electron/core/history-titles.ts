/**
 * Source titles are read-only metadata. Hosts inject multi-KB instruction
 * preambles into the same field the user's first message lands in, so a raw
 * title can be an entire policy document. This module only shortens what the
 * source already stores; it never invents or fetches new text.
 */

/** Wrapper blocks injected by the host, never written by the user. */
const PREAMBLE = new Set([
  "wiscode_runtime_instructions",
  "environment_context",
  "user_instructions",
  "system_context",
  "multi_agent_mode",
  "collaboration_mode",
  "model_switch",
  "attachments",
  "upload_url",
]);

/** Host-written placeholder names, never the user's own words. */
const PLACEHOLDER =
  /^\s*(?:untitled\s+(?:[a-z0-9-]+\s+)*session|新会话|未命名会话|未命名对话|无标题对话)\s*$/i;

const TITLE_LENGTH = 160;

const squeeze = (text: string) =>
  text.replace(/\s+/g, " ").trim().slice(0, TITLE_LENGTH).trim();

/**
 * The user's own words from a source title field, or "" when the field only
 * holds host instructions. Hosts append the real request in a trailing
 * `<user_request>` block, so that block wins when it exists.
 */
export function readableTitle(value: unknown): string {
  if (typeof value !== "string") return "";
  let text = value.replace(/\r\n?/g, "\n");
  if (!text.trim()) return "";
  let unwrapped = false;
  const asks = [...text.matchAll(/<user_request>([\s\S]*?)<\/user_request>/g)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  if (asks.length) {
    text = asks.at(-1)!;
    unwrapped = true;
  } else {
    // Some hosts prepend the project's AGENTS.md instead of a tag block.
    if (/^\s*#\s+AGENTS\.md instructions\b/i.test(text)) {
      const close = text.lastIndexOf("</INSTRUCTIONS>");
      if (close >= 0) {
        text = text.slice(close + "</INSTRUCTIONS>".length);
        unwrapped = true;
      }
    }
    // Peel leading wrapper blocks until real prose remains.
    for (let guard = 0; guard < 8; guard++) {
      const open = text.match(/^\s*<([a-z][\w.-]*)>/i);
      if (!open || !PREAMBLE.has(open[1].toLowerCase())) break;
      const close = text.lastIndexOf(`</${open[1]}>`);
      if (close < 0) {
        text = text.slice(open[0].length);
        unwrapped = true;
        continue;
      }
      text = text.slice(close + open[1].length + 3);
      unwrapped = true;
    }
  }
  // Only touch markup when this field was actually a host-wrapped field: a
  // user who typed angle brackets keeps them.
  if (unwrapped) text = text.replace(/<[^>]{1,80}>/g, " ");
  const squeezed = squeeze(text);
  // Hosts pre-fill unnamed sessions with "Untitled Codex Session" &c.; that is
  // not a title and must not mask a better fallback from a later source.
  return PLACEHOLDER.test(squeezed) ? "" : squeezed;
}

export interface CodexSpawn {
  parentThreadId?: string;
  agentPath?: string;
  nickname?: string;
}

/** A subagent fork records its role in `source.subagent.thread_spawn`. */
export function codexSpawn(
  source: unknown,
  agentPath?: unknown,
  nickname?: unknown,
): CodexSpawn | undefined {
  const spawn: CodexSpawn = {
    agentPath: typeof agentPath === "string" && agentPath ? agentPath : undefined,
    nickname: typeof nickname === "string" && nickname ? nickname : undefined,
  };
  let parsed: any = source;
  if (typeof source === "string") {
    try {
      parsed = JSON.parse(source);
    } catch {
      parsed = {};
    }
  }
  const thread =
    parsed && typeof parsed === "object"
      ? parsed.subagent?.thread_spawn
      : undefined;
  if (thread && typeof thread === "object") {
    if (typeof thread.parent_thread_id === "string")
      spawn.parentThreadId = thread.parent_thread_id;
    if (!spawn.agentPath && typeof thread.agent_path === "string")
      spawn.agentPath = thread.agent_path;
    if (!spawn.nickname && typeof thread.agent_nickname === "string")
      spawn.nickname = thread.agent_nickname;
  }
  return spawn.parentThreadId || spawn.agentPath || spawn.nickname
    ? spawn
    : undefined;
}

/**
 * Subagent forks carry no title of their own. Name them by the role they were
 * spawned for (`/root/resource_gate` → `resource_gate`), then by nickname, and
 * only as a last resort by the parent conversation they belong to.
 */
export function subagentTitle(
  spawn: CodexSpawn | undefined,
  parentTitle = "",
): string {
  const leaf =
    (spawn?.agentPath || "")
      .split(/[\\/]/)
      .filter(Boolean)
      .pop()
      ?.replace(/[\s<>]+/g, "") || "";
  const role = leaf && leaf !== "root" ? leaf : "";
  const name = spawn?.nickname ? squeeze(spawn.nickname) : "";
  if (role && name) return squeeze(`${role}（子代理 ${name}）`);
  if (role) return role;
  if (name) return squeeze(`子代理 ${name}`);
  if (parentTitle) return squeeze(`${parentTitle} · 子会话`);
  return "";
}
