/**
 * Geometry for detail callout bubbles, shared by the on-screen overlay
 * (measure.ts) and the burned-in PDF output (measure-burn.ts).
 *
 * Everything works in the measurement coordinate space: PDF-viewport points at
 * scale 1, with y growing downwards. The PDF side flips its y-up user-space
 * points into that frame before calling in, so both sides lay a bubble out with
 * exactly the same maths. Only the text width function differs, because the
 * screen draws Inter and the PDF embeds Helvetica.
 *
 * A callout is a plate with one curved tail pointing at the detail: no leader
 * line and no arrowhead, so the shape itself is the pointer. The tail always
 * reaches the detail, so its length follows how far apart the bubble and the
 * detail were placed.
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
    /** Corner rounding of the plate. */
    radius: number;
    /** Half-width of the tail where it leaves the plate, before it widens. */
    tailHalfBase: number;
    /** Stroke weight, used only to pad the shape's bounds. */
    strokeWidth: number;
    measureText: (text: string, fontSize: number) => number;
}

export type CalloutEdge = 'top' | 'right' | 'bottom' | 'left';

export interface CalloutTail {
    edge: CalloutEdge;
    /** Tail base points in outline traversal order. */
    baseA: CalloutPoint;
    baseB: CalloutPoint;
    apex: CalloutPoint;
    /** Half-width of the root along the plate edge, after it widens. */
    halfBase: number;
    /** How far the tail's curves reach outside the plate and the point. */
    bow: number;
}

export interface CalloutShape {
    box: CalloutBox;
    tail: CalloutTail | null;
    /** Closed outline in box-local coordinates, y down from the top-left. */
    path: string;
    /** Area the drawing occupies, so callers can size one element to hold it. */
    bounds: CalloutBox;
}

/** Past these limits a "bubble" stops annotating and starts hiding the drawing. */
export const MAX_CALLOUT_LINES = 4;
export const MAX_CALLOUT_LINE_CHARS = 60;

/** An empty bubble still needs a plate big enough to click into. */
const MIN_CALLOUT_WIDTH = 28;

/** Control-point offset for a quarter circle, 4/3 * tan(pi/8). */
const KAPPA = 0.5522847498307936;

/** Where a flank's control points sit along the tail. */
const TAIL_FLANK_ALONG = 0.5;

/** How far the whole tail bends off the straight chord, as a share of the gap. */
const TAIL_BEND_SHARE = 0.26;

/**
 * A bend wider than the root folds the two flanks across each other right
 * beside the plate, so it is capped against the root's half-width.
 */
const TAIL_BEND_MAX = 6;

/** Which way the tail's belly leans: +1 towards base A's end, -1 away from it. */
const TAIL_LEAN = -1;

/**
 * Least the tail leans, as a share of its length. Without a floor a tail that
 * points straight up or down comes out as a straight spike, because its lean
 * would be zero.
 */
const TAIL_LEAN_MIN = 0.35;

/** How far the flanks lift off the plate edge before turning to the detail. */
const TAIL_LIFT = 0.5;

/** Radius of the tail's rounded front, as a share of the root's body width. */
const TAIL_CAP = 0.18;

/** Control offset that makes the cap bulge exactly through the detail point. */
const TAIL_CAP_CONTROL = 4 / 3;

/** The root is about an eighth of the gap per side, never under the base. */
const TAIL_BASE_SHARE = 0.12;

/**
 * Where the tail leaves the plate, as a fraction of its width from the nearer
 * end: past the corners, but never as far in as the middle.
 */
const TAIL_EXIT_MIN = 0.25;
const TAIL_EXIT_MID = 0.3;
const TAIL_EXIT_MAX = 1 / 3;

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
 * Where a ray aimed at `tip` leaves the bubble.
 *
 * When the tip is inside the bubble there is nothing to point at: the tip comes
 * back unchanged, which `calloutShape` reads as "no tail".
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

