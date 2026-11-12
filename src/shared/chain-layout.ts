import type { ChainEdge, ChainGraph, ChainNode } from "./security";

/**
 * Geometry for the tracking-chain graph.
 *
 * Kept out of the component so the layout is a pure function of the graph: no
 * reading `window`, no measuring, numbers in and numbers out. The component
 * only draws what this returns.
 *
 * Width is measured by the caller (ResizeObserver) because the four columns
 * must share whatever horizontal space the panel actually has.
 */

export const NODE_HEIGHT = 62;
export const ROW_GAP = 14;
export const COLUMN_GAP = 56;
export const TOP_PAD = 34;

export interface LaidOutNode extends ChainNode {
  x: number;
  y: number;
  width: number;
}

export interface LaidOutEdge extends ChainEdge {
  /** Cubic-bezier path in the same coordinate space as the nodes. */
  path: string;
  /** Midpoint of the path, for the count badge. */
  cx: number;
  cy: number;
  fromLabel: string;
  toLabel: string;
}

export interface ChainLayout {
  width: number;
  height: number;
  /** Shared column box width, so headers and nodes cannot drift apart. */
  columnWidth: number;
  columns: { column: number; label: string; x: number }[];
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
}

export const COLUMN_LABELS = ["主体", "行为", "资源", "出口"] as const;

/**
 * Line width in deliberate tiers instead of scaling linearly with count.
 * Linear scaling makes one 40-step edge swamp everything else and hides the
 * small edges that matter more.
 */
export function edgeWidth(count: number): number {
  if (count >= 10) return 3;
  if (count >= 3) return 2;
  return 1.25;
}

/** Node height grows with the stack so long labels do not overflow. */
const rowY = (index: number) => TOP_PAD + index * (NODE_HEIGHT + ROW_GAP);

export function layoutChain(graph: ChainGraph, availableWidth: number): ChainLayout {
  const byColumn = [0, 1, 2, 3].map((column) =>
    graph.nodes.filter((n) => n.column === column),
  );
  const maxRows = Math.max(1, ...byColumn.map((l) => l.length));
  const width = Math.max(640, availableWidth);
  const columnWidth = (width - COLUMN_GAP * 3) / 4;

  const columns = byColumn.map((_, column) => ({
    column,
    label: COLUMN_LABELS[column],
    x: column * (columnWidth + COLUMN_GAP) + columnWidth / 2,
  }));

  const nodes: LaidOutNode[] = [];
  byColumn.forEach((list, column) => {
    const x = columns[column].x;
    list.forEach((node, index) => {
      nodes.push({
        ...node,
        x,
        y: rowY(index),
        width: columnWidth,
      });
    });
  });

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: LaidOutEdge[] = [];
  for (const edge of graph.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    // A graph that references a missing node is a bug in the projection, not
    // something to draw around; skip rather than emit a broken path.
    if (!from || !to) continue;
    const startX = from.x + from.width / 2;
    const endX = to.x - to.width / 2;
    const startY = from.y + NODE_HEIGHT / 2;
    const endY = to.y + NODE_HEIGHT / 2;
    const midX = (startX + endX) / 2;
    edges.push({
      ...edge,
      path: `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`,
      cx: midX,
      cy: (startY + endY) / 2,
      fromLabel: from.label,
      toLabel: to.label,
    });
  }

  return {
    width,
    height: TOP_PAD + maxRows * (NODE_HEIGHT + ROW_GAP) + 8,
    columnWidth,
    columns,
    nodes,
    edges,
  };
}
