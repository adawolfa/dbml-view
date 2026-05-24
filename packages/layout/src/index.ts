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

/** Radius of the quarter-circle arc inserted at every L-bend so turns read as turns, not crossings. */
const CORNER_RADIUS = 8;

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

  const decorated = decorateEdges(edges);

  const bbox = computeBbox(tables);

  return { tables, edges: decorated, bbox };
}

type Pt = { x: number; y: number };
type Seg = { isH: boolean; dir: 1 | -1; len: number };

/**
 * Single post-processing pass over routed edges. Every L-bend gets a small
 * quarter-circle arc (so turns look like turns, not crossings); horizontal
 * segments that pass strictly over another edge's vertical segment get a
 * semicircular "jump" so the crossing reads unambiguously. Picking a fixed
 * jump orientation (toward smaller y) keeps the visual consistent.
 */
function decorateEdges(edges: RoutedEdge[]): RoutedEdge[] {
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

  return edges.map((edge, ei) => {
    const pts = polylines[ei];
    if (!pts || pts.length < 2) return edge;
    const segMap = bumps.get(ei) ?? new Map<number, number[]>();
    return { ...edge, path: rebuildPath(pts, segMap, CORNER_RADIUS, JUMP_RADIUS) };
  });
}

/**
 * Parse an M/H/V path into polyline points. Adjacent duplicates are dropped so
 * downstream segment indexing isn't thrown off by degenerate routes (e.g. when
 * `fromY === toY` makes the V command a no-op).
 */
function pathToPoints(d: string): Pt[] {
  const tokens = d.trim().split(/\s+/);
  const raw: Pt[] = [];
  let cx = 0;
  let cy = 0;
  let i = 0;
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === 'M') {
      cx = Number(tokens[i++]);
      cy = Number(tokens[i++]);
      raw.push({ x: cx, y: cy });
    } else if (cmd === 'H') {
      cx = Number(tokens[i++]);
      raw.push({ x: cx, y: cy });
    } else if (cmd === 'V') {
      cy = Number(tokens[i++]);
      raw.push({ x: cx, y: cy });
    }
  }
  const pts: Pt[] = [];
  for (const p of raw) {
    const last = pts[pts.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) pts.push(p);
  }
  return pts;
}

/**
 * Walk the polyline and emit M / H / V plus arc commands for both corners and
 * jump-overs. Each interior bend trims a tangent length off both meeting
 * segments and stitches them with a quarter-circle arc; each crossing on a
 * horizontal segment becomes a semicircular bump.
 */
function rebuildPath(
  pts: Pt[],
  bumps: Map<number, number[]>,
  cornerR: number,
  jumpR: number,
): string {
  if (pts.length < 2) return '';

  const segs: Seg[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if (a.y === b.y) {
      segs.push({ isH: true, dir: b.x > a.x ? 1 : -1, len: Math.abs(b.x - a.x) });
    } else {
      segs.push({ isH: false, dir: b.y > a.y ? 1 : -1, len: Math.abs(b.y - a.y) });
    }
  }

  // Trim each segment at any end that meets a perpendicular neighbor.
  // The trim length matches between the two segments sharing a corner, so the
  // arc radius is well-defined.
  const trims: { start: number; end: number }[] = [];
  for (let i = 0; i < segs.length; i++) {
    let start = 0;
    let end = 0;
    if (i > 0 && segs[i - 1]!.isH !== segs[i]!.isH) {
      start = Math.min(cornerR, segs[i]!.len / 2, segs[i - 1]!.len / 2);
    }
    if (i < segs.length - 1 && segs[i]!.isH !== segs[i + 1]!.isH) {
      end = Math.min(cornerR, segs[i]!.len / 2, segs[i + 1]!.len / 2);
    }
    trims.push({ start, end });
  }

  const startPt = trimFromStart(pts[0]!, segs[0]!, trims[0]!.start);
  const out: string[] = ['M', fmt(startPt.x), fmt(startPt.y)];

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    const a = trimFromStart(pts[i]!, seg, trims[i]!.start);
    const b = trimFromEnd(pts[i + 1]!, seg, trims[i]!.end);

    if (seg.isH) {
      const crossings = bumps.get(i);
      if (crossings && crossings.length > 0) {
        emitHorizontalWithBumps(out, a, b, seg.dir > 0, crossings, jumpR);
      } else {
        out.push('H', fmt(b.x));
      }
    } else {
      out.push('V', fmt(b.y));
    }

    if (i < segs.length - 1 && trims[i]!.end > 0) {
      const nextSeg = segs[i + 1]!;
      const nextStart = trimFromStart(pts[i + 1]!, nextSeg, trims[i + 1]!.start);
      // Sweep flag = sign of the 2D cross product of (in-dir × out-dir).
      // Positive = clockwise turn in SVG's y-down coordinates.
      const inDx = seg.isH ? seg.dir : 0;
      const inDy = seg.isH ? 0 : seg.dir;
      const outDx = nextSeg.isH ? nextSeg.dir : 0;
      const outDy = nextSeg.isH ? 0 : nextSeg.dir;
      const sweep = inDx * outDy - inDy * outDx > 0 ? 1 : 0;
      const r = trims[i]!.end;
      out.push('A', fmt(r), fmt(r), '0', '0', String(sweep), fmt(nextStart.x), fmt(nextStart.y));
    }
  }

  return out.join(' ');
}

function trimFromStart(p: Pt, seg: Seg, t: number): Pt {
  if (t === 0) return p;
  return seg.isH ? { x: p.x + seg.dir * t, y: p.y } : { x: p.x, y: p.y + seg.dir * t };
}

function trimFromEnd(p: Pt, seg: Seg, t: number): Pt {
  if (t === 0) return p;
  return seg.isH ? { x: p.x - seg.dir * t, y: p.y } : { x: p.x, y: p.y - seg.dir * t };
}

function emitHorizontalWithBumps(
  out: string[],
  a: Pt,
  b: Pt,
  ltr: boolean,
  crossings: number[],
  r: number,
): void {
  const sorted = [...crossings].sort((p, q) => (ltr ? p - q : q - p));
  let cursorX = a.x;
  for (const cx of sorted) {
    const left = cx - r;
    const right = cx + r;
    if (ltr) {
      if (left <= cursorX) continue;
      if (right >= b.x) continue;
      out.push('H', fmt(left));
      out.push('A', fmt(r), fmt(r), '0', '0', '0', fmt(right), fmt(a.y));
      cursorX = right;
    } else {
      if (right >= cursorX) continue;
      if (left <= b.x) continue;
      out.push('H', fmt(right));
      out.push('A', fmt(r), fmt(r), '0', '0', '1', fmt(left), fmt(a.y));
      cursorX = left;
    }
  }
  out.push('H', fmt(b.x));
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
