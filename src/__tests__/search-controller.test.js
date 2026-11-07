// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { searchTextPages, getTextCoords, wrapIndex, countMatchesInAllDocs } from '../search-controller';

describe('searchTextPages', () => {
    it('returns empty array for empty page cache', () => {
        const result = searchTextPages({}, 3, 'hello');
        expect(result).toEqual([]);
    });

    it('finds matches across multiple pages', () => {
        const cache = {
            1: { text: 'hello world', viewport: { width: 800, height: 600 }, items: null },
            2: { text: 'HELLO again', viewport: { width: 800, height: 600 }, items: null },
            3: { text: 'nope', viewport: { width: 800, height: 600 }, items: null },
        };
        const result = searchTextPages(cache, 3, 'hello');
        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({ page: 1, startIndex: 0, endIndex: 5, text: 'hello' });
        expect(result[1]).toEqual({ page: 2, startIndex: 0, endIndex: 5, text: 'HELLO' });
    });

    it('finds multiple matches on same page', () => {
        const cache = {
            1: { text: 'test test test', viewport: { width: 800, height: 600 }, items: null },
        };
        const result = searchTextPages(cache, 1, 'test');
        expect(result).toHaveLength(3);
        expect(result[0].startIndex).toBe(0);
        expect(result[1].startIndex).toBe(5);
        expect(result[2].startIndex).toBe(10);
    });

    it('returns empty for no matches', () => {
        const cache = {
            1: { text: 'hello world', viewport: { width: 800, height: 600 }, items: null },
        };
        const result = searchTextPages(cache, 1, 'zzzz');
        expect(result).toEqual([]);
    });

    it('escapes regex special characters', () => {
        const cache = {
            1: { text: 'price is $10.00', viewport: { width: 800, height: 600 }, items: null },
        };
        const result = searchTextPages(cache, 1, '$10.00');
        expect(result).toHaveLength(1);
        expect(result[0].text).toBe('$10.00');
    });

    it('skips missing pages', () => {
        const cache = {
            1: { text: 'hello', viewport: { width: 800, height: 600 }, items: null },
            3: { text: 'world', viewport: { width: 800, height: 600 }, items: null },
        };
        const result = searchTextPages(cache, 3, 'hello');
        expect(result).toHaveLength(1);
        expect(result[0].page).toBe(1);
    });
});

describe('getTextCoords', () => {
    const baseItem = { text: 'ab', transform: [10, 0, 0, 10, 100, 200], width: 30, height: 12 };

    it('returns null for null items', () => {
        const cached = { text: 'hello', viewport: { width: 800, height: 600 }, items: null };
        expect(getTextCoords(cached, 0, 5)).toBeNull();
    });

    it('computes coords for a simple item', () => {
        const cached = {
            text: 'ab',
            viewport: { width: 800, height: 600, offsetY: 0 },
            items: [baseItem],
        };
        const coords = getTextCoords(cached, 0, 1);
        expect(coords).not.toBeNull();
        expect(coords.startX).toBeCloseTo(100, 1);
        expect(coords.endX).toBeGreaterThan(coords.startX);
        expect(coords.height).toBe(12);
    });

    it('computes coords with offsetY', () => {
        const cached = {
            text: 'ab',
            viewport: { width: 800, height: 600, offsetY: 50 },
            items: [baseItem],
        };
        const coords = getTextCoords(cached, 0, 1);
        expect(coords).not.toBeNull();
        expect(coords.startY).toBe(600 + 50 - (200 + 12));
    });

    it('handles multi-character start offset', () => {
        const items = [
            { text: 'ab', transform: [10, 0, 0, 10, 100, 200], width: 30, height: 12 },
            { text: 'cd', transform: [10, 0, 0, 10, 130, 200], width: 30, height: 12 },
        ];
        const cached = {
            text: 'abcd',
            viewport: { width: 800, height: 600, offsetY: 0 },
            items,
        };
        // "c" starts at index 2 in the concatenated text, which is in the second item
        const coords = getTextCoords(cached, 2, 3);
        expect(coords).not.toBeNull();
        expect(coords.startX).toBeCloseTo(130, 1); // second item's transform[4]
    });

    it('projects coords through the y-flip transform on an unrotated page', () => {
        const cached = {
            text: 'ab',
            viewport: { width: 800, height: 600, transform: [1, 0, 0, -1, 0, 600] },
            items: [{ text: 'ab', transform: [10, 0, 0, 10, 100, 200], width: 30, height: 12 }],
        };
        const coords = getTextCoords(cached, 0, 1);
        expect(coords).not.toBeNull();
        expect(coords.startX).toBeCloseTo(100, 1);
        expect(coords.startY).toBeCloseTo(600 - 200 - 12, 1);
        expect(coords.endX).toBeCloseTo(100 + (1 / 2) * 30, 1);
        expect(coords.height).toBe(12);
    });

    it('projects coords for a rotated page', () => {
        const cached = {
            text: 'ab',
            viewport: { width: 600, height: 800, transform: [0, 1, 1, 0, 0, 0] },
            items: [{ text: 'ab', transform: [10, 0, 0, 10, 100, 200], width: 30, height: 12 }],
        };
        const coords = getTextCoords(cached, 0, 1);
        expect(coords).not.toBeNull();
        // raw (x, y) -> viewport (y, x). Half the run is raw x[100,115], the
        // glyph box is y[200,212], giving viewport x[200,212] y[100,115] —
        // the box grows across X, not down Y.
        expect(coords.startX).toBeCloseTo(200, 1);
        expect(coords.startY).toBeCloseTo(100, 1);
        expect(coords.endX).toBeCloseTo(212, 1);
        expect(coords.height).toBeCloseTo(15, 1);
    });

    it('does not treat a legitimate x=0 endpoint as "not found"', () => {
        const cached = {
            text: 'ab',
            viewport: { width: 600, height: 800, transform: [0, 1, 1, 0, 0, 0] },
            items: [{ text: 'ab', transform: [10, 0, 0, 10, 0, 200], width: 30, height: 12 }],
        };
        const coords = getTextCoords(cached, 0, 1);
        expect(coords).not.toBeNull();
        expect(coords.startX).toBeCloseTo(200, 1);
        expect(coords.height).toBeCloseTo(15, 1);
    });
});

