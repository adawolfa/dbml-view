// SPA shell. Loads a .dbml file (drop, picker, sample, or ?url=) and feeds it
// into the structure, detail, and diagram components. Owns the URL hash,
// cross-component selection wiring, and the resizable three-panel layout.

import '@dbml-view/components/style.css';

import { register as registerComponents } from '@dbml-view/components';
import type {
  DbmlDetailElement,
  DbmlDiagramElement,
  DbmlStructureElement,
  HoverState,
  Selection,
} from '@dbml-view/components';
import { cs, setLocale, t } from '@dbml-view/i18n';
import { parseDbml } from '@dbml-view/parser';

const LS_KEY = 'dbml-view:last-source';
const LS_NAME_KEY = 'dbml-view:last-name';
const LS_VIEWS_KEY = 'dbml-view:active-views';
const LS_THEME_KEY = 'dbml-view:theme';
const LS_LOCALE_KEY = 'dbml-view:locale';
const LS_FONT_KEY = 'dbml-view:font';
const LS_PANEL_WIDTH_PREFIX = 'dbml-view:panel-width:';

type Locale = 'en' | 'cs';

type Theme = 'light' | 'dark';

type FontMode = 'mono' | 'proportional';

type View = 'structure' | 'detail' | 'diagram';
const VIEWS: readonly View[] = ['structure', 'detail', 'diagram'];

const PANEL_MIN_PX: Record<View, number> = {
  structure: 200,
  detail: 320,
  diagram: 280,
};

const PANEL_DEFAULT_PX: Record<View, number> = {
  structure: 280,
  detail: 480,
  diagram: 520,
};

const dropzone = mustGet<HTMLElement>('dropzone');
const fileInput = mustGet<HTMLInputElement>('file-input');
const fileButton = mustGet<HTMLButtonElement>('file-button');
const fileButtonLabel = mustGet<HTMLElement>('file-button-label');
const fileDropdownTrigger = mustGet<HTMLButtonElement>('file-dropdown-trigger');
const fileDropdown = mustGet<HTMLElement>('file-dropdown');
const status = mustGet<HTMLElement>('status');
const togglesEl = mustGet<HTMLElement>('view-toggles');
const viewsEl = mustGet<HTMLElement>('views');
const settingsTrigger = mustGet<HTMLButtonElement>('settings-trigger');
const settingsDropdown = mustGet<HTMLElement>('settings-dropdown');
const themeLightBtn = mustGet<HTMLButtonElement>('theme-light');
const themeDarkBtn = mustGet<HTMLButtonElement>('theme-dark');
const themeLightLabel = mustGet<HTMLElement>('theme-light-label');
const themeDarkLabel = mustGet<HTMLElement>('theme-dark-label');
const fontMonoBtn = mustGet<HTMLButtonElement>('font-mono');
const fontPropBtn = mustGet<HTMLButtonElement>('font-proportional');
const fontMonoLabel = mustGet<HTMLElement>('font-mono-label');
const fontPropLabel = mustGet<HTMLElement>('font-proportional-label');
const langSelect = mustGet<HTMLSelectElement>('lang-select');

const structure = mustGet<DbmlStructureElement>('structure');
const detail = mustGet<DbmlDetailElement>('detail');
const diagram = mustGet<DbmlDiagramElement>('diagram');

const viewSections: Record<View, HTMLElement> = {
  structure: mustGet<HTMLElement>('view-structure'),
  detail: mustGet<HTMLElement>('view-detail'),
  diagram: mustGet<HTMLElement>('view-diagram'),
};

const activeViews = new Set<View>(['structure', 'detail']);
const panelWidths: Record<View, number> = {
  structure: loadPanelWidth('structure'),
  detail: loadPanelWidth('detail'),
  diagram: loadPanelWidth('diagram'),
};
let hasSource = false;
let currentSelection: Selection = { kind: 'none' };

// Bootstrap locale before registering components so that connectedCallback()
// (triggered by customElements.define) already sees the correct locale.
const activeLocale: Locale = storedLocale() ?? 'en';
if (activeLocale === 'cs') setLocale(cs);

