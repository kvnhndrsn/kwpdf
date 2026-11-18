import { expect } from '@playwright/test';

// The app has no upload endpoint: a drop is a file input plus a change event, so
// the suite builds the same DataTransfer the browser would. Fixtures are fetched
// from the served origin, which is what the app's own object URLs wrap.
export async function dropFiles(page, names) {
    await page.evaluate(async (names) => {
        const files = [];
        for (const name of names) {
            const res = await fetch('fixtures/' + name, { cache: 'reload' });
            files.push(new File([await res.blob()], name.split('/').pop()));
        }
        const transfer = new DataTransfer();
        for (const file of files) transfer.items.add(file);
        const input = document.getElementById('folderInput');
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }, names);
}

/** Drop a fixture and click its row, so the viewer opens on page 1. */
export async function openPdf(page, name) {
    await dropFiles(page, [name]);
    const row = page.locator('.tree-file-item').first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();
    await expect(page.locator('#page-1')).toBeVisible({ timeout: 30_000 });
}
