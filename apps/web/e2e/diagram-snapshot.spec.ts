import { expect, test } from '@playwright/test';

// Snapshot the diagram's rendered SVG (edges + arrows) for each bundled
// sample. Any change that nudges ELK layout, edge routing, or marker geometry
// shows up here as a snapshot diff. To accept a deliberate change, re-run with
// `pnpm test:e2e --update-snapshots`.
//
// The snapshots are sensitive to font metrics (table widths drive layout), so
// the baselines are tied to the OS the test was first run on. Per-OS
// snapshots are committed for both Windows (the dev/desktop target) and
// Linux (CI); Playwright suffixes the filename with `-chromium-<platform>`,
// so the two never collide. Regenerate the Linux baseline by running the
// suite inside the matching Playwright Docker image (see
// `scripts/update-linux-snapshots.sh`) — don't rely on the host's font
// stack for it.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
  });
});

const SAMPLES = ['small', 'medium', 'large'] as const;

for (const sample of SAMPLES) {
  test(`diagram SVG snapshot — ${sample}`, async ({ page }) => {
    await page.goto('/');

    await page.locator('#file-dropdown-trigger').click();
    await page.locator('#file-dropdown .file-dropdown-item', { hasText: sample }).first().click();

    // Reveal the diagram pane — ELK only runs once the element is on-screen
    // (the component gates layout behind IntersectionObserver).
    await page.locator('#view-toggles button[data-view="diagram"]').click();
    await expect(page.locator('#view-diagram')).toBeVisible();

    // Wait for ELK + edge rendering to finish. SVG width is only set once the
    // layout pass has finished and edges have been appended.
    await page.waitForFunction(() => {
      const svg = document.querySelector('#view-diagram svg[data-edges]');
      if (!svg) return false;
      const width = svg.getAttribute('width');
      if (!width || Number(width) <= 0) return false;
      return svg.querySelectorAll('g.dv-edge-group').length > 0;
    });

    const svgMarkup = await page
      .locator('#view-diagram svg[data-edges]')
      .evaluate((el) => el.outerHTML);

    expect(normalizeSvg(svgMarkup)).toMatchSnapshot(`diagram-${sample}.svg`);
  });
}

// Round any decimal in the SVG markup to the nearest integer and put each
// element on its own line. Rounding hides sub-pixel rendering drift while
// still catching real layout shifts; newlines make diffs reviewable.
function normalizeSvg(svg: string): string {
  return svg.replace(/-?\d+\.\d+/g, (m) => String(Math.round(Number(m)))).replace(/></g, '>\n<');
}
