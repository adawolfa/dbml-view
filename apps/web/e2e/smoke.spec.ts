import { expect, test } from '@playwright/test';
import { installPersistentClear, loadSample } from './_setup';

test.beforeEach(async ({ page }) => {
  await installPersistentClear(page);
});

test('loads the small sample and renders structure + detail', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('#dropzone')).toBeVisible();

  await loadSample(page, 'small');

  // Structure tree should list both sample tables.
  const structure = page.locator('#structure');
  await expect(structure.locator('[data-node="table"]', { hasText: 'users' })).toBeVisible();
  const postsNode = structure.locator('[data-node="table"]', { hasText: 'posts' });
  await expect(postsNode).toBeVisible();

  // Click `posts` — the URL hash and detail pane should reflect the selection.
  await postsNode.click();
  await expect(page).toHaveURL(/#table:.*posts/);

  const detail = page.locator('#detail');
  await expect(detail).toContainText('posts');
});

test('view toggles enable the diagram pane', async ({ page }) => {
  await page.goto('/');
  await loadSample(page, 'small');

  const diagramToggle = page.locator('#view-toggles button[data-view="diagram"]');
  await expect(diagramToggle).toHaveAttribute('aria-pressed', 'false');
  await diagramToggle.click();
  await expect(diagramToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#view-diagram')).toBeVisible();
});
