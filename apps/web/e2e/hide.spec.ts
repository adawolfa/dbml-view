// Eye-toggle: hide tables / schemas / tablegroups from the diagram.
//
// Exercises the structure → diagram wiring: clicking the eye removes the
// table from the diagram canvas along with any edges that touched it, the
// row dims in the tree, and the choice is persisted to localStorage per file.

import { expect, test } from '@playwright/test';
import { installPersistentClear, loadSample, setViewToggle } from './_setup';

test.beforeEach(async ({ page }) => {
  await installPersistentClear(page);
});

test('hiding a single table removes it and its edges from the diagram', async ({ page }) => {
  await page.goto('/');
  await loadSample(page, 'small');
  await setViewToggle(page, 'diagram', true);
  await expect(page.locator('#diagram .dv-table[data-table-id="public.posts"]')).toBeVisible();

  // Baseline: both tables + the one FK edge are present.
  await expect(page.locator('#diagram .dv-table')).toHaveCount(2);
  await expect(page.locator('#diagram .dv-edge-group')).toHaveCount(1);

  // Click the eye next to `posts`. force:true bypasses the hover-reveal
  // (Playwright's pre-click hover already shows it, but be explicit).
  await page
    .locator('#structure .dv-tree-hide-toggle[data-hide-kind="table"][data-hide-id="public.posts"]')
    .click();

  await expect(page.locator('#diagram .dv-table')).toHaveCount(1);
  await expect(page.locator('#diagram .dv-table[data-table-id="public.users"]')).toBeVisible();
  // The edge connecting posts → users is gone with the table.
  await expect(page.locator('#diagram .dv-edge-group')).toHaveCount(0);
  // The tree row dims.
  await expect(
    page.locator('#structure .dv-tree-table[data-table-id="public.posts"]'),
  ).toHaveClass(/is-hidden/);
});

test('clicking the eye again restores the hidden table', async ({ page }) => {
  await page.goto('/');
  await loadSample(page, 'small');
  await setViewToggle(page, 'diagram', true);
  const toggle = page.locator(
    '#structure .dv-tree-hide-toggle[data-hide-kind="table"][data-hide-id="public.posts"]',
  );
  await toggle.click();
  await expect(page.locator('#diagram .dv-table')).toHaveCount(1);
  await toggle.click();
  await expect(page.locator('#diagram .dv-table')).toHaveCount(2);
  await expect(page.locator('#diagram .dv-edge-group')).toHaveCount(1);
});

test('hiding a schema hides every table under it and dims their toggles', async ({ page }) => {
  await page.goto('/');
  await loadSample(page, 'medium');
  await setViewToggle(page, 'diagram', true);
  // medium has 5 tables across two schemas.
  await expect(page.locator('#diagram .dv-table')).toHaveCount(5);

  await page
    .locator('#structure .dv-tree-hide-toggle[data-hide-kind="schema"][data-hide-id="shop"]')
    .click();

  // The four shop.* tables vanish; auth.users remains.
  await expect(page.locator('#diagram .dv-table')).toHaveCount(1);
  await expect(page.locator('#diagram .dv-table[data-table-id="auth.users"]')).toBeVisible();
  // The schema group itself shows the hidden class.
  await expect(
    page.locator('#structure .dv-tree-group').filter({ hasText: 'shop' }).first(),
  ).toHaveClass(/is-hidden/);
  // Per-table toggles under the hidden schema are still interactive (no
  // data-disabled) — clicking one smart-unhides the group.
  await expect(
    page.locator('#structure .dv-tree-hide-toggle[data-hide-id="shop.products"]'),
  ).not.toHaveAttribute('data-disabled');
});

// ---- Smart-unhide: clicking a table toggle while its group is hidden ----

test('clicking a table toggle inside a hidden schema reveals only that table', async ({ page }) => {
  await page.goto('/');
  await loadSample(page, 'medium');
  await setViewToggle(page, 'diagram', true);

  // Hide the entire shop schema (4 tables disappear).
  await page
    .locator('#structure .dv-tree-hide-toggle[data-hide-kind="schema"][data-hide-id="shop"]')
    .click();
  await expect(page.locator('#diagram .dv-table')).toHaveCount(1);

  // Click the eye on shop.addresses (inside the shop schema group).
  await page
    .locator('#structure .dv-tree-hide-toggle[data-hide-kind="table"][data-hide-id="shop.addresses"]')
    .click();

  // shop.addresses + auth.users are now visible; other shop.* tables remain hidden.
  await expect(page.locator('#diagram .dv-table')).toHaveCount(2);
  await expect(page.locator('#diagram .dv-table[data-table-id="shop.addresses"]')).toBeVisible();
  await expect(page.locator('#diagram .dv-table[data-table-id="auth.users"]')).toBeVisible();
  // The schema group is no longer marked hidden.
  await expect(
    page.locator('#structure .dv-tree-group').filter({ hasText: 'shop' }).first(),
  ).not.toHaveClass(/is-hidden/);
  // Sibling shop tables are individually hidden.
  for (const id of ['shop.products', 'shop.orders', 'shop.order_items']) {
    await expect(
      page.locator(`#structure .dv-tree-table[data-table-id="${id}"]`),
    ).toHaveClass(/is-hidden/);
  }
});