/**
 * The whole annotation for one callout: a plate with a tail spliced into the
 * edge that faces the detail.
 *
 * The tail is part of the plate's path rather than a triangle stuck onto it, so
 * the result is one filled and stroked shape with no seam and no line across the
 * opening. Its flanks are curved, which is what makes it read as a drawn callout
 * rather than a polygon.
 */
export function calloutShape(
    anchor: CalloutPoint,
    tip: CalloutPoint,
    lines: string[],
    metrics: CalloutMetrics,
): CalloutShape {
    const box = bubbleBox(anchor, lines, metrics);
    const tail = calloutTail(box, tip, metrics);

    return {
        box,
        tail,
        path: outlinePath(box, metrics.radius, tail),
        bounds: shapeBounds(box, tail, metrics.strokeWidth),
    };
}

/** The tail for `tip`, or null when the tip falls inside the plate. */
function calloutTail(box: CalloutBox, tip: CalloutPoint, metrics: CalloutMetrics): CalloutTail | null {
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const dx = tip.x - cx;
    const dy = tip.y - cy;
    if (Math.abs(dx) <= box.width / 2 && Math.abs(dy) <= box.height / 2) return null;

    const r = Math.max(0, Math.min(metrics.radius, box.width / 2, box.height / 2));

    // The tail only ever leaves through the top or the bottom edge. Out of a
    // side it has to squeeze past a corner of a plate that is much wider than
    // it is tall, and it reads as an arm stuck on the bubble rather than as a
    // speech-bubble tail.
    const down = dy > 0;
    const edge: CalloutEdge = down ? 'bottom' : 'top';
    const edgeY = down ? box.top + box.height : box.top;

    // Follow the centre-to-tip ray to that edge, then hold the exit inside the
    // quarter-to-third of the plate nearest the detail. At a corner the tail
    // looks glued to the bubble and in the middle it reads as a fin, so neither
    // is allowed even if the ray points there.
    const cross = Math.abs(dy) < 1 ? cx + dx : cx + (dx * (edgeY - cy)) / dy;
    const nearLeft = dx < 0;
    const exitX = clamp(
        cross,
        box.left + box.width * (nearLeft ? TAIL_EXIT_MIN : 1 - TAIL_EXIT_MAX),
        box.left + box.width * (nearLeft ? TAIL_EXIT_MAX : 1 - TAIL_EXIT_MIN),
        box.left + box.width * (nearLeft ? TAIL_EXIT_MID : 1 - TAIL_EXIT_MID),
    );

    // A root of one fixed width has to look like a needle once the tail has any
    // distance to cross, however its sides are curved, so the root grows with
    // the gap. It still cannot be wider than the plate edge leaves between its
    // corners, and it cannot be so wide that the base spills out of the exit
    // band — that would drag the tail back to the middle of the plate.
    const reach = Math.hypot(tip.x - exitX, tip.y - edgeY);
    const room = Math.max(0, box.width / 2 - r);
    const bandRoom = Math.max(0, box.width * TAIL_EXIT_MIN - r);
    // A tail that runs almost level with the plate has to bring its return edge
    // back along the plate's own border, which reads as a second line across
    // it. Narrowing the root only in that case leaves the edge room to clear.
    const level = Math.min(1, Math.max(0, (Math.abs(tip.x - exitX) / reach - 0.88) / 0.12));
    const half =
        Math.max(2, Math.min(Math.max(metrics.tailHalfBase, reach * TAIL_BASE_SHARE), room, bandRoom)) *
        (1 - 0.65 * level);

    // The outline walks the top edge rightwards and the bottom edge leftwards.
    const baseA: CalloutPoint = { x: down ? exitX + half : exitX - half, y: edgeY };
    const baseB: CalloutPoint = { x: down ? exitX - half : exitX + half, y: edgeY };

    // The tail always reaches the detail: its length is simply the distance
    // between the plate edge and the point, so placing the bubble further away
    // draws a longer tail instead of leaving a gap.
    const baseMidX = (baseA.x + baseB.x) / 2;
    const baseMidY = (baseA.y + baseB.y) / 2;
    const body = Math.hypot(tip.x - baseMidX, tip.y - baseMidY) || 1;
    const perp =
        Math.abs(
            ((baseA.x - baseMidX) * (tip.y - baseMidY)) / body - ((baseA.y - baseMidY) * (tip.x - baseMidX)) / body,
        ) || half;
    const bow = Math.max(tailBend(reach), tailCap(perp), reach * TAIL_FLANK_ALONG * TAIL_LIFT);
    return { edge, baseA, baseB, apex: { x: tip.x, y: tip.y }, halfBase: half, bow };
}

