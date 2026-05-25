import { expect, test } from '@playwright/test';

// Start every test with a clean slate: the app persists the last loaded source
// in localStorage and would otherwise skip the dropzone on a warm reload.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
  });
});

test('loads the small sample and renders structure + detail', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('#dropzone')).toBeVisible();

  // Open the samples dropdown and pick `small`.
  await page.locator('#file-dropdown-trigger').click();
  await page.locator('#file-dropdown .file-dropdown-item', { hasText: 'small' }).click();

  // Dropzone goes away once a source is loaded.
  await expect(page.locator('#dropzone')).toBeHidden();

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
  await page.locator('#file-dropdown-trigger').click();
  await page.locator('#file-dropdown .file-dropdown-item', { hasText: 'small' }).click();

  const diagramToggle = page.locator('#view-toggles button[data-view="diagram"]');
  await expect(diagramToggle).toHaveAttribute('aria-pressed', 'false');
  await diagramToggle.click();
  await expect(diagramToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#view-diagram')).toBeVisible();
});