// Register custom elements now — the side-effect import no longer auto-registers
// them, so we do it explicitly after setLocale() above.
registerComponents();

// Apply translations to the static HTML elements that can't be reached from
// component render methods (view toggles, file button initial state, dropzone).
initTranslations();

fileButton.addEventListener('click', () => fileInput.click());

dropzone.addEventListener('click', () => fileInput.click());

dropzone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropzone.classList.add('is-over');
});

dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('is-over');
});

dropzone.addEventListener('drop', async (event) => {
  event.preventDefault();
  dropzone.classList.remove('is-over');
  const file = event.dataTransfer?.files?.[0];
  if (file) await loadFile(file);
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (file) await loadFile(file);
});

togglesEl.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-view]');
  if (!button || button.disabled) return;
  const view = button.dataset.view as View | undefined;
  if (view && VIEWS.includes(view)) toggleView(view);
});

const samples = import.meta.glob('../../../samples/*.dbml', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const samplesByName = new Map<string, string>();
for (const [path, source] of Object.entries(samples)) {
  const name = path.split('/').pop();
  if (name) samplesByName.set(name, source);
}

// Populate the samples dropdown.
for (const [name] of samplesByName) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'file-dropdown-item';
  item.setAttribute('role', 'menuitem');
  item.textContent = name.replace(/\.dbml$/, '');
  fileDropdown.appendChild(item);
  item.addEventListener('click', () => {
    const source = samplesByName.get(name);
    if (source) applySource(source, name);
    closeFileDropdown();
  });
}

fileDropdownTrigger.addEventListener('click', () => {
  if (fileDropdown.hidden) {
    openFileDropdown();
  } else {
    closeFileDropdown();
  }
});

settingsTrigger.addEventListener('click', () => {
  if (settingsDropdown.hidden) {
    openSettingsDropdown();
  } else {
    closeSettingsDropdown();
  }
});

document.addEventListener('click', (event) => {
  if (!fileDropdown.hidden) {
    const group = fileDropdownTrigger.closest('.file-group');
    if (!group?.contains(event.target as Node)) closeFileDropdown();
  }
  if (!settingsDropdown.hidden) {
    const group = document.getElementById('settings-group');
    if (!group?.contains(event.target as Node)) closeSettingsDropdown();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!fileDropdown.hidden) {
      closeFileDropdown();
      fileDropdownTrigger.focus();
    }
    if (!settingsDropdown.hidden) {
      closeSettingsDropdown();
      settingsTrigger.focus();
    }
  }
});

function openFileDropdown(): void {
  fileDropdown.hidden = false;
  fileDropdownTrigger.setAttribute('aria-expanded', 'true');
}

function closeFileDropdown(): void {
  fileDropdown.hidden = true;
  fileDropdownTrigger.setAttribute('aria-expanded', 'false');
}

function openSettingsDropdown(): void {
  settingsDropdown.hidden = false;
  settingsTrigger.setAttribute('aria-expanded', 'true');
}

function closeSettingsDropdown(): void {
  settingsDropdown.hidden = true;
  settingsTrigger.setAttribute('aria-expanded', 'false');
}

async function loadFile(file: File): Promise<void> {
  const source = await file.text();
  applySource(source, file.name);
}

async function loadUrl(url: string, label: string): Promise<void> {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const source = await response.text();
    applySource(source, label);
  } catch (err) {
    status.textContent = t('app.error.load_url', { label, message: (err as Error).message });
  }
}

function applySource(source: string, label: string): void {
  const result = parseDbml(source);
  hasSource = true;
  dropzone.hidden = true;
  if (result.ok) {
    structure.setDatabase(result.db);
    detail.setDatabase(result.db);
  } else {
    // Push the raw source so each component renders its own error state.
    structure.source = source;
    detail.source = source;
  }
  diagram.source = source;
  setFileLabel(label);
  void setWindowTitle(label);
  status.textContent = '';
  renderViews();
  // Apply current hash (if any) to the new database so deep-links survive
  // reloading with a different file.
  syncSelectionFromHash();
  try {
    localStorage.setItem(LS_KEY, source);
    localStorage.setItem(LS_NAME_KEY, label);
  } catch {
    // Quota / private mode — silently skip persistence.
  }
}

