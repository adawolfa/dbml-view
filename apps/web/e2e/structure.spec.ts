// Structure tree: search, group expand/collapse, table/column/relation/enum
// selection, hover synchronisation with the detail pane.

import { expect, test } from '@playwright/test';
import { installPersistentClear, loadSample, setViewToggle } from './_setup';

test.beforeEach(async ({ page }) => {
  await installPersistentClear(page);
});

test('search input filters tables and columns', async ({ page }) => {
  await page.goto('/');
  await loadSample(page, 'small');
  const structure = page.locator('#structure');
  // Baseline: both tables visible.
  await expect(structure.locator('[data-node="table"]')).toHaveCount(2);

  await structure.locator('[data-search]').fill('users');
  await expect(structure.locator('[data-node="table"]', { hasText: 'users' })).toBeVisible();
  await expect(structure.locator('[data-node="table"]', { hasText: 'posts' })).toBeHidden();

  // Searching by column name reveals the parent table.
  await structure.locator('[data-search]').fill('body');
  await expect(structure.locator('[data-node="table"]', { hasText: 'posts' })).toBeVisible();
  await expect(structure.locator('[data-node="column"]', { hasText: 'body' })).toBeVisible();

  // No matches → empty state.
  await structure.locator('[data-search]').fill('zzznotreal');
  await expect(structure.locator('.dv-empty')).toBeVisible();
});

test('clicking a table selects it and emits a hash without expanding columns', async ({ page }) => {
  await page.goto('/');
  await loadSample(page, 'small');
  const structure = page.locator('#structure');
  const users = structure.locator('[data-node="table"]', { hasText: 'users' });
  await users.click();
  await expect(users).toHaveAttribute('aria-expanded', 'false');
  await expect(users).toHaveClass(/is-active/);
  await expect(page).toHaveURL(/#table:.*users/);
  await expect(page.locator('#detail')).toContainText('users');
});

test('clicking an already-selected table toggles its expansion', async ({ page }) => {
  await page.goto('/');
  await loadSample(page, 'small');
  const structure = page.locator('#structure');
  const users = structure.locator('[data-node="table"]', { hasText: 'users' });
  await users.click();
  await expect(users).toHaveAttribute('aria-expanded', 'false');
  await users.click();
  await expect(users).toHaveAttribute('aria-expanded', 'true');
  await expect(
    structure.locator('[data-node="column"][data-table-id="public.users"]').first(),
  ).toBeVisible();
});

test('double-clicking a table toggles expansion without changing selection', async ({ page }) => {
  await page.goto('/');
  await loadSample(page, 'small');
  const structure = page.locator('#structure');
  const users = structure.locator('[data-node="table"]', { hasText: 'users' });
  await users.dblclick();
  await expect(users).toHaveAttribute('aria-expanded', 'true');
});

test('clicking a column row jumps detail to that column', async ({ page }) => {
  await page.goto('/');
  await loadSample(page, 'small');
  const structure = page.locator('#structure');
  // Expand by clicking the table twice.
  const users = structure.locator('[data-node="table"]', { hasText: 'users' });
  await users.click();
  await users.click();
  const emailCol = structure.locator('[data-node="column"][data-column="email"]');
  await emailCol.click();
  await expect(emailCol).toHaveClass(/is-active/);
  // The row corresponding to `email` should now be highlighted in the detail pane.
  await expect(page.locator('#detail tr#public\\.users\\.email')).toHaveClass(/is-highlighted/);
});

test('clicking a relation node jumps to the target table', async ({ page }) => {
  await page.goto('/');
  await loadSample(page, 'small');
  const structure = page.locator('#structure');
  const posts = structure.locator('[data-node="table"]', { hasText: 'posts' });
  await posts.click();
  await posts.click(); // expand
  // `posts` has one outgoing relation to `users`. Click it.
  const rel = structure.locator('[data-node="relation"][data-target-table="public.users"]');
  await rel.click();
  await expect(page).toHaveURL(/#table:.*users/);
  await expect(page.locator('#detail .dv-detail-name')).toHaveText('users');
});

test('hovering a column in the structure highlights it in the detail pane', async ({ page }) => {
  await page.goto('/');
  await loadSample(page, 'small');
  const structure = page.locator('#structure');
  await structure.locator('[data-node="table"]', { hasText: 'users' }).click();
  await structure.locator('[data-node="table"]', { hasText: 'users' }).click(); // expand
  await structure.locator('[data-node="column"][data-column="email"]').hover();
  await expect(page.locator('#detail tr#public\\.users\\.email')).toHaveClass(/is-hovered/);
});

test.describe('multi-schema sample', () => {
  test('schema groups render with chevron + count and collapse on click', async ({ page }) => {
    await page.goto('/');
    await loadSample(page, 'medium');
    const structure = page.locator('#structure');
    const authGroup = structure.locator('[data-node="group"]', { hasText: 'auth' });
    await expect(authGroup).toBeVisible();
    await expect(authGroup).toHaveAttribute('aria-expanded', 'true');
    // The group exposes its member count as a chip — it sits next to the
    // row button (not inside it) so the eye toggle can slot between them.
    const authRow = structure.locator('.dv-tree-group[data-group-id="sc:auth"]');
    await expect(authRow.locator('> .dv-tree-row > .dv-tree-count')).toHaveText('1');
    await authGroup.click();
    await expect(authGroup).toHaveAttribute('aria-expanded', 'false');
    // Members are no longer reachable when collapsed.
    await expect(structure.locator('[data-node="table"][data-table-id="auth.users"]')).toBeHidden();
  });

  test('enum nodes render at the bottom of the tree and are selectable', async ({ page }) => {
    await page.goto('/');
    await loadSample(page, 'medium');
    const structure = page.locator('#structure');
    const orderStatus = structure.locator('[data-node="enum"]', { hasText: 'order_status' });
    await expect(orderStatus).toBeVisible();
    await orderStatus.click();
    await expect(orderStatus).toHaveClass(/is-active/);
    await expect(page).toHaveURL(/#enum:.*order_status/);
  });
});

test.describe('hover sync with the diagram', () => {
  test('hovering a table in the structure adds .is-hovered to the diagram node', async ({
    page,
  }) => {
    await page.goto('/');
    await loadSample(page, 'small');
    await setViewToggle(page, 'diagram', true);
    // Wait for the diagram to be ready before we test cross-panel hover.
    await expect(page.locator('#diagram .dv-table').first()).toBeVisible();
    await page.locator('#structure [data-node="table"]', { hasText: 'users' }).hover();
    const diagramUsers = page.locator('#diagram .dv-table[data-table-id="public.users"]');
    await expect(diagramUsers).toHaveClass(/is-hovered/);
  });
});