/**
 * Closed plate outline in box-local coordinates (y down from the top-left),
 * with the curved tail spliced into whichever edge it sits on.
 *
 * Local coordinates are what both renderers want: the screen translates the
 * path into place with an SVG transform, and pdf-lib's `drawSvgPath` translates
 * and flips it to the same top-left origin.
 */
export function outlinePath(box: CalloutBox, radius: number, tail: CalloutTail | null): string {
    const w = box.width;
    const h = box.height;
    const r = Math.max(0, Math.min(radius, w / 2, h / 2));
    const c = r * KAPPA;
    const parts: string[] = [];
    const line = (x: number, y: number) => parts.push('L ' + fmt(x) + ' ' + fmt(y));
    const curve = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) =>
        parts.push('C ' + [x1, y1, x2, y2, x3, y3].map(fmt).join(' '));

    /**
     * Walk from base A to the apex and back to base B on two bowed flanks.
     *
     * Each flank swells out over the first stretch as it leaves the plate, then
     * eases into the point, so the tail reads as one drawn leaf — the speech
     * bubble tail — instead of a triangle with straight sides.
     */
    const tailFlanks = (a: CalloutPoint, apex: CalloutPoint, b: CalloutPoint) => {
        line(a.x, a.y);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const dx = apex.x - mid.x;
        const dy = apex.y - mid.y;
        const reach = Math.hypot(dx, dy) || 1;
        const ux = dx / reach;
        const uy = dy / reach;
        const half = Math.hypot(a.x - mid.x, a.y - mid.y) || 1;
        // One normal for the whole tail, pointing at base A: both flanks bend
        // the same way and the front's shoulders stay on their own base's side,
        // which is what keeps the two edges from swapping over near the tip.
        const side = Math.sign((a.x - mid.x) * -uy + (a.y - mid.y) * ux) || 1;
        const nx = -uy * side;
        const ny = ux * side;
        const out = reach * TAIL_FLANK_ALONG;
        const bend = Math.min(tailBend(reach), half * TAIL_BEND_MAX);
        // The whole tail leans away from the end of the plate the detail is on,
        // so it sweeps outwards instead of curling back over the bubble. A tail
        // pointing straight up or down has no lean of its own, so it takes the
        // floor and leaves on the side the detail is already on.
        const skew = (apex.x - mid.x) / reach;
        const lean = Math.max(Math.abs(skew), TAIL_LEAN_MIN) * (Math.sign(skew) || 1);
        const bendX = TAIL_LEAN * lean * bend;
        // Outward normal of the plate edge the tail leaves from: a tail that
        // runs off parallel to the plate (a detail level with the bubble) would
        // otherwise graze along the edge, so both flanks lift off it first.
        const edgeX = b.x - a.x;
        const edgeY = b.y - a.y;
        const edgeLen = Math.hypot(edgeX, edgeY) || 1;
        // Only a tail running almost level with the plate needs the lift; on an
        // oblique tail it flattens the curve that makes the shape read as a tail.
        const flatness = Math.min(1, Math.max(0, (Math.abs(ux) - 0.8) / 0.2));
        const lift = out * TAIL_LIFT * flatness;
        const mx = (edgeY / edgeLen) * lift;
        const my = (-edgeX / edgeLen) * lift;
        // The body's half-width at the root: the base is cut along the plate
        // edge, which is wider than the tail itself whenever it leaves obliquely.
        const perp = Math.abs((a.x - mid.x) * uy - (a.y - mid.y) * ux) || half;
        const cap = tailCap(perp);
        // The flanks stop a cap radius short of the detail and a half-round cap
        // bulges through the point, so the tip is rounded and its front still
        // lands exactly on the detail. Both flanks meet the cap on the same
        // tangent, which is what keeps the two edges from crossing there.
        const shoulderA = { x: apex.x - ux * cap + nx * cap, y: apex.y - uy * cap + ny * cap };
        const shoulderB = { x: apex.x - ux * cap - nx * cap, y: apex.y - uy * cap - ny * cap };
        const collar = cap * TAIL_CAP_CONTROL;
        const neck = cap * 0.55;

        curve(
            a.x + ux * out + mx + bendX,
            a.y + uy * out + my,
            shoulderA.x + ux * neck,
            shoulderA.y + uy * neck,
            shoulderA.x,
            shoulderA.y,
        );
        curve(
            shoulderA.x + ux * collar,
            shoulderA.y + uy * collar,
            shoulderB.x + ux * collar,
            shoulderB.y + uy * collar,
            shoulderB.x,
            shoulderB.y,
        );
        curve(
            shoulderB.x - ux * neck,
            shoulderB.y - uy * neck,
            b.x + ux * out + mx + bendX * 0.92,
            b.y + uy * out + my,
            b.x,
            b.y,
        );
    };

    const onEdge = (edge: CalloutEdge) => {
        if (!tail || tail.edge !== edge) return null;
        const local = (p: CalloutPoint) => ({ x: p.x - box.left, y: p.y - box.top });
        return { a: local(tail.baseA), b: local(tail.baseB), apex: local(tail.apex) };
    };

    parts.push('M ' + fmt(r) + ' 0');

    // Top edge, left to right.
    let t = onEdge('top');
    if (t) tailFlanks(t.a, t.apex, t.b);
    line(w - r, 0);
    if (r > 0) curve(w - r + c, 0, w, r - c, w, r);

    // Right edge, top to bottom.
    t = onEdge('right');
    if (t) tailFlanks(t.a, t.apex, t.b);
    line(w, h - r);
    if (r > 0) curve(w, h - r + c, w - r + c, h, w - r, h);

    // Bottom edge, right to left.
    t = onEdge('bottom');
    if (t) tailFlanks(t.a, t.apex, t.b);
    line(r, h);
    if (r > 0) curve(r - c, h, 0, h - r + c, 0, h - r);

    // Left edge, bottom to top.
    t = onEdge('left');
    if (t) tailFlanks(t.a, t.apex, t.b);
    line(0, r);
    if (r > 0) curve(0, r - c, r - c, 0, r, 0);

    parts.push('Z');
    return parts.join(' ');
}

