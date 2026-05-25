// <dbml-diagram source="…"> — HTML tables + SVG overlay.
//
// Pipeline: build table DOM → measure off-screen → packages/layout →
// move tables into the canvas + draw edges → pan/zoom + toolbar.

import { t } from '@dbml-view/i18n';
import {
  GROUP_LABEL_HEIGHT,
  GROUP_PADDING,
  type LayoutResult,
  type PositionedGroup,
  type PositionedTable,
  type RoutedEdge,
  type TableMeasure,
  layout,
  reroute,
} from '@dbml-view/layout';
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
import type { HoverState } from './shared';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MIN_SCALE = 0.15;
const MAX_SCALE = 3;
const ZOOM_STEP = 1.2;
const CANVAS_PADDING = 32;
/** Pointer movement (in viewport pixels) below which a header press is treated as a click, not a drag. */
const DRAG_THRESHOLD = 3;

type Viewport = { scale: number; tx: number; ty: number };

export class DbmlDiagramElement extends HTMLElement {
  static readonly tagName = 'dbml-diagram';

  static get observedAttributes(): string[] {
    return ['source'];
  }

  private database: Database | null = null;
  /** Table IDs hidden from the diagram. Filtered out before layout/render. */
  private hiddenTables = new Set<string>();
  private rendered = false;
  private viewportEl!: HTMLElement;
  private canvasEl!: HTMLElement;
  private nodesEl!: HTMLElement;
  private groupsEl!: HTMLElement;
  private edgesEl!: SVGSVGElement;
  private statusEl!: HTMLElement;
  private toolbarEl!: HTMLElement;
  private viewport: Viewport = { scale: 1, tx: 0, ty: 0 };
  private lastLayout: LayoutResult | null = null;
  /** Working positions, mutated in place during drag; `lastLayout.tables` is rebuilt from this on each reroute. */
  private positions = new Map<string, PositionedTable>();
  private measures = new Map<string, TableMeasure>();
  /** Offset from layout-space to canvas-space, captured at layout time so drag math doesn't need to keep re-deriving it. */
  private layoutOffset = { x: 0, y: 0 };
  private tableEls = new Map<string, HTMLElement>();
  /** Mutable working copy of the laid-out groups; bbox and DOM are kept in sync as members move. */
  private groups: PositionedGroup[] = [];
  private groupEls = new Map<string, { root: HTMLElement; label: HTMLElement }>();
  private edgeEls = new Map<string, SVGGElement>();
  private edgesByTable = new Map<string, Set<string>>();
  /** edgeIds touching a column (either endpoint); used to scope the related-edge
   * highlight to the column under the pointer instead of the whole table. */
  private edgesByColumn = new Map<string, Set<string>>();
  /** Maps canonically-sorted "colA|colB" → edgeId for cross-panel hover lookup. */
  private edgesByColumnPair = new Map<string, string>();
  /** Edges currently marked `is-related`. Tracked so per-column hovers can diff
   * cleanly against the previous (possibly whole-table) set. */
  private currentRelatedEdges = new Set<string>();
  private hoveredTableId: string | null = null;
  private hoveredEdgeId: string | null = null;
  /** Column ID internally hovered (mouse over a column row in the diagram canvas). */
  private hoveredColumnId: string | null = null;
  /** Column ID that was externally highlighted (not from edge hover) and must be cleared separately. */
  private externalColumnId: string | null = null;
  private selectedTableId: string | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private pendingRelayout = false;
  private laidOutWhenVisible = false;
  /** Monotonic counter to discard async layout results that finished after a newer relayout was scheduled. */
  private layoutToken = 0;
  private hideNonRelational = false;
  private hideGroups = false;

