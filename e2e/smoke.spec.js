import fs from 'node:fs/promises';
import { test, expect } from '@playwright/test';

// The app has no upload endpoint: a drop is a file input plus a change event, so
// the suite builds the same DataTransfer the browser would. Fixtures are fetched
// from the served origin, which is what the app's own object URLs wrap.
async function dropFiles(page, names, relativePaths = {}, lastModified) {
    await page.evaluate(
        async ({ names, relativePaths, lastModified }) => {
            const files = [];
            for (const name of names) {
                const res = await fetch('fixtures/' + name, { cache: 'reload' });
                const fileName = name.split('/').pop();
                const file = new File([await res.blob()], fileName, lastModified ? { lastModified } : undefined);
                // The folder picker sets this on every file; a synthesised drop
                // has to as well for the path to survive.
                if (relativePaths[name]) {
                    Object.defineProperty(file, 'webkitRelativePath', { value: relativePaths[name] });
                }
                files.push(file);
            }
            const transfer = new DataTransfer();
            for (const file of files) transfer.items.add(file);
            const input = document.getElementById('folderInput');
            input.files = transfer.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
        },
        { names, relativePaths, lastModified },
    );
}

/** Text of the DOCX page the current match's mark sits on. */
async function currentDocMatchPage(page) {
    return page.locator('mark.doc-highlight.current').evaluate((el) => el.closest('.docx-page')?.textContent || '');
}

test.beforeEach(async ({ page }) => {
    await page.goto('/index.html');
    // A list chosen by an earlier run would change the expected counts.
    await page.evaluate(() => localStorage.clear());
    await page.reload();
});

test('scans a PDF, highlights every keyword and steps next/prev', async ({ page }) => {
    await dropFiles(page, ['one-kw.pdf']);

    const row = page.locator('.tree-file-item').first();
    await expect(row).toBeVisible();
    const treeCount = Number((await row.locator('.tree-count').textContent()).trim());
    expect(treeCount).toBeGreaterThan(0);

    await row.click();
    await expect(page.locator('#page-1')).toBeVisible();

    // Marks are `div.highlight-mark` (positioned overlays), not <mark>.
    await expect(page.locator('div.highlight-mark').first()).toBeVisible({ timeout: 20_000 });
    const matchTotal = Number((await page.locator('#matchTotal').textContent()).trim());
    expect(matchTotal).toBeGreaterThan(0);
    // The counter covers the keyword the document opened with, the tree the
    // whole list, so the counter can be the smaller of the two.
    expect(matchTotal).toBeLessThanOrEqual(treeCount);

    await expect(page.locator('div.highlight-mark.current')).toHaveCount(1);
    await expect(page.locator('#matchInput')).toHaveValue('1');

    await page.locator('#findNextBtn').click();
    await expect(page.locator('#matchInput')).toHaveValue('2');
    await expect(page.locator('div.highlight-mark.current')).toHaveCount(1);

    await page.locator('#findPrevBtn').click();
    await expect(page.locator('#matchInput')).toHaveValue('1');
});

