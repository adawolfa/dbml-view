// Phase 3a: pure (Database + measured dims) → positioned tables + routed edges.
//
// Position engine = ELK (`elk.layered`). Tables become ELK nodes, FK refs are
// ELK edges. ELK runs its layered crossing-minimization pass and gives us
// table positions; we throw ELK's edge waypoints away and run our own
// orthogonal router (grid-snapped, obstacle-aware) on top so arrows still
// anchor at the exact FK/PK row rather than the table border.
//
// Self-refs aren't sent to ELK; we route them by hand around the right side
// of the table.

import {
  DEFAULT_SCHEMA,
  type Database,
  type Ref,
  type RefEndpoint,
  type TableGroup,
  columnId,
  endpointTableId,
  tableId,
} from '@dbml-view/parser';
import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js';

const elk = new ELK();

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
  /** Containing group id (`schema.name`), or null when the table isn't grouped. */
  groupId?: string | null;
};

/**
 * Bounding box for a TableGroup. Drawn behind tables to make the cluster
 * visible; the title sits inside the top padding strip.
 */
export type PositionedGroup = {
  id: string;
  name: string;
  schemaName: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Optional explicit color from the DBML (`TableGroup foo [color: '#…']`). */
  color: string | null;
  /** Member table ids, in DBML order. */
  tableIds: string[];
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
  groups: PositionedGroup[];
  bbox: Rect;
};

export type LayoutOptions = {
  /** ELK direction. Maps to `elk.direction`. */
  direction?: 'RIGHT' | 'LEFT' | 'DOWN' | 'UP';
  /** Spacing between nodes inside the same layer. Maps to `elk.spacing.nodeNode`. */
  nodesep?: number;
  /** Spacing between layers. Maps to `elk.layered.spacing.nodeNodeBetweenLayers`. */
  ranksep?: number;
  marginx?: number;
  marginy?: number;
};

const DEFAULTS: Required<LayoutOptions> = {
  direction: 'RIGHT',
  nodesep: 60,
  ranksep: 220,
  marginx: 24,
  marginy: 24,
};

/**
 * Pad applied to a table's bounding box when used as an obstacle for edge
 * routing. Keeps the chosen midX one grid column away from the nearest table
 * edge so the rendered vertical doesn't graze a border.
 */
const OBSTACLE_PAD = 8;

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

/**
 * Two edges whose midX values fall within this many pixels share a vertical
 * jog axis (a "ladder"). They get redistributed across the channel by
 * {@link distributeMidX} so each bend at a distinct x.
 */
const MID_X_BUCKET = 4;

/**
 * Grid step for routed edge bends. Every L-corner snaps to a multiple of this
 * value on the x-axis; within a bundle, edges are assigned distinct grid
 * columns so no two corners sit at the same x or on adjacent grid cells.
 */
const GRID = 24;

/** Safety margin kept on each side of a redistributed channel so the new
 * midX values never collide with a table's stub. */
const CHANNEL_MARGIN = 4;

/** Top padding reserved inside a TableGroup parent node for its label strip. */
export const GROUP_LABEL_HEIGHT = 28;
/** Inset between the group's bounding box and its member tables on the other three sides. */
export const GROUP_PADDING = 16;

