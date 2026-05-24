// SPA shell. Loads a .dbml file (drop, picker, sample, or ?url=) and feeds it
// into the structure + diagram components. Remembers the last file in
// localStorage and the last active tab.

import '@dbml-view/components';
import '@dbml-view/components/style.css';

import type { DbmlDiagramElement, DbmlStructureElement } from '@dbml-view/components';

const LS_KEY = 'dbml-view:last-source';
const LS_NAME_KEY = 'dbml-view:last-name';
const LS_TAB_KEY = 'dbml-view:last-tab';

type Tab = 'structure' | 'diagram' | 'split';
const TABS: Tab[] = ['structure', 'diagram', 'split'];

const dropzone = mustGet<HTMLElement>('dropzone');
const fileInput = mustGet<HTMLInputElement>('file-input');
const openButton = mustGet<HTMLButtonElement>('open-button');
const status = mustGet<HTMLElement>('status');
const tabsEl = mustGet<HTMLElement>('tabs');

const structures: DbmlStructureElement[] = [
  mustGet<DbmlStructureElement>('structure'),
  mustGet<DbmlStructureElement>('structure-split'),
];
const diagrams: DbmlDiagramElement[] = [
  mustGet<DbmlDiagramElement>('diagram'),
  mustGet<DbmlDiagramElement>('diagram-split'),
];

const views: Record<Tab, HTMLElement> = {
  structure: mustGet<HTMLElement>('view-structure'),
  diagram: mustGet<HTMLElement>('view-diagram'),
  split: mustGet<HTMLElement>('view-split'),
};

let currentTab: Tab = 'structure';
let hasSource = false;
let lastSource = '';

openButton.addEventListener('click', () => fileInput.click());

dropzone.addEventListener('click', (event) => {
  if ((event.target as HTMLElement).tagName === 'BUTTON') return;
  fileInput.click();
});

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

tabsEl.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-tab]');
  if (!button || button.disabled) return;
  const tab = button.dataset.tab as Tab | undefined;
  if (tab && TABS.includes(tab)) {
    selectTab(tab);
  }
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
  lastSource = source;
  hasSource = true;
  dropzone.hidden = true;
  // Feed both copies; the active one becomes visible via selectTab.
  for (const s of structures) s.source = source;
  for (const d of diagrams) d.source = source;
  showCurrentView();
  status.textContent = label;
  try {
    localStorage.setItem(LS_KEY, source);
    localStorage.setItem(LS_NAME_KEY, label);
  } catch {
    // Quota / private mode — silently skip persistence.
  }
}

function selectTab(tab: Tab): void {
  currentTab = tab;
  for (const button of tabsEl.querySelectorAll<HTMLButtonElement>('button[data-tab]')) {
    button.classList.toggle('is-active', button.dataset.tab === tab);
  }
  try {
    localStorage.setItem(LS_TAB_KEY, tab);
  } catch {
    // ignore
  }
  showCurrentView();
}

function showCurrentView(): void {
  if (!hasSource) {
    for (const v of Object.values(views)) v.hidden = true;
    dropzone.hidden = false;
    return;
  }
  for (const [name, el] of Object.entries(views) as [Tab, HTMLElement][]) {
    el.hidden = name !== currentTab;
  }
}

function mustGet<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Bootstrap: missing #${id}`);
  return el as T;
}

// Restore last tab.
try {
  const storedTab = localStorage.getItem(LS_TAB_KEY) as Tab | null;
  if (storedTab && TABS.includes(storedTab)) {
    selectTab(storedTab);
  }
} catch {
  // ignore
}

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
// reveal it in the structure view (helps in split mode).
for (const d of diagrams) {
  d.addEventListener('table-selected', (event) => {
    const detail = (event as CustomEvent<{ tableId: string }>).detail;
    if (!detail?.tableId) return;
    window.location.hash = `#table:${encodeURIComponent(detail.tableId)}`;
  });
}
