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

/** Radius of the semicircular "hop" drawn where one edge crosses another. */
const JUMP_RADIUS = 6;

/**
 * Crossings closer than this to a segment endpoint (a corner of an edge) are
 * ignored — they're either shared corners or non-crossings, never true X cuts.
 */
const CROSSING_EPSILON = 0.5;

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

  const withJumps = applyJumpovers(edges);

  const bbox = computeBbox(tables);

  return { tables, edges: withJumps, bbox };
}

type Pt = { x: number; y: number };

/**
 * Where one routed edge's horizontal segment strictly crosses another's
 * vertical segment, replace a slice of the horizontal segment with a small
 * upward semicircle so the crossing reads as a "jump over" rather than an
 * ambiguous X. Only the horizontal side gets the bump — picking the same
 * orientation every time keeps the visual consistent across the diagram.
 */
function applyJumpovers(edges: RoutedEdge[]): RoutedEdge[] {
  if (edges.length < 2) return edges;

  const polylines = edges.map((e) => pathToPoints(e.path));

  type HSeg = { edgeIdx: number; segIdx: number; y: number; xMin: number; xMax: number };
  type VSeg = { edgeIdx: number; x: number; yMin: number; yMax: number };
  const hSegs: HSeg[] = [];
  const vSegs: VSeg[] = [];

  for (let ei = 0; ei < polylines.length; ei++) {
    const pts = polylines[ei];
    if (!pts) continue;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      if (!a || !b) continue;
      if (a.y === b.y && a.x !== b.x) {
        hSegs.push({
          edgeIdx: ei,
          segIdx: i,
          y: a.y,
          xMin: Math.min(a.x, b.x),
          xMax: Math.max(a.x, b.x),
        });
      } else if (a.x === b.x && a.y !== b.y) {
        vSegs.push({
          edgeIdx: ei,
          x: a.x,
          yMin: Math.min(a.y, b.y),
          yMax: Math.max(a.y, b.y),
        });
      }
    }
  }

  // edgeIdx → segIdx → list of crossing x-coordinates on that horizontal segment.
  const bumps = new Map<number, Map<number, number[]>>();

  for (const h of hSegs) {
    for (const v of vSegs) {
      if (v.edgeIdx === h.edgeIdx) continue;
      if (v.x <= h.xMin + CROSSING_EPSILON || v.x >= h.xMax - CROSSING_EPSILON) continue;
      if (h.y <= v.yMin + CROSSING_EPSILON || h.y >= v.yMax - CROSSING_EPSILON) continue;
      let segMap = bumps.get(h.edgeIdx);
      if (!segMap) {
        segMap = new Map();
        bumps.set(h.edgeIdx, segMap);
      }
      const list = segMap.get(h.segIdx) ?? [];
      list.push(v.x);
      segMap.set(h.segIdx, list);
    }
  }

  if (bumps.size === 0) return edges;

  return edges.map((edge, ei) => {
    const segMap = bumps.get(ei);
    const pts = polylines[ei];
    if (!segMap || !pts) return edge;
    return { ...edge, path: rebuildPathWithBumps(pts, segMap, JUMP_RADIUS) };
  });
}

/** Parse an M/H/V path string into a list of polyline points. */
function pathToPoints(d: string): Pt[] {
  const tokens = d.trim().split(/\s+/);
  const pts: Pt[] = [];
  let cx = 0;
  let cy = 0;
  let i = 0;
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === 'M') {
      cx = Number(tokens[i++]);
      cy = Number(tokens[i++]);
      pts.push({ x: cx, y: cy });
    } else if (cmd === 'H') {
      cx = Number(tokens[i++]);
      pts.push({ x: cx, y: cy });
    } else if (cmd === 'V') {
      cy = Number(tokens[i++]);
      pts.push({ x: cx, y: cy });
    }
  }
  return pts;
}

/**
 * Walk the polyline and emit a new path: horizontal segments with crossings
 * get an arc per crossing, every other segment is re-emitted as-is. Sweep flag
 * is chosen so the arc always bumps toward smaller y (visually "up") regardless
 * of whether the segment runs left-to-right or right-to-left.
 */
function rebuildPathWithBumps(
  pts: Pt[],
  bumps: Map<number, number[]>,
  r: number,
): string {
  const first = pts[0];
  if (!first) return '';
  const out: string[] = ['M', fmt(first.x), fmt(first.y)];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (!a || !b) continue;
    if (a.y === b.y && a.x !== b.x) {
      const crossings = bumps.get(i);
      if (!crossings || crossings.length === 0) {
        out.push('H', fmt(b.x));
        continue;
      }
      const ltr = b.x > a.x;
      const sorted = [...crossings].sort((p, q) => (ltr ? p - q : q - p));
      let cursorX = a.x;
      for (const cx of sorted) {
        if (ltr) {
          const left = cx - r;
          const right = cx + r;
          if (left <= cursorX) continue; // overlapping bumps — drop this one
          if (right >= b.x) continue; // bump would overrun the end
          out.push('H', fmt(left));
          out.push('A', fmt(r), fmt(r), '0', '0', '0', fmt(right), fmt(a.y));
          cursorX = right;
        } else {
          const left = cx - r;
          const right = cx + r;
          if (right >= cursorX) continue;
          if (left <= b.x) continue;
          out.push('H', fmt(right));
          out.push('A', fmt(r), fmt(r), '0', '0', '1', fmt(left), fmt(a.y));
          cursorX = left;
        }
      }
      out.push('H', fmt(b.x));
    } else if (a.x === b.x && a.y !== b.y) {
      out.push('V', fmt(b.y));
    } else {
      out.push('L', fmt(b.x), fmt(b.y));
    }
  }
  return out.join(' ');
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

  const isSelf = fromId === toId;
  const fromCenterX = fromPos.x + fromPos.width / 2;
  const toCenterX = toPos.x + toPos.width / 2;
  // Self-refs always loop around the right edge of the table (see selfRefPath),
  // so both endpoints attach to the right side.
  const fromSide: EdgeSide = isSelf ? 'right' : toCenterX >= fromCenterX ? 'right' : 'left';
  const toSide: EdgeSide = isSelf ? 'right' : toCenterX >= fromCenterX ? 'left' : 'right';

  const fromY = fromPos.y + fromRow.top + fromRow.height / 2;
  const toY = toPos.y + toRow.top + toRow.height / 2;
  const fromX = fromSide === 'right' ? fromPos.x + fromPos.width : fromPos.x;
  const toX = toSide === 'left' ? toPos.x : toPos.x + toPos.width;
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
