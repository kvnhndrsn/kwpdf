import { test, expect } from '@playwright/test';

// Phase 0 baseline. Not an assertion suite: it opens a dense drawing with
// instrumentation on and prints the measurement table, so the numbers recorded
// in REMAINING-WORK.md come from the app rather than from a guess.
//
// Run with: npx playwright test e2e/perf-baseline.spec.js
test('records the Phase 0 baseline for a vector-heavy drawing', async ({ page }) => {
    test.skip(!process.env.KWPDF_BASELINE, 'manual baseline run (set KWPDF_BASELINE=1)');

    await page.goto('/index.html?perf=1');
    await page.evaluate(() => localStorage.clear());
    await page.goto('/index.html?perf=1');

    await page.evaluate(async () => {
        const res = await fetch('fixtures/vector-heavy.pdf', { cache: 'reload' });
        const file = new File([await res.blob()], 'vector-heavy.pdf');
        const transfer = new DataTransfer();
        transfer.items.add(file);
        const input = document.getElementById('folderInput');
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const row = page.locator('.tree-file-item').first();
    await expect(row).toBeVisible({ timeout: 120_000 });
    await page.waitForFunction(() => document.body.dataset.indexing === '0', null, { timeout: 180_000 });

    // Scroll through a spread of pages so page.render() is measured on more than
    // the first one.
    for (const pageNum of [5, 15, 30, 45, 60]) {
        await page.evaluate((n) => {
            const el = document.getElementById('page-' + n);
            el?.scrollIntoView();
        }, pageNum);
        await page.waitForTimeout(1200);
    }

    const measures = await page.evaluate(() => window.__kwpdfPerf());
    const longTasks = await page.evaluate(() => window.__kwpdfPerfLongTasks());

    const renders = measures.filter((m) => m.label === 'render:paint').map((m) => m.ms);
    const median = (xs) => {
        if (!xs.length) return null;
        const sorted = [...xs].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)];
    };

    console.log('PHASE0 ' + JSON.stringify({ measures, longTasks, renders, median: median(renders) }, null, 2));
});
