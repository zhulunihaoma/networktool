import type { MemoryDocument, MemoryNode, MemorySnapshot } from "./memory";

export type MemoryFileRole = "overview" | "index" | "topic" | "instruction";
export interface MemoryReadingFile {
  document: MemoryDocument;
  name: string;
  pathLabel: string;
  label: string;
  role: MemoryFileRole;
  roleLabel: string;
  purpose: string;
  count: number;
}
export interface MemoryReadingItem {
  node: MemoryNode;
  file: MemoryReadingFile;
  title: string;
  summary: string;
  text: string;
  context: string[];
  groupId: string;
  groupLabel: string;
  when?: string;
  example?: string;
}
export interface MemoryReadingGroup {
  id: string;
  label: string;
  items: MemoryReadingItem[];
}

/** Formatting only: never invents an interpretation, use case, or example. */
export function memoryPlainText(source: string): string {
  if (/^\s*(?:`{3,}|~{3,})/.test(source)) return source.trim();
  return source
    .replace(/^\s{0,3}(?:`{3,}|~{3,}).*$/gm, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s?)/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "[图片：$1]")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_match, a, b) => a || b)
    .replace(
      /^(\s*)(desc|description|learnings|rollout_path)\s*:/gim,
      (_match, space, field) =>
        `${space}${({ desc: "说明", description: "说明", learnings: "经验", rollout_path: "来源记录" } as Record<string, string>)[field.toLowerCase()]}：`,
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function memoryHeading(title: string): string {
  const plain = memoryPlainText(title);
  const labels: Record<string, string> = {
    用户偏好: "协作偏好",
    "user profile": "用户背景",
    "user preferences": "协作偏好",
    preferences: "协作偏好",
    "general tips": "工作约定",
    "project knowledge": "项目知识",
    decisions: "历史决策",
    troubleshooting: "排查经验",
    learnings: "经验记录",
    workflow: "工作流程",
  };
  return labels[plain.toLowerCase()] || plain;
}
const sentence = (text: string, maximum: number) => {
  const first =
    text
      .split(/\n|(?<=[。！？])|(?<=[.!?])\s+(?=[A-Z])/u)
      .find((line) => line.trim())
      ?.trim() || "空白内容";
  return first.length > maximum ? `${first.slice(0, maximum)}…` : first;
};

export function memoryReading(snapshot: MemorySnapshot) {
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const entries = snapshot.nodes.filter((node) => node.kind === "entry");
  const files: MemoryReadingFile[] = snapshot.documents.map((document) => {
    const name = document.path.split(/[\\/]/).at(-1) || document.title;
    const role: MemoryFileRole =
      document.kind === "instruction"
        ? "instruction"
        : /^(memory[_-]?summary|summary)\.md$/i.test(name)
          ? "overview"
          : /^(MEMORY|index)\.md$/i.test(name)
            ? "index"
            : "topic";
    const roles = {
      overview: [
        "总览摘要",
        "汇总入口。可对照主题文件核对内容，摘要不替代来源原文。",
      ],
      index: [
        "记忆入口",
        "记忆入口与主题引用。保留其中的正文，并可沿显式引用打开其他文件。",
      ],
      topic: ["主题内容", "专题内容。按原文章节阅读，保留每一段的来源位置。"],
      instruction: [
        "持久指令",
        "Agent 的指令文件；文件存在不表示当前会话已加载或执行其中的约定。",
      ],
    };
    const normalized = document.path.replace(/\\/g, "/");
    const marker =
      /\/(\.(?:codex|claude|gemini|cursor)|\.config\/opencode)\//.exec(
        normalized,
      );
    const pathLabel = marker
      ? normalized.slice(marker.index + marker[0].length)
      : normalized;
    return {
      document,
      name,
      pathLabel,
      label: memoryHeading(document.title),
      role,
      roleLabel: roles[role][0],
      purpose: roles[role][1],
      count: entries.filter((n) => n.documentId === document.id).length,
    };
  });
  const byDocument = new Map(files.map((file) => [file.document.id, file]));
  const items: MemoryReadingItem[] = entries.flatMap((node) => {
    const file = byDocument.get(node.documentId);
    if (!file) return [];
    const context: string[] = [];
    let parent = node.parentId ? byId.get(node.parentId) : undefined;
    const visited = new Set<string>([node.id]);
    while (parent && !visited.has(parent.id)) {
      visited.add(parent.id);
      if (parent.kind === "section")
        context.unshift(memoryHeading(parent.title));
      parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }
    const groupLabel =
      context.find(
        (title) =>
          !/^\d{4}[-/]/.test(title) && !/^(?:[A-Za-z]:[\\/]|\/)/.test(title),
      ) || file.label;
    const groupId = `topic:${groupLabel}`;
    const text = memoryPlainText(node.content);
    const lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return [
      {
        node,
        file,
        title: /^\s*(?:`{3,}|~{3,})/.test(node.content)
          ? `${context.at(-1) || "原文"} · 代码片段`
          : sentence(text, 60),
        summary: sentence(text, 180),
        text,
        context,
        groupId,
        groupLabel,
        when: lines.find((line) =>
          /^(?:适用(?:场景)?|触发(?:条件)?|使用场景|when to use)\s*[:：]/i.test(
            line,
          ),
        ),
        example: lines.find((line) =>
          /^(?:示例|例如|举例|example)\s*[:：]/i.test(line),
        ),
      },
    ];
  });
  const groups = new Map<string, MemoryReadingGroup>();
  for (const item of items) {
    const group = groups.get(item.groupId) || {
      id: item.groupId,
      label: item.groupLabel,
      items: [],
    };
    group.items.push(item);
    groups.set(group.id, group);
  }
  const priority = (item: MemoryReadingItem) =>
    ["overview", "index"].includes(item.file.role) ? 1 : 0;
  const orderedGroups = [...groups.values()];
  for (const group of orderedGroups)
    group.items.sort((a, b) => priority(a) - priority(b));
  orderedGroups.sort(
    (a, b) =>
      Math.min(...a.items.map(priority)) - Math.min(...b.items.map(priority)),
  );
  return { files, items, groups: orderedGroups };
}

export function memoryReadingScope(
  groups: MemoryReadingGroup[],
  fileId = "",
  groupId = "",
) {
  return groups
    .filter((group) => !groupId || group.id === groupId)
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) => !fileId || item.node.documentId === fileId,
      ),
    }))
    .filter((group) => group.items.length);
}
