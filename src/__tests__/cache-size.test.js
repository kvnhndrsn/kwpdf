import { describe, it, expect, vi, afterEach } from 'vitest';
import { estimatePageSize, estimatePagesSize, estimateTextEntrySize, ITEM_OVERHEAD } from '../cache-size';

function makePage(items, text) {
    return {
        text,
        viewport: { width: 612, height: 792, offsetX: 0, offsetY: 0, transform: [1, 0, 0, -1, 0, 792], rotation: 0 },
        items,
    };
}

const ITEM = { text: 'tender', transform: [10, 0, 0, 10, 0, 100], width: 30, height: 10 };

describe('estimatePageSize', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('never serialises the entry', () => {
        const spy = vi.spyOn(JSON, 'stringify');
        estimatePagesSize([makePage([ITEM, ITEM], 'tender tender')]);
        estimateTextEntrySize('<p>x</p>', 'x');
        expect(spy).not.toHaveBeenCalled();
    });

    it('returns zero for a missing page', () => {
        expect(estimatePageSize(null)).toBe(0);
        expect(estimatePageSize(undefined)).toBe(0);
    });

    it('stays small for an empty page', () => {
        expect(estimatePageSize({ text: '', items: [], viewport: {} })).toBeLessThan(200);
    });

    it('grows with the page text', () => {
        const short = estimatePageSize({ text: 'a'.repeat(100), items: [], viewport: {} });
        const long = estimatePageSize({ text: 'a'.repeat(10_000), items: [], viewport: {} });
        expect(long - short).toBe(9_900);
    });

    it('counts items even when their text is tiny', () => {
        // A page of single-character runs is mostly per-item overhead, not text;
        // measuring only string length would make it nearly free to cache.
        const items = Array.from({ length: 5_000 }, () => ({ text: 'x' }));
        const size = estimatePageSize({ text: 'x'.repeat(5_000), items, viewport: {} });
        expect(size).toBeGreaterThan(5_000 * ITEM_OVERHEAD);
    });

    it('ignores a page whose items are still lazy (null)', () => {
        const lazy = estimatePageSize({ text: 'hello', items: null, viewport: {} });
        const fetched = estimatePageSize({ text: 'hello', items: [], viewport: {} });
        expect(lazy).toBe(fetched);
    });
});

describe('estimatePagesSize', () => {
    it('sums the pages and tolerates a missing array', () => {
        const page = makePage([ITEM], 'tender');
        expect(estimatePagesSize([page, page])).toBe(estimatePageSize(page) * 2);
        expect(estimatePagesSize(null)).toBe(0);
        expect(estimatePagesSize(undefined)).toBe(0);
    });

    it('tracks the JSON length it replaces', () => {
        // The estimate stands in for `JSON.stringify(pages).length`, so it must
        // stay in the same ballpark: too low and eviction never fires, too high
        // and it evicts documents that would have fit.
        const pages = Array.from({ length: 20 }, () =>
            makePage(
                Array.from({ length: 30 }, () => ({ ...ITEM })),
                'tender '.repeat(30).trim(),
            ),
        );
        const estimate = estimatePagesSize(pages);
        const actual = JSON.stringify(pages).length;
        const ratio = estimate / actual;
        expect(ratio).toBeGreaterThan(0.6);
        expect(ratio).toBeLessThan(1.6);
    });
});

describe('estimateTextEntrySize', () => {
    it('counts html and plain text', () => {
        const html = '<p>hello</p>';
        const text = 'hello';
        const size = estimateTextEntrySize(html, text);
        expect(size).toBeGreaterThan(html.length + text.length);
    });

    it('handles missing parts', () => {
        expect(estimateTextEntrySize(null, 'hello')).toBeGreaterThan(0);
        expect(estimateTextEntrySize(undefined, undefined)).toBeGreaterThan(0);
    });
});
