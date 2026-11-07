import { describe, it, expect, beforeEach } from 'vitest';
import { processTextContent, buildOffsetMap, findStartItem, findEndItem, computeMatchCoords, precomputeAllSearches } from '../pdf-search';
import { state } from '../state';
import { setKeywords } from '../cross';
import { clearKeywordRegexCache } from '../keyword-regex';

describe('processTextContent', () => {
    it('handles empty items', () => {
        const result = processTextContent({ items: [] });
        expect(result.text).toBe('');
        expect(result.items).toEqual([]);
    });

    it('concatenates single item', () => {
        const result = processTextContent({ items: [{ str: 'hello', transform: [10, 0, 0, 10, 0, 0], width: 30, height: 10 }] });
        expect(result.text).toBe('hello');
        expect(result.items).toHaveLength(1);
    });

    it('inserts spaces between items on the same line with a gap', () => {
        const items = [
            { str: 'hello', transform: [10, 0, 0, 10, 0, 100], width: 30, height: 10 },
            { str: 'world', transform: [10, 0, 0, 10, 35, 100], width: 30, height: 10 },
        ];
        const result = processTextContent({ items });
        expect(result.text).toBe('hello world');
    });

    it('does not insert space for adjacent items without gap', () => {
        const items = [
            { str: 'hello', transform: [10, 0, 0, 10, 0, 100], width: 30, height: 10 },
            { str: 'world', transform: [10, 0, 0, 10, 30, 100], width: 30, height: 10 },
        ];
        const result = processTextContent({ items });
        expect(result.text).toBe('helloworld');
    });

    it('inserts space for newline without hyphen break', () => {
        const items = [
            { str: 'hello', transform: [10, 0, 0, 10, 0, 100], width: 30, height: 10 },
            { str: 'world', transform: [10, 0, 0, 10, 0, 80], width: 30, height: 10 },
        ];
        const result = processTextContent({ items });
        expect(result.text).toBe('hello world');
    });

    it('removes hyphen break across lines', () => {
        const items = [
            { str: 'help-', transform: [10, 0, 0, 10, 0, 100], width: 30, height: 10 },
            { str: 'less', transform: [10, 0, 0, 10, 0, 80], width: 30, height: 10 },
        ];
        const result = processTextContent({ items });
        expect(result.text).toBe('helpless');
    });
});

describe('buildOffsetMap', () => {
    it('builds correct offsets for text items', () => {
        const items = [{ text: 'ab' }, { text: 'c' }, { text: 'def' }];
        const map = buildOffsetMap(items);
        expect(map.offsets).toEqual([0, 2, 3]);
        expect(map.length).toBe(6);
    });

    it('handles empty items', () => {
        const map = buildOffsetMap([]);
        expect(map.offsets).toEqual([]);
        expect(map.length).toBe(0);
    });
});

describe('findStartItem', () => {
    const items = [{ text: 'ab' }, { text: 'c' }, { text: 'def' }];
    const offsets = [0, 2, 3];

    it('finds item containing position', () => {
        const result = findStartItem(0, offsets, items);
        expect(result.index).toBe(0);
        expect(result.charStart).toBe(0);

        const result2 = findStartItem(3, offsets, items);
        expect(result2.index).toBe(2);
        expect(result2.charStart).toBe(3);
    });
});

describe('findEndItem', () => {
    const items = [{ text: 'ab' }, { text: 'c' }, { text: 'def' }];
    const offsets = [0, 2, 3];

    it('finds item containing end position', () => {
        // endPos=3 is within 'c' (offset 2, length 1)
        const result = findEndItem(3, 0, offsets, items);
        expect(result.item.text).toBe('c');
    });
});

