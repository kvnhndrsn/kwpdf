import { describe, it, expect } from 'vitest';
import { processTextContent, buildOffsetMap, findStartItem, findEndItem, computeMatchCoords } from '../pdf-search';

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
        // raw (x, y) -> viewport (y, x); hello baseline raw (0, 100) -> (100, 0)
        expect(coords.x).toBeCloseTo(100, 1);
        expect(coords.y).toBeCloseTo(-10, 1);
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
});
