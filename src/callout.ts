/**
 * Geometry for detail callout bubbles, shared by the on-screen overlay
 * (measure.ts) and the burned-in PDF output (measure-burn.ts).
 *
 * Everything works in the measurement coordinate space: PDF-viewport points at
 * scale 1, with y growing downwards. The PDF side flips its y-up user-space
 * points into that frame before calling in, so both sides lay a bubble out with
 * exactly the same maths. Only the text width function differs, because the
 * screen draws Inter and the PDF embeds Helvetica.
 */

export interface CalloutPoint {
    x: number;
    y: number;
}

export interface CalloutBox {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface CalloutMetrics {
    fontSize: number;
    /** Multiplier applied to the font size for line spacing. */
    lineHeight: number;
    paddingX: number;
    paddingY: number;
    measureText: (text: string, fontSize: number) => number;
}

/** Past these limits a "bubble" stops annotating and starts hiding the drawing. */
export const MAX_CALLOUT_LINES = 4;
export const MAX_CALLOUT_LINE_CHARS = 60;

/** An empty bubble still needs a plate big enough to click into. */
const MIN_CALLOUT_WIDTH = 28;

/**
 * Clean user text into the lines a bubble actually shows.
 *
 * Whitespace is collapsed per line, trailing blank lines disappear (they would
 * only inflate the bubble), and the caps are applied here rather than at save
 * time so the editor and the renderer always agree on the text.
 */
export function calloutLines(text: unknown): string[] {
    if (typeof text !== 'string') return [];
    const lines = text.split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim().slice(0, MAX_CALLOUT_LINE_CHARS));
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(0, MAX_CALLOUT_LINES);
}

/**
 * Bubble rectangle centred on `anchor`, sized to its text.
 *
 * The bubble grows with the text instead of wrapping it: the on-screen font and
 * the PDF font have different widths, so a shared wrap decision could not
 * round-trip, while explicit line breaks can.
 */
export function bubbleBox(anchor: CalloutPoint, lines: string[], metrics: CalloutMetrics): CalloutBox {
    const widest = lines.reduce((max, line) => Math.max(max, metrics.measureText(line, metrics.fontSize)), 0);
    const width = Math.max(MIN_CALLOUT_WIDTH, widest + metrics.paddingX * 2);
    const rows = Math.max(1, lines.length);
    const height = rows * metrics.fontSize * metrics.lineHeight + metrics.paddingY * 2;

    return {
        left: anchor.x - width / 2,
        top: anchor.y - height / 2,
        width,
        height,
    };
}

/**
 * Where a leader aimed at `tip` leaves the bubble.
 *
 * The leader runs from this point to the tip, so it never crosses the bubble's
 * interior. When the tip is inside the bubble there is no leader to draw: the
 * tip comes back unchanged and callers skip the zero-length stroke.
 */
export function leaderStart(box: CalloutBox, tip: CalloutPoint): CalloutPoint {
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const dx = tip.x - cx;
    const dy = tip.y - cy;

    if (dx === 0 && dy === 0) return { x: cx, y: cy };
    if (Math.abs(dx) <= box.width / 2 && Math.abs(dy) <= box.height / 2) return { x: tip.x, y: tip.y };

    // Scale the centre-to-tip ray until it touches whichever edge comes first.
    const tx = dx === 0 ? Infinity : box.width / 2 / Math.abs(dx);
    const ty = dy === 0 ? Infinity : box.height / 2 / Math.abs(dy);
    const t = Math.min(tx, ty);

    return { x: cx + dx * t, y: cy + dy * t };
}