describe('wrapIndex', () => {
    it('wraps zero to zero', () => {
        expect(wrapIndex(0, 5)).toBe(0);
    });

    it('returns same index within range', () => {
        expect(wrapIndex(2, 5)).toBe(2);
    });

    it('wraps overflow', () => {
        expect(wrapIndex(5, 5)).toBe(0);
        expect(wrapIndex(7, 5)).toBe(2);
    });

    it('wraps negative index', () => {
        expect(wrapIndex(-1, 5)).toBe(4);
        expect(wrapIndex(-5, 5)).toBe(0);
        expect(wrapIndex(-6, 5)).toBe(4);
    });

    it('returns 0 for empty array (length 0)', () => {
        expect(wrapIndex(3, 0)).toBe(0);
        expect(wrapIndex(-1, 0)).toBe(0);
    });

    it('handles length 1', () => {
        expect(wrapIndex(0, 1)).toBe(0);
        expect(wrapIndex(1, 1)).toBe(0);
        expect(wrapIndex(-1, 1)).toBe(0);
    });
});

describe('countMatchesInAllDocs', () => {
    beforeAll(() => {
        globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
    });

    afterAll(() => {
        delete globalThis.requestAnimationFrame;
    });

    it('returns empty for empty cache', async () => {
        const result = await countMatchesInAllDocs({}, {}, {}, 'test', { cancelled: false });
        expect(result).toEqual({ results: {}, totalMatches: 0, filesWithMatches: 0 });
    });

    it('counts matches across docs', async () => {
        const dataCache = {
            'doc1': { name: 'a.pdf', type: 'pdf', url: 'doc1', folder: '', fullPath: '', counts: {} },
            'doc2': { name: 'b.pdf', type: 'pdf', url: 'doc2', folder: '', fullPath: '', counts: {} },
        };
        const textCache = {
            'doc1': { totalPages: 1, pages: [{ text: 'hello world', viewport: { width: 800, height: 600 }, items: null, _lastAccess: 0 }], fileName: 'a.pdf', _lastAccess: 0, _size: 100 },
            'doc2': { totalPages: 1, pages: [{ text: 'goodbye hello', viewport: { width: 800, height: 600 }, items: null, _lastAccess: 0 }], fileName: 'b.pdf', _lastAccess: 0, _size: 100 },
        };
        const result = await countMatchesInAllDocs(dataCache, textCache, {}, 'hello', { cancelled: false });
        expect(result).not.toBeNull();
        expect(result.totalMatches).toBe(2);
        expect(result.filesWithMatches).toBe(2);
        expect(result.results['doc1']).toBe(1);
        expect(result.results['doc2']).toBe(1);
    });

    it('returns null when cancelled', async () => {
        const dataCache = {
            'doc1': { name: 'a.pdf', type: 'pdf', url: 'doc1', folder: '', fullPath: '', counts: {} },
        };
        const textCache = {
            'doc1': { totalPages: 1, pages: [{ text: 'hello', viewport: { width: 800, height: 600 }, items: null, _lastAccess: 0 }], fileName: 'a.pdf', _lastAccess: 0, _size: 100 },
        };
        const cancelRef = { cancelled: true };
        const result = await countMatchesInAllDocs(dataCache, textCache, {}, 'hello', cancelRef);
        expect(result).toBeNull();
    });

    it('searches docx content cache', async () => {
        const dataCache = {
            'doc1': { name: 'a.docx', type: 'docx', url: 'doc1', folder: '', fullPath: '', counts: {} },
        };
        const contentCache = {
            'doc1': { text: 'hello from docx', html: '', fileName: 'a.docx', type: 'docx', _lastAccess: 0, _size: 100 },
        };
        const result = await countMatchesInAllDocs(dataCache, {}, contentCache, 'hello', { cancelled: false });
        expect(result).not.toBeNull();
        expect(result.totalMatches).toBe(1);
        expect(result.filesWithMatches).toBe(1);
    });
});

