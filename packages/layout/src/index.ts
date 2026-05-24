// Phase 3a: pure (Database + measured dims) → positioned tables + routed edges.
//
// Engine = dagre. Tables are dagre nodes; FK refs are dagre edges. We discard
// dagre's edge waypoints and re-route every edge ourselves at the column-row
// level so arrows attach to the exact FK/PK cell, not the table border.
//
// Self-refs are skipped by dagre's ranker so we route them by hand around the
// right side of the table.

import dagre from '@dagrejs/dagre';
import {
  type Database,
  type Ref,
  type RefEndpoint,
  columnId,
  endpointTableId,
  tableId,
} from '@dbml-view/parser';

export type Rect = { x: number; y: number; width: number; height: number };

/** Measured DOM dimensions for one table — produced by the renderer's off-screen pass. */
export type TableMeasure = {
  width: number;
  height: number;
  /** Per-column row geometry, keyed by `columnId(table, col)`. `top` is relative to the table's top edge. */
  rowOffsets: Map<string, { top: number; height: number }>;
};

export type PositionedTable = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Endpoint side relative to a table's bounding box. */
export type EdgeSide = 'left' | 'right';

export type RoutedEdgeEndpoint = {
  tableId: string;
  columnId: string;
  /** Cardinality marker for the marker glyph at this end (1 / *). */
  relation: '1' | '*';
  side: EdgeSide;
  /** Absolute coordinates of the connection point (where the edge meets the table border). */
  x: number;
  y: number;
};

export type RoutedEdge = {
  id: string;
  /** Source = the FK-holding endpoint (cardinality `*`) when one exists. */
  from: RoutedEdgeEndpoint;
  to: RoutedEdgeEndpoint;
  /** SVG path data, orthogonal with bends. */
  path: string;
};

export type LayoutResult = {
  tables: PositionedTable[];
  edges: RoutedEdge[];
  bbox: Rect;
};

export type LayoutOptions = {
  rankdir?: 'LR' | 'TB' | 'RL' | 'BT';
  nodesep?: number;
  ranksep?: number;
  marginx?: number;
  marginy?: number;
};

const DEFAULTS: Required<LayoutOptions> = {
  rankdir: 'LR',
  nodesep: 40,
  ranksep: 80,
  marginx: 24,
  marginy: 24,
};

/** Horizontal gap between a table's edge and the first jog of an edge. */
const EDGE_STUB = 24;

export function layout(
  db: Database,
  measures: Map<string, TableMeasure>,
  options: LayoutOptions = {},
): LayoutResult {
  const opts = { ...DEFAULTS, ...options };

  const g = new dagre.graphlib.Graph({ directed: true, multigraph: true });
  g.setGraph({
    rankdir: opts.rankdir,
    nodesep: opts.nodesep,
    ranksep: opts.ranksep,
    marginx: opts.marginx,
    marginy: opts.marginy,
  });
  g.setDefaultEdgeLabel(() => ({}));

  const usableTables = db.tables.filter((t) => measures.has(tableId(t)));
  for (const t of usableTables) {
    const id = tableId(t);
    const m = measures.get(id);
    if (!m) continue;
    g.setNode(id, { width: m.width, height: m.height });
  }

  // Only edges between known nodes; self-edges are rendered, not laid out.
  const renderedRefs: { ref: Ref; from: RefEndpoint; to: RefEndpoint }[] = [];
  for (const [i, ref] of db.refs.entries()) {
    const [a, b] = ref.endpoints;
    if (!a || !b) continue;
    const aId = endpointTableId(a);
    const bId = endpointTableId(b);
    if (!g.hasNode(aId) || !g.hasNode(bId)) continue;
    // Source = the `*` side when one exists, otherwise the parser's first endpoint.
    const fromSide: RefEndpoint = a.relation === '*' || b.relation !== '*' ? a : b;
    const toSide: RefEndpoint = fromSide === a ? b : a;
    renderedRefs.push({ ref, from: fromSide, to: toSide });
    if (endpointTableId(fromSide) !== endpointTableId(toSide)) {
      g.setEdge(endpointTableId(fromSide), endpointTableId(toSide), {}, String(i));
    }
  }

  dagre.layout(g);

  const tables: PositionedTable[] = [];
  const positions = new Map<string, PositionedTable>();
  for (const id of g.nodes()) {
    const node = g.node(id);
    // dagre uses center coordinates; we convert to top-left.
    const positioned: PositionedTable = {
      id,
      x: node.x - node.width / 2,
      y: node.y - node.height / 2,
      width: node.width,
      height: node.height,
    };
    tables.push(positioned);
    positions.set(id, positioned);
  }

  const edges: RoutedEdge[] = [];
  for (const [i, entry] of renderedRefs.entries()) {
    const routed = routeEdge(String(i), entry, positions, measures);
    if (routed) edges.push(routed);
  }

  const bbox = computeBbox(tables);

  return { tables, edges, bbox };
}

