// <dbml-diagram source="…"> — HTML tables + SVG overlay.
//
// Pipeline: build table DOM → measure off-screen → packages/layout →
// move tables into the canvas + draw edges → pan/zoom + toolbar.

import { layout, type LayoutResult, type RoutedEdge, type TableMeasure } from '@dbml-view/layout';
import {
  type Column,
  DEFAULT_SCHEMA,
  type Database,
  type Ref,
  type Table,
  columnId,
  endpointTableId,
  hasMultipleSchemas,
  parseDbml,
  tableId,
} from '@dbml-view/parser';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MIN_SCALE = 0.15;
const MAX_SCALE = 3;
const ZOOM_STEP = 1.2;
const CANVAS_PADDING = 32;

type Viewport = { scale: number; tx: number; ty: number };

export class DbmlDiagramElement extends HTMLElement {
  static readonly tagName = 'dbml-diagram';

  static get observedAttributes(): string[] {
    return ['source'];
  }

  private database: Database | null = null;
  private rendered = false;
  private viewportEl!: HTMLElement;
  private canvasEl!: HTMLElement;
  private nodesEl!: HTMLElement;
  private edgesEl!: SVGSVGElement;
  private statusEl!: HTMLElement;
  private toolbarEl!: HTMLElement;
  private viewport: Viewport = { scale: 1, tx: 0, ty: 0 };
  private lastLayout: LayoutResult | null = null;
  private tableEls = new Map<string, HTMLElement>();
  private edgeEls = new Map<string, SVGGElement>();
  private edgesByTable = new Map<string, Set<string>>();
  private hoveredTableId: string | null = null;
  private hoveredEdgeId: string | null = null;
  private selectedTableId: string | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private pendingRelayout = false;
  private laidOutWhenVisible = false;

