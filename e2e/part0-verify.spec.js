import { test, expect } from '@playwright/test';

// Walks the "verify what already shipped" table in REMAINING-WORK.md. Each test
// name carries its row number so the notes can point at the same identifiers.

test.setTimeout(180_000);

/** Drop files from fixtures, with picker-style relative paths. */
async function drop(page, entries) {
    await page.evaluate(async (entries) => {
        const files = [];
        for (const entry of entries) {
            const res = await fetch('fixtures/' + entry.source, { cache: 'reload' });
            if (!res.ok) throw new Error('fixture ' + entry.source + ' -> ' + res.status);
            const file = new File([await res.blob()], entry.name);
            Object.defineProperty(file, 'webkitRelativePath', { value: entry.relativePath || entry.name });
            files.push(file);
        }
        const transfer = new DataTransfer();
        for (const file of files) transfer.items.add(file);
        const input = document.getElementById('folderInput');
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }, entries);
}

/** Install a custom keyword list as the active one, then reload into it. */
async function useKeywordList(page, words, name = 'Verify') {
    await page.evaluate(
        ({ words, name }) => {
            localStorage.setItem('tender_custom_lists', JSON.stringify({ [name]: words }));
            localStorage.setItem('tender_keyword_list', name);
        },
        { words, name },
    );
    await page.reload();
}

const scanDone = (page) => expect(page.locator('#statusBar')).toContainText('matches across', { timeout: 120_000 });

test.beforeEach(async ({ page }) => {
    await page.goto('/index.html');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
});

test('0.1 an HTML-ish folder name is rendered literally', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

    // A POSIX name cannot contain '/', so the fixture uses an HTML-ish name that
    // is actually representable: "<b>x".
    await drop(page, [
        { name: 'plain.pdf', source: 'two-folders/A/drawing.pdf', relativePath: 'html-folder/<b>x/plain.pdf' },
        { name: 'other.pdf', source: 'one-kw.pdf', relativePath: 'html-folder/other.pdf' },
    ]);
    await scanDone(page);

    const folder = page.locator('.folder', { hasText: '<b>x' });
    await expect(folder).toHaveCount(1);
    expect(await folder.evaluate((el) => el.textContent)).toContain('<b>x');
    expect(await page.locator('.folder b').count()).toBe(0);
    expect(await folder.getAttribute('aria-label')).toBe('<b>x');
    expect(errors).toEqual([]);
});

test('0.2 keyword grid renders hostile keywords literally and filters on click', async ({ page }) => {
    const dialogs = [];
    page.on('dialog', (d) => {
        dialogs.push(d.message());
        d.dismiss();
    });

    await useKeywordList(page, ['x<b>geotextile', 'geo"textile', 'R&D']);
    await drop(page, [{ name: 'mixed.pdf', source: 'mixed.pdf' }]);
    await expect(page.locator('.tree-count')).toHaveText('3', { timeout: 60_000 });

    const cells = page.locator('#kwGridContent .kw-grid-cell');
    await expect(cells).toHaveCount(3);
    expect(await page.locator('#kwGridContent img').count()).toBe(0);
    expect(await page.locator('#kwGridContent b').count()).toBe(0);

    const names = await cells.locator('.kw-cell-name').allTextContents();
    expect(names.sort()).toEqual(['R&D', 'geo"textile', 'x<b>geotextile'].sort());

    await page.locator('.kw-grid-cell', { hasText: 'geo"textile' }).click();
    const total = Number(await page.locator('#matchTotal').textContent());
    expect(total).toBeGreaterThan(0);
    expect(dialogs).toEqual([]);
});

test('0.3 a blank keyword line does not hang or change counts', async ({ page }) => {
    await useKeywordList(page, ['geotextile', '', '   ', 'textile']);
    await drop(page, [{ name: 'one-kw.pdf', source: 'one-kw.pdf' }]);
    await expect(page.locator('.tree-count')).toBeVisible({ timeout: 60_000 });
    const withBlanks = Number((await page.locator('.tree-count').textContent()).trim());

    await useKeywordList(page, ['geotextile', 'textile']);
    await drop(page, [{ name: 'one-kw.pdf', source: 'one-kw.pdf' }]);
    await expect(page.locator('.tree-count')).toBeVisible({ timeout: 60_000 });
    const clean = Number((await page.locator('.tree-count').textContent()).trim());

    expect(clean).toBeGreaterThan(0);
    expect(withBlanks).toBe(clean);
});

