// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
    readStoredText,
    storePdfText,
    storeDocxText,
    writeStoredText,
    clearTextCache,
    TEXT_CACHE_DB,
    TEXT_CACHE_VERSION,
    MAX_STORED_ENTRIES,
} from '../text-store';

const pdfPages = () => [
    { text: 'tender page', viewport: { width: 600, height: 800 }, items: [] },
    { text: 'pump page', viewport: { width: 600, height: 800 }, items: [] },
];

function countStoredEntries() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(TEXT_CACHE_DB, TEXT_CACHE_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const db = request.result;
            const count = db.transaction('texts', 'readonly').objectStore('texts').count();
            count.onsuccess = () => {
                resolve(count.result);
                db.close();
            };
            count.onerror = () => reject(count.error);
        };
    });
}

describe('text cache with IndexedDB', () => {
    beforeEach(async () => {
        await clearTextCache();
    });

    it('stores and rehydrates extracted PDF text', async () => {
        expect(await storePdfText('k1|a.pdf', 'a.pdf', pdfPages())).toBe(true);

        const stored = await readStoredText('k1|a.pdf');
        expect(stored?.type).toBe('pdf');
        expect(stored.pages.map((p) => p.text)).toEqual(['tender page', 'pump page']);
    });

    it('stores and rehydrates DOCX HTML and text', async () => {
        expect(await storeDocxText('k2|b.docx', 'b.docx', 'docx', '<p>tender</p>', 'tender')).toBe(true);

        const stored = await readStoredText('k2|b.docx');
        expect(stored?.type).toBe('docx');
        expect(stored.html).toBe('<p>tender</p>');
        expect(stored.text).toBe('tender');
    });

    it('treats a payload from another schema version as a miss', async () => {
        await writeStoredText({
            key: 'k3|c.pdf',
            v: TEXT_CACHE_VERSION + 1,
            type: 'pdf',
            name: 'c.pdf',
            savedAt: 1,
            pages: pdfPages(),
        });

        expect(await readStoredText('k3|c.pdf')).toBeNull();
    });

    it('prunes the oldest entries to keep the store bounded', async () => {
        const total = MAX_STORED_ENTRIES + 5;
        for (let i = 1; i <= total; i++) {
            await storePdfText(`k${i}|doc${i}.pdf`, `doc${i}.pdf`, pdfPages());
        }

        expect(await countStoredEntries()).toBeLessThanOrEqual(MAX_STORED_ENTRIES);
        expect(await readStoredText('k1|doc1.pdf')).toBeNull();
        expect(await readStoredText(`k${total}|doc${total}.pdf`)).not.toBeNull();
    });

    it('clears every saved entry', async () => {
        await storePdfText('k1|a.pdf', 'a.pdf', pdfPages());
        await storeDocxText('k2|b.docx', 'b.docx', 'docx', '<p>x</p>', 'x');
        expect(await countStoredEntries()).toBe(2);

        expect(await clearTextCache()).toBe(true);
        expect(await countStoredEntries()).toBe(0);
    });
});
