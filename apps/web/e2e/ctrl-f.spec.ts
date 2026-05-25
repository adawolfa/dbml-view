// Ctrl+F shortcut behavior:
//   - In the Tauri desktop shell (WebView2 has no native find bar), Ctrl+F
//     focuses the structure-panel search, opening the panel if it was hidden.
//   - In a plain browser, the handler bails so the native find UI is intact.

import { expect, test } from '@playwright/test';
import { installPersistentClear, loadSample, setViewToggle } from './_setup';

test.beforeEach(async ({ page }) => {
  await installPersistentClear(page);
});

test('Ctrl+F is a no-op outside the Tauri shell', async ({ page }) => {
  await page.goto('/');
  await loadSample(page, 'small');
  // Turn diagram on first so the at-least-one-visible-view invariant lets us
  // collapse the structure panel.
  await setViewToggle(page, 'diagram', true);
  await setViewToggle(page, 'structure', false);
  const structureToggle = page.locator('#view-toggles button[data-view="structure"]');
  await expect(structureToggle).toHaveAttribute('aria-pressed', 'false');

  await page.keyboard.press('Control+f');

  // Browser-path: our handler skips on isTauri, the structure panel stays off.
  await expect(structureToggle).toHaveAttribute('aria-pressed', 'false');
});

test.describe('inside the Tauri shell', () => {
  test.beforeEach(async ({ page }) => {
    // Stub the Tauri runtime so `isTauri` evaluates true at module init and
    // the bootstrap IPC calls (`take_pending_open`, `listen`, `setTitle`,
    // `show`) resolve harmlessly instead of throwing.
    await page.addInitScript(() => {
      Object.defineProperty(window, '__TAURI_INTERNALS__', {
        configurable: true,
        value: {
          invoke: () => Promise.resolve(null),
          transformCallback: () => 0,
          metadata: { currentWindow: { label: 'main' } },
        },
      });
    });
  });

  test('Ctrl+F opens the structure panel and focuses the search input', async ({ page }) => {
    await page.goto('/');
    await loadSample(page, 'small');
    await setViewToggle(page, 'diagram', true);
    await setViewToggle(page, 'structure', false);
    const structureToggle = page.locator('#view-toggles button[data-view="structure"]');
    await expect(structureToggle).toHaveAttribute('aria-pressed', 'false');

    await page.keyboard.press('Control+f');

    await expect(structureToggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#view-structure')).toBeVisible();
    await expect(page.locator('#structure [data-search]')).toBeFocused();
  });

  test('Ctrl+F focuses the search input when the structure panel is already open', async ({
    page,
  }) => {
    await page.goto('/');
    await loadSample(page, 'small');
    const structureToggle = page.locator('#view-toggles button[data-view="structure"]');
    await expect(structureToggle).toHaveAttribute('aria-pressed', 'true');

    await page.keyboard.press('Control+f');

    await expect(page.locator('#structure [data-search]')).toBeFocused();
  });

  test('Ctrl+F selects any existing text in the search input', async ({ page }) => {
    await page.goto('/');
    await loadSample(page, 'small');
    await page.locator('#structure [data-search]').fill('users');

    // Move focus elsewhere so Ctrl+F has work to do.
    await page.locator('#view-toggles button[data-view="structure"]').focus();
    await expect(page.locator('#structure [data-search]')).not.toBeFocused();

    await page.keyboard.press('Control+f');

    const search = page.locator('#structure [data-search]');
    await expect(search).toBeFocused();
    // Selection should span the full existing value.
    const selection = await search.evaluate((el: HTMLInputElement) => ({
      start: el.selectionStart,
      end: el.selectionEnd,
      length: el.value.length,
    }));
    expect(selection.start).toBe(0);
    expect(selection.end).toBe(selection.length);
    expect(selection.length).toBe(5);
  });
});
