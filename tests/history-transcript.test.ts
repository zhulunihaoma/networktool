import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { readConversation } from "../electron/core/history-transcript";
import { HistoryService } from "../electron/core/history-service";
import { HandoffManager } from "../electron/core/handoff";
import type { HandoffSource } from "../src/shared/handoff-api";

async function read(records: unknown[], source: HandoffSource = "ZCode") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dialogue-test-"));
  try {
    const file = path.join(root, "archive.jsonl");
    await fs.writeFile(file, records.map((r) => JSON.stringify(r)).join("\n"));
    return await readConversation(file, root, source);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
const row = (source: string, identity: unknown, record: unknown) => ({
  source,
  identity,
  record,
});
const digest = (entries: [string, string][]) =>
  createHash("sha256")
    .update(entries.map(([role, text]) => `${role}\0${text}`).join("\0"))
    .digest("hex");

test("ZCode joins real message parts in chronological order and excludes internal metadata", async () => {
  const result = await read([
    row("identity", {}, { title: "NOT_DIALOGUE", text: "CONFIGURATION" }),
    row("message", { id: "a", time_created: 2000 }, { role: "assistant" }),
    row("message", { id: "z", time_created: 1000 }, { role: "user" }),
    row(
      "message",
      { id: "hidden", time_created: 1500 },
      { role: "user", semantics: { uiVisibility: "hidden" } },
    ),
    row(
      "part",
      { message_id: "a", sequence: 2 },
      { type: "text", text: "后半段" },
    ),
    row(
      "part",
      { message_id: "z", sequence: 1 },
      { type: "text", text: "  用户原文\n保留空白和中文🙂  " },
    ),
    row(
      "part",
      { message_id: "a", sequence: 1 },
      { type: "text", text: "前半段" },
    ),
    row("part", { message_id: "hidden" }, { type: "text", text: "HIDDEN" }),
    row(
      "part",
      { message_id: "z" },
      { type: "reasoning", text: "PRIVATE_REASONING" },
    ),
    row(
      "part",
      { message_id: "a" },
      { type: "tool", state: { input: { text: "TOOL_INPUT" } } },
    ),
  ]);
  assert.equal(result.messageCount, 2);
  assert.equal(
    result.sha256,
    digest([
      ["user", "  用户原文\n保留空白和中文🙂  "],
      ["assistant", "前半段\n后半段"],
    ]),
  );
  assert.doesNotMatch(
    result.text,
    /CONFIGURATION|HIDDEN|PRIVATE_REASONING|TOOL_INPUT/,
  );
});

test("OpenCode v2 roles come from native row types, text blocks retain their original order", async () => {
  const result = await read(
    [
      row(
        "session_message",
        { id: "u", type: "user", seq: 0, time_created: 1000 },
        { text: "真实请求" },
      ),
      row(
        "session_message",
        { id: "a", type: "assistant", seq: 1, time_created: 2000 },
        {
          content: [
            { type: "reasoning", text: "HIDDEN" },
            { type: "text", text: "回答一" },
            {
              type: "tool",
              state: { content: [{ type: "text", text: "TOOL" }] },
            },
            { type: "text", text: "回答二" },
          ],
        },
      ),
    ],
    "OpenCode",
  );
  assert.equal(
    result.sha256,
    digest([
      ["user", "真实请求"],
      ["assistant", "回答一\n回答二"],
    ]),
  );
});

test("Codex event/response mirrors are deduplicated without dropping repeated real requests", async () => {
  const response = {
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "继续" }],
    },
  };
  const event = {
    type: "event_msg",
    payload: { type: "user_message", message: "继续" },
  };
  const result = await read(
    [
      response,
      event,
      event,
      response,
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          channel: "analysis",
          content: [{ type: "output_text", text: "PRIVATE_REASONING" }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          channel: "final",
          content: [{ type: "output_text", text: "已完成" }],
        },
      },
    ],
    "Codex",
  );
  assert.equal(result.messageCount, 3);
  assert.equal(
    result.sha256,
    digest([
      ["user", "继续"],
      ["user", "继续"],
      ["assistant", "已完成"],
    ]),
  );
});

