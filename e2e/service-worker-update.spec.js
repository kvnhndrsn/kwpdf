import { test, expect } from '@playwright/test';

// Pages serves the app at a directory root, so a navigation looks like
// "/kwpdf/" — not "/kwpdf/index.html". A pathname-only network-first check
// misses that and serves the previous build's HTML from the SW cache while the
// new CSS/JS come from the network. The toolbar then renders the new stylesheet
// against old markup until a manual refresh swaps the document over.
test('a root-path navigation fetches fresh HTML despite a stale cached document', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => !!navigator.serviceWorker?.controller);

    // Poison the cache entry the old code path would have served: current HTML
    // with a marker on the toolbar. If navigations are still cache-first, the
    // next load shows the marker.
    await page.evaluate(async () => {
        const res = await fetch('index.html');
        const html = await res.text();
        const name = (await caches.keys()).find((k) => k.startsWith('kwpdf-'));
        if (!name) throw new Error('no kwpdf cache found');
        const marked = html.replace('<div class="viewer-toolbar">', '<div class="viewer-toolbar" data-stale="1">');
        if (marked === html) throw new Error('toolbar marker not found in index.html');
        const cache = await caches.open(name);
        await cache.put(
            new URL('./', location.href).href,
            new Response(marked, { headers: { 'content-type': 'text/html' } }),
        );
    });

    await page.goto('/');

    await expect(page.locator('.viewer-toolbar[data-stale]')).toHaveCount(0);
    // Sanity: the current build's markup is the four two-row control groups.
    await expect(page.locator('.viewer-toolbar > .toolbar-section')).toHaveCount(4);
});
