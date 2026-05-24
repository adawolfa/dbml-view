// SPA shell. Loads a .dbml file (drop, picker, sample, or ?url=) and feeds it
// into <dbml-structure>. Remembers the last file in localStorage. Tabs for
// Diagram / Split are stubs until Phase 3 lands.

import '@dbml-view/components';
import '@dbml-view/components/style.css';

import type { DbmlStructureElement } from '@dbml-view/components';

const LS_KEY = 'dbml-view:last-source';
const LS_NAME_KEY = 'dbml-view:last-name';

const dropzone = mustGet<HTMLElement>('dropzone');
const fileInput = mustGet<HTMLInputElement>('file-input');
const openButton = mustGet<HTMLButtonElement>('open-button');
const structureView = mustGet<HTMLElement>('view-structure');
const structure = mustGet<DbmlStructureElement>('structure');
const status = mustGet<HTMLElement>('status');

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
  structure.source = source;
  dropzone.hidden = true;
  structureView.hidden = false;
  status.textContent = label;
  try {
    localStorage.setItem(LS_KEY, source);
    localStorage.setItem(LS_NAME_KEY, label);
  } catch {
    // Quota / private mode — silently skip persistence.
  }
}

function mustGet<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Bootstrap: missing #${id}`);
  return el as T;
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
