import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MemoryScanner, MEMORY_LIMITS } from "../electron/core/memory";
import { parseMemoryDocument, emptyMemorySnapshot } from "../src/shared/memory";
import { memoryGraph } from "../src/shared/memory-graph";

const metadata = {
  id: "test",
  title: "MEMORY.md",
  path: "/test/MEMORY.md",
  kind: "memory" as const,
  scope: "用户级",
  modified: 1,
};
const parse = (text: string, limit?: number) =>
  parseMemoryDocument(metadata, text, limit);
async function fixture(
  run: (
    scanner: MemoryScanner,
    home: string,
    put: (relative: string, text: string) => Promise<string>,
  ) => Promise<void>,
) {
  const home = await mkdtemp(path.join(os.tmpdir(), "network-memory-"));
  const put = async (relative: string, text: string) => {
    const file = path.join(home, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
    return file;
  };
  try {
    await run(new MemoryScanner(home), home, put);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("parses headings, separate items, nested lists and original source lines", () => {
  const result = parse(
    "---\nname: sample\n---\n# Project\n## Preferences\n- Speak Chinese\n  - Keep commands unchanged\n- Explain changes\n\n## Decisions\nRead local files.\n",
  );
  assert.equal(result.document.title, "Project");
  assert.equal(result.document.frontmatter, "---\nname: sample\n---");
  assert.equal(result.nodes.filter((n) => n.kind === "section").length, 2);
  const item = result.nodes.find((n) => n.title === "Speak Chinese")!;
  assert.equal(item.startLine, 6);
  assert.equal(item.endLine, 7);
  assert.match(item.content, /Keep commands/);
  assert.equal(
    result.nodes.find((n) => n.id === item.parentId)?.title,
    "Preferences",
  );
  assert.equal(
    result.nodes.find((n) => n.title === "Explain changes")?.startLine,
    8,
  );
  assert(
    result.edges.every(
      (e) =>
        result.nodes.some((n) => n.id === e.from) &&
        result.nodes.some((n) => n.id === e.to),
    ),
  );
});

test("does not turn headings or list markers inside code fences into graph structure", () => {
  const result = parse(
    "# Memory\n## Code\n````md\n# Fake heading\n- Fake item\n```\n````\n\n## Real heading\nA fact.",
  );
  assert.deepEqual(
    result.nodes.filter((n) => n.kind === "section").map((n) => n.title),
    ["Code", "Real heading"],
  );
  assert.match(
    result.nodes.find((n) => n.kind === "entry")!.content,
    /# Fake heading/,
  );
});

test("makes truncation explicit and preserves separate H1 scopes", () => {
  const result = parse("# One\n- a\n# Two\n- b", 3);
  assert.equal(result.document.truncated, true);
  assert(result.nodes.length <= 3);
  const both = parse("# One\na\n# Two\nb");
  assert.deepEqual(
    both.nodes
      .filter((n) => n.parentId === both.document.rootId)
      .map((n) => n.title),
    ["One", "Two"],
  );
});

test("discovers five agents separately and reads selected project entry points", async () =>
  fixture(async (scanner, home, put) => {
    await put(".codex/memories/MEMORY.md", "# Codex\n- codex fact");
    await put(
      ".claude/projects/demo/memory/MEMORY.md",
      "# Claude\n- claude fact",
    );
    await put(".gemini/GEMINI.md", "# Gemini\n- gemini fact");
    await put(
      ".cursor/rules/global.mdc",
      "---\nalwaysApply: true\n---\n# Cursor\n- cursor rule",
    );
    await put(".config/opencode/AGENTS.md", "# OpenCode\n- opencode rule");
    await put("project/AGENTS.md", "# Shared instructions\n- project rule");
    scanner.setProject(path.join(home, "project"));
    for (const agent of [
      "codex",
      "claude",
      "gemini",
      "cursor",
      "opencode",
    ] as const) {
      const result = await scanner.scan(agent);
      assert.equal(result.agent, agent);
      assert(result.documents.length > 0);
      assert.equal(result.mode, "local");
      assert(
        result.nodes.some((n) =>
          n.content.includes(
            `${agent} ${agent === "cursor" || agent === "opencode" ? "rule" : "fact"}`,
          ),
        ),
      );
      if (["codex", "claude", "cursor", "opencode"].includes(agent))
        assert(
          result.documents.some((d) => d.scope === path.join(home, "project")),
        );
      for (const other of [
        "codex",
        "claude",
        "gemini",
        "cursor",
        "opencode",
      ].filter((x) => x !== agent))
        assert(
          !result.nodes.some(
            (n) =>
              n.content === `- ${other} fact` ||
              n.content === `- ${other} rule`,
          ),
        );
    }
  }));

test("sanitizes secrets without shifting source lines or modifying any source", async () =>
  fixture(async (scanner, home, put) => {
    const raw =
      "# Secrets\nAuthorization: Bearer private-token\n\n-----BEGIN PRIVATE KEY-----\nprivate contents\n-----END PRIVATE KEY-----\n\n## Later\n- token=example-secret\n- ordinary fact\n";
    const file = await put(".codex/memories/MEMORY.md", raw);
    const result = await scanner.scan("codex");
    const output = JSON.stringify(result);
    for (const secret of [
      "private-token",
      "private contents",
      "example-secret",
    ])
      assert(!output.includes(secret));
    assert.match(output, /已脱敏/);
    assert.equal(result.nodes.find((n) => n.title === "Later")?.startLine, 8);
    assert.equal(
      result.nodes.find((n) => n.title === "ordinary fact")?.startLine,
      10,
    );
    assert.equal(await readFile(file, "utf8"), raw);
  }));

test("only connects explicit references to documents already found; no remote fetch or path-following", async () =>
  fixture(async (scanner, home, put) => {
    await put(
      ".codex/memories/MEMORY.md",
      "# Index\n- [Topic](topic.md)\n- [External](https://example.com/remote.md)\n- [Outside](../../outside.md)",
    );
    await put(".codex/memories/topic.md", "# Topic\n- a real fact");
    await put("outside.md", "private outside document");
    const result = await scanner.scan("codex");
    const refs = result.edges.filter((e) => e.kind === "reference");
    assert.equal(refs.length, 1);
    assert.equal(result.nodes.find((n) => n.id === refs[0].to)?.title, "Topic");
    assert(!JSON.stringify(result).includes("private outside document"));
  }));

test("skips transcripts, symlinks, huge files and non-Markdown documents", async () =>
  fixture(async (scanner, home, put) => {
    const good = await put(".codex/memories/MEMORY.md", "# Good\n- readable");
    await put(
      ".codex/memories/rollout_summaries/history.md",
      "transcript contents",
    );
    await put(".codex/memories/token.json", "private settings");
    await put(
      ".codex/memories/huge.md",
      "x".repeat(MEMORY_LIMITS.fileBytes + 1),
    );
    await symlink(good, path.join(home, ".codex/memories/linked.md"));
    const result = await scanner.scan("codex");
    assert.equal(result.documents.length, 1);
    assert(!JSON.stringify(result).includes("transcript contents"));
    assert(result.warnings.some((w) => w.includes("256 KB")));
    assert(result.warnings.some((w) => w.includes("符号链接")));
  }));

test("rejects linked ancestors and reports an actual missing state", async () =>
  fixture(async (scanner, home, put) => {
    assert.equal((await scanner.scan("codex")).documents.length, 0);
    assert(
      (await scanner.scan("codex")).roots.some((r) => r.status === "missing"),
    );
    const target = path.join(home, "elsewhere");
    await put("elsewhere/MEMORY.md", "outside scope");
    await mkdir(path.join(home, ".codex"));
    await symlink(target, path.join(home, ".codex/memories"));
    const result = await scanner.scan("codex");
    assert.equal(result.documents.length, 0);
    assert(result.roots.some((r) => r.status === "error"));
    assert.throws(() => scanner.setProject("../bad"), /绝对/);
  }));

test("custom source directories stay isolated to the selected Agent and deduplicate documents", async () =>
  fixture(async (scanner, home, put) => {
    const file = await put("custom/topic.md", "# Custom\n- manual");
    scanner.addDirectory("gemini", path.dirname(file));
    scanner.addDirectory("gemini", path.dirname(file));
    assert.equal((await scanner.scan("gemini")).documents.length, 1);
    assert.equal((await scanner.scan("codex")).documents.length, 0);
  }));

test("graph paginates complete branches and exposes references without dangling edges", () => {
  const result = parse(
    "# Root\n## A\n- a\n- b\n- c\n## B\n- d\n## C\n- e\n## D\n- f",
  );
  const snapshot = {
    ...emptyMemorySnapshot("codex"),
    documents: [result.document],
    nodes: result.nodes,
    edges: result.edges,
  };
  const graph = memoryGraph(snapshot, result.document.rootId, 0, 720);
  assert.equal(graph.pages, 2);
  assert(graph.nodes.length <= 10);
  assert(
    graph.nodes.every(
      (n) => n.x - n.width / 2 >= 0 && n.x + n.width / 2 <= 720,
    ),
  );
  const last = memoryGraph(snapshot, result.document.rootId, 20, 320);
  assert.equal(last.page, 3);
  assert(last.nodes.some((n) => n.node.title === "D"));
  const visible = new Set(graph.nodes.map((n) => n.node.id));
  assert(graph.edges.every((e) => visible.has(e.from) && visible.has(e.to)));
  const a = result.nodes.find((n) => n.title === "A")!;
  assert.equal(memoryGraph(snapshot, a.id, 0, 720).nodes.length, 4);
});
