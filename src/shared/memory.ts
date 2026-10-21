export const MEMORY_AGENTS = [
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude Code" },
  { id: "gemini", label: "Gemini CLI" },
  { id: "cursor", label: "Cursor" },
  { id: "opencode", label: "OpenCode" },
] as const;
export type MemoryAgent = (typeof MEMORY_AGENTS)[number]["id"];
export type MemoryKind = "memory" | "instruction" | "document";
export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  memory: "记忆文件",
  instruction: "持久指令",
  document: "自选文档",
};
export interface MemoryNode {
  id: string;
  documentId: string;
  parentId?: string;
  kind: "document" | "section" | "entry";
  title: string;
  content: string;
  startLine: number;
  endLine: number;
}
export interface MemoryEdge {
  from: string;
  to: string;
  kind: "contains" | "reference";
}
export interface MemoryDocument {
  id: string;
  rootId: string;
  title: string;
  path: string;
  scope: string;
  kind: MemoryKind;
  modified: number;
  frontmatter?: string;
  sourceText?: string;
  truncated: boolean;
}
export interface MemoryRoot {
  path: string;
  status: "read" | "missing" | "error";
  message?: string;
}
export interface MemorySnapshot {
  agent: MemoryAgent;
  checkedAt: number;
  mode: "local" | "demo";
  project?: string;
  documents: MemoryDocument[];
  nodes: MemoryNode[];
  edges: MemoryEdge[];
  roots: MemoryRoot[];
  warnings: string[];
}
export interface MemoryAPI {
  memories(agent: MemoryAgent): Promise<MemorySnapshot>;
  chooseMemoryDirectory(
    agent: MemoryAgent,
    mode: "project" | "memory",
  ): Promise<MemorySnapshot | undefined>;
}

/** Markdown stays inert text. Source line numbers refer to the original file. */
export function parseMemoryDocument(
  document: Omit<MemoryDocument, "rootId" | "truncated">,
  text: string,
  limit = 500,
) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const rootId = `${document.id}:root`;
  const nodes: MemoryNode[] = [
    {
      id: rootId,
      documentId: document.id,
      kind: "document",
      title: document.title,
      content: "",
      startLine: 1,
      endLine: Math.max(1, lines.length),
    },
  ];
  const edges: MemoryEdge[] = [];
  const stack = [{ id: rootId, level: 0 }];
  let start = 0,
    block: string[] = [],
    blockStart = 0;
  let fence: { character: string; length: number } | undefined;
  let truncated = false;
  let frontmatter: string | undefined;
  const add = (node: MemoryNode) => {
    if (nodes.length >= limit) {
      truncated = true;
      return false;
    }
    nodes.push(node);
    if (node.parentId)
      edges.push({ from: node.parentId, to: node.id, kind: "contains" });
    return true;
  };
  const flush = (end: number) => {
    if (!block.length) return;
    const content = block.join("\n").trim();
    if (content)
      add({
        id: `${document.id}:L${blockStart + 1}`,
        documentId: document.id,
        parentId: stack.at(-1)!.id,
        kind: "entry",
        title: memoryTitle(content),
        content,
        startLine: blockStart + 1,
        endLine: end,
      });
    block = [];
  };
  // Keep metadata out of the topology, but preserve offsets in the source.
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex(
      (line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line),
    );
    if (end > 0) {
      start = end + 1;
      frontmatter = lines.slice(0, end + 1).join("\n");
    }
  }
  for (let i = start; i < lines.length; i++) {
    if (truncated) break;
    const line = lines[i];
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      block.push(line);
      if (
        marker &&
        marker[1][0] === fence.character &&
        marker[1].length >= fence.length &&
        !line.trim().slice(marker[1].length).trim()
      )
        fence = undefined;
      continue;
    }
    if (marker) {
      flush(i);
      blockStart = i;
      block.push(line);
      fence = { character: marker[1][0], length: marker[1].length };
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
    if (heading) {
      flush(i);
      const level = heading[1].length;
      while (stack.length > 1 && stack.at(-1)!.level >= level) stack.pop();
      const id = `${document.id}:L${i + 1}`;
      if (
        !add({
          id,
          documentId: document.id,
          parentId: stack.at(-1)!.id,
          kind: "section",
          title: memoryTitle(heading[2]),
          content: line,
          startLine: i + 1,
          endLine: i + 1,
        })
      )
        break;
      stack.push({ id, level });
    } else if (!line.trim()) flush(i);
    else {
      // An indented nested list remains with its parent item.
      if (
        /^(?:[-*+]\s|\d+[.)]\s)/.test(line) ||
        /^\s{0,3}(?:---+|\*\*\*+)\s*$/.test(line)
      )
        flush(i);
      if (!block.length) blockStart = i;
      block.push(line);
    }
  }
  if (!truncated) flush(lines.length);
  // A sole introductory H1 is the document title, not an extra navigation level.
  const first = nodes[1];
  if (
    first?.kind === "section" &&
    /^#\s/.test(first.content) &&
    nodes.filter((n) => n.parentId === rootId).length === 1
  ) {
    nodes[0].title = first.title;
    for (const node of nodes)
      if (node.parentId === first.id) node.parentId = rootId;
    nodes.splice(1, 1);
    edges.splice(
      0,
      edges.length,
      ...nodes
        .filter((n) => n.parentId)
        .map((n) => ({
          from: n.parentId!,
          to: n.id,
          kind: "contains" as const,
        })),
    );
  }
  return {
    document: {
      ...document,
      rootId,
      title: nodes[0].title,
      truncated,
      frontmatter,
      sourceText: text,
    },
    nodes,
    edges,
  };
}

export function memoryTitle(content: string) {
  return (
    content
      .split("\n")
      .find((line) => line.trim())
      ?.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+)/, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*`_]/g, "")
      .trim()
      .slice(0, 100) || "未命名内容"
  );
}

export function emptyMemorySnapshot(
  agent: MemoryAgent,
  mode: "local" | "demo" = "local",
): MemorySnapshot {
  return {
    agent,
    mode,
    checkedAt: Date.now(),
    documents: [],
    nodes: [],
    edges: [],
    roots: [],
    warnings: [],
  };
}
