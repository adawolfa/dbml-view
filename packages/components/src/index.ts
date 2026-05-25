// Custom Elements must be registered explicitly — call register() after setting
// the locale so that connectedCallback() picks up the correct translations.

import { DbmlStructureElement, registerStructureElement } from './structure';
import { DbmlDetailElement, registerDetailElement } from './detail';
import { DbmlDiagramElement, registerDiagramElement } from './diagram';

export { DbmlStructureElement, registerStructureElement };
export { DbmlDetailElement, registerDetailElement };
export { DbmlDiagramElement, registerDiagramElement };
export type { Selection, HoverState } from './shared';

/** Register all custom elements. Call this after setLocale() so that the initial
 * render uses the correct translations. */
export function register(): void {
  registerStructureElement();
  registerDetailElement();
  registerDiagramElement();
}
