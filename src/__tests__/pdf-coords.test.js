import { describe, it, expect } from 'vitest';
import { projectPoint, itemUnitAdvance, projectItem } from '../pdf-coords';

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

describe('projectItem', () => {
    it('returns baseline, top and viewport-space advance direction', () => {
        const item = { transform: [10, 0, 0, 10, 0, 100], height: 10, width: 30 };
        const p = projectItem(item, [1, 0, 0, -1, 0, 800]);
        expect(p.x).toBeCloseTo(0, 6);
        expect(p.y).toBeCloseTo(700, 6);
        expect(p.top).toBeCloseTo(690, 6);
        expect(p.dx).toBeCloseTo(1, 6);
        expect(p.dy).toBeCloseTo(0, 6);
    });

    it('rotated text advances along the projected axis', () => {
        const item = { transform: [10, 0, 0, 10, 100, 200], height: 12, width: 30 };
        const p = projectItem(item, [0, 1, 1, 0, 0, 0]);
        expect(p.x).toBeCloseTo(200, 6);
        expect(p.y).toBeCloseTo(100, 6);
        expect(p.top).toBeCloseTo(88, 6);
        expect(p.dx).toBeCloseTo(0, 6);
        expect(p.dy).toBeCloseTo(1, 6);
    });
});