function setFileLabel(label: string): void {
  fileButtonLabel.textContent = label;
  fileButton.title = label;
}

const APP_TITLE = 'DBML View';

async function setWindowTitle(label: string | null): Promise<void> {
  const title = label ?? APP_TITLE;
  document.title = title;
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().setTitle(title);
  } catch {
    // Tauri runtime missing or IPC error — browser title fallback is fine.
  }
}

function toggleView(view: View): void {
  if (activeViews.has(view)) {
    if (activeViews.size === 1) return; // keep at-least-one invariant
    activeViews.delete(view);
  } else {
    activeViews.add(view);
  }
  persistViews();
  renderViews();
}

function setActiveViews(views: Iterable<View>): void {
  activeViews.clear();
  for (const v of views) activeViews.add(v);
  if (activeViews.size === 0) activeViews.add('structure');
  renderViews();
}

function persistViews(): void {
  try {
    localStorage.setItem(LS_VIEWS_KEY, [...activeViews].join(','));
  } catch {
    // ignore
  }
}

function renderViews(): void {
  for (const button of togglesEl.querySelectorAll<HTMLButtonElement>('button[data-view]')) {
    const view = button.dataset.view as View | undefined;
    const on = view !== undefined && activeViews.has(view);
    button.classList.toggle('is-active', on);
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  updateDetailToggle();
  if (!hasSource) {
    viewsEl.hidden = true;
    dropzone.hidden = false;
    return;
  }
  viewsEl.hidden = false;
  for (const view of VIEWS) {
    viewSections[view].hidden = !effectivelyVisible(view);
  }
  layoutPanels();
}

/**
 * Rebuilds the splitter DOM and applies widths. Each visible panel except
 * the last one gets a fixed pixel width; the last fills the remaining space.
 * Splitters live between adjacent visible panels and resize the panel on
 * their left.
 */
function layoutPanels(): void {
  // Remove existing splitters; sections re-order naturally.
  for (const splitter of viewsEl.querySelectorAll('.app-splitter')) splitter.remove();

  const visible = VIEWS.filter((v) => effectivelyVisible(v));
  if (visible.length === 0) return;

  // When the structure panel is the only visible panel it would stretch to the
  // full window width, which looks odd for a narrow tree. Mark it so CSS can
  // cap its width; clear the flag whenever other panels are alongside it.
  viewSections.structure.classList.toggle(
    'is-solo',
    visible.length === 1 && visible[0] === 'structure',
  );

  // Reset widths on all sections, then apply per visible panel.
  for (const v of VIEWS) {
    const section = viewSections[v];
    section.style.removeProperty('flex');
    section.style.removeProperty('width');
    section.style.removeProperty('min-width');
  }

  visible.forEach((view, idx) => {
    const section = viewSections[view];
    const isLast = idx === visible.length - 1;
    section.style.minWidth = `${PANEL_MIN_PX[view]}px`;
    if (isLast) {
      // Fills the remaining space.
      section.style.flex = '1 1 0';
    } else {
      const width = Math.max(PANEL_MIN_PX[view], panelWidths[view]);
      section.style.flex = `0 0 ${width}px`;
      // Insert a splitter after this section, anchored to the panel on its left.
      const splitter = makeSplitter(view);
      section.after(splitter);
    }
  });
}

function makeSplitter(leftView: View): HTMLElement {
  const splitter = document.createElement('div');
  splitter.className = 'app-splitter';
  splitter.setAttribute('role', 'separator');
  splitter.setAttribute('aria-orientation', 'vertical');
  splitter.tabIndex = 0;
  splitter.dataset.leftView = leftView;

  let drag: { pointerId: number; startX: number; startWidth: number } | null = null;

  splitter.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const section = viewSections[leftView];
    event.preventDefault();
    splitter.setPointerCapture(event.pointerId);
    splitter.classList.add('is-dragging');
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: section.getBoundingClientRect().width,
    };
  });

  splitter.addEventListener('pointermove', (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const max = maxWidthFor(leftView);
    const next = clamp(
      drag.startWidth + (event.clientX - drag.startX),
      PANEL_MIN_PX[leftView],
      max,
    );
    setPanelWidth(leftView, next);
  });

  const end = (event: PointerEvent): void => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag = null;
    splitter.classList.remove('is-dragging');
    if (splitter.hasPointerCapture(event.pointerId)) {
      splitter.releasePointerCapture(event.pointerId);
    }
    savePanelWidth(leftView);
  };
  splitter.addEventListener('pointerup', end);
  splitter.addEventListener('pointercancel', end);

  splitter.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 32 : 8;
    const current = viewSections[leftView].getBoundingClientRect().width;
    const max = maxWidthFor(leftView);
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setPanelWidth(leftView, clamp(current - step, PANEL_MIN_PX[leftView], max));
      savePanelWidth(leftView);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      setPanelWidth(leftView, clamp(current + step, PANEL_MIN_PX[leftView], max));
      savePanelWidth(leftView);
    }
  });

  splitter.addEventListener('dblclick', () => {
    setPanelWidth(leftView, PANEL_DEFAULT_PX[leftView]);
    savePanelWidth(leftView);
  });

  return splitter;
}

