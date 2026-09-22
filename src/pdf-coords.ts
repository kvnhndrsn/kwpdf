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

/**
 * Project a text item into viewport (y-down) space at scale 1.
 *
 * Returns the item's baseline start point (x, y), the top of its text box
 * (top = baseline y − box height), and the viewport-space advance direction
 * (dx, dy) covering one "unit" of advance so callers can interpolate within
 * the item.
 */
export function projectItem(
    item: { transform: number[]; height?: number; width?: number },
    m: ViewportTransform,
) {
    const t = item.transform;
    const baseline = projectPoint(m, t[4], t[5]);
    const [ux, uy] = itemUnitAdvance(t);
    const after = projectPoint(m, t[4] + ux, t[5] + uy);
    const itemH = item.height || Math.hypot(t[0], t[1]) || 0;
    return {
        x: baseline[0],
        y: baseline[1],
        top: baseline[1] - itemH,
        dx: after[0] - baseline[0],
        dy: after[1] - baseline[1],
    };
}