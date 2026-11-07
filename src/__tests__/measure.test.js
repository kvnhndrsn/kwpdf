import { describe, it, expect } from 'vitest';
import {
    pdfToMm,
    realWorldMm,
    addCommas,
    formatLength,
    formatArea,
    simplePolygonArea,
    getIntersection,
    decomposePolygon,
    distanceBetween,
    snapAngle45,
    polylineLength,
    parseScaleString,
} from '../measure';

describe('pdfToMm', () => {
    it('converts PDF points to mm', () => {
        const mm = pdfToMm(72);
        expect(mm).toBeCloseTo(25.4, 8);
    });

    it('returns 0 for 0 input', () => {
        expect(pdfToMm(0)).toBe(0);
    });
});

describe('realWorldMm', () => {
    it('applies scale ratio', () => {
        const mm = realWorldMm(72);
        expect(mm).toBeCloseTo(2540, 5);
    });
});

describe('addCommas', () => {
    it('adds commas to thousands', () => {
        expect(addCommas('1000')).toBe('1,000');
        expect(addCommas('1000000')).toBe('1,000,000');
    });

    it('handles decimal values', () => {
        expect(addCommas('1234.56')).toBe('1,234.56');
    });

    it('handles small numbers', () => {
        expect(addCommas('5')).toBe('5');
    });
});

describe('formatLength', () => {
    it('returns mm for values < 10mm', () => {
        expect(formatLength(5)).toBe('5 mm');
        expect(formatLength(0)).toBe('0 mm');
    });

    it('returns cm for values < 1000mm', () => {
        expect(formatLength(100)).toBe('10.0 cm');
        expect(formatLength(500)).toBe('50.0 cm');
    });

    it('returns m for values >= 1000mm', () => {
        expect(formatLength(1000)).toBe('1.00 m');
        expect(formatLength(5000)).toBe('5.00 m');
        expect(formatLength(1234567)).toBe('1,234.57 m');
    });

    it('clamps negative values to 0', () => {
        expect(formatLength(-10)).toBe('0 mm');
    });
});

describe('formatArea', () => {
    it('returns mm² for values < 100mm²', () => {
        expect(formatArea(50)).toBe('50 mm²');
        expect(formatArea(0)).toBe('0 mm²');
    });

    it('returns cm² for values < 10000mm²', () => {
        expect(formatArea(500)).toBe('5.0 cm²');
    });

    it('returns m² for values >= 10000mm²', () => {
        expect(formatArea(10000)).toBe('0.01 m²');
        expect(formatArea(1000000)).toBe('1.00 m²');
        expect(formatArea(123456789)).toBe('123.46 m²');
    });

    it('clamps negative values to 0', () => {
        expect(formatArea(-5)).toBe('0 mm²');
    });
});

describe('simplePolygonArea', () => {
    it('computes area of a triangle', () => {
        const area = simplePolygonArea([
            { x: 0, y: 0 },
            { x: 3, y: 0 },
            { x: 0, y: 4 },
        ]);
        expect(area).toBeCloseTo(6, 10);
    });

    it('computes area of a square', () => {
        const area = simplePolygonArea([
            { x: 0, y: 0 },
            { x: 2, y: 0 },
            { x: 2, y: 2 },
            { x: 0, y: 2 },
        ]);
        expect(area).toBeCloseTo(4, 10);
    });
});

describe('getIntersection', () => {
    it('returns null for parallel lines', () => {
        const result = getIntersection({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 });
        expect(result).toBeNull();
    });

    it('finds intersection of crossing segments', () => {
        const result = getIntersection({ x: 0, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }, { x: 2, y: 0 });
        expect(result).not.toBeNull();
        expect(result.x).toBeCloseTo(1, 5);
        expect(result.y).toBeCloseTo(1, 5);
    });

    it('returns null for non-intersecting segments', () => {
        const result = getIntersection({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 1 }, { x: 3, y: 1 });
        expect(result).toBeNull();
    });
});

describe('decomposePolygon', () => {
    it('returns empty for < 3 points', () => {
        expect(decomposePolygon([{ x: 0, y: 0 }])).toEqual([]);
        expect(
            decomposePolygon([
                { x: 0, y: 0 },
                { x: 1, y: 0 },
            ]),
        ).toEqual([]);
    });

    it('decomposes a self-intersecting bow-tie into two triangles', () => {
        const bowtie = [
            { x: 0, y: 0 },
            { x: 2, y: 2 },
            { x: 2, y: 0 },
            { x: 0, y: 2 },
        ];
        const result = decomposePolygon(bowtie);
        expect(result.length).toBeGreaterThanOrEqual(2);
        result.forEach((poly) => {
            expect(poly.length).toBeGreaterThanOrEqual(3);
        });
    });

    it('passes through a simple convex polygon unchanged', () => {
        const square = [
            { x: 0, y: 0 },
            { x: 2, y: 0 },
            { x: 2, y: 2 },
            { x: 0, y: 2 },
        ];
        const result = decomposePolygon(square);
        expect(result).toHaveLength(1);
        expect(result[0]).toHaveLength(4);
    });
});

describe('distanceBetween', () => {
    it('computes distance between two points', () => {
        expect(distanceBetween({ x: 0, y: 0 }, { x: 3, y: 4 })).toBeCloseTo(5, 10);
    });

    it('returns 0 for same point', () => {
        expect(distanceBetween({ x: 5, y: 5 }, { x: 5, y: 5 })).toBe(0);
    });
});

describe('snapAngle45', () => {
    it('returns the point unchanged when snap is false', () => {
        const p2 = { x: 10, y: 3 };
        const result = snapAngle45({ x: 0, y: 0 }, p2, false);
        expect(result.x).toBe(p2.x);
        expect(result.y).toBe(p2.y);
    });

    it('snaps to 45° angle', () => {
        const result = snapAngle45({ x: 0, y: 0 }, { x: 10, y: 5 }, true);
        expect(Math.abs(result.x - result.y)).toBeLessThan(0.1);
    });

    it('snaps to horizontal', () => {
        const result = snapAngle45({ x: 0, y: 0 }, { x: 10, y: 2 }, true);
        expect(Math.abs(result.y)).toBeLessThan(0.1);
    });

    it('snaps to vertical', () => {
        const result = snapAngle45({ x: 0, y: 0 }, { x: 2, y: 10 }, true);
        expect(Math.abs(result.x)).toBeLessThan(0.1);
    });
});

describe('polylineLength', () => {
    it('computes length of open polyline', () => {
        const len = polylineLength(
            [
                { x: 0, y: 0 },
                { x: 3, y: 0 },
                { x: 3, y: 4 },
            ],
            false,
        );
        expect(len).toBeCloseTo(3 + 4, 10);
    });

    it('computes length of closed polyline', () => {
        const len = polylineLength(
            [
                { x: 0, y: 0 },
                { x: 3, y: 0 },
                { x: 3, y: 4 },
            ],
            true,
        );
        expect(len).toBeCloseTo(3 + 4 + 5, 10);
    });
});

describe('parseScaleString', () => {
    it('parses "1 mm = 50 mm"', () => {
        expect(parseScaleString('1 mm = 50 mm')).toBe(50);
    });

    it('returns null for unmatched strings', () => {
        expect(parseScaleString('nothing here')).toBeNull();
        expect(parseScaleString('')).toBeNull();
    });
});