describe('computeMatchCoords', () => {
    it('computes coordinates for a match span', () => {
        const textItems = [
            { text: 'hello', transform: [10, 0, 0, 10, 0, 100], width: 30, height: 10 },
            { text: 'world', transform: [10, 0, 0, 10, 35, 100], width: 30, height: 10 },
        ];
        const viewport = { width: 500, height: 800, offsetY: 20 };
        const offsetMap = buildOffsetMap(textItems);

        const coords = computeMatchCoords(0, 5, viewport, textItems, offsetMap);
        expect(coords).toHaveProperty('x');
        expect(coords).toHaveProperty('y');
        expect(coords).toHaveProperty('width');
        expect(coords).toHaveProperty('height');
        expect(coords.width).toBeGreaterThanOrEqual(4);
    });

    it('falls back to legacy math when no transform is present', () => {
        const textItems = [
            { text: 'hello', transform: [10, 0, 0, 10, 0, 100], width: 30, height: 10 },
        ];
        const viewport = { width: 500, height: 800, offsetY: 20 };
        const offsetMap = buildOffsetMap(textItems);

        const coords = computeMatchCoords(0, 5, viewport, textItems, offsetMap);
        expect(coords.x).toBeCloseTo(0, 1);
        expect(coords.y).toBeCloseTo((800 + 20) - (100 + 10), 1);
        expect(coords.height).toBe(10);
    });

    it('projects coords through the y-flip transform on an unrotated page', () => {
        const textItems = [
            { text: 'hello', transform: [10, 0, 0, 10, 0, 100], width: 30, height: 10 },
            { text: 'world', transform: [10, 0, 0, 10, 35, 100], width: 30, height: 10 },
        ];
        const viewport = { width: 500, height: 800, transform: [1, 0, 0, -1, 0, 800] };
        const offsetMap = buildOffsetMap(textItems);

        const coords = computeMatchCoords(0, 5, viewport, textItems, offsetMap);
        expect(coords.x).toBeCloseTo(0, 1);
        expect(coords.y).toBeCloseTo(800 - (100 + 10), 1);
        expect(coords.width).toBeCloseTo(30, 1);
        expect(coords.height).toBe(10);
    });

    it('interpolates along the advance direction for a partial char offset', () => {
        const textItems = [
            { text: 'hello', transform: [10, 0, 0, 10, 0, 100], width: 30, height: 10 },
        ];
        const viewport = { width: 500, height: 800, transform: [1, 0, 0, -1, 0, 800] };
        const offsetMap = buildOffsetMap(textItems);

        const coords = computeMatchCoords(3, 5, viewport, textItems, offsetMap);
        expect(coords.x).toBeCloseTo(18, 1);
    });

    it('projects coords for a 90-degree rotated page', () => {
        // Raw page 500x800 with rotation 90 -> viewport 800x500, transform [0,1,1,0,0,0].
        const textItems = [
            { text: 'hello', transform: [10, 0, 0, 10, 0, 100], width: 30, height: 10 },
        ];
        const viewport = { width: 800, height: 500, transform: [0, 1, 1, 0, 0, 0] };
        const offsetMap = buildOffsetMap(textItems);

        const coords = computeMatchCoords(0, 5, viewport, textItems, offsetMap);
        // raw (x, y) -> viewport (y, x). The run spans raw x[0,30] y[100,110],
        // so its box is viewport x[100,110] y[0,30]: the long axis is vertical.
        expect(coords.x).toBeCloseTo(100, 1);
        expect(coords.y).toBeCloseTo(0, 1);
        expect(coords.width).toBeCloseTo(10, 1);
        expect(coords.height).toBeCloseTo(30, 1);
    });

    it('does not collapse the box for a 180-degree rotated page', () => {
        const textItems = [
            { text: 'hello', transform: [10, 0, 0, 10, 0, 100], width: 30, height: 10 },
        ];
        const viewport = { width: 500, height: 800, transform: [-1, 0, 0, 1, 500, 0] };
        const offsetMap = buildOffsetMap(textItems);

        const coords = computeMatchCoords(0, 5, viewport, textItems, offsetMap);
        // 180 flips the advance direction, so x must be measured from the far end.
        expect(coords.width).toBeCloseTo(30, 1);
        expect(coords.height).toBeCloseTo(10, 1);
    });

    it('honors a non-zero viewBox (cropBox) origin', () => {
        // viewBox [50,0,550,800] -> transform [1,0,0,-1,-50,800]
        const textItems = [
            { text: 'hello', transform: [10, 0, 0, 10, 100, 100], width: 30, height: 10 },
        ];
        const viewport = { width: 500, height: 800, transform: [1, 0, 0, -1, -50, 800] };
        const offsetMap = buildOffsetMap(textItems);

        const coords = computeMatchCoords(0, 5, viewport, textItems, offsetMap);
        expect(coords.x).toBeCloseTo(50, 1);
        expect(coords.y).toBeCloseTo(800 - (100 + 10), 1);
    });

    it('returns one box per line fragment when the match wraps', () => {
        // "heat bonded" with the break between the two words: the second run
        // sits on the next baseline, so it cannot be unioned into the first box.
        const textItems = [
            { text: 'heat', transform: [10, 0, 0, 10, 0, 100], width: 22, height: 10 },
            { text: ' ', transform: [10, 0, 0, 10, 22, 80], width: 3, height: 10 },
            { text: 'bonded', transform: [10, 0, 0, 10, 0, 80], width: 36, height: 10 },
        ];
        const viewport = { width: 500, height: 800, transform: [1, 0, 0, -1, 0, 800] };
        const offsetMap = buildOffsetMap(textItems);

        const coords = computeMatchCoords(0, 11, viewport, textItems, offsetMap);

        expect(coords.boxes).toHaveLength(2);
        // The anchor stays on the first fragment, which is what scrolling uses.
        expect(coords.x).toBeCloseTo(0, 1);
        expect(coords.width).toBeCloseTo(22, 1);
        expect(coords.boxes[1].y).toBeCloseTo(coords.y + 20, 1);
        expect(coords.boxes[1].width).toBeCloseTo(36, 1);
    });

    it('keeps one box for a match that stays on one line', () => {
        const textItems = [
            { text: 'heat', transform: [10, 0, 0, 10, 0, 100], width: 22, height: 10 },
            { text: ' ', transform: [10, 0, 0, 10, 22, 100], width: 3, height: 10 },
            { text: 'bonded', transform: [10, 0, 0, 10, 25, 100], width: 36, height: 10 },
        ];
        const viewport = { width: 500, height: 800, transform: [1, 0, 0, -1, 0, 800] };
        const offsetMap = buildOffsetMap(textItems);

        const coords = computeMatchCoords(0, 11, viewport, textItems, offsetMap);

        expect(coords.boxes).toHaveLength(1);
        expect(coords.width).toBeCloseTo(61, 1);
        expect(coords.boxes[0]).toEqual({ x: coords.x, y: coords.y, width: coords.width, height: coords.height });
    });
});

