// Diagram pane: toolbar buttons (zoom in/out, fit, reset, SVG export), zoom
// status indicator, table selection round-trip.

import { expect, test } from '@playwright/test';
import { installPersistentClear, loadSample, setViewToggle } from './_setup';

test.beforeEach(async ({ page }) => {
  await installPersistentClear(page);
  await page.goto('/');
  await loadSample(page, 'medium');
  await setViewToggle(page, 'diagram', true);
  // Wait for layout to finish before each test touches the toolbar.
  await expect(page.locator('#diagram .dv-table').first()).toBeVisible();
});

test('toolbar exposes all five action buttons with titles', async ({ page }) => {
  const toolbar = page.locator('#diagram .dv-diagram-toolbar');
  for (const [act, title] of [
    ['zoom-in', 'Zoom in'],
    ['zoom-out', 'Zoom out'],
    ['fit', 'Fit to screen'],
    ['reset', 'Reset zoom'],
    ['export-svg', 'Export SVG'],
  ] as const) {
    await expect(toolbar.locator(`button[data-act="${act}"]`)).toHaveAttribute('title', title);
  }
});

test('reset button restores 100% zoom in the status indicator', async ({ page }) => {
  const status = page.locator('#diagram .dv-diagram-status');
  await page.locator('#diagram button[data-act="reset"]').click();
  await expect(status).toHaveText('100%');
});

test('zoom in / zoom out step by 20% from 100%', async ({ page }) => {
  const status = page.locator('#diagram .dv-diagram-status');
  await page.locator('#diagram button[data-act="reset"]').click();
  await expect(status).toHaveText('100%');
  await page.locator('#diagram button[data-act="zoom-in"]').click();
  await expect(status).toHaveText('120%');
  await page.locator('#diagram button[data-act="zoom-in"]').click();
  await expect(status).toHaveText('144%');
  await page.locator('#diagram button[data-act="zoom-out"]').click();
  await expect(status).toHaveText('120%');
});

test('fit button does not crash and leaves the status in a percent state', async ({ page }) => {
  await page.locator('#diagram button[data-act="reset"]').click();
  await page.locator('#diagram button[data-act="zoom-in"]').click();
  await page.locator('#diagram button[data-act="fit"]').click();
  await expect(page.locator('#diagram .dv-diagram-status')).toHaveText(/\d+%/);
});

test('Export SVG triggers a diagram.svg download', async ({ page }) => {
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#diagram button[data-act="export-svg"]').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('diagram.svg');
});

test('clicking a table in the diagram syncs selection to structure + detail', async ({ page }) => {
  // The medium sample uses multi-schema IDs.
  await page.locator('#diagram .dv-table[data-table-id="shop.products"]').click();
  await expect(page).toHaveURL(/#table:shop.products/);
  await expect(page.locator('#detail .dv-detail-name')).toHaveText('products');
  await expect(
    page.locator('#structure [data-node="table"][data-table-id="shop.products"]'),
  ).toHaveClass(/is-active/);
  // The diagram itself marks the clicked node as selected.
  await expect(page.locator('#diagram .dv-table[data-table-id="shop.products"]')).toHaveClass(
    /is-selected/,
  );
});

test('hovering a diagram table highlights the matching structure row', async ({ page }) => {
  await page.locator('#diagram .dv-table[data-table-id="shop.orders"]').hover();
  await expect(
    page.locator('#structure [data-node="table"][data-table-id="shop.orders"]'),
  ).toHaveClass(/is-hovered/);
});

test('renders TableGroup hulls behind member tables', async ({ page }) => {
  // The medium sample defines a `commerce` TableGroup, but multi-schema mode in
  // the structure tree ignores it. The diagram still draws the hull.
  await expect(page.locator('#diagram .dv-group')).toHaveCount(1);
  await expect(page.locator('#diagram .dv-group-label')).toHaveText('commerce');
});

test('FK-only toggle hides non-relationship columns and re-layout', async ({ page }) => {
  const toggle = page.locator('#diagram button[data-act="cols-toggle"]');
  const productsRows = page.locator(
    '#diagram .dv-table[data-table-id="shop.products"] [data-column-id]',
  );
  const ordersRows = page.locator(
    '#diagram .dv-table[data-table-id="shop.orders"] [data-column-id]',
  );

  // Default: toggle is off and every column renders.
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(productsRows).toHaveCount(5);
  await expect(ordersRows).toHaveCount(5);

  // Toggle on: only FK-participant columns survive.
  // products keeps only `id` (referenced by order_items.product_id).
  // orders keeps `id`, `user_id`, `shipping_address_id` (all referenced by FKs).
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(productsRows).toHaveCount(1);
  await expect(ordersRows).toHaveCount(3);
  await expect(ordersRows.locator('.dv-row-name')).toHaveText([
    'id',
    'user_id',
    'shipping_address_id',
  ]);

  // Edges still anchor correctly — every ref endpoint is an FK-participant by
  // definition, so all 5 edges in the medium sample remain visible.
  await expect(page.locator('#diagram .dv-edge-group')).toHaveCount(5);

  // Toggle off: all columns restored.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(productsRows).toHaveCount(5);
  await expect(ordersRows).toHaveCount(5);
});

test('panning the canvas via background drag changes the viewport translation', async ({
  page,
}) => {
  await page.locator('#diagram button[data-act="reset"]').click();
  const canvas = page.locator('#diagram .dv-canvas');
  const initial = await canvas.evaluate((el) => (el as HTMLElement).style.transform);
  // Drag from the toolbar-clear viewport area downward+right.
  const viewport = page.locator('#diagram .dv-diagram-viewport');
  const box = await viewport.boundingBox();
  if (!box) throw new Error('viewport has no bounding box');
  const startX = box.x + box.width - 30;
  const startY = box.y + box.height - 30;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX - 100, startY - 60, { steps: 6 });
  await page.mouse.up();
  const after = await canvas.evaluate((el) => (el as HTMLElement).style.transform);
  expect(after).not.toBe(initial);
});
