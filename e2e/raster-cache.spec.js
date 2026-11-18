import { test, expect } from '@playwright/test';
import { openPdf } from './helpers.js';

const RASTER_DB = 'kwpdf-raster-cache';

/**
 * How many bitmaps the cache holds. Returns -2 when the database does not
 * exist yet, so this probe never creates it (an empty version-1 database would
 * stop the app's own upgrade from creating the store).
 */
async function rasterEntryCount(page) {
    return page.evaluate(async (dbName) => {
        const databases = await indexedDB.databases();
        if (!databases.some((db) => db.name === dbName)) return -2;

        return new Promise((resolve) => {
            const request = indexedDB.open(dbName);
            request.onerror = () => resolve(-1);
            request.onsuccess = () => {
                const db = request.result;
                if (!db.objectStoreNames.length) {
                    db.close();
                    resolve(0);
                    return;
                }
                const store = db.transaction(db.objectStoreNames[0], 'readonly').objectStore(db.objectStoreNames[0]);
                const count = store.count();
                count.onsuccess = () => {
                    resolve(count.result);
                    db.close();
                };
                count.onerror = () => {
                    resolve(-1);
                    db.close();
                };
            };
        });
    }, RASTER_DB);
}

test.beforeEach(async ({ page }) => {
    // Each test gets a fresh browser context, so IndexedDB starts empty: the
    // first open below cannot hit and the second has to.
    await page.goto('/index.html');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
});

test('reuses a stored bitmap instead of re-rendering on the next open', async ({ page }) => {
    await openPdf(page, 'one-kw.pdf');

    const firstCanvas = page.locator('#page-1 canvas');
    await expect(firstCanvas).toBeVisible({ timeout: 20_000 });
    await expect(firstCanvas).not.toHaveAttribute('data-raster-cached', '1');

    // Storing is deliberately narrow: the current page, on idle, after 600 ms.
    await expect.poll(() => rasterEntryCount(page), { timeout: 20_000 }).toBeGreaterThan(0);

    // A reload is a new session with the same origin storage — exactly what a
    // user gets when they come back to a file they looked at earlier.
    await page.reload();
    await openPdf(page, 'one-kw.pdf');

    const secondCanvas = page.locator('#page-1 canvas');
    await expect(secondCanvas).toHaveAttribute('data-raster-cached', '1', { timeout: 20_000 });

    // The reused bitmap has to be the rendered page, not an empty canvas.
    const paintedPixels = await secondCanvas.evaluate((canvas) => {
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let painted = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) painted++;
        return painted;
    });
    expect(paintedPixels).toBeGreaterThan(0);
});
