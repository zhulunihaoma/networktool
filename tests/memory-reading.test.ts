import test from "node:test";
import assert from "node:assert/strict";
import {
  parseMemoryDocument,
  emptyMemorySnapshot,
  type MemorySnapshot,
} from "../src/shared/memory";
import {
  memoryReading,
  memoryReadingScope,
  memoryPlainText,
} from "../src/shared/memory-reading";
import { memoryOverviewGraph } from "../src/shared/memory-graph";

function fixture(): MemorySnapshot {
  const files = [
    {
      id: "index",
      path: "/home/user/.codex/memories/MEMORY.md",
      text: "# Index\n## User preferences\n- [查看协作偏好](preferences.md)\n",
    },
    {
      id: "prefs",
      path: "/home/user/.codex/memories/preferences.md",
      text: "# Preferences\n## User preferences\n- **先说结论**，再解释原因。\n- 控制修改范围。\n  适用场景：只修改当前任务。\n  示例：保留其他未提交文件。\n",
    },
    {
      id: "project",
      path: "/home/user/.codex/memories/projects/networktool.md",
      text: "# 项目约定\n## 项目知识\n- 默认从本机文件读取。\n- 保留原文行号。\n## 排查经验\n- 来源变更后刷新。\n",
    },
    {
      id: "summary",
      path: "/home/user/.codex/memories/memory_summary.md",
      text: "# Summary\n- 仅总览中存在的原文也应保留。\n",
    },
  ];
  const result = emptyMemorySnapshot("codex");
  for (const file of files) {
    const parsed = parseMemoryDocument(
      {
        id: file.id,
        title: file.path.split("/").at(-1)!,
        path: file.path,
        kind: "memory",
        scope: "用户级",
        modified: 1,
      },
      file.text,
    );
    result.documents.push(parsed.document);
    result.nodes.push(...parsed.nodes);
    result.edges.push(...parsed.edges);
  }
  const reference = result.nodes.find(
    (n) => n.documentId === "index" && n.kind === "entry",
  )!;
  result.edges.push({
    from: reference.id,
    to: "prefs:root",
    kind: "reference",
  });
  return result;
}

test("groups real entries across files without dropping index-only content or source evidence", () => {
  const snapshot = fixture(),
    reading = memoryReading(snapshot);
  assert.equal(reading.files.length, 4);
  assert.equal(
    reading.items.length,
    snapshot.nodes.filter((n) => n.kind === "entry").length,
  );
  const preferences = reading.groups.find((g) => g.label === "协作偏好")!;
  assert.equal(
    new Set(preferences.items.map((i) => i.node.documentId)).size,
    2,
  );
  assert.equal(preferences.items[0].file.document.id, "prefs");
  assert(reading.items.some((i) => i.text.includes("仅总览中存在")));
  assert(
    reading.items.every(
      (i) => i.node.startLine > 0 && i.file.document.path && i.node.content,
    ),
  );
  assert.equal(
    reading.files.find((f) => f.document.id === "index")?.role,
    "index",
  );
  assert.equal(
    reading.files.find((f) => f.document.id === "summary")?.role,
    "overview",
  );
  assert.equal(
    reading.files.find((f) => f.document.id === "project")?.pathLabel,
    "memories/projects/networktool.md",
  );
});

test("reading cleanup retains source wording, code identifiers, and original line numbers", () => {
  assert.equal(
    memoryPlainText("- **说明**：使用 `API_KEY`，参见 [文档](notes.md)。"),
    "说明：使用 API_KEY，参见 文档。",
  );
  assert.equal(
    memoryPlainText("  - desc: 读取来源\n  - learnings: 保留范围"),
    "说明： 读取来源\n经验： 保留范围",
  );
  const code = "```sh\n# keep comment\ncommand --api_key=example\n```";
  assert.equal(memoryPlainText(code), code);
  const snapshot = fixture(),
    reading = memoryReading(snapshot);
  const item = reading.items.find((i) => i.text.startsWith("先说结论"))!;
  assert.equal(item.node.startLine, 3);
  assert.match(item.node.content, /\*\*先说结论\*\*/);
  assert.equal(item.title, "先说结论，再解释原因。");
  assert.equal(
    snapshot.documents
      .find((d) => d.id === "prefs")
      ?.sourceText?.split("\n")[2],
    item.node.content,
  );
});

test("does not invent a use case or example when source does not contain one", () => {
  const reading = memoryReading(fixture());
  const first = reading.items.find((i) => i.text.startsWith("先说结论"))!;
  assert.equal(first.when, undefined);
  assert.equal(first.example, undefined);
  const explicit = reading.items.find((i) =>
    i.text.startsWith("控制修改范围"),
  )!;
  assert.equal(explicit.when, "适用场景：只修改当前任务。");
  assert.equal(explicit.example, "示例：保留其他未提交文件。");
});

test("scopes by actual source document and topic without mixing other files", () => {
  const reading = memoryReading(fixture());
  const prefs = memoryReadingScope(reading.groups, "prefs");
  assert(
    prefs.flatMap((g) => g.items).every((i) => i.node.documentId === "prefs"),
  );
  assert.equal(prefs.flatMap((g) => g.items).length, 2);
  const group = reading.groups.find((g) => g.label === "协作偏好")!;
  assert.equal(memoryReadingScope(reading.groups, "", group.id).length, 1);
  assert.equal(memoryReadingScope(reading.groups, "absent").length, 0);
});

test("overview graph spans files, keeps explicit references and fits every supported width", () => {
  const snapshot = fixture(),
    reading = memoryReading(snapshot);
  for (const width of [260, 430, 550, 800]) {
    const graph = memoryOverviewGraph(snapshot, reading.groups, 0, width);
    const seen = new Set(graph.nodes.map((n) => n.id));
    assert(graph.nodes.some((n) => n.node?.documentId === "prefs"));
    assert(graph.nodes.some((n) => n.node?.documentId === "project"));
    assert(
      graph.nodes.every(
        (n) =>
          n.x - n.width / 2 >= 0 &&
          n.x + n.width / 2 <= width &&
          n.y + n.height / 2 <= graph.height,
      ),
    );
    assert(graph.edges.every((e) => seen.has(e.from) && seen.has(e.to)));
    for (let i = 0; i < graph.nodes.length; i++)
      for (let j = i + 1; j < graph.nodes.length; j++) {
        const a = graph.nodes[i],
          b = graph.nodes[j];
        assert(
          !(
            Math.abs(a.x - b.x) < (a.width + b.width) / 2 &&
            Math.abs(a.y - b.y) < (a.height + b.height) / 2
          ),
        );
      }
  }
  const indexScope = memoryReadingScope(reading.groups, "index");
  const graph = memoryOverviewGraph(snapshot, indexScope, 0, 550);
  assert(
    graph.edges.some((e) => e.kind === "reference" && e.to === "prefs:root"),
  );
});