test('0.4 duplicate keywords collapse to one cell and one count', async ({ page }) => {
    await useKeywordList(page, ['geotextile', 'Geotextile']);
    await drop(page, [{ name: 'one-kw.pdf', source: 'one-kw.pdf' }]);
    await expect(page.locator('.tree-count')).toHaveText('3', { timeout: 60_000 });

    await expect(page.locator('#kwGridContent .kw-grid-cell')).toHaveCount(1);
    await expect(page.locator('.kw-cell-name')).toHaveText('geotextile');
});

test('0.5 a zero-result inline search clears the previous PDF marks', async ({ page }) => {
    await drop(page, [{ name: 'one-kw.pdf', source: 'one-kw.pdf' }]);
    await expect(page.locator('.tree-file-item')).toBeVisible({ timeout: 60_000 });
    await page.locator('.tree-file-item .file').first().click();
    await expect(page.locator('#page-1')).toBeVisible({ timeout: 30_000 });

    await page.fill('#inlineSearchInput', 'geotextile');
    await expect(page.locator('div.highlight-mark').first()).toBeVisible({ timeout: 30_000 });
    const marks = await page.locator('div.highlight-mark').count();
    expect(marks).toBeGreaterThan(0);

    await page.fill('#inlineSearchInput', 'zzzzz');
    await expect(page.locator('div.highlight-mark')).toHaveCount(0);

    await page.fill('#inlineSearchInput', 'geotextile');
    await expect(page.locator('div.highlight-mark').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('div.highlight-mark.current')).toHaveCount(1);
    expect(await page.locator('div.highlight-mark').count()).toBeGreaterThan(0);
});

test('0.6 a zero-result DOCX search clears every mark', async ({ page }) => {
    await drop(page, [{ name: 'waiting.docx', source: 'waiting.docx' }]);
    await expect(page.locator('.tree-file-item')).toBeVisible({ timeout: 60_000 });
    await page.locator('.tree-file-item .file').first().click();
    await expect(page.locator('.docx-page').first()).toBeVisible({ timeout: 30_000 });

    await page.fill('#inlineSearchInput', 'geotextile');
    await expect(page.locator('mark.doc-highlight').first()).toBeVisible({ timeout: 30_000 });

    await page.fill('#inlineSearchInput', 'zzzzz');
    await expect(page.locator('mark.doc-highlight')).toHaveCount(0);
});

test('0.7 repeated DOCX terms step 1-2-3 with one current mark', async ({ page }) => {
    await drop(page, [{ name: 'repeated-3.docx', source: 'repeated-3.docx' }]);
    await expect(page.locator('.tree-file-item')).toBeVisible({ timeout: 60_000 });
    await page.locator('.tree-file-item .file').first().click();
    await expect(page.locator('.docx-page').first()).toBeVisible({ timeout: 30_000 });

    await page.fill('#inlineSearchInput', 'tender');
    await expect(page.locator('mark.doc-highlight.current')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator('#matchInput')).toHaveValue('1');

    await page.locator('#findNextBtn').click();
    await expect(page.locator('#matchInput')).toHaveValue('2');
    await page.locator('#findNextBtn').click();
    await expect(page.locator('#matchInput')).toHaveValue('3');
    await expect(page.locator('mark.doc-highlight.current')).toHaveCount(1);

    const pageText = await page
        .locator('mark.doc-highlight.current')
        .evaluate((el) => el.closest('.docx-page').textContent);
    expect(pageText).toContain('Tender page one');
});

