// PDF coordinate projection helpers.
//
// pdf.js renders each page's canvas in *viewport space*: the page content is
// mapped through `PageViewport.transform` (which handles rotation, y-flip,
// userUnit and cropBox/viewBox offsets). `getTextContent()` however returns
// text item transforms in *unrotated PDF user space* (y-up). To overlay
// text/highlights on the rendered canvas we therefore project each text
// item's baseline through the same transform, replicating pdf.js's
// `PageViewport.convertToViewportPoint`.

export type ViewportTransform = number[];

/** Apply a PDF → viewport transform matrix to a point in PDF user space. */
export function projectPoint(m: ViewportTransform, x: number, y: number): [number, number] {
    return [
        x * m[0] + y * m[2] + m[4],
        x * m[1] + y * m[3] + m[5],
    ];
}

/** Unit advance direction (in PDF user space) of a text item's glyph run. */
export function itemUnitAdvance(t: number[]): [number, number] {
    const u = Math.hypot(t[0], t[1]);
    if (u === 0) return [1, 0];
    return [t[0] / u, t[1] / u];
}

export interface ProjectedBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Axis-aligned bounding box of a (possibly partial) text run in viewport space.
 *
 * The run's text-space rectangle (u ∈ [start,end] × width, v ∈ [0, height]) is
 * mapped through the item's own text matrix and then through the viewport
 * matrix, and the four corners are bounded. Unlike interpolating a single
 * baseline, this stays correct when the page is rotated (where the advance runs
 * along viewport Y and the box's long axis is vertical) and for rotated/skewed
 * glyph runs, which common construction drawings use heavily.
 */
export function projectItemBox(
    item: { transform: number[]; height?: number; width?: number },
    m: ViewportTransform,
    startFrac = 0,
    endFrac = 1,
): ProjectedBox {
    const t = item.transform;
    const w = item.width || 0;
    const h = item.height || Math.hypot(t[0], t[1]) || 0;
    const u0 = w * Math.max(0, Math.min(1, startFrac));
    const u1 = w * Math.max(0, Math.min(1, endFrac));
    const [lo, hi] = u1 < u0 ? [u1, u0] : [u0, u1];

    // `width`/`height` are already expressed in PDF user-space units, so the
    // font scale baked into the transform must be normalized out before using
    // it as a direction (otherwise a 10pt run would be scaled ten times over).
    const s = Math.hypot(t[0], t[1]) || 1;
    const ax = t[0] / s, ay = t[1] / s; // advance direction
    const px = t[2] / s, py = t[3] / s; // perpendicular ("up" in glyph space)

    const at = (u: number, v: number): [number, number] => projectPoint(
        m,
        t[4] + ax * u + px * v,
        t[5] + ay * u + py * v,
    );

    const corners = [at(lo, 0), at(hi, 0), at(hi, h), at(lo, h)];
    const xs = corners.map(c => c[0]);
    const ys = corners.map(c => c[1]);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return {
        x: minX,
        y: minY,
        width: Math.max(...xs) - minX,
        height: Math.max(...ys) - minY,
    };
}

/** True when two projected boxes share area (touching edges do not count). */
export function boxesOverlap(a: ProjectedBox, b: ProjectedBox, epsilon = 0.01): boolean {
    return (
        a.x < b.x + b.width - epsilon &&
        b.x < a.x + a.width - epsilon &&
        a.y < b.y + b.height - epsilon &&
        b.y < a.y + a.height - epsilon
    );
}

/** Smallest box containing both inputs. */
export function unionBoxes(a: ProjectedBox, b: ProjectedBox): ProjectedBox {
    const minX = Math.min(a.x, b.x);
    const minY = Math.min(a.y, b.y);
    const maxX = Math.max(a.x + a.width, b.x + b.width);
    const maxY = Math.max(a.y + a.height, b.y + b.height);
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}