  connectedCallback(): void {
    if (!this.rendered) {
      this.classList.add('dv-diagram');
      this.innerHTML = makeTemplate();
      this.viewportEl = this.querySelector<HTMLElement>('[data-viewport]')!;
      this.canvasEl = this.querySelector<HTMLElement>('[data-canvas]')!;
      this.nodesEl = this.querySelector<HTMLElement>('[data-nodes]')!;
      this.groupsEl = this.querySelector<HTMLElement>('[data-groups]')!;
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
      this.renderEmpty();
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

  /**
   * Replace the set of hidden table IDs and trigger a relayout. Hidden tables
   * are removed from the diagram entirely — their refs disappear along with
   * them since the layout engine only emits edges between known tables.
   */
  setHiddenTableIds(ids: Iterable<string>): void {
    const next = new Set(ids);
    if (setsEqual(next, this.hiddenTables)) return;
    this.hiddenTables = next;
    this.laidOutWhenVisible = false;
    if (!this.rendered || !this.database) return;
    this.scheduleRelayout();
  }

  private scheduleRelayout(): void {
    if (this.pendingRelayout) return;
    this.pendingRelayout = true;
    requestAnimationFrame(() => {
      this.pendingRelayout = false;
      void this.relayout();
    });
  }

  private async relayout(): Promise<void> {
    const db = this.database;
    if (!db) return;
    const visibleTables = db.tables.filter((t) => !this.hiddenTables.has(tableId(t)));
    if (visibleTables.length === 0) {
      this.renderEmpty();
      return;
    }
    // Defer until visible — measurements are bogus when display:none.
    if (this.viewportEl.clientWidth === 0 || this.viewportEl.clientHeight === 0) {
      return;
    }
    const myToken = ++this.layoutToken;
    this.laidOutWhenVisible = true;
    this.statusEl.textContent = '';
    this.tableEls.clear();
    this.edgeEls.clear();
    this.edgesByTable.clear();
    this.nodesEl.innerHTML = '';
    this.groupsEl.innerHTML = '';
    while (this.edgesEl.firstChild) this.edgesEl.removeChild(this.edgesEl.firstChild);

    // Step 1+2: build tables and measure them in the visible canvas (already
    // off-screen via transform on first render). One layout pass keeps the
    // initial flicker invisible — we hide the canvas until measurement is done.
    this.canvasEl.style.visibility = 'hidden';
    const measures = new Map<string, TableMeasure>();
    const showSchema = hasMultipleSchemas(db);
    for (const table of visibleTables) {
      const id = tableId(table);
      const el = buildTableElement(table, refsForTable(db, id), showSchema, this.hideNonRelational);
      el.dataset.tableId = id;
      if (table.headerColor) {
        el.style.setProperty('--dv-table-header-color', table.headerColor);
        el.classList.add('has-header-color');
      }
      this.nodesEl.appendChild(el);
      this.tableEls.set(id, el);
    }

    // Force a synchronous reflow before measuring.
    void this.nodesEl.offsetHeight;

    for (const [id, el] of this.tableEls) {
      // offsetWidth/Height (not getBoundingClientRect) — the canvas carries a
      // CSS transform from the previous fit-to-screen, which would scale rect
      // values and feed the layout engine bogus (tiny) table sizes.
      const rowOffsets = new Map<string, { top: number; height: number }>();
      for (const rowEl of el.querySelectorAll<HTMLElement>('[data-column-id]')) {
        const cid = rowEl.dataset.columnId;
        if (!cid) continue;
        rowOffsets.set(cid, { top: rowEl.offsetTop, height: rowEl.offsetHeight });
      }
      measures.set(id, { width: el.offsetWidth, height: el.offsetHeight, rowOffsets });
    }

    const result = await layout(db, measures);
    // A newer relayout has started while we awaited ELK — drop this result.
    if (myToken !== this.layoutToken) return;
    this.lastLayout = result;
    this.measures = measures;
    this.positions = new Map(result.tables.map((t) => [t.id, { ...t }]));

    // Step 3: position tables in the canvas.
    this.layoutOffset = {
      x: CANVAS_PADDING - result.bbox.x,
      y: CANVAS_PADDING - result.bbox.y,
    };
    const canvasWidth = result.bbox.width + CANVAS_PADDING * 2;
    const canvasHeight = result.bbox.height + CANVAS_PADDING * 2;
    this.canvasEl.style.width = `${canvasWidth}px`;
    this.canvasEl.style.height = `${canvasHeight}px`;

    for (const positioned of result.tables) {
      const el = this.tableEls.get(positioned.id);
      if (!el) continue;
      this.applyTableTransform(el, positioned);
      el.style.width = `${positioned.width}px`;
    }

    this.renderGroups(result.groups);
    // Re-apply the current hide state after a relayout and sync the toggle button.
    this.groupsEl.hidden = this.hideGroups;
    this.updateGroupsToggle();
    this.renderEdges(result.edges, canvasWidth, canvasHeight);

    this.canvasEl.style.visibility = 'visible';
    this.fit();
  }

  private applyTableTransform(el: HTMLElement, p: { x: number; y: number }): void {
    el.style.transform = `translate(${p.x + this.layoutOffset.x}px, ${p.y + this.layoutOffset.y}px)`;
  }

  /**
   * Render TableGroup hulls underneath everything. Plain absolutely-positioned
   * divs — easier than SVG for the label + border, and the canvas transform
   * carries them along with tables and edges for free.
   */
  private renderGroups(groups: PositionedGroup[]): void {
    this.groupsEl.innerHTML = '';
    this.groupEls.clear();
    // Keep a mutable working copy — drag handlers update each group's bbox in
    // place so the next reroute sees fresh coordinates without recomputing.
    this.groups = groups.map((g) => ({ ...g }));
    const dx = this.layoutOffset.x;
    const dy = this.layoutOffset.y;
    for (const g of this.groups) {
      const el = document.createElement('div');
      el.className = 'dv-group';
      el.dataset.groupId = g.id;
      el.style.transform = `translate(${g.x + dx}px, ${g.y + dy}px)`;
      el.style.width = `${g.width}px`;
      el.style.height = `${g.height}px`;
      if (g.color) {
        // DBML colors are arbitrary hex; soften the fill and use the same hue
        // for the border / label background so the cluster reads as one thing.
        el.style.setProperty('--dv-group-color', g.color);
      }
      const label = document.createElement('div');
      label.className = 'dv-group-label';
      label.textContent = g.name;
      el.appendChild(label);
      this.groupsEl.appendChild(el);
      this.groupEls.set(g.id, { root: el, label });
    }
  }

  /**
   * Recompute the bounding box of a single group from its members' current
   * positions and push the new geometry into the DOM. Called on every drag
   * frame — both when a single member moves and when the whole group is
   * being dragged by its label.
   */
  private updateGroupRect(groupId: string): void {
    const group = this.groups.find((g) => g.id === groupId);
    if (!group) return;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const tid of group.tableIds) {
      const pos = this.positions.get(tid);
      if (!pos) continue;
      if (pos.x < minX) minX = pos.x;
      if (pos.y < minY) minY = pos.y;
      if (pos.x + pos.width > maxX) maxX = pos.x + pos.width;
      if (pos.y + pos.height > maxY) maxY = pos.y + pos.height;
    }
    if (!Number.isFinite(minX)) return;
    group.x = minX - GROUP_PADDING;
    group.y = minY - GROUP_LABEL_HEIGHT;
    group.width = maxX - minX + GROUP_PADDING * 2;
    group.height = maxY - minY + GROUP_LABEL_HEIGHT + GROUP_PADDING;
    const els = this.groupEls.get(groupId);
    if (!els) return;
    els.root.style.transform = `translate(${group.x + this.layoutOffset.x}px, ${group.y + this.layoutOffset.y}px)`;
    els.root.style.width = `${group.width}px`;
    els.root.style.height = `${group.height}px`;
  }

  private renderEdges(edges: RoutedEdge[], canvasWidth: number, canvasHeight: number): void {
    this.edgeEls.clear();
    this.edgesByTable.clear();
    this.edgesByColumn.clear();
    this.edgesByColumnPair.clear();
    // The old SVG elements are gone — drop the tracking set so the next
    // updateRelatedEdges() doesn't try to remove classes from stale nodes.
    this.currentRelatedEdges = new Set();
    while (this.edgesEl.firstChild) this.edgesEl.removeChild(this.edgesEl.firstChild);
    this.edgesEl.setAttribute('width', String(canvasWidth));
    this.edgesEl.setAttribute('height', String(canvasHeight));
    this.edgesEl.setAttribute('viewBox', `0 0 ${canvasWidth} ${canvasHeight}`);
    const dx = this.layoutOffset.x;
    const dy = this.layoutOffset.y;
    for (const edge of edges) {
      const shifted = shiftEdge(edge, dx, dy);
      const group = document.createElementNS(SVG_NS, 'g');
      group.setAttribute('class', edge.color ? 'dv-edge-group has-color' : 'dv-edge-group');
      group.dataset.edgeId = edge.id;
      group.dataset.fromTable = edge.from.tableId;
      group.dataset.toTable = edge.to.tableId;
      group.dataset.fromColumn = edge.from.columnId;
      group.dataset.toColumn = edge.to.columnId;
      if (edge.color) {
        group.style.setProperty('--dv-edge-color', edge.color);
      }
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
      track(this.edgesByColumn, edge.from.columnId, edge.id);
      track(this.edgesByColumn, edge.to.columnId, edge.id);
      const [pairA, pairB] = [edge.from.columnId, edge.to.columnId].sort();
      this.edgesByColumnPair.set(`${pairA}|${pairB}`, edge.id);
    }
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

    let panning = false;
    let panStartX = 0;
    let panStartY = 0;
    let panOriginTx = 0;
    let panOriginTy = 0;
    let panPointer: number | null = null;

    this.viewportEl.addEventListener('pointerdown', (event) => {
      // Pan on background drag only; don't hijack clicks inside tables.
      const onTable = (event.target as HTMLElement).closest('[data-table-id]');
      if (onTable) return;
      // Cancel any in-progress animated pan so manual drag feels instant.
      this.canvasEl.classList.remove('is-panning-to');
      panning = true;
      panPointer = event.pointerId;
      panStartX = event.clientX;
      panStartY = event.clientY;
      panOriginTx = this.viewport.tx;
      panOriginTy = this.viewport.ty;
      this.viewportEl.setPointerCapture(event.pointerId);
      this.viewportEl.classList.add('is-panning');
    });
    this.viewportEl.addEventListener('pointermove', (event) => {
      if (!panning || event.pointerId !== panPointer) return;
      this.viewport.tx = panOriginTx + (event.clientX - panStartX);
      this.viewport.ty = panOriginTy + (event.clientY - panStartY);
      this.applyViewport();
    });
    const endPan = (event: PointerEvent): void => {
      if (event.pointerId !== panPointer) return;
      panning = false;
      panPointer = null;
      this.viewportEl.classList.remove('is-panning');
    };
    this.viewportEl.addEventListener('pointerup', endPan);
    this.viewportEl.addEventListener('pointercancel', endPan);

    this.nodesEl.addEventListener('pointerover', (event) => {
      const target = event.target as HTMLElement;
      const tableEl = target.closest<HTMLElement>('[data-table-id]');
      const newTableId = tableEl?.dataset.tableId ?? null;
      const colEl = target.closest<HTMLElement>('[data-column-id]');
      const newColId = colEl?.dataset.columnId ?? null;

      const tableChanged = newTableId !== this.hoveredTableId;
      const colChanged = newColId !== this.hoveredColumnId;
      if (!tableChanged && !colChanged) return;

      // Keep column highlight in sync with the pointer position.
      if (colChanged) {
        if (this.hoveredColumnId) {
          this.nodesEl
            .querySelector(`[data-column-id="${cssEscape(this.hoveredColumnId)}"]`)
            ?.classList.remove('is-edge-endpoint');
        }
        this.hoveredColumnId = newColId;
        if (newColId) {
          this.nodesEl
            .querySelector(`[data-column-id="${cssEscape(newColId)}"]`)
            ?.classList.add('is-edge-endpoint');
        }
      }

      if (tableChanged) this.applyTableHover(newTableId);
      else if (colChanged) this.updateRelatedEdges();

      // Emit the finest-grained state available.
      const state: HoverState =
        newColId && newTableId
          ? { kind: 'column', tableId: newTableId, columnId: newColId }
          : newTableId
            ? { kind: 'table', tableId: newTableId }
            : { kind: 'none' };
      this.dispatchEvent(
        new CustomEvent<HoverState>('hover-change', { detail: state, bubbles: true }),
      );
    });
    this.nodesEl.addEventListener('pointerleave', () => {
      if (this.hoveredColumnId) {
        this.nodesEl
          .querySelector(`[data-column-id="${cssEscape(this.hoveredColumnId)}"]`)
          ?.classList.remove('is-edge-endpoint');
        this.hoveredColumnId = null;
      }
      this.setHovered(null);
    });

    // Body clicks still select the table. Header clicks go through the drag
    // path, which falls back to selection when movement is below the threshold.
    this.nodesEl.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (target.closest('.dv-table-header')) return;
      const el = target.closest<HTMLElement>('[data-table-id]');
      const id = el?.dataset.tableId ?? null;
      if (id) this.selectTable(id);
    });

