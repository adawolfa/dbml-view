// SPA shell. Loads a .dbml file (drop, picker, sample, or ?url=) and feeds it
// into the structure + diagram components. Remembers the last file in
// localStorage and the last set of active views.

import '@dbml-view/components';
import '@dbml-view/components/style.css';

import type { DbmlDiagramElement, DbmlStructureElement } from '@dbml-view/components';

const LS_KEY = 'dbml-view:last-source';
const LS_NAME_KEY = 'dbml-view:last-name';
const LS_VIEWS_KEY = 'dbml-view:active-views';
const LS_THEME_KEY = 'dbml-view:theme';

type Theme = 'light' | 'dark';

type View = 'structure' | 'diagram';
const VIEWS: readonly View[] = ['structure', 'diagram'];

const dropzone = mustGet<HTMLElement>('dropzone');
const fileInput = mustGet<HTMLInputElement>('file-input');
const fileButton = mustGet<HTMLButtonElement>('file-button');
const fileButtonLabel = mustGet<HTMLElement>('file-button-label');
const status = mustGet<HTMLElement>('status');
const togglesEl = mustGet<HTMLElement>('view-toggles');
const viewsEl = mustGet<HTMLElement>('views');
const themeToggle = mustGet<HTMLButtonElement>('theme-toggle');

const structure = mustGet<DbmlStructureElement>('structure');
const diagram = mustGet<DbmlDiagramElement>('diagram');

const viewSections: Record<View, HTMLElement> = {
  structure: mustGet<HTMLElement>('view-structure'),
  diagram: mustGet<HTMLElement>('view-diagram'),
};

const activeViews = new Set<View>(['structure']);
let hasSource = false;

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

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-sample]')) {
  const name = button.dataset.sample;
  if (!name || !samplesByName.has(name)) {
    button.disabled = true;
    continue;
  }
  button.addEventListener('click', () => {
    const source = samplesByName.get(name);
    if (source) applySource(source, name);
  });
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
    status.textContent = `Couldn't load ${label}: ${(err as Error).message}`;
  }
}

function applySource(source: string, label: string): void {
  hasSource = true;
  dropzone.hidden = true;
  structure.source = source;
  diagram.source = source;
  setFileLabel(label);
  status.textContent = '';
  renderViews();
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
  if (!hasSource) {
    viewsEl.hidden = true;
    dropzone.hidden = false;
    return;
  }
  viewsEl.hidden = false;
  viewsEl.classList.toggle('is-split', activeViews.size > 1);
  for (const view of VIEWS) {
    viewSections[view].hidden = !activeViews.has(view);
  }
}

function mustGet<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Bootstrap: missing #${id}`);
  return el as T;
}

// --- Theme: follow system preference until the user explicitly toggles. ---

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
  const theme = effectiveTheme();
  document.documentElement.setAttribute('data-theme', theme);
  const label = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  themeToggle.title = label;
  themeToggle.setAttribute('aria-label', label);
}

themeToggle.addEventListener('click', () => {
  const next: Theme = effectiveTheme() === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem(LS_THEME_KEY, next);
  } catch {
    // ignore
  }
  applyTheme();
});

darkMql.addEventListener('change', () => {
  if (storedTheme() === null) applyTheme();
});

applyTheme();

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

// Bootstrap: ?url=… > last-stored source > drop zone.
const urlParam = new URLSearchParams(window.location.search).get('url');
if (urlParam) {
  void loadUrl(urlParam, urlParam);
} else {
  try {
    const stored = localStorage.getItem(LS_KEY);
    const storedName = localStorage.getItem(LS_NAME_KEY);
    if (stored) applySource(stored, storedName ?? '(previous)');
  } catch {
    // ignore
  }
}

// Cross-component sync: when the user clicks a table in the diagram, also
// reveal it in the structure view (helps when both are visible).
diagram.addEventListener('table-selected', (event) => {
  const detail = (event as CustomEvent<{ tableId: string }>).detail;
  if (!detail?.tableId) return;
  window.location.hash = `#table:${encodeURIComponent(detail.tableId)}`;
});
