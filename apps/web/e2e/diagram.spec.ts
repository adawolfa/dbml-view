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

test("hovering a relational column highlights only that column's edge, not all edges of the table", async ({
  page,
}) => {
  // `shop.orders` participates in three edges: orders.user_id → users.id,
  // orders.shipping_address_id → addresses.id, and order_items.order_id → orders.id.
  // Hovering a single FK column should narrow the highlight to that one edge.
  const userIdEdge = page.locator(
    '#diagram .dv-edge-group[data-from-column="shop.orders.user_id"][data-to-column="auth.users.id"]',
  );
  const shippingEdge = page.locator(
    '#diagram .dv-edge-group[data-from-column="shop.orders.shipping_address_id"][data-to-column="shop.addresses.id"]',
  );
  const orderItemsEdge = page.locator(
    '#diagram .dv-edge-group[data-from-column="shop.order_items.order_id"][data-to-column="shop.orders.id"]',
  );

  // Sanity: the three edges exist.
  await expect(userIdEdge).toHaveCount(1);
  await expect(shippingEdge).toHaveCount(1);
  await expect(orderItemsEdge).toHaveCount(1);

  // Hover the `user_id` row inside the `shop.orders` table.
  await page
    .locator(
      '#diagram .dv-table[data-table-id="shop.orders"] [data-column-id="shop.orders.user_id"]',
    )
    .hover();

  // Only the specific edge for that column gets the related highlight.
  await expect(userIdEdge).toHaveClass(/is-related/);
  await expect(shippingEdge).not.toHaveClass(/is-related/);
  await expect(orderItemsEdge).not.toHaveClass(/is-related/);
});

test('hovering a non-relational column still highlights all edges of the table', async ({
  page,
}) => {
  // `status` on shop.orders is not part of any ref, so the highlight should
  // fall back to the whole-table behaviour.
  const userIdEdge = page.locator(
    '#diagram .dv-edge-group[data-from-column="shop.orders.user_id"][data-to-column="auth.users.id"]',
  );
  const shippingEdge = page.locator(
    '#diagram .dv-edge-group[data-from-column="shop.orders.shipping_address_id"][data-to-column="shop.addresses.id"]',
  );
  const orderItemsEdge = page.locator(
    '#diagram .dv-edge-group[data-from-column="shop.order_items.order_id"][data-to-column="shop.orders.id"]',
  );

  await page
    .locator(
      '#diagram .dv-table[data-table-id="shop.orders"] [data-column-id="shop.orders.status"]',
    )
    .hover();

  await expect(userIdEdge).toHaveClass(/is-related/);
  await expect(shippingEdge).toHaveClass(/is-related/);
  await expect(orderItemsEdge).toHaveClass(/is-related/);
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

  // Default: toggle is highlighted (all columns showing) and every column renders.
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveClass(/is-active/);
  await expect(productsRows).toHaveCount(5);
  await expect(ordersRows).toHaveCount(5);

  // Click to filter: only FK-participant columns survive; button is no longer highlighted.
  // products keeps only `id` (referenced by order_items.product_id).
  // orders keeps `id`, `user_id`, `shipping_address_id` (all referenced by FKs).
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).not.toHaveClass(/is-active/);
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

  // Click again to restore: all columns visible and button highlighted again.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveClass(/is-active/);
  await expect(productsRows).toHaveCount(5);
  await expect(ordersRows).toHaveCount(5);
});

test('groups-toggle button is visible only when the DBML uses table groups', async ({ page }) => {
  // The medium sample has a 'commerce' TableGroup — button must be visible.
  const toggle = page.locator('#diagram button[data-act="groups-toggle"]');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('title', 'Show group containers');

  // The small sample has no TableGroups — button must be absent from the UI.
  await loadSample(page, 'small');
  await expect(page.locator('#diagram .dv-table').first()).toBeVisible();
  await expect(toggle).not.toBeVisible();
});

test('groups-toggle hides and restores group container elements', async ({ page }) => {
  const toggle = page.locator('#diagram button[data-act="groups-toggle"]');
  // .dv-group elements have explicit JS-set dimensions so toBeVisible() is meaningful.
  const firstGroup = page.locator('#diagram .dv-group').first();

  // Default: toggle is highlighted (groups showing) and the group hull is visible.
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveClass(/is-active/);
  await expect(firstGroup).toBeVisible();

  // Click to hide: .dv-groups gets display:none and the toggle is no longer highlighted.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).not.toHaveClass(/is-active/);
  await expect(firstGroup).not.toBeVisible();

  // Click again to restore: groups reappear and the toggle highlights again.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveClass(/is-active/);
  await expect(firstGroup).toBeVisible();
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