test('attributes DOCX matches to pages and navigates them', async ({ page }) => {
    // waiting.docx puts "geotextile" on pages 7, 14, ... 49 and nothing earlier.
    await dropFiles(page, ['waiting.docx']);

    const row = page.locator('.tree-file-item').first();
    await expect(row).toBeVisible();
    await expect(row.locator('.tree-count')).toHaveText('7');

    await row.click();
    await expect(page.locator('.docx-page').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#matchTotal')).toHaveText('7');
    await expect(page.locator('mark.doc-highlight.current')).toHaveCount(1);
    await expect(page.locator('#matchInput')).toHaveValue('1');

    // Page attribution is the part that used to be wrong: the first match must
    // sit on the page its text is on, not on the first page of the document.
    expect(await currentDocMatchPage(page)).toContain('Section 7');

    await page.locator('#findNextBtn').click();
    await expect(page.locator('#matchInput')).toHaveValue('2');
    expect(await currentDocMatchPage(page)).toContain('Section 14');
});

test('exports the scan results as CSV', async ({ page }) => {
    await dropFiles(page, ['one-kw.pdf', 'mixed.pdf']);
    await expect(page.locator('#statusBar')).toContainText('matches across', { timeout: 60_000 });

    const downloadPromise = page.waitForEvent('download');
    await page.click('#exportCsvBtn');
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/^kwpdf-results-\d{4}-\d{2}-\d{2}\.csv$/);
    const csv = await fs.readFile(await download.path(), 'utf8');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const [header, ...rows] = csv.slice(1).trim().split('\r\n');
    expect(header).toBe('File,Folder,Page,Keyword,Count,Snippet,OCR');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.startsWith('one-kw.pdf,') || row.startsWith('mixed.pdf,'))).toBe(true);
    await expect(page.locator('#statusBar')).toContainText('Exported');
});

test('opens a document from the results tree with the keyboard', async ({ page }) => {
    await dropFiles(page, ['one-kw.pdf', 'mixed.pdf']);
    await expect(page.locator('#statusBar')).toContainText('matches across', { timeout: 60_000 });

    const row = page.locator('.tree-file-item .file', { hasText: 'one-kw.pdf' });
    await row.focus();
    await expect(row).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(page.locator('.file.active')).toContainText('one-kw.pdf', { timeout: 20_000 });
});

test('warns before unloading while a scan is still running', async ({ page }) => {
    // A synthetic event: the browser's own prompt only appears on a real
    // navigation, but the handler's decision is observable this way.
    const prevented = () =>
        page.evaluate(() => {
            const event = new Event('beforeunload', { cancelable: true });
            window.dispatchEvent(event);
            return event.defaultPrevented;
        });

    expect(await prevented()).toBe(false);

    // Two files take the batch path, and a 120-page PDF keeps it running long
    // enough to be observed; a single file would open in the viewer instead.
    await dropFiles(page, ['large.pdf', 'one-kw.pdf']);
    let warned = false;
    for (let i = 0; i < 60 && !warned; i++) {
        warned = await prevented();
        if (!warned) await page.waitForTimeout(100);
    }
    expect(warned).toBe(true);

    await expect(page.locator('#statusBar')).toContainText('matches across', { timeout: 60_000 });
    await expect.poll(prevented, { timeout: 15_000 }).toBe(false);
});

test('skips a file that is already loaded', async ({ page }) => {
    const when = 1_700_000_000_000;
    const rows = page.locator('.tree-file-item');

    await dropFiles(page, ['one-kw.pdf'], {}, when);
    await expect(rows).toHaveCount(1);
    const countText = (await rows.first().locator('.tree-count').textContent()).trim();

    // The same file again: same path, size and modification time, but a new drop
    // and therefore a new object URL.
    await dropFiles(page, ['one-kw.pdf'], {}, when);
    await expect(rows).toHaveCount(1);
    await expect(page.locator('#statusBar')).toContainText('Already loaded: one-kw.pdf');
    await expect(rows.first().locator('.tree-count')).toHaveText(countText);
});

test('renders a folder name literally instead of as markup', async ({ page }) => {
    await dropFiles(page, ['html-folder/%3Cb%3Ex%3C%2Fb%3E/plain.pdf'], {
        'html-folder/%3Cb%3Ex%3C%2Fb%3E/plain.pdf': 'html-folder/<b>x</b>/plain.pdf',
    });

    await expect(page.locator('.tree-file-item').filter({ hasText: 'plain.pdf' })).toBeVisible();

    // A folder name is untrusted text: it must not create elements. (The name
    // contains slashes, so the tree nests it as extra segments; that part is the
    // app's path splitting, not escaping.)
    await expect(page.locator('#sidebar b')).toHaveCount(0);
    await expect(page.locator('#sidebar')).toContainText('<b>x<');
});