test('0.9 editing keywords rescans the loaded library', async ({ page }) => {
    await drop(page, [
        { name: 'one-kw.pdf', source: 'one-kw.pdf' },
        { name: 'mixed.pdf', source: 'mixed.pdf' },
    ]);
    await scanDone(page);

    const row = page.locator('.tree-file-item', { hasText: 'one-kw.pdf' });
    await expect(row.locator('.tree-count')).toBeVisible();
    const before = Number((await row.locator('.tree-count').textContent()).trim());
    expect(before).toBeGreaterThan(0);

    const openManager = async () => {
        await page.locator('#settingsBtn').click();
        await page.locator('#settingsKwBtn').click();
        await expect(page.locator('#kwInput')).toBeVisible();
    };
    const currentWords = async () =>
        (await page.locator('#kwInput').inputValue())
            .split('\n')
            .map((w) => w.trim())
            .filter(Boolean);

    await openManager();
    const words = await currentWords();
    // A word from one-kw.pdf that the active list does not already contain, so
    // the count change is unambiguous.
    const added = ['nonwoven', 'schedule', 'wording', 'separator'].find(
        (candidate) => !words.some((w) => w.toLowerCase() === candidate),
    );
    expect(added).toBeTruthy();
    await page.locator('#kwInput').fill([...words, added].join('\n'));
    await page.locator('#kwSaveBtn').click();

    await expect(row.locator('.tree-count')).toHaveText(String(before + 1), { timeout: 60_000 });

    await openManager();
    const without = (await currentWords()).filter((w) => w.toLowerCase() !== added);
    await page.locator('#kwInput').fill(without.join('\n'));
    await page.locator('#kwSaveBtn').click();

    await expect(row.locator('.tree-count')).toHaveText(String(before), { timeout: 60_000 });
});

test('0.10 an imported keyword list can be deleted again', async ({ page }) => {
    const messages = [];
    page.on('dialog', (d) => {
        messages.push(d.message());
        d.accept();
    });

    await page.locator('#settingsBtn').click();
    await page.locator('#settingsKwBtn').click();
    await expect(page.locator('#kwInput')).toBeVisible();

    const chooser = page.waitForEvent('filechooser');
    await page.locator('#kwImportBtn').click();
    await (
        await chooser
    ).setFiles({
        name: 'imported.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify({ name: 'Imported Row', keywords: ['geotextile', 'textile'] })),
    });

    await expect(page.locator('#kwListSelector')).toHaveValue('Imported Row', { timeout: 15_000 });
    await expect(page.locator('#kwInput')).toHaveValue('geotextile\ntextile');

    await page.locator('#kwDeleteListBtn').click();

    await expect(page.locator('#kwListSelector')).not.toHaveValue('Imported Row');
    const verdict = await page.evaluate(() => {
        const lists = JSON.parse(localStorage.getItem('tender_custom_lists') || '{}');
        return { keys: Object.keys(lists), active: localStorage.getItem('tender_keyword_list') };
    });
    expect(verdict.keys).not.toContain('Imported Row');
    expect(verdict.active).not.toBe('Imported Row');
    expect(messages.some((m) => m.includes('Delete list "Imported Row"'))).toBe(true);
});

test('0.11 the service worker caches the app and serves it offline', async ({ page, context }) => {
    await page.evaluate(async () => {
        await navigator.serviceWorker.ready;
    });
    await page.reload();
    await expect(page.locator('#sidebar')).toBeVisible();

    const cacheNames = await page.evaluate(() => caches.keys());
    expect(cacheNames.length).toBeGreaterThan(0);

    await context.setOffline(true);
    try {
        await page.reload();
        await expect(page.locator('#sidebar')).toBeVisible({ timeout: 30_000 });
        await expect(page.locator('#statusBar')).toContainText('Ready');
    } finally {
        await context.setOffline(false);
    }
});

test('0.12 the manifest and its icon resolve', async ({ page }) => {
    const manifest = await page.request.get('manifest.json');
    expect(manifest.ok()).toBe(true);
    const data = await manifest.json();
    const icon = (data.icons || [])[0];
    expect(icon?.src).toBeTruthy();

    const iconRes = await page.request.get(icon.src);
    expect(iconRes.ok()).toBe(true);
    expect(iconRes.headers()['content-type']).toContain('image');
});

test('0.15 a single-file drop reports one document', async ({ page }) => {
    await drop(page, [{ name: 'one-kw.pdf', source: 'one-kw.pdf' }]);

    await expect(page.locator('#statusBar')).toContainText('across 1 document', { timeout: 60_000 });
});