export async function layout(
  db: Database,
  measures: Map<string, TableMeasure>,
  options: LayoutOptions = {},
): Promise<LayoutResult> {
  const opts = { ...DEFAULTS, ...options };

  const usableTables = db.tables.filter((t) => measures.has(tableId(t)));
  const knownIds = new Set(usableTables.map((t) => tableId(t)));

  // Collect refs to render. Same source-direction policy as before: prefer
  // the `*` endpoint as the FK side so arrows point parent ← child.
  const renderedRefs: { ref: Ref; from: RefEndpoint; to: RefEndpoint }[] = [];
  for (const ref of db.refs) {
    const [a, b] = ref.endpoints;
    if (!a || !b) continue;
    if (!knownIds.has(endpointTableId(a)) || !knownIds.has(endpointTableId(b))) continue;
    const fromSide: RefEndpoint = a.relation === '*' || b.relation !== '*' ? a : b;
    const toSide: RefEndpoint = fromSide === a ? b : a;
    renderedRefs.push({ ref, from: fromSide, to: toSide });
  }

  // Build TableGroup membership. A table can belong to at most one group
  // (DBML's own constraint). Tables not in any group sit at root.
  const groupOfTable = new Map<string, string>();
  const groupSpecs: { id: string; group: TableGroup; tableIds: string[] }[] = [];
  for (const group of db.tableGroups) {
    const gid = tableGroupId(group);
    const memberIds: string[] = [];
    for (const member of group.tables) {
      // @dbml/parse returns "" (not null) for schemaName when a TableGroup member
      // has no schema qualifier, while db.tables uses null. Use || so both
      // falsy values fall back to the default schema and the IDs match.
      const mid = `${member.schemaName || DEFAULT_SCHEMA}.${member.name}`;
      if (!knownIds.has(mid)) continue;
      if (groupOfTable.has(mid)) continue;
      groupOfTable.set(mid, gid);
      memberIds.push(mid);
    }
    if (memberIds.length > 0) groupSpecs.push({ id: gid, group, tableIds: memberIds });
  }

  // ELK nodes: ungrouped tables live at root; grouped tables nest inside a
  // parent node per TableGroup. Hierarchy + INCLUDE_CHILDREN tells layered
  // to lay everything out together while keeping cluster members adjacent.
  const tableNodeFor = (id: string): ElkNode => {
    const m = measures.get(id)!;
    return { id, width: m.width, height: m.height };
  };
  const rootChildren: ElkNode[] = [];
  for (const t of usableTables) {
    const id = tableId(t);
    if (groupOfTable.has(id)) continue;
    rootChildren.push(tableNodeFor(id));
  }
  for (const spec of groupSpecs) {
    rootChildren.push({
      id: spec.id,
      layoutOptions: {
        'elk.padding': `[top=${GROUP_LABEL_HEIGHT},left=${GROUP_PADDING},bottom=${GROUP_PADDING},right=${GROUP_PADDING}]`,
      },
      children: spec.tableIds.map(tableNodeFor),
    });
  }

  const elkEdges = renderedRefs
    .map((entry, i) => {
      const fromId = endpointTableId(entry.from);
      const toId = endpointTableId(entry.to);
      if (fromId === toId) return null;
      return { id: String(i), sources: [fromId], targets: [toId] };
    })
    .filter((e): e is { id: string; sources: string[]; targets: string[] } => e !== null);

  const elkGraph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': opts.direction,
      // Orthogonal edges so ELK assumes the same routing model we render
      // with — even though we discard ELK's edge points, this still
      // influences node ordering and layer spacing decisions.
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.spacing.nodeNode': String(opts.nodesep),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(opts.ranksep),
      'elk.layered.spacing.edgeNodeBetweenLayers': '24',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '16',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.considerModelOrder.strategy': 'PREFER_EDGES',
      'elk.padding': `[top=${opts.marginy},left=${opts.marginx},bottom=${opts.marginy},right=${opts.marginx}]`,
    },
    children: rootChildren,
    edges: elkEdges,
  };

  const elkResult = await elk.layout(elkGraph);

  // Walk the hierarchy: anything with children is a group, leaves are tables.
  // Children x/y are parent-relative, so we sum offsets to get absolute coords.
  const positions = new Map<string, PositionedTable>();
  const groupRects = new Map<string, { x: number; y: number; width: number; height: number }>();
  const walk = (node: ElkNode, offsetX: number, offsetY: number, groupId: string | null): void => {
    const absX = offsetX + (node.x ?? 0);
    const absY = offsetY + (node.y ?? 0);
    if (node.children && node.children.length > 0 && node.id !== 'root') {
      groupRects.set(node.id, {
        x: absX,
        y: absY,
        width: node.width ?? 0,
        height: node.height ?? 0,
      });
      for (const child of node.children) walk(child, absX, absY, node.id);
    } else if (node.id !== 'root') {
      positions.set(node.id, {
        id: node.id,
        x: absX,
        y: absY,
        width: node.width ?? 0,
        height: node.height ?? 0,
        groupId,
      });
    } else if (node.children) {
      for (const child of node.children) walk(child, absX, absY, null);
    }
  };
  walk(elkResult, 0, 0, null);

  const result = reroute(db, positions, measures);
  // Carry the group rectangles through (reroute doesn't know about groups —
  // they don't affect routing, only rendering).
  result.groups = groupSpecs
    .map((spec) => {
      const rect = groupRects.get(spec.id);
      if (!rect) return null;
      return {
        id: spec.id,
        name: spec.group.name ?? spec.id,
        schemaName: spec.group.schemaName ?? DEFAULT_SCHEMA,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        color: spec.group.color ?? null,
        tableIds: spec.tableIds,
      };
    })
    .filter((g): g is PositionedGroup => g !== null);
  // A group's bounding box extends past its children (label strip on top,
  // padding on the other sides). Expand the layout bbox so the canvas
  // doesn't clip the group's border or label.
  result.bbox = expandBboxToGroups(result.bbox, result.groups);
  return result;
}

