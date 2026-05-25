// Parse-error modal: opening a broken .dbml file shows a modal with the error
// position, an adjacent-code snippet, and the highlighted error line.

import { expect, test } from '@playwright/test';
import { installPersistentClear, loadSample } from './_setup';

/** Simulate loading DBML source via the hidden file input. */
async function loadSource(
  page: import('@playwright/test').Page,
  source: string,
  filename = 'test.dbml',
): Promise<void> {
  await page.setInputFiles('#file-input', {
    name: filename,
    mimeType: 'text/plain',
    buffer: Buffer.from(source, 'utf-8'),
  });
}

test.beforeEach(async ({ page }) => {
  await installPersistentClear(page);
});

test.describe('parse-error modal', () => {
  test('shows the modal when a broken file is opened', async ({ page }) => {
    await page.goto('/');
    await loadSource(page, 'this is not dbml at all', 'broken.dbml');

    const modal = page.locator('#error-modal');
    await expect(modal).toBeVisible();
    // The dialog must not sit on top of everything when closed — verify it carries the [open] attribute.
    await expect(modal).toHaveAttribute('open');
  });

  test('displays an error position (line:column)', async ({ page }) => {
    await page.goto('/');
    await loadSource(page, 'this is not dbml at all');

    const pos = page.locator('#error-modal .error-modal-pos').first();
    await expect(pos).toBeVisible();
    // Must match "line:column" format.
    await expect(pos).toHaveText(/^\d+:\d+$/);
  });

  test('displays a code snippet with the error line highlighted', async ({ page }) => {
    await page.goto('/');
    // Multi-line source so the context window has content to show.
    const source = [
      'Table users {',
      '  id int [pk]',
      '  name varchar(255',
      '  email varchar(255)',
      '}',
    ].join('\n');
    await loadSource(page, source, 'schema.dbml');

    const modal = page.locator('#error-modal');
    await expect(modal).toBeVisible();

    // At least one code block is shown.
    const codeBlock = modal.locator('.error-modal-code').first();
    await expect(codeBlock).toBeVisible();

    // Exactly one line carries the error highlight.
    const errorLine = codeBlock.locator('.error-modal-line.is-error');
    await expect(errorLine).toHaveCount(1);
  });

  test('close button dismisses the modal', async ({ page }) => {
    await page.goto('/');
    await loadSource(page, 'bad content @@');

    const modal = page.locator('#error-modal');
    await expect(modal).toBeVisible();

    await page.locator('#error-modal-close').click();
    await expect(modal).toBeHidden();
  });

  test('pressing Escape dismisses the modal', async ({ page }) => {
    await page.goto('/');
    await loadSource(page, 'bad content @@');

    const modal = page.locator('#error-modal');
    await expect(modal).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();
  });

  test('the dialog element is not visible when no parse error has occurred', async ({ page }) => {
    await page.goto('/');
    // No file loaded — modal must not be visible at all.
    await expect(page.locator('#error-modal')).toBeHidden();
  });

  test('bad file does not overwrite a previously loaded valid file', async ({ page }) => {
    await page.goto('/');
    // 1. Load a good file first.
    await loadSample(page, 'small');
    await expect(
      page.locator('#structure [data-node="table"]', { hasText: 'users' }),
    ).toBeVisible();

    // 2. Attempt to load a broken file via the file input.
    await loadSource(page, 'this is definitely not valid dbml !!');

    // 3. Modal appears…
    await expect(page.locator('#error-modal')).toBeVisible();

    // 4. …but the structure tree still shows the previous valid content.
    await expect(
      page.locator('#structure [data-node="table"]', { hasText: 'users' }),
    ).toBeVisible();
  });
});
