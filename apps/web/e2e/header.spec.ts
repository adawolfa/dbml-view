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
    expect(names).toEqual(['colors', 'edge-cases', 'large', 'medium', 'small', 'tablegroup']);
  });

  test('outside click closes the samples dropdown', async ({ page }) => {
    await page.goto('/');
    await loadSample(page, 'small');
    await page.locator('#file-dropdown-trigger').click();
    await expect(page.locator('#file-dropdown')).toBeVisible();
    // Click well to the right of the file-group and below the header — past
    // the dropdown's projection — so the document outside-click handler fires.
    await page.mouse.click(700, 400);
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
    // small.dbml has no Project block — falls back to the filename.
    await expect(page.locator('#file-button-label')).toHaveText('small.dbml');
  });

  test('project name from DBML is used as the button label and page title', async ({ page }) => {
    await page.goto('/');
    await loadSample(page, 'medium'); // contains: Project shop { ... }
    await expect(page.locator('#file-button-label')).toHaveText('shop');
    expect(await page.title()).toBe('shop');
  });

  test('file without a project block falls back to filename in label and title', async ({
    page,
  }) => {
    await page.goto('/');
    await loadSample(page, 'small'); // no Project block
    await expect(page.locator('#file-button-label')).toHaveText('small.dbml');
    expect(await page.title()).toBe('small.dbml');
  });

  test('uploading a file via the hidden input loads its contents', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles({
      name: 'inline.dbml',
      mimeType: 'text/plain',
      buffer: Buffer.from('Table inline_demo {\n  id integer [pk]\n  label varchar\n}\n'),
    });
    await expect(page.locator('#dropzone')).toBeHidden();
    // No Project block → falls back to the filename.
    await expect(page.locator('#file-button-label')).toHaveText('inline.dbml');
    await expect(
      page.locator('#structure [data-node="table"]', { hasText: 'inline_demo' }),
    ).toBeVisible();
  });

  test('uploading a file with a project block shows the project name', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-input').setInputFiles({
      name: 'my_schema.dbml',
      mimeType: 'text/plain',
      buffer: Buffer.from('Project my_app {}\nTable demo {\n  id integer [pk]\n}\n'),
    });
    await expect(page.locator('#dropzone')).toBeHidden();
    await expect(page.locator('#file-button-label')).toHaveText('my_app');
    expect(await page.title()).toBe('my_app');
  });
});

test.describe('recent files', () => {
  /** Upload an inline .dbml via the hidden file input. */
  const uploadInline = async (
    page: import('@playwright/test').Page,
    name: string,
    body = 'Table t { id integer [pk] }\n',
  ): Promise<void> => {
    await page
      .locator('#file-input')
      .setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(body) });
    await expect(page.locator('#file-button-label')).toHaveText(name);
  };

  test('no recents → dropdown shows samples only (no section headers)', async ({ page }) => {
    await page.goto('/');
    await page.locator('#file-dropdown-trigger').click();
    await expect(page.locator('#file-dropdown')).toBeVisible();
    await expect(page.locator('#file-dropdown .file-dropdown-section')).toHaveCount(0);
    await expect(page.locator('#file-dropdown .file-dropdown-divider')).toHaveCount(0);
  });

  test('uploading a file adds it to recents under a "Recent" section', async ({ page }) => {
    await page.goto('/');
    await uploadInline(page, 'first.dbml');

    await page.locator('#file-dropdown-trigger').click();
    const dropdown = page.locator('#file-dropdown');
    await expect(dropdown).toBeVisible();
    // Section headers + divider appear once a recent is present.
    await expect(dropdown.locator('.file-dropdown-section').nth(0)).toHaveText('Recent');
    await expect(dropdown.locator('.file-dropdown-section').nth(1)).toHaveText('Samples');
    await expect(dropdown.locator('.file-dropdown-divider')).toHaveCount(1);
    // First .file-dropdown-item under the dropdown is the most recent file.
    await expect(dropdown.locator('.file-dropdown-item').first()).toHaveText('first.dbml');
  });

  test('loading a sample does not add it to recents', async ({ page }) => {
    await page.goto('/');
    await loadSample(page, 'small');
    await page.locator('#file-dropdown-trigger').click();
    await expect(page.locator('#file-dropdown .file-dropdown-section')).toHaveCount(0);
  });

  test('clicking a recent re-opens it and bumps it to the top', async ({ page }) => {
    await page.goto('/');
    await uploadInline(page, 'alpha.dbml');
    await uploadInline(page, 'beta.dbml');
    await uploadInline(page, 'gamma.dbml');

    // Recents are most-recent-first; load a sample so we can verify the re-open.
    await loadSample(page, 'small');
    await expect(page.locator('#file-button-label')).toHaveText('small.dbml');

    await page.locator('#file-dropdown-trigger').click();
    // Click "alpha.dbml" — the oldest of the three.
    await page.locator('#file-dropdown .file-dropdown-item', { hasText: /^alpha\.dbml$/ }).click();
    await expect(page.locator('#file-button-label')).toHaveText('alpha.dbml');

    // Re-open: alpha is now first; the section labels and order reflect the bump.
    await page.locator('#file-dropdown-trigger').click();
    const recents = page
      .locator('#file-dropdown')
      .locator('.file-dropdown-item')
      .filter({ hasText: /\.dbml$/ });
    await expect(recents.nth(0)).toHaveText('alpha.dbml');
    await expect(recents.nth(1)).toHaveText('gamma.dbml');
    await expect(recents.nth(2)).toHaveText('beta.dbml');
  });

  test('recents are capped at 5, oldest evicted', async ({ page }) => {
    await page.goto('/');
    for (const name of ['a.dbml', 'b.dbml', 'c.dbml', 'd.dbml', 'e.dbml', 'f.dbml']) {
      await uploadInline(page, name);
    }

    await page.locator('#file-dropdown-trigger').click();
    const recents = page
      .locator('#file-dropdown')
      .locator('.file-dropdown-item')
      .filter({ hasText: /\.dbml$/ });
    await expect(recents).toHaveCount(5);
    const names = await recents.allTextContents();
    expect(names).toEqual(['f.dbml', 'e.dbml', 'd.dbml', 'c.dbml', 'b.dbml']);
  });

  test('parse error does not add the file to recents', async ({ page }) => {
    await page.goto('/');
    await page
      .locator('#file-input')
      .setInputFiles({ name: 'broken.dbml', mimeType: 'text/plain', buffer: Buffer.from('@@@') });
    await expect(page.locator('#error-modal')).toBeVisible();
    await page.locator('#error-modal-close').click();

    await page.locator('#file-dropdown-trigger').click();
    await expect(page.locator('#file-dropdown .file-dropdown-section')).toHaveCount(0);
  });

  test('dropdown is wider than the open button so long names fit', async ({ page }) => {
    await page.goto('/');
    // Measure with the default "Open" label so the file-group is at its narrow
    // resting width — otherwise a long filename could push the button group
    // close to the dropdown's max-width and defeat the comparison.
    await page.locator('#file-dropdown-trigger').click();
    const dropdownBox = await page.locator('#file-dropdown').boundingBox();
    const groupBox = await page.locator('.file-group').boundingBox();
    expect(dropdownBox).not.toBeNull();
    expect(groupBox).not.toBeNull();
    expect(dropdownBox!.width).toBeGreaterThan(groupBox!.width);
    // And at least the design min-width — enough room for typical filenames.
    expect(dropdownBox!.width).toBeGreaterThanOrEqual(260);
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