/** Cap so the rightmost flex panel never collapses below its min-width. */
function maxWidthFor(view: View): number {
  const visible = VIEWS.filter((v) => effectivelyVisible(v));
  const containerWidth = viewsEl.getBoundingClientRect().width;
  // Account for gaps and splitters between adjacent panels.
  const gapCount = Math.max(0, visible.length - 1);
  const overhead = gapCount * (APP_PANEL_GAP_PX + APP_SPLITTER_PX);
  let reserved = overhead;
  for (const v of visible) {
    if (v === view) continue;
    // Each other non-last visible panel takes its current width; the last one
    // takes its min-width as a floor.
    const idx = visible.indexOf(v);
    const isLast = idx === visible.length - 1;
    reserved += isLast ? PANEL_MIN_PX[v] : Math.max(PANEL_MIN_PX[v], panelWidths[v]);
  }
  return Math.max(PANEL_MIN_PX[view], containerWidth - reserved);
}

function setPanelWidth(view: View, width: number): void {
  panelWidths[view] = width;
  const section = viewSections[view];
  section.style.flex = `0 0 ${Math.round(width)}px`;
}

function savePanelWidth(view: View): void {
  try {
    localStorage.setItem(`${LS_PANEL_WIDTH_PREFIX}${view}`, String(Math.round(panelWidths[view])));
  } catch {
    // ignore
  }
}

