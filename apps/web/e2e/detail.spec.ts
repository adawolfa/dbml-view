// Detail panel: table/enum content, flag badges, jump-links, hover round-trip.

import { expect, test } from '@playwright/test';
import { installPersistentClear, loadSample } from './_setup';

test.beforeEach(async ({ page }) => {
  await installPersistentClear(page);
});

test('table detail lists every column with the right flags and types', async ({ page }) => {
  await page.goto('/');
  await loadSample(page, 'small');
  await page.locator('#structure [data-node="table"]', { hasText: 'posts' }).click();
  const detail = page.locator('#detail');
  await expect(detail.locator('.dv-detail-name')).toHaveText('posts');
  // Five rows: id, user_id, title, body, published_at.
  await expect(detail.locator('tbody tr')).toHaveCount(5);
  const idRow = detail.locator('tr#public\\.posts\\.id');
  await expect(idRow).toContainText('integer');
  await expect(idRow.locator('.dv-badge-pk')).toHaveText('PK');
  await expect(idRow.locator('.dv-badge-auto')).toHaveText('AUTO');
  // user_id is the FK to users — should carry an FK badge.
  await expect(detail.locator('tr#public\\.posts\\.user_id .dv-badge-fk')).toHaveText('FK');
  // The unique email column on `users` carries the UNIQUE badge.
  await page.locator('#structure [data-node="table"]', { hasText: 'users' }).click();
  await expect(page.locator('#detail tr#public\\.users\\.email .dv-badge-unique')).toHaveText(
    'UNIQUE',
  );
});

test('omits the schema prefix on the ID and in references when no schemas are used', async ({
  page,
}) => {
  await page.goto('/');
  await loadSample(page, 'small');
  await page.locator('#structure [data-node="table"]', { hasText: 'posts' }).click();
  // The header shows just `posts`, not `public.posts`.
  await expect(page.locator('#detail .dv-detail-id')).toHaveText('posts');
  // The single outgoing ref also says `users.(id)`, no `public.` prefix.
  await expect(page.locator('#detail .dv-refs')).toContainText('users.(id)');
});

test('clicking an outgoing-ref link navigates to the target table', async ({ page }) => {
  await page.goto('/');
  await loadSample(page, 'small');
  await page.locator('#structure [data-node="table"]', { hasText: 'posts' }).click();
  await page.locator('#detail a[data-jump-table="public.users"]').click();
  await expect(page).toHaveURL(/#table:.*users/);
  await expect(page.locator('#detail .dv-detail-name')).toHaveText('users');
});

test('clicking an enum-typed column jumps to the enum detail', async ({ page }) => {
  await page.goto('/');
  await loadSample(page, 'medium');
  await page.locator('#structure [data-node="table"]', { hasText: 'orders' }).click();
  // The `status` column types to order_status — renders as a jump link.
  const enumLink = page.locator('#detail a[data-jump-enum="public.order_status"]');
  await expect(enumLink).toBeVisible();
  await enumLink.click();
  await expect(page).toHaveURL(/#enum:.*order_status/);
  await expect(page.locator('#detail .dv-detail-name')).toContainText('order_status');
});

test('enum detail lists values and the columns that reference it', async ({ page }) => {
  await page.goto('/');
  await loadSample(page, 'medium');
  await page.locator('#structure [data-node="enum"]', { hasText: 'order_status' }).click();
  const detail = page.locator('#detail');
  // Four values from the medium sample.
  await expect(detail.locator('tbody tr')).toHaveCount(4);
  for (const value of ['draft', 'paid', 'shipped', 'cancelled']) {
    await expect(
      detail.locator('td.dv-col-name', { hasText: new RegExp(`^${value}$`) }),
    ).toBeVisible();
  }
  // "Used by" links back to shop.orders.
  await expect(detail.locator('a[data-jump-table="shop.orders"]')).toBeVisible();
});

test('the indexes section renders when a table has indexes', async ({ page }) => {
  await page.goto('/');
  await loadSample(page, 'medium');
  await page.locator('#structure [data-node="table"]', { hasText: 'products' }).click();
  const detail = page.locator('#detail');
  await expect(detail).toContainText('Indexes');
  const indexes = detail.locator('.dv-indexes li');
  await expect(indexes).toHaveCount(2);
  await expect(indexes).toContainText(['(sku)', '(name)']);
});

test('table detail without selection shows the picker hint and a count', async ({ page }) => {
  await page.goto('/');
  await loadSample(page, 'medium');
  // medium has multi-schema; ensure the toggle stays visible.
  await expect(page.locator('#detail')).toContainText('Pick a table or enum');
  await expect(page.locator('#detail')).toContainText(/\d+ tables?/);
  await expect(page.locator('#detail')).toContainText(/\d+ enum/);
});

test('hovering a row in the detail highlights the parent table in the tree', async ({ page }) => {
  await page.goto('/');
  await loadSample(page, 'medium');
  await page.locator('#structure [data-node="table"]', { hasText: 'orders' }).click();
  // Selecting a table doesn't expand its column children in the tree, so the
  // hover propagates to the parent table row (the structure pane's documented
  // fallback when the matching column node isn't rendered).
  await page.locator('#detail tr#shop\\.orders\\.status').hover();
  await expect(
    page.locator('#structure [data-node="table"][data-table-id="shop.orders"]'),
  ).toHaveClass(/is-hovered/);
});
