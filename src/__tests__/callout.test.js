import { describe, it, expect } from 'vitest';
import { bubbleBox, calloutLines, leaderStart, MAX_CALLOUT_LINES, MAX_CALLOUT_LINE_CHARS } from '../callout';

function metrics(overrides = {}) {
    return {
        fontSize: 10,
        lineHeight: 1.2,
        paddingX: 5,
        paddingY: 3,
        measureText: (line) => line.length * 10,
        ...overrides,
    };
}

const tenByTen = metrics();

describe('calloutLines', () => {
    it('trims, collapses inner whitespace and drops trailing blank lines', () => {
        expect(calloutLines('  a   b  \n\n  c \n\n')).toEqual(['a b', '', 'c']);
    });

    it('returns nothing for empty or non-string text', () => {
        expect(calloutLines('')).toEqual([]);
        expect(calloutLines('   \n\t ')).toEqual([]);
        expect(calloutLines('\n\n')).toEqual([]);
        expect(calloutLines(undefined)).toEqual([]);
        expect(calloutLines(42)).toEqual([]);
    });

    it('caps the line count and the characters per line', () => {
        expect(calloutLines('1\n2\n3\n4\n5\n6')).toHaveLength(MAX_CALLOUT_LINES);
        expect(calloutLines('x'.repeat(MAX_CALLOUT_LINE_CHARS + 20))[0]).toHaveLength(MAX_CALLOUT_LINE_CHARS);
    });
});

describe('bubbleBox', () => {
    it('centres the plate on the anchor and sizes it to the text', () => {
        const box = bubbleBox({ x: 100, y: 50 }, ['AB'], tenByTen);

        expect(box.width).toBe(20 + 10);
        expect(box.height).toBeCloseTo(12 + 6, 8);
        expect(box.left).toBeCloseTo(100 - 15, 8);
        expect(box.top).toBeCloseTo(50 - 9, 8);
    });

    it('uses the widest line and grows one row per line', () => {
        const one = bubbleBox({ x: 0, y: 0 }, ['A'], tenByTen);
        const two = bubbleBox({ x: 0, y: 0 }, ['A', 'ABCDE'], tenByTen);

        expect(two.width).toBe(50 + 10);
        expect(two.height).toBeCloseTo(2 * 12 + 6, 8);
        expect(two.width).toBeGreaterThan(one.width);
    });

    it('still gives an empty bubble a plate to click into', () => {
        const box = bubbleBox({ x: 0, y: 0 }, [], tenByTen);

        expect(box.width).toBe(28);
        expect(box.height).toBeCloseTo(12 + 6, 8);
    });
});

describe('leaderStart', () => {
    const box = { left: 100, top: 100, width: 40, height: 20 };

    it('leaves through whichever edge faces the tip', () => {
        expect(leaderStart(box, { x: 300, y: 110 }).x).toBeCloseTo(140, 8);
        expect(leaderStart(box, { x: 300, y: 110 }).y).toBeCloseTo(110, 8);

        expect(leaderStart(box, { x: -300, y: 110 }).x).toBeCloseTo(100, 8);
        expect(leaderStart(box, { x: 120, y: -300 }).y).toBeCloseTo(100, 8);
        expect(leaderStart(box, { x: 120, y: 300 }).y).toBeCloseTo(120, 8);
    });

    it('clamps to a corner for a diagonal tip', () => {
        const start = leaderStart(box, { x: 300, y: 400 });

        expect(start.y).toBeCloseTo(120, 8);
        expect(start.x).toBeGreaterThan(120);
        expect(start.x).toBeLessThan(140);
    });

    it('draws no leader when the tip is inside the bubble', () => {
        expect(leaderStart(box, { x: 130, y: 105 })).toEqual({ x: 130, y: 105 });
        expect(leaderStart(box, { x: 120, y: 110 })).toEqual({ x: 120, y: 110 });
    });
});