function loadPanelWidth(view: View): number {
  try {
    const stored = localStorage.getItem(`${LS_PANEL_WIDTH_PREFIX}${view}`);
    const parsed = stored !== null ? Number.parseInt(stored, 10) : Number.NaN;
    if (Number.isFinite(parsed) && parsed >= PANEL_MIN_PX[view]) return parsed;
  } catch {
    // ignore
  }
  return PANEL_DEFAULT_PX[view];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Returns true if a view panel should actually be shown. The detail panel is
 * additionally gated on having a table or enum selected — when nothing is
 * selected it stays hidden regardless of the header toggle state.
 */
function effectivelyVisible(view: View): boolean {
  return activeViews.has(view) && (view !== 'detail' || currentSelection.kind !== 'none');
}

function initTranslations(): void {
  // File button — title is overwritten with the filename once a file is loaded;
  // this sets the initial "no file" state.
  fileButton.title = t('app.file_button.title');
  fileButtonLabel.textContent = t('app.file_button.label');

  // View toggle button labels (icon stays untouched; only the <span data-label> is set).
  for (const button of togglesEl.querySelectorAll<HTMLButtonElement>('[data-view]')) {
    const view = button.dataset.view;
    const label = button.querySelector<HTMLElement>('[data-label]');
    if (!label) continue;
    if (view === 'structure') label.textContent = t('app.view.structure');
    else if (view === 'detail') label.textContent = t('app.view.detail.table');
    else if (view === 'diagram') label.textContent = t('app.view.diagram');
  }
  updateDetailToggle();

  // Samples label.
  const sampleLabelEl = document.querySelector('.sample-label');
  if (sampleLabelEl) sampleLabelEl.textContent = t('app.samples.label');

  // Dropzone — the prompt uses a {extension} placeholder so translators can
  // reorder the phrase; we substitute a <code> element here.
  const dropzoneP1 = dropzone.querySelector('p:not(.dropzone-hint)');
  const dropzoneHint = dropzone.querySelector('.dropzone-hint');
  if (dropzoneP1)
    dropzoneP1.innerHTML = t('app.dropzone.prompt', { extension: '<code>.dbml</code>' });
  if (dropzoneHint) dropzoneHint.textContent = t('app.dropzone.hint');

  // Settings dropdown.
  const settingsLabel = t('app.settings.open');
  settingsTrigger.title = settingsLabel;
  settingsTrigger.setAttribute('aria-label', settingsLabel);

  const lightLabel = t('app.settings.theme.light');
  const darkLabel = t('app.settings.theme.dark');
  themeLightLabel.textContent = lightLabel;
  themeDarkLabel.textContent = darkLabel;
  themeLightBtn.title = lightLabel;
  themeDarkBtn.title = darkLabel;

  const monoLabel = t('app.settings.font.mono');
  const propLabel = t('app.settings.font.proportional');
  fontMonoLabel.textContent = monoLabel;
  fontPropLabel.textContent = propLabel;
  fontMonoBtn.title = monoLabel;
  fontPropBtn.title = propLabel;

  langSelect.setAttribute('aria-label', t('app.settings.language.label'));
}

/**
 * The Detail toggle shows "Table" with a table icon by default; when the user
 * is viewing an enum it swaps to "Enum" with the enum icon. Driven by
 * currentSelection — call whenever it changes.
 */
function updateDetailToggle(): void {
  const button = togglesEl.querySelector<HTMLButtonElement>('button[data-view="detail"]');
  if (!button) return;
  const label = button.querySelector<HTMLElement>('[data-label]');
  const tableIcon = button.querySelector<HTMLElement>('[data-icon="table"]');
  const enumIcon = button.querySelector<HTMLElement>('[data-icon="enum"]');
  const isEnum = currentSelection.kind === 'enum';
  if (label) label.textContent = t(isEnum ? 'app.view.detail.enum' : 'app.view.detail.table');
  // toggleAttribute() — not the `.hidden` IDL property — because the icons are
  // SVG elements and `hidden` IDL doesn't reflect to the attribute on SVGElement.
  if (tableIcon) tableIcon.toggleAttribute('hidden', isEnum);
  if (enumIcon) enumIcon.toggleAttribute('hidden', !isEnum);
}

function mustGet<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Bootstrap: missing #${id}`);
  return el as T;
}

const APP_PANEL_GAP_PX = 0; // gaps are removed in favor of explicit splitters
const APP_SPLITTER_PX = 6;

// --- Theme: follow system preference unless the user picks light/dark. ---

const darkMql = window.matchMedia('(prefers-color-scheme: dark)');

