// Settings dropdown: theme, font, language.

import { expect, test } from '@playwright/test';
import { installPersistentClear, loadSample } from './_setup';

test.use({ colorScheme: 'light' });

test.beforeEach(async ({ page }) => {
  await installPersistentClear(page);
});

test.describe('dropdown plumbing', () => {
  test('trigger toggles the dropdown open/closed', async ({ page }) => {
    await page.goto('/');
    const trigger = page.locator('#settings-trigger');
    const dropdown = page.locator('#settings-dropdown');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(dropdown).toBeHidden();

    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(dropdown).toBeVisible();

    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(dropdown).toBeHidden();
  });

  test('outside click closes the dropdown', async ({ page }) => {
    await page.goto('/');
    await loadSample(page, 'small');
    await page.locator('#settings-trigger').click();
    await expect(page.locator('#settings-dropdown')).toBeVisible();
    // The structure search input is always visible after load and clearly
    // outside the settings-group.
    await page.locator('#structure [data-search]').click();
    await expect(page.locator('#settings-dropdown')).toBeHidden();
  });

  test('Escape closes the dropdown and refocuses the trigger', async ({ page }) => {
    await page.goto('/');
    const trigger = page.locator('#settings-trigger');
    await trigger.click();
    await expect(page.locator('#settings-dropdown')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#settings-dropdown')).toBeHidden();
    await expect(trigger).toBeFocused();
  });
});

test.describe('theme toggle', () => {
  test('initial state mirrors the system color scheme', async ({ page }) => {
    await page.goto('/');
    // colorScheme is forced to light above, so the html should match.
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.locator('#settings-trigger').click();
    await expect(page.locator('#theme-light')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#theme-dark')).toHaveAttribute('aria-pressed', 'false');
  });

  test('picking dark switches the document theme and persists', async ({ page }) => {
    await page.goto('/');
    await page.locator('#settings-trigger').click();
    await page.locator('#theme-dark').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('#theme-dark')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#theme-light')).toHaveAttribute('aria-pressed', 'false');
    const stored = await page.evaluate(() => localStorage.getItem('dbml-view:theme'));
    expect(stored).toBe('dark');
  });

  test('picking the system-matching theme clears the override', async ({ page }) => {
    await page.goto('/');
    // First store an explicit override.
    await page.locator('#settings-trigger').click();
    await page.locator('#theme-dark').click();
    expect(await page.evaluate(() => localStorage.getItem('dbml-view:theme'))).toBe('dark');
    // Picking light (which matches the forced system scheme) should unset it.
    await page.locator('#theme-light').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await page.evaluate(() => localStorage.getItem('dbml-view:theme'))).toBeNull();
  });
});

test.describe('font toggle', () => {
  test('default is mono (no data-font attribute)', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).not.toHaveAttribute('data-font', 'proportional');
    await page.locator('#settings-trigger').click();
    await expect(page.locator('#font-mono')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#font-proportional')).toHaveAttribute('aria-pressed', 'false');
  });

  test('picking proportional sets data-font and persists', async ({ page }) => {
    await page.goto('/');
    await page.locator('#settings-trigger').click();
    await page.locator('#font-proportional').click();
    await expect(page.locator('html')).toHaveAttribute('data-font', 'proportional');
    await expect(page.locator('#font-proportional')).toHaveAttribute('aria-pressed', 'true');
    const stored = await page.evaluate(() => localStorage.getItem('dbml-view:font'));
    expect(stored).toBe('proportional');
  });

  test('switching back to mono removes the override', async ({ page }) => {
    await page.goto('/');
    await page.locator('#settings-trigger').click();
    await page.locator('#font-proportional').click();
    expect(await page.evaluate(() => localStorage.getItem('dbml-view:font'))).toBe('proportional');
    await page.locator('#font-mono').click();
    await expect(page.locator('html')).not.toHaveAttribute('data-font', 'proportional');
    expect(await page.evaluate(() => localStorage.getItem('dbml-view:font'))).toBeNull();
  });
});

test.describe('language select', () => {
  test('lists English and Czech and defaults to English', async ({ page }) => {
    await page.goto('/');
    await page.locator('#settings-trigger').click();
    const select = page.locator('#lang-select');
    await expect(select).toHaveValue('en');
    const options = await select.locator('option').allTextContents();
    expect(options).toEqual(['English', 'Čeština']);
  });

  test('switching to Czech reloads the page with translated labels', async ({ page }) => {
    await page.goto('/');
    await page.locator('#settings-trigger').click();
    // The change handler calls location.reload() — wait for the load to complete.
    await Promise.all([
      page.waitForLoadState('load'),
      page.locator('#lang-select').selectOption('cs'),
    ]);
    await expect(page.locator('#file-button-label')).toHaveText('Otevřít');
    await expect(page.locator('#view-toggles button[data-view="structure"]')).toContainText(
      'Struktura',
    );
    await expect(page.locator('#view-toggles button[data-view="diagram"]')).toContainText(
      'Diagram',
    );
    // Settings preserved their selection after reload.
    await page.locator('#settings-trigger').click();
    await expect(page.locator('#lang-select')).toHaveValue('cs');
  });
});