function expandBboxToGroups(bbox: Rect, groups: PositionedGroup[]): Rect {
  if (groups.length === 0) return bbox;
  let minX = bbox.x;
  let minY = bbox.y;
  let maxX = bbox.x + bbox.width;
  let maxY = bbox.y + bbox.height;
  for (const g of groups) {
    if (g.x < minX) minX = g.x;
    if (g.y < minY) minY = g.y;
    if (g.x + g.width > maxX) maxX = g.x + g.width;
    if (g.y + g.height > maxY) maxY = g.y + g.height;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function tableGroupId(group: TableGroup): string {
  return `__group__:${group.schemaName ?? DEFAULT_SCHEMA}.${group.name ?? ''}`;
}

/**
 * Re-run the edge-routing pipeline against a caller-supplied set of table
 * positions, skipping ELK. Used when the user drags a table — the positions
 * change but the layout engine doesn't need to run again. Pure and sync.
 */
export function reroute(
  db: Database,
  positions: Map<string, PositionedTable>,
  measures: Map<string, TableMeasure>,
): LayoutResult {
  const knownIds = new Set(positions.keys());

  const renderedRefs: { ref: Ref; from: RefEndpoint; to: RefEndpoint }[] = [];
  for (const ref of db.refs) {
    const [a, b] = ref.endpoints;
    if (!a || !b) continue;
    if (!knownIds.has(endpointTableId(a)) || !knownIds.has(endpointTableId(b))) continue;
    const fromSide: RefEndpoint = a.relation === '*' || b.relation !== '*' ? a : b;
    const toSide: RefEndpoint = fromSide === a ? b : a;
    renderedRefs.push({ ref, from: fromSide, to: toSide });
  }

  const tables = [...positions.values()];

  const rawRoutes: RawRoute[] = [];
  for (const [i, entry] of renderedRefs.entries()) {
    const raw = computeRawRoute(String(i), entry, positions, measures);
    if (raw) rawRoutes.push(raw);
  }

  distributeMidX(rawRoutes, tables);

  const edges: RoutedEdge[] = rawRoutes.map(rawToRoutedEdge);
  const decorated = decorateEdges(edges);
  const bbox = computeBbox(tables);

  // Groups (if any) are stitched back in by the caller. `reroute` is also
  // used live during table drags, where groups deliberately don't follow —
  // it would be jarring for the bounding box to jump on every pointermove.
  return { tables, edges: decorated, groups: [], bbox };
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

/**
 * Geometric description of one edge, computed in two stages: first per edge
 * in {@link computeRawRoute}, then redistributed by {@link distributeMidX} so
 * edges sharing a jog axis are spread across the channel. The final SVG path
 * is emitted from this struct via {@link rawToRoutedEdge}.
 */
type RawRoute = {
  id: string;
  from: RoutedEdgeEndpoint;
  to: RoutedEdgeEndpoint;
  midX: number;
  isSelf: boolean;
  selfTable: PositionedTable | null;
};

function computeRawRoute(
  edgeId: string,
  entry: { ref: Ref; from: RefEndpoint; to: RefEndpoint },
  positions: Map<string, PositionedTable>,
  measures: Map<string, TableMeasure>,
): RawRoute | null {
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

  const dirFrom = fromSide === 'right' ? 1 : -1;
  const dirTo = toSide === 'right' ? 1 : -1;
  const fromStubX = fromX + dirFrom * EDGE_STUB;
  const toStubX = toX + dirTo * EDGE_STUB;
  // Same-side cables share a jog on whichever side is further out.
  const midX = isSelf
    ? 0 // unused; self-refs render via selfRefPath
    : fromSide === toSide
      ? fromSide === 'right'
        ? Math.max(fromStubX, toStubX)
        : Math.min(fromStubX, toStubX)
      : (fromStubX + toStubX) / 2;

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
    midX,
    isSelf,
    selfTable: isSelf ? fromPos : null,
  };
}

function rawToRoutedEdge(r: RawRoute): RoutedEdge {
  const path =
    r.isSelf && r.selfTable
      ? selfRefPath(r.selfTable, r.from.y, r.to.y)
      : orthogonalPathFromMid(r.from.x, r.from.y, r.midX, r.to.x, r.to.y);
  return { id: r.id, from: r.from, to: r.to, path };
}

function columnIdFromEndpoint(endpoint: RefEndpoint, name: string): string {
  return columnId({ name: endpoint.tableName, schemaName: endpoint.schemaName ?? null }, { name });
}

/**
 * Snap every edge's vertical jog to a global grid column (multiples of
 * {@link GRID}) and ensure no two edges in the same bundle land in the same
 * or an adjacent grid column. Without this, every FK between two rank
 * columns computes the same `midX` and the bundle reads as a single thick
 * vertical with horizontal rungs — the classic ladder look.
 *
 * Algorithm:
 * 1. Bucket cross-side routes by their initial `midX` to find ladder
 *    bundles, plus same-side routes (which loop around one table edge).
 * 2. For each bundle, allocate distinct grid columns centered on the
 *    bundle's desired midpoint, snapped to the grid.
 * 3. Single-edge routes still snap to the grid so every bend in the
 *    diagram lines up to the same lattice.
 */
function distributeMidX(routes: RawRoute[], tables: PositionedTable[]): void {
  // Global record of (column, y-range) cells already claimed by some edge.
  // Used after the per-bundle pass to detect cross-bundle collisions (two
  // unrelated edges that happen to want the same grid column with
  // overlapping y) and shift one of them.
  const used: { col: number; yLo: number; yHi: number; routeId: string }[] = [];

  const groups = new Map<string, RawRoute[]>();
  for (const r of routes) {
    if (r.isSelf) continue;
    const key = `${Math.round(r.midX / MID_X_BUCKET)}|${r.from.side}|${r.to.side}`;
    let arr = groups.get(key);
    if (!arr) {
      arr = [];
      groups.set(key, arr);
    }
    arr.push(r);
  }

  for (const group of groups.values()) {
    if (group.length === 0) continue;

    // Order edges by y-midpoint so neighbouring grid columns correspond to
    // neighbouring rows — the resulting jog pattern reads as a smooth fan.
    group.sort((a, b) => (a.from.y + a.to.y) / 2 - (b.from.y + b.to.y) / 2);

    const sample = group[0]!;
    const n = group.length;
    const sameSide = sample.from.side === sample.to.side;

    // Channel bounds — the x interval inside which midX must fall to avoid
    // U-turn paths. Same-side bundles get an open-ended channel on the far
    // side of the table loop.
    let lo: number;
    let hi: number;
    if (sameSide) {
      const base = sample.midX;
      const sign = sample.from.side === 'right' ? 1 : -1;
      const depth = (n - 1) * GRID + GRID;
      if (sign === 1) {
        lo = base;
        hi = base + depth;
      } else {
        lo = base - depth;
        hi = base;
      }
    } else {
      lo = Number.NEGATIVE_INFINITY;
      hi = Number.POSITIVE_INFINITY;
      for (const r of group) {
        const fromStub = r.from.x + (r.from.side === 'right' ? EDGE_STUB : -EDGE_STUB);
        const toStub = r.to.x + (r.to.side === 'right' ? EDGE_STUB : -EDGE_STUB);
        const a = Math.min(fromStub, toStub);
        const b = Math.max(fromStub, toStub);
        if (a > lo) lo = a;
        if (b < hi) hi = b;
      }
    }

    // Bundle wants n distinct grid columns; total width (n-1)*GRID.
    const center = (lo + hi) / 2;
    const totalWidth = (n - 1) * GRID;
    let startX = center - totalWidth / 2;

    // Try to keep the bundle inside the channel. If it overflows, accept
    // the overrun; widening the channel is dagre's job (ranksep).
    if (hi - lo - CHANNEL_MARGIN * 2 >= totalWidth) {
      if (startX < lo + CHANNEL_MARGIN) startX = lo + CHANNEL_MARGIN;
      if (startX + totalWidth > hi - CHANNEL_MARGIN) {
        startX = hi - CHANNEL_MARGIN - totalWidth;
      }
    }

    // Snap startX onto the global grid so every column in this bundle is a
    // grid multiple. All edges then sit at `startX + i*GRID`.
    startX = Math.round(startX / GRID) * GRID;

    group.forEach((r, i) => {
      r.midX = startX + i * GRID;
    });
  }

  // Cross-bundle collision + obstacle pass. Two routes from different
  // bundles can pick the same or an adjacent grid column when their
  // channels overlap; if their y-ranges also overlap, the two verticals
  // merge visually. Independently, the desired column for an edge can fall
  // inside an unrelated table — its vertical jog would pierce that table.
  // Walk routes in deterministic order and push each to the nearest grid
  // column that satisfies *both* constraints (no neighbour collision, no
  // obstacle crossing on any of the three H/V/H segments).
  const ordered = routes.filter((r) => !r.isSelf).slice();
  ordered.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  for (const r of ordered) {
    const yLo = Math.min(r.from.y, r.to.y);
    const yHi = Math.max(r.from.y, r.to.y);

    // Obstacles for *this* edge: every table whose bbox we don't want to
    // pierce, padded so the edge doesn't graze a border.
    const obstacles: Obstacle[] = [];
    for (const t of tables) {
      if (t.id === r.from.tableId || t.id === r.to.tableId) continue;
      obstacles.push({
        x: t.x - OBSTACLE_PAD,
        y: t.y - OBSTACLE_PAD,
        xH: t.x + t.width + OBSTACLE_PAD,
        yH: t.y + t.height + OBSTACLE_PAD,
      });
    }

    const desiredCol = Math.round(r.midX / GRID);
    // Tier 1: respect both collision *and* obstacle constraints, but only
    // search within ~12 grid columns (~288 px) of the desired position.
    // Past that the H-V-H shape distorts into a long U-turn, which reads
    // worse than just letting the line clip through a table.
    let chosen = findColumn(
      desiredCol,
      12,
      (c) =>
        !collides(used, c, yLo, yHi) &&
        !pathHitsObstacle(r.from.x, r.from.y, c * GRID, r.to.x, r.to.y, obstacles),
    );
    // Tier 2: relax obstacle avoidance, still avoid bundle collisions, in a
    // wider window so the cross-bundle pass keeps doing its job.
    if (chosen === null) {
      chosen = findColumn(desiredCol, 64, (c) => !collides(used, c, yLo, yHi));
    }
    // Tier 3: nothing free at all — keep the desired position and accept
    // the visual collision.
    const col = chosen ?? desiredCol;
    r.midX = col * GRID;
    used.push({ col, yLo, yHi, routeId: r.id });
  }
}

type Obstacle = { x: number; y: number; xH: number; yH: number };

/**
 * Search outward from `desiredCol` in alternating directions (±1, ±2, …)
 * for the closest grid column that satisfies `predicate`. Returns `null` if
 * no column within `maxRadius` matches; the caller decides what fallback to
 * use.
 */
function findColumn(
  desiredCol: number,
  maxRadius: number,
  predicate: (col: number) => boolean,
): number | null {
  if (predicate(desiredCol)) return desiredCol;
  for (let r = 1; r <= maxRadius; r++) {
    if (predicate(desiredCol + r)) return desiredCol + r;
    if (predicate(desiredCol - r)) return desiredCol - r;
  }
  return null;
}

/** A grid column is occupied if any already-placed edge claims this column
 * or one immediately adjacent and shares overlapping y. */
function collides(
  used: { col: number; yLo: number; yHi: number }[],
  col: number,
  yLo: number,
  yHi: number,
): boolean {
  for (const u of used) {
    if (Math.abs(u.col - col) > 1) continue;
    // Overlap with a 4-px slack so endpoints flush against a row aren't
    // counted as collisions with that row's own edge.
    if (u.yHi < yLo + 4 || u.yLo > yHi - 4) continue;
    return true;
  }
  return false;
}

/**
 * True if any of an H-V-H route's three segments would pass through any of
 * the given obstacles. Used by {@link distributeMidX} to reject grid columns
 * whose vertical jog would pierce an unrelated table, and to also keep the
 * two horizontal stubs out of intermediate tables that happen to sit at the
 * same row y.
 */
function pathHitsObstacle(
  fromX: number,
  fromY: number,
  midX: number,
  toX: number,
  toY: number,
  obstacles: Obstacle[],
): boolean {
  const h1Lo = Math.min(fromX, midX);
  const h1Hi = Math.max(fromX, midX);
  const vLo = Math.min(fromY, toY);
  const vHi = Math.max(fromY, toY);
  const h2Lo = Math.min(midX, toX);
  const h2Hi = Math.max(midX, toX);
  for (const o of obstacles) {
    if (fromY > o.y && fromY < o.yH && h1Hi > o.x && h1Lo < o.xH) return true;
    if (midX > o.x && midX < o.xH && vHi > o.y && vLo < o.yH) return true;
    if (toY > o.y && toY < o.yH && h2Hi > o.x && h2Lo < o.xH) return true;
  }
  return false;
}

/**
 * Orthogonal jog with an externally chosen midX (the x of the vertical
 * segment). Allows the bundle-distribution pass to assign each edge its own
 * track without re-deriving the geometry.
 */
function orthogonalPathFromMid(
  fromX: number,
  fromY: number,
  midX: number,
  toX: number,
  toY: number,
): string {
  return [`M ${fmt(fromX)} ${fmt(fromY)}`, `H ${fmt(midX)}`, `V ${fmt(toY)}`, `H ${fmt(toX)}`].join(
    ' ',
  );
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
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const t of tables) {
    if (t.x < minX) minX = t.x;
    if (t.y < minY) minY = t.y;
    if (t.x + t.width > maxX) maxX = t.x + t.width;
    if (t.y + t.height > maxY) maxY = t.y + t.height;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
