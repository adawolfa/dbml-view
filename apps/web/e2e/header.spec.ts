// Header surface: file group (open button + samples dropdown), view toggles.

import { expect, test } from '@playwright/test';
import { installPersistentClear, loadSample } from './_setup';

test.beforeEach(async ({ page }) => {
  await installPersistentClear(page);
});

test.describe('file group', () => {
  test('dropzone is visible before a source is loaded', async ({ page }) => {
    await page.goto('/');
    const dropzone = page.locator('#dropzone');
    await expect(dropzone).toBeVisible();
    await expect(dropzone).toContainText('.dbml');
    // Sample-hint paragraph mentions the dropdown next to Open.
    await expect(dropzone.locator('.dropzone-hint')).toBeVisible();
  });

  test('Open button opens the system file chooser', async ({ page }) => {
    await page.goto('/');
    const chooserPromise = page.waitForEvent('filechooser');
    await page.locator('#file-button').click();
    const chooser = await chooserPromise;
    expect(chooser.isMultiple()).toBe(false);
    // Dismiss with an empty file list — Playwright requires it to be settled.
    await chooser.setFiles([]);
  });

  test('dropzone click also opens the file chooser', async ({ page }) => {
    await page.goto('/');
    const chooserPromise = page.waitForEvent('filechooser');
    await page.locator('#dropzone').click();
    const chooser = await chooserPromise;
    await chooser.setFiles([]);
  });

  test('samples dropdown trigger toggles open/closed', async ({ page }) => {
    await page.goto('/');
    const trigger = page.locator('#file-dropdown-trigger');
    const dropdown = page.locator('#file-dropdown');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(dropdown).toBeHidden();

    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(dropdown).toBeVisible();

    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(dropdown).toBeHidden();
  });

  test('samples dropdown lists every shipped sample', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-dropdown-trigger').click();
    const items = page.locator('#file-dropdown .file-dropdown-item');
    const names = (await items.allTextContents()).map((s) => s.trim()).sort();
    expect(names).toEqual(['edge-cases', 'large', 'medium', 'small', 'tablegroup']);
  });

  test('outside click closes the samples dropdown', async ({ page }) => {
    await page.goto('/');
    await loadSample(page, 'small');
    await page.locator('#file-dropdown-trigger').click();
    await expect(page.locator('#file-dropdown')).toBeVisible();
    // The structure search input is always visible after load and clearly
    // outside the file-group.
    await page.locator('#structure [data-search]').click();
    await expect(page.locator('#file-dropdown')).toBeHidden();
    await expect(page.locator('#file-dropdown-trigger')).toHaveAttribute('aria-expanded', 'false');
  });

  test('Escape closes the dropdown and returns focus to the trigger', async ({ page }) => {
    await page.goto('/');
    const trigger = page.locator('#file-dropdown-trigger');
    await trigger.click();
    await expect(page.locator('#file-dropdown')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#file-dropdown')).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('loading a sample swaps the dropzone for the panes', async ({ page }) => {
    await page.goto('/');
    await loadSample(page, 'small');
    await expect(page.locator('#dropzone')).toBeHidden();
    await expect(page.locator('#views')).toBeVisible();
    // The Open button's label is replaced with the file name.
    await expect(page.locator('#file-button-label')).toHaveText('small.dbml');
  });

  test('uploading a file via the hidden input loads its contents', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles({
      name: 'inline.dbml',
      mimeType: 'text/plain',
      buffer: Buffer.from('Table inline_demo {\n  id integer [pk]\n  label varchar\n}\n'),
    });
    await expect(page.locator('#dropzone')).toBeHidden();
    await expect(page.locator('#file-button-label')).toHaveText('inline.dbml');
    await expect(
      page.locator('#structure [data-node="table"]', { hasText: 'inline_demo' }),
    ).toBeVisible();
  });
});

test.describe('view toggles', () => {
  test('default state shows structure + detail, hides diagram', async ({ page }) => {
    await page.goto('/');
    await loadSample(page, 'small');
    await expect(page.locator('#view-toggles button[data-view="structure"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.locator('#view-toggles button[data-view="detail"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.locator('#view-toggles button[data-view="diagram"]')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  test('toggling structure off + on persists at-least-one invariant', async ({ page }) => {
    await page.goto('/');
    await loadSample(page, 'small');
    // Click a table so detail becomes effectively visible too.
    await page.locator('#structure [data-node="table"]', { hasText: 'users' }).click();
    const structure = page.locator('#view-toggles button[data-view="structure"]');
    const detail = page.locator('#view-toggles button[data-view="detail"]');
    await structure.click();
    await expect(structure).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#view-structure')).toBeHidden();
    // Now try to toggle detail off — only detail is left, the click should be a no-op.
    await detail.click();
    await expect(detail).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#view-detail')).toBeVisible();
  });

  test('detail toggle label/icon swap to Enum when an enum is selected', async ({ page }) => {
    await page.goto('/');
    await loadSample(page, 'medium');
    const detailToggle = page.locator('#view-toggles button[data-view="detail"]');
    // Default: "Table" label, table icon visible.
    await expect(detailToggle.locator('[data-label]')).toHaveText('Table');
    await expect(detailToggle.locator('[data-icon="table"]')).toBeVisible();
    await expect(detailToggle.locator('[data-icon="enum"]')).toBeHidden();

    // Pick the order_status enum from the structure tree.
    await page.locator('#structure [data-node="enum"]', { hasText: 'order_status' }).click();

    await expect(detailToggle.locator('[data-label]')).toHaveText('Enum');
    await expect(detailToggle.locator('[data-icon="enum"]')).toBeVisible();
    await expect(detailToggle.locator('[data-icon="table"]')).toBeHidden();
  });

  test('diagram toggle reveals the diagram pane and renders tables', async ({ page }) => {
    await page.goto('/');
    await loadSample(page, 'small');
    await page.locator('#view-toggles button[data-view="diagram"]').click();
    const diagram = page.locator('#view-diagram');
    await expect(diagram).toBeVisible();
    // Diagram needs a layout pass before tables show up.
    await expect(diagram.locator('.dv-table').first()).toBeVisible();
    await expect(diagram.locator('.dv-table')).toHaveCount(2);
  });
});
