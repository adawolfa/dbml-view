// Structure-tree search enhancements: fuzzy matching, highlight markup,
// keyboard navigation (arrows / Enter / Escape), clear button + search icon,
// and cross-panel diagram preview on the active match.

import { expect, test } from '@playwright/test';
import { installPersistentClear, loadSample, setViewToggle } from './_setup';

test.beforeEach(async ({ page }) => {
  await installPersistentClear(page);
});

test('search icon is rendered inside the input shell', async ({ page }) => {
  await page.goto('/');
  await loadSample(page, 'small');
  const structure = page.locator('#structure');
  await expect(structure.locator('.dv-search .dv-search-icon')).toBeVisible();
});

test('search icon hides while typing and reappears once the input is cleared', async ({ page }) => {
  await page.goto('/');
  await loadSample(page, 'small');
  const structure = page.locator('#structure');
  const search = structure.locator('[data-search]');
  const icon = structure.locator('.dv-search .dv-search-icon');
  await expect(icon).toBeVisible();
  await search.fill('users');
  await expect(icon).toBeHidden();
  await search.fill('');
  await expect(icon).toBeVisible();
});

test('fuzzy/word search matches non-contiguous characters', async ({ page }) => {
  await page.goto('/');
  await loadSample(page, 'medium');
  const structure = page.locator('#structure');

  // "orit" matches "order_items" by jumping the underscore — strict substring
  // wouldn't catch this; the word-aware fallback does.
  await structure.locator('[data-search]').fill('orit');
  const tableNode = structure.locator('[data-node="table"][data-table-id="shop.order_items"]');
  await expect(tableNode).toBeVisible();
  // The matched chars are wrapped in <mark> spans — should be exactly two
  // contiguous runs ("or" + "it") for this query.
  const marks = tableNode.locator('.dv-tree-table-name mark.dv-tree-match');
  await expect(marks).toHaveCount(2);
  await expect(marks.nth(0)).toHaveText('or');
  await expect(marks.nth(1)).toHaveText('it');
});

test('contiguous substring matches are highlighted with a single span', async ({ page }) => {
  await page.goto('/');
  await loadSample(page, 'small');
  const structure = page.locator('#structure');
  await structure.locator('[data-search]').fill('use');
  const node = structure.locator('[data-node="table"][data-table-id="public.users"]');
  const marks = node.locator('.dv-tree-table-name mark.dv-tree-match');
  await expect(marks).toHaveCount(1);
  await expect(marks.nth(0)).toHaveText('use');
});

test('first match is pre-highlighted; arrows move the active cursor', async ({ page }) => {
  await page.goto('/');
  await loadSample(page, 'medium');
  const structure = page.locator('#structure');
  const search = structure.locator('[data-search]');
  await search.fill('ord');

  // First match in visual order: the auth.users.password_hash column.
  await expect(structure.locator('.is-search-active')).toHaveAttribute(
    'data-column',
    'password_hash',
  );

  // ArrowDown advances to the next match (shop.order_items table).
  await search.focus();
  await page.keyboard.press('ArrowDown');
  await expect(structure.locator('.is-search-active')).toHaveAttribute(
    'data-table-id',
    'shop.order_items',
  );

  // ArrowUp returns to the previous match.
  await page.keyboard.press('ArrowUp');
  await expect(structure.locator('.is-search-active')).toHaveAttribute(
    'data-column',
    'password_hash',
  );
});

test('Enter activates the current match, clears the query, and blurs the input', async ({
  page,
}) => {
  await page.goto('/');
  await loadSample(page, 'medium');
  const structure = page.locator('#structure');
  const search = structure.locator('[data-search]');
  await search.fill('ord');
  await search.focus();
  // Step down to shop.order_items, then commit.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  // Selection happened (hash updated)…
  await expect(page).toHaveURL(/#table:.*order_items/);
  // …and the search field cleared + lost focus so typing somewhere else doesn't
  // re-trigger a search.
  await expect(search).toHaveValue('');
  await expect(search).not.toBeFocused();
  // Icon comes back since the placeholder is shown again.
  await expect(structure.locator('.dv-search .dv-search-icon')).toBeVisible();
});

test('Escape clears the search and hides the clear button', async ({ page }) => {
  await page.goto('/');
  await loadSample(page, 'small');
  const structure = page.locator('#structure');
  const search = structure.locator('[data-search]');
  await search.fill('users');
  await expect(structure.locator('[data-search-clear]')).toBeVisible();
  await search.focus();
  await page.keyboard.press('Escape');
  await expect(search).toHaveValue('');
  await expect(structure.locator('[data-search-clear]')).toBeHidden();
  // All tables visible again (filter cleared).
  await expect(structure.locator('[data-node="table"]')).toHaveCount(2);
});

test('clear button resets the query and refocuses the input', async ({ page }) => {
  await page.goto('/');
  await loadSample(page, 'small');
  const structure = page.locator('#structure');
  const search = structure.locator('[data-search]');
  await search.fill('users');
  await structure.locator('[data-search-clear]').click();
  await expect(search).toHaveValue('');
  await expect(search).toBeFocused();
});

test('active match in the structure highlights the corresponding table in the diagram', async ({
  page,
}) => {
  await page.goto('/');
  await loadSample(page, 'medium');
  await setViewToggle(page, 'diagram', true);
  // Wait for diagram layout to settle.
  await expect(page.locator('#diagram .dv-table').first()).toBeVisible();

  const structure = page.locator('#structure');
  const search = structure.locator('[data-search]');
  await search.fill('ord');

  // First match is a column under auth.users, so that table should be hovered
  // in the diagram and the matching row marked as an edge endpoint.
  await expect(page.locator('#diagram .dv-table[data-table-id="auth.users"]')).toHaveClass(
    /is-hovered/,
  );
  await expect(page.locator('#diagram [data-column-id="auth.users.password_hash"]')).toHaveClass(
    /is-edge-endpoint/,
  );

  // Arrow down: highlight should follow to shop.order_items table.
  await search.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#diagram .dv-table[data-table-id="shop.order_items"]')).toHaveClass(
    /is-hovered/,
  );
  await expect(page.locator('#diagram .dv-table[data-table-id="auth.users"]')).not.toHaveClass(
    /is-hovered/,
  );
});

test('clearing the search drops the diagram preview highlight', async ({ page }) => {
  await page.goto('/');
  await loadSample(page, 'medium');
  await setViewToggle(page, 'diagram', true);
  await expect(page.locator('#diagram .dv-table').first()).toBeVisible();

  const structure = page.locator('#structure');
  const search = structure.locator('[data-search]');
  await search.fill('ord');
  await expect(page.locator('#diagram .dv-table[data-table-id="auth.users"]')).toHaveClass(
    /is-hovered/,
  );
  await search.focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('#diagram .dv-table[data-table-id="auth.users"]')).not.toHaveClass(
    /is-hovered/,
  );
});
