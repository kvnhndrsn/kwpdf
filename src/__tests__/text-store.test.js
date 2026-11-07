import { describe, it, expect } from 'vitest';
import {
    cacheKey,
    validStoredText,
    readStoredText,
    storePdfText,
    storeDocxText,
    clearTextCache,
    TEXT_CACHE_VERSION,
} from '../text-store';

const pdfEntry = (extra = {}) => ({
    key: 'abc|a.pdf',
    v: TEXT_CACHE_VERSION,
    type: 'pdf',
    name: 'a.pdf',
    savedAt: 1,
    pages: [{ text: 'tender', viewport: { width: 1, height: 1 }, items: null }],
    ...extra,
});

const docxEntry = (extra = {}) => ({
    key: 'def|b.docx',
    v: TEXT_CACHE_VERSION,
    type: 'docx',
    name: 'b.docx',
    savedAt: 1,
    html: '<p>tender</p>',
    text: 'tender',
    ...extra,
});

describe('cacheKey', () => {
    it('is stable for the same bytes and name, and path-sensitive', async () => {
        const bytes = new TextEncoder().encode('hello');
        const a = await cacheKey(bytes, 'a.pdf');
        const again = await cacheKey(bytes, 'a.pdf');
        const otherPath = await cacheKey(bytes, 'b/a.pdf');
        const otherBytes = await cacheKey(new TextEncoder().encode('hello!'), 'a.pdf');

        expect(a).toMatch(/^[0-9a-f]{64}\|a\.pdf$/);
        expect(again).toBe(a);
        expect(otherPath).not.toBe(a);
        expect(otherBytes).not.toBe(a);
    });

    it('returns null for missing input', async () => {
        expect(await cacheKey(null, 'a.pdf')).toBeNull();
        expect(await cacheKey(new Uint8Array(0), '')).toBeNull();
    });
});

describe('validStoredText', () => {
    it('accepts a well-formed PDF entry', () => {
        expect(validStoredText(pdfEntry())).not.toBeNull();
    });

    it('accepts a well-formed DOCX entry and a legacy .doc one', () => {
        expect(validStoredText(docxEntry())).not.toBeNull();
        expect(validStoredText(docxEntry({ type: 'doc' }))).not.toBeNull();
    });

    it('rejects entries from another schema version', () => {
        expect(validStoredText(pdfEntry({ v: TEXT_CACHE_VERSION + 1 }))).toBeNull();
        expect(validStoredText(pdfEntry({ v: undefined }))).toBeNull();
    });

    it('rejects half-written and unusable entries', () => {
        expect(validStoredText(null)).toBeNull();
        expect(validStoredText(pdfEntry({ pages: [] }))).toBeNull();
        expect(validStoredText(pdfEntry({ pages: [{ viewport: {} }] }))).toBeNull();
        expect(validStoredText(docxEntry({ html: '', text: '' }))).toBeNull();
        expect(validStoredText(docxEntry({ text: 5 }))).toBeNull();
        expect(validStoredText({ ...pdfEntry(), type: 'xlsx' })).toBeNull();
        expect(validStoredText(pdfEntry({ key: '' }))).toBeNull();
    });
});

describe('storage without IndexedDB', () => {
    it('degrades to a cache miss instead of throwing', async () => {
        expect(await readStoredText('abc|a.pdf')).toBeNull();
        expect(await clearTextCache()).toBe(false);
        expect(await storePdfText(null, 'a.pdf', pdfEntry().pages)).toBe(false);
        expect(await storePdfText('abc|a.pdf', 'a.pdf', pdfEntry().pages)).toBe(false);
        expect(await storeDocxText('def|b.docx', 'b.docx', 'docx', '<p>x</p>', 'x')).toBe(false);
    });

    it('rejects empty payloads before touching storage', async () => {
        expect(await storePdfText('abc|a.pdf', 'a.pdf', [])).toBe(false);
        expect(await storeDocxText('def|b.docx', 'b.docx', 'docx', '', '')).toBe(false);
    });
});
