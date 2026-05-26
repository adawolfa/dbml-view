// Custom Elements must be registered explicitly — call register() after setting
// the locale so that connectedCallback() picks up the correct translations.

import { DbmlDetailElement, registerDetailElement } from './detail';
import { DbmlDiagramElement, registerDiagramElement } from './diagram';
import { DbmlStructureElement, registerStructureElement } from './structure';

export type { HiddenSet, HoverState, Selection } from './shared';
export { computeHiddenTableIds, emptyHiddenSet, hiddenSetIsEmpty } from './shared';
export type { SearchActiveDetail, SearchMatch } from './structure';
export {
  DbmlDetailElement,
  DbmlDiagramElement,
  DbmlStructureElement,
  registerDetailElement,
  registerDiagramElement,
  registerStructureElement,
};

/** Register all custom elements. Call this after setLocale() so that the initial
 * render uses the correct translations. */
export function register(): void {
  registerStructureElement();
  registerDetailElement();
  registerDiagramElement();
}