test('clicking a table toggle inside a hidden tablegroup reveals only that table', async ({
  page,
}) => {
  await page.goto('/');
  // tablegroup.dbml has users (standalone) + posts/comments under the `content` TableGroup.
  // All tables use the public schema so the tree renders tablegroup headers.
  await loadSample(page, 'tablegroup');
  await setViewToggle(page, 'diagram', true);

  // Hide the `content` tablegroup (posts + comments disappear).
  await page
    .locator(
      '#structure .dv-tree-hide-toggle[data-hide-kind="tablegroup"][data-hide-id="public.content"]',
    )
    .click();
  // 3 tables → 1 visible (users).
  await expect(page.locator('#diagram .dv-table')).toHaveCount(1);

  // Click the eye on public.posts (inside the content tablegroup).
  await page
    .locator(
      '#structure .dv-tree-hide-toggle[data-hide-kind="table"][data-hide-id="public.posts"]',
    )
    .click();

  // posts + users are now visible; comments remains hidden.
  await expect(page.locator('#diagram .dv-table')).toHaveCount(2);
  await expect(page.locator('#diagram .dv-table[data-table-id="public.posts"]')).toBeVisible();
  await expect(page.locator('#diagram .dv-table[data-table-id="public.users"]')).toBeVisible();
  // The tablegroup group row is no longer hidden.
  await expect(
    page.locator('#structure .dv-tree-group').filter({ hasText: 'content' }).first(),
  ).not.toHaveClass(/is-hidden/);
  // Sibling tablegroup member (comments) is individually hidden.
  await expect(
    page.locator('#structure .dv-tree-table[data-table-id="public.comments"]'),
  ).toHaveClass(/is-hidden/);
});

test('eye toggle sits between the row content and the count chip', async ({ page }) => {
  await page.goto('/');
  await loadSample(page, 'medium');
  const row = page
    .locator('#structure .dv-tree-table[data-table-id="auth.users"] .dv-tree-row')
    .first();
  const tag = await row.evaluate((el) =>
    Array.from((el as HTMLElement).children).map((c) => ({
      tag: c.tagName,
      cls: (c as HTMLElement).className,
    })),
  );
  // Expected order: row button, hide toggle, count chip.
  expect(tag.map((c) => c.tag)).toEqual(['BUTTON', 'BUTTON', 'SPAN']);
  expect(tag[1]?.cls).toContain('dv-tree-hide-toggle');
  expect(tag[2]?.cls).toContain('dv-tree-count');
});

test('hidden state survives a reload via localStorage', async ({ page }) => {
  await page.goto('/');
  await loadSample(page, 'small');
  await setViewToggle(page, 'diagram', true);
  await page
    .locator('#structure .dv-tree-hide-toggle[data-hide-kind="table"][data-hide-id="public.posts"]')
    .click();
  await expect(page.locator('#diagram .dv-table')).toHaveCount(1);

  // Reload — applySource() restores the last source from localStorage along
  // with the matching hidden set.
  await page.reload();
  await setViewToggle(page, 'diagram', true);
  await expect(page.locator('#diagram .dv-table')).toHaveCount(1);
  await expect(
    page.locator('#structure .dv-tree-table[data-table-id="public.posts"]'),
  ).toHaveClass(/is-hidden/);
});

test('eye toggles stay aligned across rows regardless of count digit width', async ({ page }) => {
  // Regression: a double-digit column count (e.g. auth.users with 10 columns)
  // used to push the eye toggle leftward, breaking visual alignment with
  // toggles next to single-digit counts. The count chip now reserves a
  // min-width so the toggle stays at a fixed x-position per row.
  await page.goto('/');
  await loadSample(page, 'large');

  // auth.users has 10 cols (2 digits); auth.roles has 3 cols (1 digit).
  // Both rows must place their eye toggle at the same x-coordinate.
  const usersToggle = page.locator(
    '#structure .dv-tree-hide-toggle[data-hide-kind="table"][data-hide-id="auth.users"]',
  );
  const rolesToggle = page.locator(
    '#structure .dv-tree-hide-toggle[data-hide-kind="table"][data-hide-id="auth.roles"]',
  );
  // Force visibility so getBoundingClientRect reflects the laid-out position
  // even though the toggle is opacity:0 until hovered.
  await usersToggle.evaluate((el) => ((el as HTMLElement).style.opacity = '1'));
  await rolesToggle.evaluate((el) => ((el as HTMLElement).style.opacity = '1'));

  const usersBox = await usersToggle.boundingBox();
  const rolesBox = await rolesToggle.boundingBox();
  expect(usersBox).not.toBeNull();
  expect(rolesBox).not.toBeNull();
  // Allow 0.5px slack for sub-pixel rounding — anything bigger is misalignment.
  expect(Math.abs((usersBox?.x ?? 0) - (rolesBox?.x ?? 0))).toBeLessThan(1);
});

test('hide toggle reveals on row hover and stays visible when item is hidden', async ({ page }) => {
  await page.goto('/');
  await loadSample(page, 'small');
  const usersRow = page.locator(
    '#structure .dv-tree-table[data-table-id="public.users"] .dv-tree-row',
  );
  const toggle = usersRow.locator('.dv-tree-hide-toggle');
  // Hovering the row brings the eye into view.
  await usersRow.hover();
  await expect(toggle).toHaveCSS('opacity', '1');
  // After hiding the table, the toggle gains the `is-hidden-target` class so
  // it stays visible even when the row is no longer hovered.
  await toggle.click();
  await expect(toggle).toHaveClass(/is-hidden-target/);
  await expect(toggle).toHaveCSS('opacity', '1');
});