function storedTheme(): Theme | null {
  try {
    const v = localStorage.getItem(LS_THEME_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

function effectiveTheme(): Theme {
  return storedTheme() ?? (darkMql.matches ? 'dark' : 'light');
}

function applyTheme(): void {
  document.documentElement.setAttribute('data-theme', effectiveTheme());
}

function refreshThemeButtons(): void {
  const active = effectiveTheme();
  themeLightBtn.setAttribute('aria-pressed', active === 'light' ? 'true' : 'false');
  themeDarkBtn.setAttribute('aria-pressed', active === 'dark' ? 'true' : 'false');
}

function setTheme(next: Theme): void {
  // Picking the mode that already matches the system unsets the stored override
  // so the app reverts to following system preference.
  const systemTheme: Theme = darkMql.matches ? 'dark' : 'light';
  try {
    if (next === systemTheme) {
      localStorage.removeItem(LS_THEME_KEY);
    } else {
      localStorage.setItem(LS_THEME_KEY, next);
    }
  } catch {
    // ignore
  }
  applyTheme();
  refreshThemeButtons();
}

themeLightBtn.addEventListener('click', () => setTheme('light'));
themeDarkBtn.addEventListener('click', () => setTheme('dark'));

darkMql.addEventListener('change', () => {
  if (storedTheme() === null) applyTheme();
  refreshThemeButtons();
});

applyTheme();
refreshThemeButtons();

// --- Locale: persist and switch on change (reload to re-render all components). ---

function storedLocale(): Locale | null {
  try {
    const v = localStorage.getItem(LS_LOCALE_KEY);
    return v === 'en' || v === 'cs' ? v : null;
  } catch {
    return null;
  }
}

// Initialise the language <select> to reflect the stored locale.
langSelect.value = activeLocale;

langSelect.addEventListener('change', () => {
  const next = langSelect.value;
  try {
    localStorage.setItem(LS_LOCALE_KEY, next);
  } catch {
    // ignore
  }
  window.location.reload();
});

// --- Font: switch between monospace (Cascadia Code) and proportional (Aptos). ---

function storedFont(): FontMode | null {
  try {
    const v = localStorage.getItem(LS_FONT_KEY);
    return v === 'mono' || v === 'proportional' ? v : null;
  } catch {
    return null;
  }
}

function effectiveFont(): FontMode {
  return storedFont() ?? 'mono';
}

function applyFont(): void {
  if (effectiveFont() === 'proportional') {
    document.documentElement.setAttribute('data-font', 'proportional');
  } else {
    document.documentElement.removeAttribute('data-font');
  }
}

function refreshFontButtons(): void {
  const active = effectiveFont();
  fontMonoBtn.setAttribute('aria-pressed', active === 'mono' ? 'true' : 'false');
  fontPropBtn.setAttribute('aria-pressed', active === 'proportional' ? 'true' : 'false');
}

function setFont(next: FontMode): void {
  // 'mono' is the default — picking it clears any stored override so the app
  // mirrors the theme behaviour of "picking the default unsets the preference".
  try {
    if (next === 'mono') {
      localStorage.removeItem(LS_FONT_KEY);
    } else {
      localStorage.setItem(LS_FONT_KEY, next);
    }
  } catch {
    // ignore
  }
  applyFont();
  refreshFontButtons();
}

fontMonoBtn.addEventListener('click', () => setFont('mono'));
fontPropBtn.addEventListener('click', () => setFont('proportional'));

applyFont();
refreshFontButtons();

// --- Selection wiring: structure ↔ detail ↔ diagram via URL hash. ---

function parseHashSelection(): Selection {
  const hash = window.location.hash;
  const tableMatch = /^#table:(.+)$/.exec(hash);
  if (tableMatch) return { kind: 'table', tableId: decodeURIComponent(tableMatch[1] ?? '') };
  const enumMatch = /^#enum:(.+)$/.exec(hash);
  if (enumMatch) return { kind: 'enum', enumId: decodeURIComponent(enumMatch[1] ?? '') };
  return { kind: 'none' };
}

function selectionToHash(selection: Selection): string {
  if (selection.kind === 'table') return `#table:${encodeURIComponent(selection.tableId)}`;
  if (selection.kind === 'enum') return `#enum:${encodeURIComponent(selection.enumId)}`;
  return '';
}

/** Push a selection to the components without echoing the hash. */
function applySelection(selection: Selection): void {
  currentSelection = selection;
  structure.setSelection(selection);
  detail.setSelection(selection);
  renderViews();
}

function syncSelectionFromHash(): void {
  applySelection(parseHashSelection());
}

structure.addEventListener('selection-change', (event) => {
  const sel = (event as CustomEvent<Selection>).detail;
  currentSelection = sel;
  detail.setSelection(sel);
  if (sel.kind === 'table') diagram.revealTable(sel.tableId);
  renderViews();
  const target = selectionToHash(sel);
  if (target && window.location.hash !== target) {
    history.replaceState(null, '', target || window.location.pathname);
  }
});

// Cross-component sync: when the user clicks a table in the diagram, also
// reveal it in the structure + detail panes.
diagram.addEventListener('table-selected', (event) => {
  const id = (event as CustomEvent<{ tableId: string }>).detail?.tableId;
  if (!id) return;
  const sel: Selection = { kind: 'table', tableId: id };
  applySelection(sel);
  const target = selectionToHash(sel);
  if (window.location.hash !== target) history.replaceState(null, '', target);
});

// Cross-panel hover synchronisation. Each panel emits `hover-change`; the app
// shell routes it to the OTHER two panels only (no echo back to the source).
diagram.addEventListener('hover-change', (event) => {
  const state = (event as CustomEvent<HoverState>).detail;
  structure.setExternalHover(state);
  detail.setExternalHover(state);
});

structure.addEventListener('hover-change', (event) => {
  const state = (event as CustomEvent<HoverState>).detail;
  diagram.setExternalHover(state);
  detail.setExternalHover(state);
});

detail.addEventListener('hover-change', (event) => {
  const state = (event as CustomEvent<HoverState>).detail;
  diagram.setExternalHover(state);
  structure.setExternalHover(state);
});

// Detail emits 'jump-to' when the user clicks a cross-link inside it.
detail.addEventListener('jump-to', (event) => {
  const sel = (event as CustomEvent<Selection>).detail;
  applySelection(sel);
  const target = selectionToHash(sel);
  if (window.location.hash !== target) history.replaceState(null, '', target);
});

window.addEventListener('hashchange', () => {
  syncSelectionFromHash();
});

// Restore last set of active views.
try {
  const stored = localStorage.getItem(LS_VIEWS_KEY);
  if (stored) {
    const restored = stored
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is View => (VIEWS as readonly string[]).includes(s));
    if (restored.length > 0) setActiveViews(restored);
  }
} catch {
  // ignore
}

renderViews();

// Bootstrap: Tauri argv > ?url= > last-stored source > drop zone.
void bootstrap().finally(() => {
  // Tauri starts the window hidden so the user never sees a white flash before
  // the theme + content are painted. Reveal it once initial state is applied.
  void showTauriWindow();
});

async function bootstrap(): Promise<void> {
  if (await bootstrapTauri()) return;

  const urlParam = new URLSearchParams(window.location.search).get('url');
  if (urlParam) {
    void loadUrl(urlParam, urlParam);
    return;
  }
  try {
    const stored = localStorage.getItem(LS_KEY);
    const storedName = localStorage.getItem(LS_NAME_KEY);
    if (stored) applySource(stored, storedName ?? t('app.previous_file'));
  } catch {
    // ignore
  }
}

async function showTauriWindow(): Promise<void> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().show();
  } catch {
    // ignore
  }
}

