import { test, expect } from '@playwright/test';
import { dropFiles } from './helpers.js';

// A drop can land before keywords.json has been read and applied. Scanning then
// measures every document against an empty list, so the row is published with
// no count and nothing recomputes it: the document looks like it never matched.
// The fix gates intake on keyword readiness, and this test holds the window open
// with a slow keywords.json so the drop is guaranteed to arrive inside it.
test.use({ serviceWorkers: 'block' });

test('a drop during keyword loading is still scanned with the full list', async ({ page }) => {
    await page.route('**/keywords.json', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await route.continue();
    });

    await page.goto('/index.html');
    await page.evaluate(() => localStorage.clear());
    await page.reload();

    // Drop immediately: keywords.json is still in flight at this point.
    await dropFiles(page, ['one-kw.pdf']);

    const row = page.locator('.tree-file-item').first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await page.waitForFunction(() => document.body.dataset.indexing === '0', null, { timeout: 30_000 });

    // one-kw.pdf: 3 geotextile + 2 textile + 1 nonwoven + 1 filter fabric
    // + 1 separator layer. A scan that ran on an empty list counts 0.
    await expect(row.locator('.tree-count')).toHaveText('8');
});