function routeEdge(
  edgeId: string,
  entry: { ref: Ref; from: RefEndpoint; to: RefEndpoint },
  positions: Map<string, PositionedTable>,
  measures: Map<string, TableMeasure>,
): RoutedEdge | null {
  const fromId = endpointTableId(entry.from);
  const toId = endpointTableId(entry.to);
  const fromPos = positions.get(fromId);
  const toPos = positions.get(toId);
  const fromMeasure = measures.get(fromId);
  const toMeasure = measures.get(toId);
  if (!fromPos || !toPos || !fromMeasure || !toMeasure) return null;

  // Anchor on the first column of the composite (good enough for v1; matches
  // most real-world schemas where composite FKs are rare).
  const fromCol = entry.from.fieldNames[0];
  const toCol = entry.to.fieldNames[0];
  if (!fromCol || !toCol) return null;

  const fromColId = columnIdFromEndpoint(entry.from, fromCol);
  const toColId = columnIdFromEndpoint(entry.to, toCol);

  const fromRow = fromMeasure.rowOffsets.get(fromColId);
  const toRow = toMeasure.rowOffsets.get(toColId);
  if (!fromRow || !toRow) return null;

  const fromCenterX = fromPos.x + fromPos.width / 2;
  const toCenterX = toPos.x + toPos.width / 2;
  const fromSide: EdgeSide = toCenterX >= fromCenterX ? 'right' : 'left';
  const toSide: EdgeSide = toCenterX >= fromCenterX ? 'left' : 'right';

  const fromY = fromPos.y + fromRow.top + fromRow.height / 2;
  const toY = toPos.y + toRow.top + toRow.height / 2;
  const fromX = fromSide === 'right' ? fromPos.x + fromPos.width : fromPos.x;
  const toX = toSide === 'left' ? toPos.x : toPos.x + toPos.width;

  const isSelf = fromId === toId;
  const path = isSelf
    ? selfRefPath(fromPos, fromY, toY)
    : orthogonalPath(fromX, fromY, fromSide, toX, toY, toSide);

  return {
    id: edgeId,
    from: {
      tableId: fromId,
      columnId: fromColId,
      relation: entry.from.relation,
      side: fromSide,
      x: fromX,
      y: fromY,
    },
    to: {
      tableId: toId,
      columnId: toColId,
      relation: entry.to.relation,
      side: toSide,
      x: toX,
      y: toY,
    },
    path,
  };
}

function columnIdFromEndpoint(endpoint: RefEndpoint, name: string): string {
  return columnId(
    { name: endpoint.tableName, schemaName: endpoint.schemaName ?? null },
    { name },
  );
}

/**
 * Orthogonal jog: exit horizontally → vertical mid-segment → enter horizontally.
 * Same-side connections route around the table with a wider stub.
 */
function orthogonalPath(
  fromX: number,
  fromY: number,
  fromSide: EdgeSide,
  toX: number,
  toY: number,
  toSide: EdgeSide,
): string {
  const dirFrom = fromSide === 'right' ? 1 : -1;
  const dirTo = toSide === 'right' ? 1 : -1;
  const fromStubX = fromX + dirFrom * EDGE_STUB;
  const toStubX = toX + dirTo * EDGE_STUB;
  // Same-side cables share a jog on whichever side is further out.
  let midX: number;
  if (fromSide === toSide) {
    midX = fromSide === 'right' ? Math.max(fromStubX, toStubX) : Math.min(fromStubX, toStubX);
  } else {
    midX = (fromStubX + toStubX) / 2;
  }
  return [
    `M ${fmt(fromX)} ${fmt(fromY)}`,
    `H ${fmt(midX)}`,
    `V ${fmt(toY)}`,
    `H ${fmt(toX)}`,
  ].join(' ');
}

/** Self-ref: U-shape that exits the right edge, swings out, and re-enters the right edge. */
function selfRefPath(table: PositionedTable, fromY: number, toY: number): string {
  const outX = table.x + table.width;
  const swingX = outX + EDGE_STUB * 2;
  return [
    `M ${fmt(outX)} ${fmt(fromY)}`,
    `H ${fmt(swingX)}`,
    `V ${fmt(toY)}`,
    `H ${fmt(outX)}`,
  ].join(' ');
}

function fmt(n: number): string {
  return n.toFixed(1);
}

function computeBbox(tables: PositionedTable[]): Rect {
  if (tables.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const t of tables) {
    if (t.x < minX) minX = t.x;
    if (t.y < minY) minY = t.y;
    if (t.x + t.width > maxX) maxX = t.x + t.width;
    if (t.y + t.height > maxY) maxY = t.y + t.height;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