// Container resize: if the user shrinks the window such that the rightmost
// flex panel would underflow, clamp the fixed-width siblings.
window.addEventListener('resize', () => {
  if (!hasSource) return;
  let dirty = false;
  const visible = VIEWS.filter((v) => effectivelyVisible(v));
  for (let i = 0; i < visible.length - 1; i++) {
    const view = visible[i]!;
    const max = maxWidthFor(view);
    if (panelWidths[view] > max) {
      setPanelWidth(view, max);
      dirty = true;
    }
  }
  if (dirty) {
    // No persistence on resize-driven adjustments; only explicit user drags
    // overwrite stored widths.
  }
});

// When running inside the Tauri shell, subscribe to file-open events (from
// double-click / second-instance launches) and drain the initial argv payload.
// Returns true if an initial file was applied — in that case we skip the
// browser-only fallbacks (URL param, localStorage).
async function bootstrapTauri(): Promise<boolean> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return false;
  try {
    const [{ invoke }, { listen }] = await Promise.all([
      import('@tauri-apps/api/core'),
      import('@tauri-apps/api/event'),
    ]);
    type Payload = { name: string; source: string };
    await listen<Payload>('dbml-open', (event) => {
      applySource(event.payload.source, event.payload.name);
    });
    const initial = await invoke<Payload | null>('take_pending_open');
    if (initial) {
      applySource(initial.source, initial.name);
      return true;
    }
  } catch {
    // Tauri runtime missing or IPC error — fall back to browser behaviour.
  }
  return false;
}
