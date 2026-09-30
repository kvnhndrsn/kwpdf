// Canvas backing-store budget.
//
// pdf.js 4.x dropped its own `maxCanvasPixels` clamp, so the page renderer owns
// the limit. Without one, a big page at high zoom asks the browser for a backing
// store it cannot allocate; with an `alpha: false` context an unpainted canvas
// is opaque black, which reads to the user as "this page rendered as a black
// rectangle" rather than "this page is too big to rasterise".

/**
 * Default ceiling on backing-store pixels (~64 MB at 4 bytes/px). Comfortably
 * under Chrome's ~268 MP / 16384 px hard limits while staying sharp for normal
 * letter/A1 pages at 1x-3x zoom.
 */
export const MAX_CANVAS_PIXELS = 16_777_216;

/**
 * Largest scale that keeps a `width` x `height` page within a pixel budget.
 *
 * @returns `scale` unchanged when it already fits; otherwise the same scale
 *   reduced by sqrt(maxPixels / actualPixels). Degenerate inputs (zero, negative,
 *   NaN, Infinity) return `scale` untouched so a malformed viewport can never
 *   turn into a zero-sized canvas.
 */
export function fitScaleForPixels(
    width: number,
    height: number,
    scale: number,
    maxPixels: number = MAX_CANVAS_PIXELS,
): number {
    if (!isFinite(scale) || scale <= 0) return scale;
    if (!isFinite(width) || !isFinite(height) || width <= 0 || height <= 0) return scale;
    if (!isFinite(maxPixels) || maxPixels <= 0) return scale;

    const pixels = width * height * scale * scale;
    if (!isFinite(pixels) || pixels <= maxPixels) return scale;

    const fitted = scale * Math.sqrt(maxPixels / pixels);
    return isFinite(fitted) && fitted > 0 ? fitted : scale;
}