test("Claude replies sharing a provider ID preserve distinct committed message UUIDs", async () => {
  const result = await read(
    [
      { type: "user", uuid: "u", message: { role: "user", content: "问题" } },
      {
        type: "assistant",
        uuid: "a1",
        message: {
          id: "provider-message",
          role: "assistant",
          content: [{ type: "text", text: "第一段" }],
        },
      },
      {
        type: "assistant",
        uuid: "a2",
        message: {
          id: "provider-message",
          role: "assistant",
          content: [{ type: "text", text: "第二段" }],
        },
      },
    ],
    "ClaudeCode",
  );
  assert.equal(
    result.sha256,
    digest([
      ["user", "问题"],
      ["assistant", "第一段"],
      ["assistant", "第二段"],
    ]),
  );
});

test("DSH, WorkBuddy, Cursor and VS Code native visible messages are recognized", async () => {
  const fixtures: [HandoffSource, unknown[], [string, string][]][] = [
    [
      "DeepSeekHarness",
      [
        {
          type: "user/message",
          data: { id: "u", content: "问题", source: { kind: "human" } },
        },
        {
          type: "assistant/message",
          data: {
            message: { id: "a", content: [{ type: "text", text: "回复" }] },
          },
        },
      ],
      [
        ["user", "问题"],
        ["assistant", "回复"],
      ],
    ],
    [
      "WorkBuddy",
      [
        {
          type: "message",
          role: "user",
          content: [{ type: "text", text: "问题" }],
        },
        { type: "message", role: "assistant", content: "回复" },
      ],
      [
        ["user", "问题"],
        ["assistant", "回复"],
      ],
    ],
    [
      "Cursor",
      [
        row("cursorDiskKV", { key: "bubbleId:x:u" }, { type: 1, text: "问题" }),
        row("cursorDiskKV", { key: "bubbleId:x:a" }, { type: 2, text: "回复" }),
      ],
      [
        ["user", "问题"],
        ["assistant", "回复"],
      ],
    ],
    [
      "VSCode",
      [
        {
          requests: [
            {
              requestId: "u",
              message: { text: "问题" },
              response: [{ kind: "markdownContent", value: "回复" }],
            },
          ],
        },
      ],
      [
        ["user", "问题"],
        ["assistant", "回复"],
      ],
    ],
  ];
  for (const [source, records, expected] of fixtures)
    assert.equal(
      (await read(records, source)).sha256,
      digest(expected),
      source,
    );
});

test("Copilot UI text takes precedence over duplicated API history", async () => {
  const result = await read(
    [
      [
        { type: "say", say: "text", text: "问题" },
        { type: "say", say: "text", text: "回复" },
        { type: "say", say: "user_feedback", text: "再问" },
      ],
      [
        { role: "user", content: "问题" },
        { role: "assistant", content: "回复" },
      ],
    ],
    "CopilotCode",
  );
  assert.equal(
    result.sha256,
    digest([
      ["user", "问题"],
      ["assistant", "回复"],
      ["user", "再问"],
    ]),
  );
});

test("copy includes all visible text beyond old 8K/48K/120K cuts, with only explicit redactions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dialogue-copy-test-"));
  const history = new HistoryService(path.join(root, "owned"), root);
  try {
    const file = path.join(root, "export.json");
    const text = "FULL_BEGIN\n" + "中🙂\n".repeat(64 * 1024) + "\nFULL_END";
    await fs.writeFile(
      file,
      JSON.stringify({
        info: { id: "x", title: "长对话", directory: "/project" },
        messages: [
          { info: { id: "u", role: "user" }, parts: [{ type: "text", text }] },
          {
            info: { id: "a", role: "assistant" },
            parts: [{ type: "text", text: "回复原文\napi_key=private-secret" }],
          },
        ],
      }),
    );
    const manager = new HandoffManager(
      undefined,
      undefined,
      undefined,
      history,
    );
    const imported = await manager.importFile(file);
    assert.equal(imported.messageCount, 2);
    assert(imported.transcript.includes(text));
    assert(!imported.transcript.includes("private-secret"));
    const preview = manager.prepare("继续", "Codex");
    assert(preview.content.includes(text));
    let copied = "";
    await manager.copy(preview.token, async (value) => {
      copied = value;
    });
    assert.equal(copied, preview.content);
    assert(copied.includes("FULL_END"));
  } finally {
    history.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
