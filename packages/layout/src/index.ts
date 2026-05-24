// Stub — Phase 3a.
// Pure function: (Database + measured dimensions) → table positions + edge routes.
// Engine = dagre (default), swappable for elkjs.

export type Rect = { x: number; y: number; width: number; height: number };

export type TableMeasure = {
  width: number;
  height: number;
  rowOffsets: Map<string, { top: number; height: number }>;
};

export type PositionedTable = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RoutedEdge = {
  id: string;
  fromTableId: string;
  toTableId: string;
  fromColumnId: string;
  toColumnId: string;
  path: string; // SVG path data
};

export type LayoutResult = {
  tables: PositionedTable[];
  edges: RoutedEdge[];
  bbox: Rect;
};

export function layout(): LayoutResult {
  throw new Error('layout: not implemented (Phase 3a)');
}