/** Everything the drawing covers, padded for the stroke, so one element fits. */
function shapeBounds(box: CalloutBox, tail: CalloutTail | null, strokeWidth: number): CalloutBox {
    let minX = box.left;
    let minY = box.top;
    let maxX = box.left + box.width;
    let maxY = box.top + box.height;

    if (tail) {
        minX = Math.min(minX, tail.apex.x);
        minY = Math.min(minY, tail.apex.y);
        maxX = Math.max(maxX, tail.apex.x);
        maxY = Math.max(maxY, tail.apex.y);
    }

    // The flanks bow out past the straight chord to the point, so the bounds
    // have to hold that bulge as well as the stroke.
    const pad = Math.max(1, strokeWidth, tail ? tail.bow : 0);
    return {
        left: minX - pad,
        top: minY - pad,
        width: maxX - minX + pad * 2,
        height: maxY - minY + pad * 2,
    };
}

/** How far the whole tail bends off the straight chord to the point. */
function tailBend(reach: number): number {
    return reach * TAIL_BEND_SHARE;
}

/** Radius of the tail's rounded front, from the root's body half-width. */
function tailCap(perp: number): number {
    return Math.max(1.5, perp * TAIL_CAP);
}

function clamp(value: number, lo: number, hi: number, fallback: number): number {
    if (hi < lo) return fallback;
    return Math.max(lo, Math.min(hi, value));
}

/** Path numbers: enough precision for a curve, short enough to read. */
function fmt(value: number): string {
    return String(Math.round(value * 1000) / 1000);
}