test('0.16 a failed batch entry leaves no dead tree row', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await drop(page, [
        { name: 'bad.pdf', source: 'bad.pdf' },
        { name: 'one-kw.pdf', source: 'one-kw.pdf' },
    ]);

    await expect(page.locator('.tree-file-item')).toHaveCount(1, { timeout: 120_000 });
    await expect(page.locator('.tree-file-item')).toContainText('one-kw.pdf');
    await expect(page.locator('#results')).not.toContainText('bad.pdf');
    await expect(page.locator('#statusBar')).toContainText('failed');
    expect(errors).toEqual([]);
});

test('0.17/0.18 a long PDF opens at page 1 and jumps to a later page', async ({ page }) => {
    await drop(page, [{ name: 'large.pdf', source: 'large.pdf' }]);
    await expect(page.locator('.tree-file-item')).toBeVisible({ timeout: 60_000 });
    await page.locator('.tree-file-item .file').first().click();

    await expect(page.locator('#page-1')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#pageTotal')).toHaveText('120');

    await page.locator('#pageInput').fill('100');
    await page.locator('#pageInput').press('Enter');

    await expect(page.locator('#page-100')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#pageInput')).toHaveValue('100');
});

test('0.19/0.20 only a window of pages holds a canvas', async ({ page }) => {
    await drop(page, [{ name: 'large.pdf', source: 'large.pdf' }]);
    await expect(page.locator('.tree-file-item')).toBeVisible({ timeout: 60_000 });
    await page.locator('.tree-file-item .file').first().click();
    await expect(page.locator('#page-1 canvas')).toBeVisible({ timeout: 60_000 });

    await page.locator('#page-60').scrollIntoViewIfNeeded();
    await expect(page.locator('#page-60 canvas')).toHaveCount(1, { timeout: 60_000 });

    await page.locator('#page-1').scrollIntoViewIfNeeded();
    await expect(page.locator('#page-1 canvas')).toHaveCount(1, { timeout: 60_000 });

    const canvases = await page.locator('#pdfViewer canvas').count();
    expect(canvases).toBeLessThan(40);
});

test('0.23 the keyword dropdown is not rebuilt while stepping matches', async ({ page }) => {
    await drop(page, [{ name: 'one-kw.pdf', source: 'one-kw.pdf' }]);
    await expect(page.locator('.tree-file-item')).toBeVisible({ timeout: 60_000 });
    await page.locator('.tree-file-item .file').first().click();
    await expect(page.locator('div.highlight-mark.current')).toHaveCount(1, { timeout: 30_000 });

    const menu = page.locator('.custom-dropdown[data-for="keywordSelect"] .custom-dropdown-menu');
    await menu.evaluate((el) => {
        el.dataset.probe = 'kept';
    });

    await page.locator('#findNextBtn').click();
    await page.locator('#findPrevBtn').click();

    await expect(menu).toHaveAttribute('data-probe', 'kept');
    const rebuilt = await page.locator('.custom-dropdown[data-for="keywordSelect"] .custom-dropdown-menu').count();
    expect(rebuilt).toBe(1);
});

test('0.21 clearing during a rescan stops without errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

    const entries = Array.from({ length: 20 }, (_, i) => ({
        name: 'doc' + i + '.pdf',
        source: 'one-kw.pdf',
        relativePath: 'bulk/doc' + i + '.pdf',
    }));
    await drop(page, entries);
    await scanDone(page);
    await expect(page.locator('.tree-file-item')).toHaveCount(20, { timeout: 120_000 });

    // Add a keyword (triggering a rescan of every document), then clear while it
    // is in flight.
    await page.locator('#settingsBtn').click();
    await page.locator('#settingsKwBtn').click();
    await page.locator('#kwInput').fill('geotextile\ntextile\nseparator');
    await page.locator('#kwSaveBtn').click();
    await page.locator('#clearAllBtn').click();

    await expect(page.locator('.tree-file-item')).toHaveCount(0, { timeout: 60_000 });
    await expect(page.locator('#results')).toContainText('Drop files to begin scanning');
    expect(errors).toEqual([]);
});
