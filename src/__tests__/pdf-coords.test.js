import { describe, it, expect } from 'vitest';
import { projectPoint, itemUnitAdvance, projectItemBox, boxesOverlap, unionBoxes } from '../pdf-coords';

describe('projectPoint', () => {
    it('maps an unrotated page (y-flip)', () => {
        const m = [1, 0, 0, -1, 0, 800];
        expect(projectPoint(m, 0, 0)).toEqual([0, 800]);
        expect(projectPoint(m, 50, 100)).toEqual([50, 700]);
    });

    it('maps a 90-degree rotated page (swap + advance along new axis)', () => {
        const m = [0, 1, 1, 0, 0, 0];
        expect(projectPoint(m, 100, 200)).toEqual([200, 100]);
    });

    it('honors translation from a non-zero viewBox origin', () => {
        const m = [1, 0, 0, -1, -50, 800];
        expect(projectPoint(m, 100, 100)).toEqual([50, 700]);
    });
});

describe('itemUnitAdvance', () => {
    it('normalizes the glyph-run direction in PDF space', () => {
        expect(itemUnitAdvance([10, 0, 0, 10, 0, 0])).toEqual([1, 0]);
        expect(itemUnitAdvance([0, 10, -10, 0, 0, 0])).toEqual([0, 1]);
    });

    it('falls back to (1, 0) for zero-length transforms', () => {
        expect(itemUnitAdvance([0, 0, 0, 0, 1, 2])).toEqual([1, 0]);
    });
});

describe('projectItemBox', () => {
    const yFlip = [1, 0, 0, -1, 0, 800];

    it('returns the axis-aligned box of a run on an unrotated page', () => {
        const item = { transform: [10, 0, 0, 10, 0, 100], height: 10, width: 30 };
        const b = projectItemBox(item, yFlip);
        expect(b.x).toBeCloseTo(0, 6);
        expect(b.y).toBeCloseTo(690, 6);
        expect(b.width).toBeCloseTo(30, 6);
        expect(b.height).toBeCloseTo(10, 6);
    });

    it('swaps the axes on a 90-degree rotated page', () => {
        // The run advances along viewport Y, so the box grows vertically.
        const item = { transform: [10, 0, 0, 10, 0, 100], height: 10, width: 30 };
        const b = projectItemBox(item, [0, 1, 1, 0, 0, 0]);
        expect(b.x).toBeCloseTo(100, 6);
        expect(b.y).toBeCloseTo(0, 6);
        expect(b.width).toBeCloseTo(10, 6);
        expect(b.height).toBeCloseTo(30, 6);
    });

    it('handles a glyph run rotated within the page', () => {
        // Text rotated 90 degrees in user space: the 30pt advance runs along
        // viewport Y, so the box is 12 wide and 30 tall (not the transpose).
        const item = { transform: [0, 10, -10, 0, 100, 200], height: 12, width: 30 };
        const b = projectItemBox(item, yFlip);
        expect(b.width).toBeCloseTo(12, 6);
        expect(b.height).toBeCloseTo(30, 6);
    });

    it('does not apply the font scale twice', () => {
        // A 10pt run is 30pt wide, not 300pt.
        const item = { transform: [10, 0, 0, 10, 0, 100], height: 10, width: 30 };
        const b = projectItemBox(item, yFlip);
        expect(b.width).toBeCloseTo(30, 6);
    });

    it('interpolates a partial run', () => {
        const item = { transform: [10, 0, 0, 10, 0, 100], height: 10, width: 30 };
        const b = projectItemBox(item, yFlip, 0.5, 1);
        expect(b.x).toBeCloseTo(15, 6);
        expect(b.width).toBeCloseTo(15, 6);
    });
});

describe('boxesOverlap / unionBoxes', () => {
    it('detects overlap and ignores mere edge contact', () => {
        const a = { x: 0, y: 0, width: 10, height: 10 };
        expect(boxesOverlap(a, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
        expect(boxesOverlap(a, { x: 10, y: 0, width: 10, height: 10 })).toBe(false);
        expect(boxesOverlap(a, { x: 20, y: 20, width: 5, height: 5 })).toBe(false);
    });

    it('unions into the enclosing box', () => {
        const u = unionBoxes(
            { x: 0, y: 0, width: 10, height: 4 },
            { x: 8, y: 2, width: 6, height: 10 },
        );
        expect(u).toEqual({ x: 0, y: 0, width: 14, height: 12 });
    });
});