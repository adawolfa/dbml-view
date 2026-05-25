// Shared helpers for the E2E suite.
//
// The app persists state (last source, panel widths, theme, font, locale) in
// localStorage. Tests need a clean slate, but a few exercises (locale change)
// also reload the page mid-test — a blanket "clear on every navigation"
// init script would wipe what we just set. The sessionStorage flag below
// makes the clear fire exactly once per Playwright test instead.

import type { Page } from '@playwright/test';

export async function installPersistentClear(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      if (!sessionStorage.getItem('__dbml_test_cleared__')) {
        localStorage.clear();
        sessionStorage.setItem('__dbml_test_cleared__', '1');
      }
    } catch {
      // ignore — private mode / sandbox
    }
  });
}

/** Open the samples dropdown and pick the entry whose label matches `name`. */
export async function loadSample(page: Page, name: string): Promise<void> {
  await page.locator('#file-dropdown-trigger').click();
  await page
    .locator('#file-dropdown .file-dropdown-item', { hasText: new RegExp(`^${name}$`) })
    .click();
  await page.locator('#dropzone').waitFor({ state: 'hidden' });
}

/** Switch a single view toggle on or off and wait for the pane to settle. */
export async function setViewToggle(
  page: Page,
  view: 'structure' | 'detail' | 'diagram',
  on: boolean,
): Promise<void> {
  const toggle = page.locator(`#view-toggles button[data-view="${view}"]`);
  const pressed = (await toggle.getAttribute('aria-pressed')) === 'true';
  if (pressed !== on) await toggle.click();
}
