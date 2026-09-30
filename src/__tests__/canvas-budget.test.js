import { describe, it, expect } from 'vitest';
import { fitScaleForPixels, MAX_CANVAS_PIXELS } from '../canvas-budget';

describe('fitScaleForPixels', () => {
    it('leaves a scale that already fits untouched', () => {
        expect(fitScaleForPixels(612, 792, 1)).toBe(1);
        expect(fitScaleForPixels(612, 792, 2)).toBe(2);
    });

    it('reduces an oversized scale to exactly the budget', () => {
        const scale = fitScaleForPixels(612, 792, 8, 1_000_000);
        const pixels = 612 * 792 * scale * scale;
        expect(pixels).toBeCloseTo(1_000_000, 6);
        expect(scale).toBeLessThan(8);
    });

    it('never exceeds the budget for extreme zoom', () => {
        // 400in x 200in sheet at 4x with a 2x dpr would be ~10 Gpx unblended.
        const scale = fitScaleForPixels(28_800, 14_400, 8);
        const pixels = 28_800 * 14_400 * scale * scale;
        expect(pixels).toBeLessThanOrEqual(MAX_CANVAS_PIXELS + 1);
        expect(scale).toBeGreaterThan(0);
    });

    it('is monotonic and plateaus once the budget binds', () => {
        // 1200x1600 = 1.92 MP at 1x: fits through 2x, clamps from 4x on.
        const fitted = [1, 2, 4, 8, 16, 32].map(s => fitScaleForPixels(1200, 1600, s));
        for (let i = 1; i < fitted.length; i++) {
            expect(fitted[i]).toBeGreaterThanOrEqual(fitted[i - 1]);
        }
        expect(fitted[0]).toBe(1);
        expect(fitted[1]).toBe(2);
        // Every input from 4x up clamps to the same scale.
        expect(fitted[2]).toBeCloseTo(fitted[5], 10);
        expect(fitted[5]).toBeLessThan(32);
    });

    it('passes through a large page that still fits the default budget', () => {
        // Letter at 5x is ~12.1 MP, under MAX_CANVAS_PIXELS: no downscale.
        expect(fitScaleForPixels(612, 792, 4)).toBe(4);
        expect(fitScaleForPixels(612, 792, 5)).toBe(5);
        // At 6x it is ~17.5 MP and must be clamped.
        expect(fitScaleForPixels(612, 792, 6)).toBeLessThan(6);
    });

    it('honours a custom budget', () => {
        expect(fitScaleForPixels(612, 792, 4, 1_000_000)).toBeLessThan(4);
        expect(fitScaleForPixels(612, 792, 4, 100_000_000)).toBe(4);
    });

    it('returns the input scale for degenerate inputs instead of throwing', () => {
        expect(fitScaleForPixels(612, 792, 0)).toBe(0);
        expect(fitScaleForPixels(612, 792, -2)).toBe(-2);
        expect(fitScaleForPixels(612, 792, NaN)).toBeNaN();
        expect(fitScaleForPixels(612, 792, Infinity)).toBe(Infinity);
        expect(fitScaleForPixels(0, 792, 2)).toBe(2);
        expect(fitScaleForPixels(612, 0, 2)).toBe(2);
        expect(fitScaleForPixels(NaN, 792, 2)).toBe(2);
        expect(fitScaleForPixels(612, 792, 2, 0)).toBe(2);
    });

    it('returns the input scale when the pixel count overflows to Infinity', () => {
        expect(fitScaleForPixels(1e300, 1e300, 1)).toBe(1);
    });
});
