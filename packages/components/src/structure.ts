// Stub — Phase 2.
// `<dbml-structure source="…">` or `<dbml-structure>` with a `database` prop.

export class DbmlStructureElement extends HTMLElement {
  static readonly tagName = 'dbml-structure';

  connectedCallback(): void {
    this.textContent = 'dbml-structure — not implemented (Phase 2)';
  }
}

if (!customElements.get(DbmlStructureElement.tagName)) {
  customElements.define(DbmlStructureElement.tagName, DbmlStructureElement);
}
