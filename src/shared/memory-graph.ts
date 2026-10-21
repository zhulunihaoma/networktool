import type { MemoryNode, MemorySnapshot } from "./memory";
import type { MemoryReadingGroup } from "./memory-reading";

export interface MemoryOverviewNode {
  id: string;
  title: string;
  subtitle: string;
  kind: "root" | "group" | "entry" | "reference";
  node?: MemoryNode;
  groupId?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Overview spans source files. Reference edges retain their original evidence. */
export function memoryOverviewGraph(
  snapshot: MemorySnapshot,
  groups: MemoryReadingGroup[],
  page: number,
  width: number,
) {
  const columns = width < 430 ? 1 : 2;
  const pages = Math.max(1, Math.ceil(groups.length / 4));
  const current = Math.max(0, Math.min(page, pages - 1));
  const nodeWidth = Math.min(196, (width - 36) / columns - 24);
  const nodes: MemoryOverviewNode[] = [
    {
      id: "overview:root",
      title: "记忆内容",
      subtitle: `${groups.length} 个主题`,
      kind: "root",
      x: width / 2,
      y: 44,
      width: Math.min(220, width - 30),
      height: 70,
    },
  ];
  const edges: { from: string; to: string; kind: "contains" | "reference" }[] =
    [];
  let height = 250;
  groups.slice(current * 4, (current + 1) * 4).forEach((group, i) => {
    const x = 18 + ((width - 36) / columns) * ((i % columns) + 0.5),
      base = Math.floor(i / columns) * 340;
    nodes.push({
      id: group.id,
      title: group.label,
      subtitle: `${group.items.length} 项 · 点击展开`,
      kind: "group",
      groupId: group.id,
      x,
      y: 140 + base,
      width: nodeWidth,
      height: 90,
    });
    edges.push({ from: "overview:root", to: group.id, kind: "contains" });
    group.items.slice(0, 2).forEach((item, row) => {
      nodes.push({
        id: item.node.id,
        title: item.title,
        subtitle: `${item.file.name} · 第 ${item.node.startLine} 行`,
        kind: "entry",
        node: item.node,
        x,
        y: 242 + base + row * 120,
        width: nodeWidth,
        height: 106,
      });
      edges.push({ from: group.id, to: item.node.id, kind: "contains" });
      height = Math.max(height, 242 + base + row * 120 + 70);
    });
  });
  const visible = new Set(nodes.map((node) => node.id));
  const references = snapshot.edges.filter(
    (edge) => edge.kind === "reference" && visible.has(edge.from),
  );
  const targets = [...new Set(references.map((edge) => edge.to))]
    .filter((id) => !visible.has(id))
    .slice(0, columns);
  targets.forEach((id, i) => {
    const node = snapshot.nodes.find((node) => node.id === id),
      document = snapshot.documents.find((d) => d.id === node?.documentId);
    if (!node || !document) return;
    nodes.push({
      id,
      title: document.path.split(/[\\/]/).at(-1) || document.title,
      subtitle: "原文引用的文件",
      kind: "reference",
      node,
      x: 18 + ((width - 36) / targets.length) * (i + 0.5),
      y: height + 30,
      width: nodeWidth,
      height: 70,
    });
    visible.add(id);
  });
  if (targets.length) height += 100;
  edges.push(...references.filter((edge) => visible.has(edge.to)));
  return { nodes, edges, pages, page: current, height };
}

export interface MemoryGraphNode {
  node: MemoryNode;
  x: number;
  y: number;
  width: number;
  more: number;
}
export function memoryGraph(
  snapshot: MemorySnapshot,
  focusId: string,
  page: number,
  width: number,
) {
  const focus = snapshot.nodes.find((n) => n.id === focusId);
  if (!focus)
    return {
      nodes: [] as MemoryGraphNode[],
      edges: [],
      pages: 1,
      page: 0,
      height: 300,
    };
  const columns = width < 380 ? 1 : width < 590 ? 2 : 3;
  const direct = snapshot.nodes.filter((n) => n.parentId === focusId);
  const pages = Math.max(1, Math.ceil(direct.length / columns));
  const current = Math.min(Math.max(0, page), pages - 1);
  const nodeWidth = Math.min(178, (width - 40) / columns - 24);
  const nodes: MemoryGraphNode[] = [
    {
      node: focus,
      x: width / 2,
      y: 48,
      width: Math.min(230, width - 40),
      more: direct.length,
    },
  ];
  const groups = direct.slice(current * columns, (current + 1) * columns);
  let height = 230;
  groups.forEach((node, column) => {
    const x = 20 + ((width - 40) / columns) * (column + 0.5);
    const children = snapshot.nodes.filter((n) => n.parentId === node.id);
    nodes.push({ node, x, y: 158, width: nodeWidth, more: children.length });
    children.slice(0, 2).forEach((child, row) => {
      nodes.push({
        node: child,
        x,
        y: 270 + row * 110,
        width: nodeWidth,
        more: snapshot.nodes.filter((n) => n.parentId === child.id).length,
      });
      height = Math.max(height, 270 + row * 110 + 70);
    });
  });
  const visible = new Set(nodes.map((n) => n.node.id));
  const references = snapshot.edges.filter(
    (e) => e.kind === "reference" && visible.has(e.from) && !visible.has(e.to),
  );
  const targets = [...new Set(references.map((e) => e.to))].slice(0, columns);
  if (targets.length) {
    targets.forEach((id, i) => {
      const node = snapshot.nodes.find((n) => n.id === id);
      if (node) {
        nodes.push({
          node,
          x: 20 + ((width - 40) / targets.length) * (i + 0.5),
          y: height + 30,
          width: nodeWidth,
          more: 0,
        });
        visible.add(id);
      }
    });
    height += 110;
  }
  return {
    nodes,
    edges: snapshot.edges.filter(
      (e) => visible.has(e.from) && visible.has(e.to),
    ),
    pages,
    page: current,
    height,
  };
}
