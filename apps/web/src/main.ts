// Stub — Phase 4.
// SPA shell: drop zone, tab switch (Structure / Diagram / Split),
// localStorage for the last file, ?url= parameter.

import '@dbml-view/components';
import '@dbml-view/components/style.css';

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input') as HTMLInputElement | null;

if (!dropzone || !fileInput) {
  throw new Error('Bootstrap: missing #dropzone or #file-input in index.html');
}

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
  if (file) {
    await loadFile(file);
  }
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (file) {
    await loadFile(file);
  }
});

async function loadFile(file: File): Promise<void> {
  const source = await file.text();
  // TODO Phase 4: pass into <dbml-structure> / <dbml-diagram>.
  console.log('Loaded DBML, %d bytes', source.length);
}
