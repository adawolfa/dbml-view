// Stub — Phase 3b.
// `<dbml-diagram source="…">` — HTML tables + SVG overlay with FK edges.
// Pipeline: measurement (off-screen) → layout (packages/layout) → render + pan/zoom.

export class DbmlDiagramElement extends HTMLElement {
  static readonly tagName = 'dbml-diagram';

  connectedCallback(): void {
    this.textContent = 'dbml-diagram — not implemented (Phase 3b)';
  }
}

if (!customElements.get(DbmlDiagramElement.tagName)) {
  customElements.define(DbmlDiagramElement.tagName, DbmlDiagramElement);
}
