// DBML color attributes (`Table [headerColor: #…]`, `Ref [color: #…]`, and
// `TableGroup [color: #…]`) propagate into the rendered diagram as inline CSS
// custom properties and turn on the matching `has-*` classes. The `colors`
// sample exercises all three.

import { expect, test } from '@playwright/test';
import { installPersistentClear, loadSample, setViewToggle } from './_setup';

test.beforeEach(async ({ page }) => {
  await installPersistentClear(page);
  await page.goto('/');
  await loadSample(page, 'colors');
  await setViewToggle(page, 'diagram', true);
  await expect(page.locator('#diagram .dv-table').first()).toBeVisible();
});

test('table headerColor lands on the table element as a custom property', async ({ page }) => {
  const users = page.locator('#diagram .dv-table[data-table-id="public.users"]');
  await expect(users).toHaveClass(/has-header-color/);
  await expect(users).toHaveAttribute('style', /--dv-table-header-color:\s*#2563eb/);

  // The header background actually changes — pull the computed value back out
  // and confirm it's no longer the default neutral grey.
  const headerBg = await users
    .locator('.dv-table-header')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(headerBg).not.toBe('');
  expect(headerBg).not.toBe('rgba(0, 0, 0, 0)');

  // Tables without a configured color stay unstyled — guards against an
  // accidental "all tables get the same color" regression.
  const noColorTables = page.locator('#diagram .dv-table:not(.has-header-color)');
  await expect(noColorTables).toHaveCount(0); // every sample table is colored
});

test('ref color lands on the edge group as a custom property and currentColor', async ({
  page,
}) => {
  const redEdge = page.locator(
    '#diagram .dv-edge-group[data-from-column="public.posts.user_id"][data-to-column="public.users.id"]',
  );
  await expect(redEdge).toHaveClass(/has-color/);
  await expect(redEdge).toHaveAttribute('style', /--dv-edge-color:\s*#ef4444/);

  // The path inherits color from currentColor; assert it actually paints red.
  const stroke = await redEdge
    .locator('path.dv-edge')
    .evaluate((el) => getComputedStyle(el).stroke);
  expect(stroke).toBe('rgb(239, 68, 68)');

  const greenEdge = page.locator(
    '#diagram .dv-edge-group[data-from-column="public.comments.post_id"][data-to-column="public.posts.id"]',
  );
  await expect(greenEdge).toHaveAttribute('style', /--dv-edge-color:\s*#22c55e/);
});

test('TableGroup color tints the group hull', async ({ page }) => {
  const group = page.locator('#diagram .dv-group');
  await expect(group).toHaveCount(1);
  await expect(group).toHaveAttribute('style', /--dv-group-color:\s*#a855f7/);
});

test('structure view tints table, group, and relation icons by their DBML colors', async ({
  page,
}) => {
  // Structure renders alongside the diagram by default in the test fixture's view set.
  const structure = page.locator('#structure');

  const tablegroupIcon = structure.locator(
    '[data-node="group"][data-group-id="tg:public.content"] .dv-tree-node-icon',
  );
  await expect(tablegroupIcon).toHaveAttribute('style', /color:\s*#a855f7/);

  const usersIcon = structure.locator(
    '[data-node="table"][data-table-id="public.users"] .dv-tree-node-icon',
  );
  await expect(usersIcon).toHaveAttribute('style', /color:\s*#2563eb/);

  // Expand `posts` so its outgoing relation (→ users) is rendered and we can
  // check the arrow color.
  const postsNode = structure.locator('[data-node="table"][data-table-id="public.posts"]');
  await postsNode.dblclick();
  const usersArrow = structure
    .locator('[data-node="relation"][data-from-column-id="public.posts.user_id"]')
    .locator('.dv-tree-rel-arrow');
  await expect(usersArrow).toHaveAttribute('style', /color:\s*#ef4444/);
});
