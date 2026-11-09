import { describe, it, expect } from 'vitest';
import {
    bubbleBox,
    calloutLines,
    calloutShape,
    leaderStart,
    MAX_CALLOUT_LINES,
    MAX_CALLOUT_LINE_CHARS,
} from '../callout';

function metrics(overrides = {}) {
    return {
        fontSize: 10,
        lineHeight: 1.2,
        paddingX: 5,
        paddingY: 3,
        radius: 5,
        tailHalfBase: 8,
        strokeWidth: 1,
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

describe('calloutShape', () => {
    const anchor = { x: 100, y: 50 };

    function baseMid(shape) {
        return {
            x: (shape.tail.baseA.x + shape.tail.baseB.x) / 2,
            y: (shape.tail.baseA.y + shape.tail.baseB.y) / 2,
        };
    }

    it('reaches the detail, so the tail is as long as the gap', () => {
        const tip = { x: 400, y: 60 };
        const shape = calloutShape(anchor, tip, ['AB'], tenByTen);
        const base = baseMid(shape);

        expect(shape.tail.edge).toBe('bottom');
        expect(shape.tail.baseA.y).toBeCloseTo(shape.box.top + shape.box.height, 8);
        expect(shape.tail.apex.x).toBeCloseTo(tip.x, 8);
        expect(shape.tail.apex.y).toBeCloseTo(tip.y, 8);
        expect(Math.hypot(tip.x - base.x, tip.y - base.y)).toBeGreaterThan(200);
    });

    it('draws a longer tail for a detail that is further away', () => {
        const near = calloutShape(anchor, { x: 160, y: 50 }, ['AB'], tenByTen);
        const far = calloutShape(anchor, { x: 500, y: 50 }, ['AB'], tenByTen);

        expect(near.tail.apex.x).toBeCloseTo(160, 8);
        expect(far.tail.apex.x).toBeCloseTo(500, 8);
        expect(far.bounds.width).toBeGreaterThan(near.bounds.width);
    });

    it('widens the root for a detail that is further away', () => {
        const wide = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        const near = calloutShape(anchor, { x: 100, y: -90 }, [wide], tenByTen);
        const far = calloutShape(anchor, { x: 100, y: -600 }, [wide], tenByTen);
        const rootWidth = (shape) =>
            Math.hypot(shape.tail.baseA.x - shape.tail.baseB.x, shape.tail.baseA.y - shape.tail.baseB.y);

        expect(rootWidth(far)).toBeGreaterThan(rootWidth(near));
        // However far it goes, the root still fits inside the exit band.
        expect(rootWidth(far) / 2).toBeLessThanOrEqual(far.box.width * 0.25 - tenByTen.radius + 1e-9);
        expect(far.tail.halfBase).toBeCloseTo(rootWidth(far) / 2, 8);
    });

    it('keeps a short tail curved instead of hooking back', () => {
        const tip = { x: 124, y: -30 };
        const shape = calloutShape(anchor, tip, ['AB'], tenByTen);
        const apex = shape.tail.apex;
        const local = { x: apex.x - shape.box.left, y: apex.y - shape.box.top };

        expect(apex.x).toBeCloseTo(tip.x, 8);
        expect(shape.path.match(/C /g)).toHaveLength(7);
        // The tail's control points stay on the detail's side of the plate.
        expect(local.y).toBeLessThan(0);
    });

    it('only ever leaves through the top or bottom edge', () => {
        const tips = [
            { x: 400, y: 60 },
            { x: -300, y: 44 },
            { x: 100, y: -200 },
            { x: 100, y: 300 },
            { x: 380, y: -120 },
            { x: -200, y: 220 },
        ];

        for (const tip of tips) {
            const shape = calloutShape(anchor, tip, ['AB'], tenByTen);
            const bottom = shape.box.top + shape.box.height;

            expect(['top', 'bottom']).toContain(shape.tail.edge);
            expect(shape.tail.baseA.y).toBeCloseTo(shape.tail.edge === 'top' ? shape.box.top : bottom, 8);
            expect(shape.tail.baseB.y).toBeCloseTo(shape.tail.baseA.y, 8);
        }
    });

    it('exits a quarter to a third of the plate in from the end nearest the detail', () => {
        const right = calloutShape(anchor, { x: 400, y: 20 }, ['AB'], tenByTen);
        const left = calloutShape(anchor, { x: -300, y: 20 }, ['AB'], tenByTen);
        const share = (shape) => {
            const x = (shape.tail.baseA.x + shape.tail.baseB.x) / 2;
            return (x - shape.box.left) / shape.box.width;
        };

        // Mirrored for a detail on the other side.
        expect(share(right)).toBeCloseTo(1 - share(left), 8);
        // Detail on the right: a third to a quarter in from the right end.
        expect(share(right)).toBeGreaterThanOrEqual(1 - 1 / 3 - 1e-9);
        expect(share(right)).toBeLessThanOrEqual(0.75 + 1e-9);
    });

    it('has no leader line or arrowhead at all', () => {
        const shape = calloutShape(anchor, { x: 400, y: 60 }, ['AB'], tenByTen);

        expect('leader' in shape).toBe(false);
        expect('arrow' in shape).toBe(false);
    });

    it('splices a curved tail into the outline', () => {
        const tip = { x: 400, y: 60 };
        const shape = calloutShape(anchor, tip, ['AB'], tenByTen);
        const round = (value) => String(Math.round(value * 1000) / 1000);
        const baseA = shape.tail.baseA;
        const local = round(baseA.x - shape.box.left) + ' ' + round(baseA.y - shape.box.top);

        // The outline breaks at the tail's base instead of running past it.
        expect(shape.path).toContain(local);
        // Four rounded corners, the two flanks of the tail and its round front.
        expect(shape.path.match(/C /g)).toHaveLength(7);
        expect(shape.path.endsWith('Z')).toBe(true);
    });

    it('leaves the box bare when the detail is inside the bubble', () => {
        const shape = calloutShape(anchor, { x: 100, y: 50 }, ['AB'], tenByTen);

        expect(shape.tail).toBeNull();
        expect(shape.path.match(/C /g)).toHaveLength(4);
    });

    it('grows its bounds to hold the tail', () => {
        const shape = calloutShape(anchor, { x: 400, y: 60 }, ['AB'], tenByTen);

        expect(shape.bounds.left).toBeLessThanOrEqual(shape.box.left);
        expect(shape.bounds.left + shape.bounds.width).toBeGreaterThanOrEqual(shape.tail.apex.x);
        expect(shape.bounds.top + shape.bounds.height).toBeGreaterThanOrEqual(shape.tail.apex.y);
    });
});