describe('searchTextPages query memo', () => {
    function page(text) {
        return { text, viewport: { width: 800, height: 600 }, items: null };
    }

    it('returns an equal but independent array for a repeated query', () => {
        const cache = { 1: page('hello hello') };

        const first = searchTextPages(cache, 1, 'hello');
        const second = searchTextPages(cache, 1, 'hello');

        expect(second).toEqual(first);
        expect(second).not.toBe(first);
    });

    it('does not hand out the memoised array itself', () => {
        const cache = { 1: page('hello hello') };

        const first = searchTextPages(cache, 1, 'hello');
        first.length = 0;

        expect(searchTextPages(cache, 1, 'hello')).toHaveLength(2);
    });

    it('re-scans once the page cache gains a page', () => {
        const cache = { 1: page('hello') };
        expect(searchTextPages(cache, 1, 'hello')).toHaveLength(1);

        cache[2] = page('hello again');
        const after = searchTextPages(cache, 2, 'hello');

        expect(after).toHaveLength(2);
        expect(after[1].page).toBe(2);
    });

    it('keeps separate results for separate queries', () => {
        const cache = { 1: page('hello world') };

        expect(searchTextPages(cache, 1, 'hello')).toHaveLength(1);
        expect(searchTextPages(cache, 1, 'world')).toHaveLength(1);
        expect(searchTextPages(cache, 1, 'hello')[0].startIndex).toBe(0);
    });
});

describe('countMatchesInAllDocs scheduling', () => {
    function library(count) {
        const docDataCache = {};
        const docTextCache = {};
        for (let i = 0; i < count; i++) {
            const url = 'blob:' + i;
            docDataCache[url] = { type: 'pdf' };
            docTextCache[url] = {
                totalPages: 1,
                pages: [{ text: 'alpha beta' }],
                fileName: 'f' + i,
                _lastAccess: 0,
                _size: 0,
            };
        }
        return { docDataCache, docTextCache };
    }

    it('completes when requestAnimationFrame never runs (hidden tab)', async () => {
        const realRaf = globalThis.requestAnimationFrame;
        const realHidden = Object.getOwnPropertyDescriptor(document, 'hidden');
        // A hidden tab pauses requestAnimationFrame; the chunk loop has to fall
        // back to a task or the search never finishes.
        globalThis.requestAnimationFrame = () => 0;
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });

        try {
            const { docDataCache, docTextCache } = library(60);
            const counts = await countMatchesInAllDocs(
                docDataCache, docTextCache, {}, 'alpha', { cancelled: false },
            );

            expect(counts).not.toBeNull();
            expect(counts.totalMatches).toBe(60);
            expect(counts.filesWithMatches).toBe(60);
        } finally {
            globalThis.requestAnimationFrame = realRaf;
            if (realHidden) Object.defineProperty(document, 'hidden', realHidden);
            else delete document.hidden;
        }
    });

    it('still reports cancellation while backgrounded', async () => {
        const realRaf = globalThis.requestAnimationFrame;
        const realHidden = Object.getOwnPropertyDescriptor(document, 'hidden');
        globalThis.requestAnimationFrame = () => 0;
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });

        try {
            const { docDataCache, docTextCache } = library(60);
            const cancelRef = { cancelled: true };
            const counts = await countMatchesInAllDocs(docDataCache, docTextCache, {}, 'alpha', cancelRef);
            expect(counts).toBeNull();
        } finally {
            globalThis.requestAnimationFrame = realRaf;
            if (realHidden) Object.defineProperty(document, 'hidden', realHidden);
            else delete document.hidden;
        }
    });
});

describe('getTextCoords item lookup', () => {
    function item(text, x, width = 30) {
        return { text, transform: [10, 0, 0, 10, x, 200], width, height: 12 };
    }

    function entry(items) {
        return {
            text: items.map(i => i.text).join(''),
            viewport: { width: 800, height: 600, offsetY: 0 },
            items,
        };
    }

    it('spans a match that crosses two adjacent runs', () => {
        const cached = entry([item('ab', 100), item('cd', 130)]);

        const coords = getTextCoords(cached, 1, 3);

        expect(coords).not.toBeNull();
        // 'b' starts halfway through the first run, 'c' ends halfway through the second.
        expect(coords.startX).toBeCloseTo(100 + 0.5 * 30, 5);
        expect(coords.endX).toBeCloseTo(130 + 0.5 * 30, 5);
    });

    it('skips empty runs without losing the match', () => {
        const cached = entry([item('ab', 100), item('', 0), item('cd', 130)]);

        const coords = getTextCoords(cached, 2, 3);

        expect(coords).not.toBeNull();
        expect(coords.startX).toBeCloseTo(130, 5);
    });

    it('returns null when the range starts past the end of the text', () => {
        const cached = entry([item('ab', 100)]);
        expect(getTextCoords(cached, 2, 3)).toBeNull();
    });
});