  connectedCallback(): void {
    if (!this.rendered) {
      this.classList.add('dv-diagram');
      this.innerHTML = TEMPLATE;
      this.viewportEl = this.querySelector<HTMLElement>('[data-viewport]')!;
      this.canvasEl = this.querySelector<HTMLElement>('[data-canvas]')!;
      this.nodesEl = this.querySelector<HTMLElement>('[data-nodes]')!;
      this.edgesEl = this.querySelector<SVGSVGElement>('[data-edges]')!;
      this.statusEl = this.querySelector<HTMLElement>('[data-status]')!;
      this.toolbarEl = this.querySelector<HTMLElement>('[data-toolbar]')!;
      this.wireInteractions();
      this.rendered = true;
    }
    if (typeof ResizeObserver !== 'undefined' && !this.resizeObserver) {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.lastLayout && this.viewport.scale > 0) {
          // Keep current zoom; just clamp into bounds when the box shrinks.
          this.applyViewport();
        }
      });
      this.resizeObserver.observe(this.viewportEl);
    }
    if (typeof IntersectionObserver !== 'undefined' && !this.intersectionObserver) {
      // Tab-switched views start as display:none. Wait until we have non-zero
      // dimensions before doing the measurement pass — getBoundingClientRect
      // is all zeros for hidden elements.
      this.intersectionObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && this.database && !this.laidOutWhenVisible) {
            this.scheduleRelayout();
          }
        }
      });
      this.intersectionObserver.observe(this);
    }
    const source = this.getAttribute('source');
    if (source !== null && this.database === null) {
      this.source = source;
    } else if (this.database) {
      this.scheduleRelayout();
    }
  }

  disconnectedCallback(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.intersectionObserver?.disconnect();
    this.intersectionObserver = null;
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
    if (name === 'source' && value !== null) {
      this.source = value;
    }
  }

  set source(value: string) {
    const result = parseDbml(value);
    if (!result.ok) {
      this.database = null;
      this.renderError(result.errors);
      return;
    }
    this.setDatabase(result.db);
  }

  setDatabase(db: Database): void {
    this.database = db;
    this.laidOutWhenVisible = false;
    if (!this.rendered) return;
    this.scheduleRelayout();
  }

  private scheduleRelayout(): void {
    if (this.pendingRelayout) return;
    this.pendingRelayout = true;
    requestAnimationFrame(() => {
      this.pendingRelayout = false;
      this.relayout();
    });
  }

  private relayout(): void {
    const db = this.database;
    if (!db) return;
    if (db.tables.length === 0) {
      this.renderEmpty();
      return;
    }
    // Defer until visible — measurements are bogus when display:none.
    if (this.viewportEl.clientWidth === 0 || this.viewportEl.clientHeight === 0) {
      return;
    }
    this.laidOutWhenVisible = true;
    this.statusEl.textContent = '';
    this.tableEls.clear();
    this.edgeEls.clear();
    this.edgesByTable.clear();
    this.nodesEl.innerHTML = '';
    while (this.edgesEl.firstChild) this.edgesEl.removeChild(this.edgesEl.firstChild);

    // Step 1+2: build tables and measure them in the visible canvas (already
    // off-screen via transform on first render). One layout pass keeps the
    // initial flicker invisible — we hide the canvas until measurement is done.
    this.canvasEl.style.visibility = 'hidden';
    const measures = new Map<string, TableMeasure>();
    const showSchema = hasMultipleSchemas(db);
    for (const table of db.tables) {
      const id = tableId(table);
      const el = buildTableElement(table, refsForTable(db, id), showSchema);
      el.dataset.tableId = id;
      this.nodesEl.appendChild(el);
      this.tableEls.set(id, el);
    }

    // Force a synchronous reflow before measuring.
    void this.nodesEl.offsetHeight;

    for (const [id, el] of this.tableEls) {
      const rect = el.getBoundingClientRect();
      const rowOffsets = new Map<string, { top: number; height: number }>();
      for (const rowEl of el.querySelectorAll<HTMLElement>('[data-column-id]')) {
        const cid = rowEl.dataset.columnId;
        if (!cid) continue;
        rowOffsets.set(cid, { top: rowEl.offsetTop, height: rowEl.offsetHeight });
      }
      measures.set(id, { width: rect.width, height: rect.height, rowOffsets });
    }

    const result = layout(db, measures);
    this.lastLayout = result;

    // Step 3: position tables in the canvas.
    const offsetX = CANVAS_PADDING - result.bbox.x;
    const offsetY = CANVAS_PADDING - result.bbox.y;
    const canvasWidth = result.bbox.width + CANVAS_PADDING * 2;
    const canvasHeight = result.bbox.height + CANVAS_PADDING * 2;
    this.canvasEl.style.width = `${canvasWidth}px`;
    this.canvasEl.style.height = `${canvasHeight}px`;

    for (const positioned of result.tables) {
      const el = this.tableEls.get(positioned.id);
      if (!el) continue;
      el.style.transform = `translate(${positioned.x + offsetX}px, ${positioned.y + offsetY}px)`;
      el.style.width = `${positioned.width}px`;
    }

    // Step 4: SVG edges, in the same coordinate space (offset built into the path).
    this.edgesEl.setAttribute('width', String(canvasWidth));
    this.edgesEl.setAttribute('height', String(canvasHeight));
    this.edgesEl.setAttribute('viewBox', `0 0 ${canvasWidth} ${canvasHeight}`);
    for (const edge of result.edges) {
      const shifted = shiftEdge(edge, offsetX, offsetY);
      const group = document.createElementNS(SVG_NS, 'g');
      group.setAttribute('class', 'dv-edge-group');
      group.dataset.edgeId = edge.id;
      group.dataset.fromTable = edge.from.tableId;
      group.dataset.toTable = edge.to.tableId;
      group.dataset.fromColumn = edge.from.columnId;
      group.dataset.toColumn = edge.to.columnId;
      // Invisible wide stroke under the visible line — gives the edge a practical
      // hover target (the 1.5px visible stroke alone is far too thin to grab).
      const hit = document.createElementNS(SVG_NS, 'path');
      hit.setAttribute('d', shifted.path);
      hit.setAttribute('class', 'dv-edge-hit');
      group.appendChild(hit);
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', shifted.path);
      path.setAttribute('class', 'dv-edge');
      group.appendChild(path);
      const fromMarker = endpointMarker(shifted.from);
      if (fromMarker) group.appendChild(fromMarker);
      // Directional arrow at the `to` end replaces the cardinality glyph there
      // so the relationship's direction reads at a glance.
      group.appendChild(directionArrow(shifted.to));
      group.addEventListener('mouseenter', () => this.setHoveredEdge(edge.id));
      group.addEventListener('mouseleave', () => this.setHoveredEdge(null));
      this.edgesEl.appendChild(group);
      this.edgeEls.set(edge.id, group);
      track(this.edgesByTable, edge.from.tableId, edge.id);
      track(this.edgesByTable, edge.to.tableId, edge.id);
    }

    this.canvasEl.style.visibility = 'visible';
    this.fit();
  }

  private wireInteractions(): void {
    this.viewportEl.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        const rect = this.viewportEl.getBoundingClientRect();
        const cx = event.clientX - rect.left;
        const cy = event.clientY - rect.top;
        const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
        this.zoomAt(cx, cy, factor);
      },
      { passive: false },
    );

    let dragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragOriginTx = 0;
    let dragOriginTy = 0;
    let activePointer: number | null = null;

    this.viewportEl.addEventListener('pointerdown', (event) => {
      // Pan on background drag only; don't hijack clicks inside tables.
      const onTable = (event.target as HTMLElement).closest('[data-table-id]');
      if (onTable) return;
      dragging = true;
      activePointer = event.pointerId;
      dragStartX = event.clientX;
      dragStartY = event.clientY;
      dragOriginTx = this.viewport.tx;
      dragOriginTy = this.viewport.ty;
      this.viewportEl.setPointerCapture(event.pointerId);
      this.viewportEl.classList.add('is-panning');
    });
    this.viewportEl.addEventListener('pointermove', (event) => {
      if (!dragging || event.pointerId !== activePointer) return;
      this.viewport.tx = dragOriginTx + (event.clientX - dragStartX);
      this.viewport.ty = dragOriginTy + (event.clientY - dragStartY);
      this.applyViewport();
    });
    const endDrag = (event: PointerEvent): void => {
      if (event.pointerId !== activePointer) return;
      dragging = false;
      activePointer = null;
      this.viewportEl.classList.remove('is-panning');
    };
    this.viewportEl.addEventListener('pointerup', endDrag);
    this.viewportEl.addEventListener('pointercancel', endDrag);

    this.nodesEl.addEventListener('pointerover', (event) => {
      const el = (event.target as HTMLElement).closest<HTMLElement>('[data-table-id]');
      const id = el?.dataset.tableId ?? null;
      if (id !== this.hoveredTableId) this.setHovered(id);
    });
    this.nodesEl.addEventListener('pointerleave', () => this.setHovered(null));

    this.nodesEl.addEventListener('click', (event) => {
      const el = (event.target as HTMLElement).closest<HTMLElement>('[data-table-id]');
      const id = el?.dataset.tableId ?? null;
      if (id) {
        this.selectTable(id);
      }
    });

    this.toolbarEl.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
      if (!button) return;
      switch (button.dataset.act) {
        case 'zoom-in':
          this.zoomAt(this.viewportEl.clientWidth / 2, this.viewportEl.clientHeight / 2, ZOOM_STEP);
          break;
        case 'zoom-out':
          this.zoomAt(
            this.viewportEl.clientWidth / 2,
            this.viewportEl.clientHeight / 2,
            1 / ZOOM_STEP,
          );
          break;
        case 'fit':
          this.fit();
          break;
        case 'reset':
          this.viewport = { scale: 1, tx: 0, ty: 0 };
          this.applyViewport();
          break;
        case 'export-svg':
          this.exportSvg();
          break;
      }
    });
  }

  /** Zoom keeping the viewport-relative point (cx, cy) anchored under the cursor. */
  private zoomAt(cx: number, cy: number, factor: number): void {
    const newScale = clamp(this.viewport.scale * factor, MIN_SCALE, MAX_SCALE);
    const effective = newScale / this.viewport.scale;
    this.viewport.tx = cx - (cx - this.viewport.tx) * effective;
    this.viewport.ty = cy - (cy - this.viewport.ty) * effective;
    this.viewport.scale = newScale;
    this.applyViewport();
  }

  private applyViewport(): void {
    this.canvasEl.style.transform = `translate(${this.viewport.tx}px, ${this.viewport.ty}px) scale(${this.viewport.scale})`;
    this.statusEl.textContent = `${Math.round(this.viewport.scale * 100)}%`;
  }

  /** Fit-to-screen: scale the canvas to fit the viewport with a small inset. */
  private fit(): void {
    if (!this.lastLayout) return;
    const vw = this.viewportEl.clientWidth;
    const vh = this.viewportEl.clientHeight;
    if (vw === 0 || vh === 0) return;
    const cw = this.canvasEl.clientWidth;
    const ch = this.canvasEl.clientHeight;
    if (cw === 0 || ch === 0) return;
    const scale = clamp(Math.min(vw / cw, vh / ch, 1), MIN_SCALE, MAX_SCALE);
    this.viewport = {
      scale,
      tx: (vw - cw * scale) / 2,
      ty: (vh - ch * scale) / 2,
    };
    this.applyViewport();
  }

  private setHoveredEdge(id: string | null): void {
    if (this.hoveredEdgeId === id) return;
    if (this.hoveredEdgeId) {
      const prev = this.edgeEls.get(this.hoveredEdgeId);
      if (prev) {
        prev.classList.remove('is-hovered');
        const fromCol = prev.dataset.fromColumn;
        const toCol = prev.dataset.toColumn;
        if (fromCol) this.nodesEl.querySelector(`[data-column-id="${cssEscape(fromCol)}"]`)?.classList.remove('is-edge-endpoint');
        if (toCol) this.nodesEl.querySelector(`[data-column-id="${cssEscape(toCol)}"]`)?.classList.remove('is-edge-endpoint');
      }
    }
    this.hoveredEdgeId = id;
    if (id) {
      const next = this.edgeEls.get(id);
      if (next) {
        // SVG has no z-index — paint order is DOM order. Re-appending to the
        // end of the edges layer pulls this edge over the cluster of overlapping
        // siblings so the highlight isn't hidden under another line.
        this.edgesEl.appendChild(next);
        next.classList.add('is-hovered');
        const fromCol = next.dataset.fromColumn;
        const toCol = next.dataset.toColumn;
        if (fromCol) this.nodesEl.querySelector(`[data-column-id="${cssEscape(fromCol)}"]`)?.classList.add('is-edge-endpoint');
        if (toCol) this.nodesEl.querySelector(`[data-column-id="${cssEscape(toCol)}"]`)?.classList.add('is-edge-endpoint');
      }
    }
  }

  private setHovered(id: string | null): void {
    if (this.hoveredTableId) {
      const prev = this.tableEls.get(this.hoveredTableId);
      prev?.classList.remove('is-hovered');
      for (const edgeId of this.edgesByTable.get(this.hoveredTableId) ?? []) {
        this.edgeEls.get(edgeId)?.classList.remove('is-related');
      }
    }
    this.hoveredTableId = id;
    if (id) {
      this.tableEls.get(id)?.classList.add('is-hovered');
      for (const edgeId of this.edgesByTable.get(id) ?? []) {
        this.edgeEls.get(edgeId)?.classList.add('is-related');
      }
    }
  }

  private selectTable(id: string): void {
    if (this.selectedTableId && this.selectedTableId !== id) {
      this.tableEls.get(this.selectedTableId)?.classList.remove('is-selected');
    }
    this.selectedTableId = id;
    this.tableEls.get(id)?.classList.add('is-selected');
    this.dispatchEvent(
      new CustomEvent('table-selected', { detail: { tableId: id }, bubbles: true }),
    );
  }

  private renderError(errors: { line: number; column: number; message: string }[]): void {
    this.canvasEl.style.visibility = 'hidden';
    this.nodesEl.innerHTML = '';
    while (this.edgesEl.firstChild) this.edgesEl.removeChild(this.edgesEl.firstChild);
    this.statusEl.innerHTML = errors
      .map((e) => `<span class="dv-error">${e.line}:${e.column} ${escapeHtml(e.message)}</span>`)
      .join('');
  }

  private renderEmpty(): void {
    this.canvasEl.style.visibility = 'hidden';
    this.nodesEl.innerHTML = '';
    while (this.edgesEl.firstChild) this.edgesEl.removeChild(this.edgesEl.firstChild);
    this.statusEl.textContent = 'No tables to draw.';
  }

  /** Export the current diagram as a standalone SVG document. Triggers a download. */
  private exportSvg(): void {
    if (!this.lastLayout) return;
    const width = this.canvasEl.clientWidth;
    const height = this.canvasEl.clientHeight;
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="${SVG_NS}" xmlns:xhtml="http://www.w3.org/1999/xhtml" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <style>${EXPORT_CSS}</style>
  ${this.edgesEl.innerHTML}
  <foreignObject x="0" y="0" width="${width}" height="${height}">
    <xhtml:div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:${width}px;height:${height}px">
      ${this.nodesEl.innerHTML}
    </xhtml:div>
  </foreignObject>
</svg>`;
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'diagram.svg';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

const TEMPLATE = `
  <div class="dv-diagram-toolbar" data-toolbar>
    <button type="button" data-act="zoom-in" title="Zoom in">+</button>
    <button type="button" data-act="zoom-out" title="Zoom out">−</button>
    <button type="button" data-act="fit" title="Fit to screen">Fit</button>
    <button type="button" data-act="reset" title="Reset zoom">1:1</button>
    <button type="button" data-act="export-svg" title="Export SVG">SVG</button>
    <span class="dv-diagram-status" data-status></span>
  </div>
  <div class="dv-diagram-viewport" data-viewport>
    <div class="dv-canvas" data-canvas>
      <svg class="dv-edges" data-edges xmlns="${SVG_NS}"></svg>
      <div class="dv-nodes" data-nodes></div>
    </div>
  </div>
`;

const EXPORT_CSS = `
.dv-table { position: absolute; box-sizing: border-box; background: #fff; border: 1px solid #d1d5db; border-radius: 6px; font: 13px / 1.4 ui-sans-serif, system-ui, sans-serif; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
.dv-table-header { padding: 0.4rem 0.6rem; background: #f3f4f6; border-bottom: 1px solid #d1d5db; font-weight: 600; }
.dv-table-schema { font-size: 0.65rem; color: #6b7280; text-transform: uppercase; letter-spacing: 0.04em; display: block; }
.dv-row { display: grid; grid-template-columns: 1fr auto auto; gap: 0.5rem; padding: 0.25rem 0.6rem; border-top: 1px solid #f1f5f9; font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
.dv-row-flags { color: #94a3b8; font-size: 10px; }
.dv-row-type { color: #6d28d9; font-size: 11px; }
.dv-edge-group { color: #94a3b8; }
.dv-edge { fill: none; stroke: currentColor; stroke-width: 1.5; }
.dv-edge-hit { fill: none; stroke: transparent; stroke-width: 14; }
.dv-marker, .dv-arrow { fill: currentColor; stroke: currentColor; }
`;

function shiftEdge(edge: RoutedEdge, dx: number, dy: number): RoutedEdge {
  return {
    ...edge,
    path: shiftPath(edge.path, dx, dy),
    from: { ...edge.from, x: edge.from.x + dx, y: edge.from.y + dy },
    to: { ...edge.to, x: edge.to.x + dx, y: edge.to.y + dy },
  };
}

/** Shift an orthogonal path built from M/H/V/A commands. */
function shiftPath(d: string, dx: number, dy: number): string {
  const tokens = d.trim().split(/\s+/);
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const cmd = tokens[i++];
    switch (cmd) {
      case 'M': {
        const x = Number(tokens[i++]);
        const y = Number(tokens[i++]);
        out.push('M', (x + dx).toFixed(1), (y + dy).toFixed(1));
        break;
      }
      case 'H': {
        const x = Number(tokens[i++]);
        out.push('H', (x + dx).toFixed(1));
        break;
      }
      case 'V': {
        const y = Number(tokens[i++]);
        out.push('V', (y + dy).toFixed(1));
        break;
      }
      case 'L': {
        const x = Number(tokens[i++]);
        const y = Number(tokens[i++]);
        out.push('L', (x + dx).toFixed(1), (y + dy).toFixed(1));
        break;
      }
      case 'A': {
        // A rx ry x-axis-rotation large-arc-flag sweep-flag x y
        const rx = tokens[i++];
        const ry = tokens[i++];
        const rot = tokens[i++];
        const large = tokens[i++];
        const sweep = tokens[i++];
        const x = Number(tokens[i++]);
        const y = Number(tokens[i++]);
        out.push('A', rx!, ry!, rot!, large!, sweep!, (x + dx).toFixed(1), (y + dy).toFixed(1));
        break;
      }
      default:
        if (cmd) out.push(cmd);
    }
  }
  return out.join(' ');
}

/**
 * Directional arrowhead at the `to` endpoint: tip on the table border, base
 * extending back along the edge. Makes the relationship direction obvious.
 */
function directionArrow(end: { side: 'left' | 'right'; x: number; y: number }): SVGElement {
  const dir = end.side === 'left' ? 1 : -1; // positive points into the table
  const baseX = end.x - dir * 9;
  const tri = document.createElementNS(SVG_NS, 'polygon');
  tri.setAttribute(
    'points',
    `${end.x},${end.y} ${baseX},${end.y - 4} ${baseX},${end.y + 4}`,
  );
  tri.setAttribute('class', 'dv-arrow');
  return tri;
}

/**
 * Endpoint glyph: filled triangle for `*` (many), small circle for `1`.
 * Simpler than full crow's-foot, reads well at multiple zooms.
 */
function endpointMarker(end: {
  relation: '1' | '*';
  side: 'left' | 'right';
  x: number;
  y: number;
}): SVGElement | null {
  const dir = end.side === 'right' ? -1 : 1; // glyph points back toward the table
  if (end.relation === '*') {
    const tip = `${end.x},${end.y}`;
    const back1 = `${end.x + dir * 10},${end.y - 5}`;
    const back2 = `${end.x + dir * 10},${end.y + 5}`;
    const poly = document.createElementNS(SVG_NS, 'polygon');
    poly.setAttribute('points', `${tip} ${back1} ${back2}`);
    poly.setAttribute('class', 'dv-marker dv-marker-many');
    return poly;
  }
  const circle = document.createElementNS(SVG_NS, 'circle');
  circle.setAttribute('cx', String(end.x + dir * 5));
  circle.setAttribute('cy', String(end.y));
  circle.setAttribute('r', '3');
  circle.setAttribute('class', 'dv-marker dv-marker-one');
  return circle;
}

function buildTableElement(table: Table, refs: Ref[], showSchema: boolean): HTMLElement {
  const id = tableId(table);
  const el = document.createElement('div');
  el.className = 'dv-table';
  const schema = table.schemaName ?? DEFAULT_SCHEMA;
  const pkColumns = new Set(table.fields.filter((c) => c.pk).map((c) => c.name));
  const fkColumns = new Set<string>();
  const selfId = id;
  for (const ref of refs) {
    const [a, b] = ref.endpoints;
    if (!a || !b) continue;
    if (a.relation === '*' && endpointTableId(a) === selfId) for (const f of a.fieldNames) fkColumns.add(f);
    if (b.relation === '*' && endpointTableId(b) === selfId) for (const f of b.fieldNames) fkColumns.add(f);
  }
  el.innerHTML = `
    <div class="dv-table-header">
      ${showSchema ? `<span class="dv-table-schema">${escapeHtml(schema)}</span>` : ''}
      <span class="dv-table-name">${escapeHtml(table.name)}</span>
    </div>
    ${table.fields
      .map((c) => renderRow(table, c, pkColumns, fkColumns))
      .join('')}
  `;
  return el;
}

function renderRow(table: Table, column: Column, pks: Set<string>, fks: Set<string>): string {
  const flags: string[] = [];
  if (pks.has(column.name)) flags.push('PK');
  if (fks.has(column.name)) flags.push('FK');
  if (column.not_null && !pks.has(column.name)) flags.push('NN');
  const id = columnId(table, column);
  return `
    <div class="dv-row" data-column-id="${escapeAttr(id)}">
      <span class="dv-row-name">${escapeHtml(column.name)}</span>
      <span class="dv-row-type">${escapeHtml(formatType(column))}</span>
      <span class="dv-row-flags">${flags.join(' ')}</span>
    </div>
  `;
}

function formatType(column: Column): string {
  const { schemaName, type_name, args } = column.type;
  const qualified = schemaName ? `${schemaName}.${type_name}` : type_name;
  return args ? `${qualified}(${args})` : qualified;
}

function refsForTable(db: Database, id: string): Ref[] {
  return db.refs.filter((ref) => {
    const [a, b] = ref.endpoints;
    if (!a || !b) return false;
    return endpointTableId(a) === id || endpointTableId(b) === id;
  });
}

function track<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
}

if (!customElements.get(DbmlDiagramElement.tagName)) {
  customElements.define(DbmlDiagramElement.tagName, DbmlDiagramElement);
}
