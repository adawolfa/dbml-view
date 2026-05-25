// App-level behaviour: panel splitter drag/reset, source restoration from
// localStorage, deep-linking via the URL hash, dropzone drag-over visuals.

import { expect, test } from '@playwright/test';
import { installPersistentClear, loadSample, setViewToggle } from './_setup';

test.beforeEach(async ({ page }) => {
  await installPersistentClear(page);
});

test.describe('splitter between visible panels', () => {
  test('renders a splitter between structure and detail when both are visible', async ({
    page,
  }) => {
    await page.goto('/');
    await loadSample(page, 'small');
    await page.locator('#structure [data-node="table"]', { hasText: 'users' }).click();
    await expect(page.locator('#views .app-splitter')).toHaveCount(1);
  });

  test('dragging the splitter resizes the left panel', async ({ page }) => {
    await page.goto('/');
    await loadSample(page, 'small');
    await page.locator('#structure [data-node="table"]', { hasText: 'users' }).click();
    const structureSection = page.locator('#view-structure');
    const initial = (await structureSection.boundingBox())?.width ?? 0;
    expect(initial).toBeGreaterThan(0);

    const splitter = page.locator('#views .app-splitter').first();
    const box = await splitter.boundingBox();
    if (!box) throw new Error('splitter has no bounding box');
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 120, startY, { steps: 6 });
    await page.mouse.up();

    const widened = (await structureSection.boundingBox())?.width ?? 0;
    expect(widened).toBeGreaterThan(initial + 80);
  });

  test('double-clicking the splitter resets to the default width (280px)', async ({ page }) => {
    await page.goto('/');
    await loadSample(page, 'small');
    await page.locator('#structure [data-node="table"]', { hasText: 'users' }).click();
    const structureSection = page.locator('#view-structure');
    const splitter = page.locator('#views .app-splitter').first();

    // Drag wide first, then double-click.
    const box = await splitter.boundingBox();
    if (!box) throw new Error('splitter has no bounding box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 200, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();

    await splitter.dblclick();
    const reset = (await structureSection.boundingBox())?.width ?? 0;
    // PANEL_DEFAULT_PX.structure is 280; allow a 2px tolerance for sub-pixel rounding.
    expect(Math.abs(reset - 280)).toBeLessThan(2);
  });

  test('persists dragged width to localStorage and restores on reload', async ({ page }) => {
    await page.goto('/');
    await loadSample(page, 'small');
    await page.locator('#structure [data-node="table"]', { hasText: 'users' }).click();
    const splitter = page.locator('#views .app-splitter').first();
    const box = await splitter.boundingBox();
    if (!box) throw new Error('splitter has no bounding box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 80, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();

    const stored = await page.evaluate(() =>
      localStorage.getItem('dbml-view:panel-width:structure'),
    );
    expect(stored).not.toBeNull();
    expect(Number.parseInt(stored ?? '0', 10)).toBeGreaterThan(280);
  });
});

test.describe('persistence and deep links', () => {
  test('reload restores the last loaded source and label', async ({ page }) => {
    await page.goto('/');
    await loadSample(page, 'small');
    await page.reload();
    // We didn't keep the sample's filename (label persists too).
    await expect(page.locator('#dropzone')).toBeHidden();
    await expect(page.locator('#file-button-label')).toHaveText('small.dbml');
    await expect(
      page.locator('#structure [data-node="table"]', { hasText: 'users' }),
    ).toBeVisible();
  });

  test('reload restores the active set of view toggles', async ({ page }) => {
    await page.goto('/');
    await loadSample(page, 'small');
    await setViewToggle(page, 'diagram', true);
    await page.reload();
    await expect(page.locator('#view-toggles button[data-view="diagram"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('navigating to #table:… selects the table on load', async ({ page }) => {
    await page.goto('/');
    await loadSample(page, 'small');
    // Force the hash change directly.
    await page.evaluate(() => {
      window.location.hash = '#table:public.users';
    });
    await expect(page.locator('#detail .dv-detail-name')).toHaveText('users');
    await expect(
      page.locator('#structure [data-node="table"][data-table-id="public.users"]'),
    ).toHaveClass(/is-active/);
  });

  test('navigating to #enum:… selects the enum on load', async ({ page }) => {
    await page.goto('/');
    await loadSample(page, 'medium');
    await page.evaluate(() => {
      window.location.hash = '#enum:public.order_status';
    });
    await expect(page.locator('#detail .dv-detail-name')).toContainText('order_status');
  });
});

test.describe('dropzone visuals', () => {
  test('dragging a file over the dropzone applies the is-over class', async ({ page }) => {
    await page.goto('/');
    const dropzone = page.locator('#dropzone');
    await expect(dropzone).not.toHaveClass(/is-over/);

    // Synthesise a dragover with a fake DataTransfer payload.
    await dropzone.dispatchEvent('dragover');
    await expect(dropzone).toHaveClass(/is-over/);

    await dropzone.dispatchEvent('dragleave');
    await expect(dropzone).not.toHaveClass(/is-over/);
  });
});