    this.wireTableDrag();
    this.wireGroupDrag();

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
        case 'cols-toggle':
          this.toggleRelationalFilter();
          break;
        case 'groups-toggle':
          this.toggleGroupVisibility();
          break;
      }
    });
    this.updateColsToggle();
    this.updateGroupsToggle();
  }

  private toggleRelationalFilter(): void {
    this.hideNonRelational = !this.hideNonRelational;
    this.updateColsToggle();
    if (this.database) this.scheduleRelayout();
  }

  private updateColsToggle(): void {
    const btn = this.toolbarEl.querySelector<HTMLButtonElement>('button[data-act="cols-toggle"]');
    if (!btn) return;
    btn.classList.toggle('is-active', this.hideNonRelational);
    btn.setAttribute('aria-pressed', this.hideNonRelational ? 'true' : 'false');
  }

  private toggleGroupVisibility(): void {
    this.hideGroups = !this.hideGroups;
    this.groupsEl.hidden = this.hideGroups;
    this.updateGroupsToggle();
  }

  /** Show the toggle button only when the current layout has at least one group; sync pressed state. */
  private updateGroupsToggle(): void {
    const btn = this.toolbarEl.querySelector<HTMLButtonElement>('button[data-act="groups-toggle"]');
    if (!btn) return;
    const hasGroups = this.groups.length > 0;
    btn.hidden = !hasGroups;
    btn.classList.toggle('is-active', this.hideGroups);
    btn.setAttribute('aria-pressed', this.hideGroups ? 'true' : 'false');
  }

  /**
   * Drag a table by its header. Below {@link DRAG_THRESHOLD} of pointer
   * movement the press becomes a click (table selection); past it, we capture
   * the pointer and begin updating positions, re-routing edges live.
   */
  private wireTableDrag(): void {
    let dragId: string | null = null;
    let dragEl: HTMLElement | null = null;
    let dragPointer: number | null = null;
    let startClientX = 0;
    let startClientY = 0;
    let originX = 0;
    let originY = 0;
    let active = false;
    let pendingFrame = false;
    let pendingX = 0;
    let pendingY = 0;

    const onMove = (event: PointerEvent): void => {
      if (dragPointer === null || event.pointerId !== dragPointer) return;
      const scale = this.viewport.scale || 1;
      const dx = (event.clientX - startClientX) / scale;
      const dy = (event.clientY - startClientY) / scale;
      if (!active) {
        if (
          Math.hypot(event.clientX - startClientX, event.clientY - startClientY) < DRAG_THRESHOLD
        ) {
          return;
        }
        active = true;
        dragEl?.classList.add('is-dragging');
        this.canvasEl.classList.add('is-dragging-table');
      }
      pendingX = originX + dx;
      pendingY = originY + dy;
      if (pendingFrame) return;
      pendingFrame = true;
      requestAnimationFrame(() => {
        pendingFrame = false;
        if (!dragId) return;
        const pos = this.positions.get(dragId);
        if (!pos) return;
        pos.x = pendingX;
        pos.y = pendingY;
        if (dragEl) this.applyTableTransform(dragEl, pos);
        if (pos.groupId) this.updateGroupRect(pos.groupId);
        this.rerouteEdges();
      });
    };

    const endDrag = (event: PointerEvent): void => {
      if (dragPointer === null || event.pointerId !== dragPointer) return;
      const wasActive = active;
      try {
        this.nodesEl.releasePointerCapture(event.pointerId);
      } catch {
        // ignore — pointer was never captured (no actual drag)
      }
      if (dragEl) dragEl.classList.remove('is-dragging');
      this.canvasEl.classList.remove('is-dragging-table');
      const id = dragId;
      dragId = null;
      dragEl = null;
      dragPointer = null;
      active = false;
      pendingFrame = false;
      // A short press without crossing the drag threshold = click → select.
      if (!wasActive && id) this.selectTable(id);
    };

    this.nodesEl.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement;
      const tableEl = target.closest<HTMLElement>('[data-table-id]');
      if (!tableEl) return;
      // Only the header initiates a drag; column rows stay clickable for
      // future row-level interactions and let text selection inside the
      // table body keep working.
      if (!target.closest('.dv-table-header')) return;
      const id = tableEl.dataset.tableId;
      if (!id) return;
      const pos = this.positions.get(id);
      if (!pos) return;
      event.preventDefault();
      dragId = id;
      dragEl = tableEl;
      dragPointer = event.pointerId;
      startClientX = event.clientX;
      startClientY = event.clientY;
      originX = pos.x;
      originY = pos.y;
      active = false;
      this.nodesEl.setPointerCapture(event.pointerId);
    });
    this.nodesEl.addEventListener('pointermove', onMove);
    this.nodesEl.addEventListener('pointerup', endDrag);
    this.nodesEl.addEventListener('pointercancel', endDrag);
  }

  /**
   * Drag every table in a TableGroup at once by grabbing the group's label.
   * Mirrors {@link wireTableDrag}: below {@link DRAG_THRESHOLD} the press is
   * just a no-op (label has no click action); past it, all member positions
   * shift by the same delta and the group's bbox follows.
   */
  private wireGroupDrag(): void {
    let dragGroupId: string | null = null;
    let dragLabelEl: HTMLElement | null = null;
    let dragPointer: number | null = null;
    let startClientX = 0;
    let startClientY = 0;
    let startPositions = new Map<string, { x: number; y: number }>();
    let active = false;
    let pendingFrame = false;
    let pendingDx = 0;
    let pendingDy = 0;

    const onMove = (event: PointerEvent): void => {
      if (dragPointer === null || event.pointerId !== dragPointer) return;
      const scale = this.viewport.scale || 1;
      const dx = (event.clientX - startClientX) / scale;
      const dy = (event.clientY - startClientY) / scale;
      if (!active) {
        if (
          Math.hypot(event.clientX - startClientX, event.clientY - startClientY) < DRAG_THRESHOLD
        ) {
          return;
        }
        active = true;
        dragLabelEl?.classList.add('is-dragging');
        this.canvasEl.classList.add('is-dragging-table');
        for (const tid of startPositions.keys()) {
          this.tableEls.get(tid)?.classList.add('is-dragging');
        }
      }
      pendingDx = dx;
      pendingDy = dy;
      if (pendingFrame) return;
      pendingFrame = true;
      requestAnimationFrame(() => {
        pendingFrame = false;
        if (!dragGroupId) return;
        for (const [tid, start] of startPositions) {
          const pos = this.positions.get(tid);
          if (!pos) continue;
          pos.x = start.x + pendingDx;
          pos.y = start.y + pendingDy;
          const el = this.tableEls.get(tid);
          if (el) this.applyTableTransform(el, pos);
        }
        this.updateGroupRect(dragGroupId);
        this.rerouteEdges();
      });
    };

    const endDrag = (event: PointerEvent): void => {
      if (dragPointer === null || event.pointerId !== dragPointer) return;
      try {
        this.groupsEl.releasePointerCapture(event.pointerId);
      } catch {
        // ignore — pointer was never captured (no actual drag past threshold)
      }
      dragLabelEl?.classList.remove('is-dragging');
      this.canvasEl.classList.remove('is-dragging-table');
      for (const tid of startPositions.keys()) {
        this.tableEls.get(tid)?.classList.remove('is-dragging');
      }
      dragGroupId = null;
      dragLabelEl = null;
      dragPointer = null;
      active = false;
      pendingFrame = false;
      startPositions = new Map();
    };

    this.groupsEl.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const labelEl = (event.target as HTMLElement).closest<HTMLElement>('.dv-group-label');
      if (!labelEl) return;
      const groupEl = labelEl.parentElement as HTMLElement | null;
      const groupId = groupEl?.dataset.groupId;
      if (!groupId) return;
      const group = this.groups.find((g) => g.id === groupId);
      if (!group) return;
      // Stop the event from reaching the viewport's pan handler — otherwise
      // grabbing the label would also start a background pan.
      event.preventDefault();
      event.stopPropagation();
      dragGroupId = groupId;
      dragLabelEl = labelEl;
      dragPointer = event.pointerId;
      startClientX = event.clientX;
      startClientY = event.clientY;
      startPositions = new Map();
      for (const tid of group.tableIds) {
        const pos = this.positions.get(tid);
        if (pos) startPositions.set(tid, { x: pos.x, y: pos.y });
      }
      active = false;
      this.groupsEl.setPointerCapture(event.pointerId);
    });
    this.groupsEl.addEventListener('pointermove', onMove);
    this.groupsEl.addEventListener('pointerup', endDrag);
    this.groupsEl.addEventListener('pointercancel', endDrag);
  }

  /** Re-route edges against `this.positions`; called on every drag frame. */
  private rerouteEdges(): void {
    if (!this.database || !this.lastLayout) return;
    const result = reroute(this.database, this.positions, this.measures);
    this.lastLayout = result;
    const canvasWidth = Number.parseFloat(this.canvasEl.style.width) || 0;
    const canvasHeight = Number.parseFloat(this.canvasEl.style.height) || 0;
    this.renderEdges(result.edges, canvasWidth, canvasHeight);
    // Re-apply hover/selection visuals after edges are re-rendered.
    // Reset the tracked IDs first so applyTableHover/applyEdgeHover don't early-exit.
    const prevTableId = this.hoveredTableId;
    const prevEdgeId = this.hoveredEdgeId;
    this.hoveredTableId = null;
    this.hoveredEdgeId = null;
    if (prevTableId) this.applyTableHover(prevTableId);
    if (prevEdgeId) this.applyEdgeHover(prevEdgeId);
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

  // ---- Visual-only hover primitives (no event emission) ----

  private applyEdgeHover(id: string | null): void {
    if (this.hoveredEdgeId === id) return;
    if (this.hoveredEdgeId) {
      const prev = this.edgeEls.get(this.hoveredEdgeId);
      if (prev) {
        prev.classList.remove('is-hovered');
        const fromCol = prev.dataset.fromColumn;
        const toCol = prev.dataset.toColumn;
        if (fromCol)
          this.nodesEl
            .querySelector(`[data-column-id="${cssEscape(fromCol)}"]`)
            ?.classList.remove('is-edge-endpoint');
        if (toCol)
          this.nodesEl
            .querySelector(`[data-column-id="${cssEscape(toCol)}"]`)
            ?.classList.remove('is-edge-endpoint');
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
        if (fromCol)
          this.nodesEl
            .querySelector(`[data-column-id="${cssEscape(fromCol)}"]`)
            ?.classList.add('is-edge-endpoint');
        if (toCol)
          this.nodesEl
            .querySelector(`[data-column-id="${cssEscape(toCol)}"]`)
            ?.classList.add('is-edge-endpoint');
      }
    }
  }

  private applyTableHover(id: string | null): void {
    if (this.hoveredTableId === id) return;
    if (this.hoveredTableId) {
      this.tableEls.get(this.hoveredTableId)?.classList.remove('is-hovered');
    }
    this.hoveredTableId = id;
    if (id) {
      this.tableEls.get(id)?.classList.add('is-hovered');
    }
    this.updateRelatedEdges();
  }

  /**
   * Recompute which edges should carry the `is-related` highlight based on
   * the current table + column hover state. When the pointer is on a column
   * that participates in any relationship, scope the highlight to that
   * column's edges only — otherwise fall back to all edges of the hovered
   * table.
   */
  private updateRelatedEdges(): void {
    const next = new Set<string>();
    if (this.hoveredTableId) {
      const activeColumn = this.hoveredColumnId ?? this.externalColumnId;
      const columnEdges = activeColumn ? this.edgesByColumn.get(activeColumn) : undefined;
      const source =
        columnEdges && columnEdges.size > 0
          ? columnEdges
          : this.edgesByTable.get(this.hoveredTableId);
      if (source) for (const id of source) next.add(id);
    }
    for (const id of this.currentRelatedEdges) {
      if (!next.has(id)) this.edgeEls.get(id)?.classList.remove('is-related');
    }
    for (const id of next) {
      if (!this.currentRelatedEdges.has(id)) this.edgeEls.get(id)?.classList.add('is-related');
    }
    this.currentRelatedEdges = next;
  }

  // ---- Internal handlers: apply visual + emit hover-change ----

  private setHoveredEdge(id: string | null): void {
    if (this.hoveredEdgeId === id) return;
    this.applyEdgeHover(id);
    const el = id ? this.edgeEls.get(id) : null;
    const state: HoverState = el
      ? { kind: 'edge', colA: el.dataset.fromColumn ?? '', colB: el.dataset.toColumn ?? '' }
      : { kind: 'none' };
    this.dispatchEvent(
      new CustomEvent<HoverState>('hover-change', { detail: state, bubbles: true }),
    );
  }

  private setHovered(id: string | null): void {
    if (this.hoveredTableId === id) return;
    this.applyTableHover(id);
    const state: HoverState = id ? { kind: 'table', tableId: id } : { kind: 'none' };
    this.dispatchEvent(
      new CustomEvent<HoverState>('hover-change', { detail: state, bubbles: true }),
    );
  }

  // ---- Public API: receive hover from other panels (no re-emission) ----

  /**
   * Apply a hover state driven by another panel. Does NOT emit `hover-change`
   * to prevent feedback loops. The app shell routes events between panels.
   */
  setExternalHover(state: HoverState): void {
    // Clear any internally-hovered column (user's mouse was in the diagram canvas).
    if (this.hoveredColumnId) {
      this.nodesEl
        .querySelector(`[data-column-id="${cssEscape(this.hoveredColumnId)}"]`)
        ?.classList.remove('is-edge-endpoint');
      this.hoveredColumnId = null;
    }
    // Clear any externally-applied column highlight (tracked separately
    // since it doesn't go through applyEdgeHover / applyTableHover).
    if (this.externalColumnId) {
      this.nodesEl
        .querySelector(`[data-column-id="${cssEscape(this.externalColumnId)}"]`)
        ?.classList.remove('is-edge-endpoint');
      this.externalColumnId = null;
    }
    this.applyTableHover(null);
    this.applyEdgeHover(null);
    switch (state.kind) {
      case 'table':
        this.applyTableHover(state.tableId);
        break;
      case 'column': {
        const colEl = this.nodesEl.querySelector(`[data-column-id="${cssEscape(state.columnId)}"]`);
        if (colEl) {
          colEl.classList.add('is-edge-endpoint');
          // Set externalColumnId BEFORE applyTableHover so updateRelatedEdges
          // can scope the highlight to this column's edges rather than the
          // table's full set.
          this.externalColumnId = state.columnId;
        }
        this.applyTableHover(state.tableId);
        break;
      }
      case 'edge': {
        const [pairA, pairB] = [state.colA, state.colB].sort();
        const edgeId = this.edgesByColumnPair.get(`${pairA}|${pairB}`);
        if (edgeId) this.applyEdgeHover(edgeId);
        break;
      }
    }
  }

  private selectTable(id: string): void {
    this.applyTableSelection(id);
    this.dispatchEvent(
      new CustomEvent('table-selected', { detail: { tableId: id }, bubbles: true }),
    );
  }

  /** Apply selection visual without emitting an event. Shared by selectTable and revealTable. */
  private applyTableSelection(id: string): void {
    if (this.selectedTableId && this.selectedTableId !== id) {
      this.tableEls.get(this.selectedTableId)?.classList.remove('is-selected');
    }
    this.selectedTableId = id;
    this.tableEls.get(id)?.classList.add('is-selected');
  }

  // ---- Public API: reveal table on external selection ----

  /**
   * Make the given table visible in the viewport (panning smoothly if needed),
   * mark it selected, and briefly pulse it so it's easy to locate visually.
   * Called when selection comes from the structure or detail pane; does NOT emit
   * `table-selected` to prevent feedback loops.
   */
  revealTable(id: string): void {
    // 1. Apply selection visual.
    this.applyTableSelection(id);

    // 2. Pan to the table if it's outside the current viewport.
    const pos = this.positions.get(id);
    if (!pos) return;

    const vw = this.viewportEl.clientWidth;
    const vh = this.viewportEl.clientHeight;
    if (vw === 0 || vh === 0) return;

    const { scale, tx, ty } = this.viewport;
    // Canvas-space top-left corner of the table.
    const cx = pos.x + this.layoutOffset.x;
    const cy = pos.y + this.layoutOffset.y;
    const cw = pos.width;
    const ch = pos.height;

    // Map to viewport-space.
    const vpLeft = cx * scale + tx;
    const vpTop = cy * scale + ty;
    const vpRight = (cx + cw) * scale + tx;
    const vpBottom = (cy + ch) * scale + ty;

    if (vpLeft < 0 || vpTop < 0 || vpRight > vw || vpBottom > vh) {
      // Center the table in the viewport.
      this.panTo(vw / 2 - (cx + cw / 2) * scale, vh / 2 - (cy + ch / 2) * scale);
    }

    // 3. Brief highlight so the table pops visually.
    const el = this.tableEls.get(id);
    if (el) {
      el.classList.remove('is-revealed');
      void el.offsetWidth; // force reflow so removing + re-adding restarts the animation
      el.classList.add('is-revealed');
      el.addEventListener('animationend', () => el.classList.remove('is-revealed'), { once: true });
    }
  }

  /** Smoothly pan to (newTx, newTy) via a temporary CSS transition on the canvas. */
  private panTo(newTx: number, newTy: number): void {
    this.canvasEl.classList.add('is-panning-to');
    this.viewport.tx = newTx;
    this.viewport.ty = newTy;
    this.applyViewport();
    this.canvasEl.addEventListener(
      'transitionend',
      () => this.canvasEl.classList.remove('is-panning-to'),
      { once: true },
    );
  }

  private renderEmpty(): void {
    this.canvasEl.style.visibility = 'hidden';
    this.nodesEl.innerHTML = '';
    while (this.edgesEl.firstChild) this.edgesEl.removeChild(this.edgesEl.firstChild);
    this.statusEl.textContent = t('diagram.empty');
    // No tables means no groups — hide the toggle button.
    this.groups = [];
    this.groupEls.clear();
    this.groupsEl.innerHTML = '';
    this.groupsEl.hidden = false;
    this.updateGroupsToggle();
  }

  /** Export the current diagram as a standalone SVG document. Triggers a download. */
  private exportSvg(): void {
    if (!this.lastLayout) return;
    const width = this.canvasEl.clientWidth;
    const height = this.canvasEl.clientHeight;
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="${SVG_NS}" xmlns:xhtml="http://www.w3.org/1999/xhtml" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <style>${EXPORT_CSS}</style>
  <foreignObject x="0" y="0" width="${width}" height="${height}">
    <xhtml:div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:${width}px;height:${height}px">
      ${this.groupsEl.outerHTML}
    </xhtml:div>
  </foreignObject>
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
    a.download = t('diagram.export.filename');
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function makeTemplate(): string {
  return `
    <div class="dv-diagram-toolbar" data-toolbar>
      <button type="button" data-act="zoom-in" title="${escapeAttr(t('diagram.toolbar.zoom_in.title'))}">${escapeHtml(t('diagram.toolbar.zoom_in.label'))}</button>
      <button type="button" data-act="zoom-out" title="${escapeAttr(t('diagram.toolbar.zoom_out.title'))}">${escapeHtml(t('diagram.toolbar.zoom_out.label'))}</button>
      <button type="button" data-act="fit" class="dv-diagram-toolbar-icon-btn" title="${escapeAttr(t('diagram.toolbar.fit.title'))}" aria-label="${escapeAttr(t('diagram.toolbar.fit.title'))}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6V3.5a1 1 0 0 1 1-1H6M10 2.5h2.5a1 1 0 0 1 1 1V6M13.5 10v2.5a1 1 0 0 1-1 1H10M6 13.5H3.5a1 1 0 0 1-1-1V10"/></svg></button>
      <button type="button" data-act="reset" title="${escapeAttr(t('diagram.toolbar.reset.title'))}">${escapeHtml(t('diagram.toolbar.reset.label'))}</button>
      <button type="button" data-act="export-svg" title="${escapeAttr(t('diagram.toolbar.export_svg.title'))}">${escapeHtml(t('diagram.toolbar.export_svg.label'))}</button>
      <span class="dv-diagram-toolbar-sep" aria-hidden="true"></span>
      <button type="button" data-act="cols-toggle" class="dv-diagram-toolbar-icon-btn" aria-pressed="false" title="${escapeAttr(t('diagram.toolbar.cols.toggle.title'))}" aria-label="${escapeAttr(t('diagram.toolbar.cols.toggle.title'))}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 9.5a3.18 3.18 0 0 0 4.5 0l1.5-1.5a3.18 3.18 0 0 0-4.5-4.5L7 4.5"/><path d="M9.5 6.5a3.18 3.18 0 0 0-4.5 0l-1.5 1.5a3.18 3.18 0 0 0 4.5 4.5L9 11.5"/></svg></button>
      <button type="button" data-act="groups-toggle" class="dv-diagram-toolbar-icon-btn" aria-pressed="false" hidden title="${escapeAttr(t('diagram.toolbar.groups.toggle.title'))}" aria-label="${escapeAttr(t('diagram.toolbar.groups.toggle.title'))}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="2" stroke-dasharray="3 2"/></svg></button>
      <span class="dv-diagram-status" data-status></span>
    </div>
    <div class="dv-diagram-viewport" data-viewport>
      <div class="dv-canvas" data-canvas>
        <div class="dv-groups" data-groups></div>
        <svg class="dv-edges" data-edges xmlns="${SVG_NS}"></svg>
        <div class="dv-nodes" data-nodes></div>
      </div>
    </div>
  `;
}

const EXPORT_CSS = `
.dv-table { position: absolute; box-sizing: border-box; background: #fff; border: 1px solid #d1d5db; font: 13px / 1.4 ui-sans-serif, system-ui, sans-serif; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
.dv-table-header { padding: 0.4rem 0.6rem; background: #f3f4f6; border-bottom: 1px solid #d1d5db; font-weight: 600; }
.dv-table.has-header-color > .dv-table-header { background: color-mix(in srgb, var(--dv-table-header-color) 22%, #f3f4f6); border-bottom-color: color-mix(in srgb, var(--dv-table-header-color) 60%, #d1d5db); }
.dv-table.has-header-color > .dv-table-header .dv-table-name { color: color-mix(in srgb, var(--dv-table-header-color) 75%, #242424); }
.dv-table-schema { font-size: 0.65rem; color: #6b7280; text-transform: uppercase; letter-spacing: 0.04em; display: block; }
.dv-row { display: grid; grid-template-columns: 1fr auto auto; gap: 0.5rem; padding: 0.25rem 0.6rem; border-top: 1px solid #f1f5f9; font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
.dv-row-flags { color: #94a3b8; font-size: 10px; }
.dv-row-type { color: #6d28d9; font-size: 11px; }
.dv-group { position: absolute; top: 0; left: 0; box-sizing: border-box; background: rgba(148, 163, 184, 0.07); border: 1px dashed rgba(148, 163, 184, 0.6); border-radius: 6px; }
.dv-group-label { position: absolute; top: 4px; left: 8px; padding: 0.1rem 0.45rem; font-size: 0.65rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: #475569; background: #f1f5f9; border: 1px solid rgba(148, 163, 184, 0.5); border-radius: 4px; }
.dv-edge-group { color: #94a3b8; }
.dv-edge-group.has-color { color: var(--dv-edge-color); }
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
  tri.setAttribute('points', `${end.x},${end.y} ${baseX},${end.y - 4} ${baseX},${end.y + 4}`);
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

function buildTableElement(
  table: Table,
  refs: Ref[],
  showSchema: boolean,
  hideNonRelational: boolean,
): HTMLElement {
  const id = tableId(table);
  const el = document.createElement('div');
  el.className = 'dv-table';
  const schema = table.schemaName ?? DEFAULT_SCHEMA;
  const pkColumns = new Set(table.fields.filter((c) => c.pk).map((c) => c.name));
  // FK badge: column on the `*` (foreign-key-holder) side.
  const fkColumns = new Set<string>();
  // Filter participants: any column on either side of any ref involving this table.
  // The PK side is referenced *by* an FK, so it counts as "part of the FK" too.
  const fkParticipants = new Set<string>();
  const selfId = id;
  for (const ref of refs) {
    const [a, b] = ref.endpoints;
    if (!a || !b) continue;
    if (endpointTableId(a) === selfId) {
      for (const f of a.fieldNames) fkParticipants.add(f);
      if (a.relation === '*') for (const f of a.fieldNames) fkColumns.add(f);
    }
    if (endpointTableId(b) === selfId) {
      for (const f of b.fieldNames) fkParticipants.add(f);
      if (b.relation === '*') for (const f of b.fieldNames) fkColumns.add(f);
    }
  }
  const visibleRows = table.fields
    .filter((c) => isColumnVisible(c, hideNonRelational, fkParticipants))
    .map((c) => renderRow(table, c, pkColumns, fkColumns))
    .join('');
  el.innerHTML = `
    <div class="dv-table-header">
      ${showSchema ? `<span class="dv-table-schema">${escapeHtml(schema)}</span>` : ''}
      <span class="dv-table-name">${escapeHtml(table.name)}</span>
    </div>
    ${visibleRows}
  `;
  return el;
}

function isColumnVisible(
  column: Column,
  hideNonRelational: boolean,
  fkParticipants: Set<string>,
): boolean {
  return !hideNonRelational || fkParticipants.has(column.name);
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
  // @dbml/parse already bakes args into type_name (e.g. "varchar(255)"),
  // so we only need the schema prefix — appending `args` again would duplicate the parens.
  const { schemaName, type_name } = column.type;
  return schemaName ? `${schemaName}.${type_name}` : type_name;
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

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
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
  return typeof CSS !== 'undefined' && CSS.escape
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&');
}

export function registerDiagramElement(): void {
  if (!customElements.get(DbmlDiagramElement.tagName)) {
    customElements.define(DbmlDiagramElement.tagName, DbmlDiagramElement);
  }
}