describe('precomputeAllSearches', () => {
    beforeEach(() => {
        state.searchCache = Object.create(null);
        state.searchDeduplicated = false;
        state.textPageCache = {};
        state.totalPages = 1;
        state.docGeneration = 0;
        state.pdfDoc = null;
        state.textPageCache[1] = {
            text: 'hello world',
            viewport: { width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] },
            items: [{ text: 'hello world', transform: [10, 0, 0, 10, 0, 100], width: 60, height: 10 }]
        };
    });

    it('does not throw when the active keyword list is empty', async () => {
        setKeywords([]);
        clearKeywordRegexCache();
        await expect(precomputeAllSearches()).resolves.not.toThrow();
        expect(state.searchDeduplicated).toBe(true);
    });

    it('records matches for a populated keyword list', async () => {
        setKeywords(['world']);
        clearKeywordRegexCache();
        await precomputeAllSearches();
        expect(state.searchCache.world).toHaveLength(1);
        expect(state.searchDeduplicated).toBe(true);
    });

    it('keeps keywords that collide with Object.prototype', async () => {
        state.textPageCache[1] = {
            text: 'a __proto__ b constructor c toString d',
            viewport: { width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] },
            items: [{ text: 'a __proto__ b constructor c toString d', transform: [10, 0, 0, 10, 0, 100], width: 60, height: 10 }]
        };
        setKeywords(['__proto__', 'constructor', 'toString']);
        clearKeywordRegexCache();
        await precomputeAllSearches();

        // A plain {} cache would read these as inherited members (or write
        // through the prototype setter) instead of storing match lists.
        expect(Array.isArray(state.searchCache['__proto__'])).toBe(true);
        expect(state.searchCache['__proto__']).toHaveLength(1);
        expect(state.searchCache.constructor).toHaveLength(1);
        expect(state.searchCache.toString).toHaveLength(1);
        expect(Object.getPrototypeOf(state.searchCache)).toBeNull();
    });

    it('abandons precompute when the document changes mid-flight', async () => {
        setKeywords(['world']);
        clearKeywordRegexCache();

        // Force the lazy item fetch so there is an await to race against.
        state.textPageCache[1].items = null;
        state.pdfDoc = {
            getPage: async () => ({
                getTextContent: async () => {
                    // Simulate the user opening another document mid-extraction.
                    state.docGeneration++;
                    return { items: [{ str: 'hello world', transform: [10, 0, 0, 10, 0, 100], width: 60, height: 10 }] };
                }
            })
        };

        await precomputeAllSearches();

        // The stale run must not mark the cache complete, otherwise the newly
        // opened document would skip its own precompute.
        expect(state.searchDeduplicated).toBe(false);
        expect(state.searchCache.world).toBeUndefined();
    });
});
