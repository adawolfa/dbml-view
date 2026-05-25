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
  // Per-table toggles under the hidden schema render as disabled (transitive).
  await expect(
    page.locator('#structure .dv-tree-hide-toggle[data-hide-id="shop.products"]'),
  ).toHaveAttribute('data-disabled', 'true');
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
