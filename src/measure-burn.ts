import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { PDFFont, PDFPage } from 'pdf-lib';
import { MEASURE_STYLE } from './measure-style';
import { bubbleBox, calloutLines, leaderStart } from './callout';
import type { CalloutMetrics } from './callout';

/** A measured point, in PDF-viewport points at scale 1 (y down from the page top). */
export interface BurnPoint {
    page: number;
    x: number;
    y: number;
}

export interface BurnMeasurement {
    type?: string;
    points?: BurnPoint[];
    label?: string;
    /** Detail callout note; callouts have no measurement label. */
    text?: string;
}

/**
 * Maps viewport coordinates to PDF user space for one page.
 *
 * The browser supplies a pdf.js `PageViewport` (scale 1), whose
 * `convertToPdfPoint()` handles page rotation and crop-box offsets. Tests pass
 * a plain function; nothing here assumes pdf.js.
 */
export interface PageMapper {
    toUserSpace(x: number, y: number): { x: number; y: number };
}

export interface BurnInput {
    bytes: Uint8Array | ArrayBuffer;
    measurements: BurnMeasurement[];
    getPage: (pageNum: number) => PageMapper | null | Promise<PageMapper | null>;
}

export interface BurnResult {
    bytes: Uint8Array;
    /** Number of measurements drawn into the output. */
    drawn: number;
    /** Pages that could not be drawn: outside the document, or no mapper. */
    skippedPages: number[];
}

interface Pt {
    x: number;
    y: number;
}

const BURN_COLOR = rgb(MEASURE_STYLE.red, MEASURE_STYLE.green, MEASURE_STYLE.blue);
const BURN_OPACITY = MEASURE_STYLE.opacity;
const AREA_FILL_OPACITY = 0.15;
const LABEL_BACKGROUND_OPACITY = 0.75;
const LABEL_PADDING_X = 5;
const LABEL_PADDING_Y = 2;
const LABEL_LINE_HEIGHT = 1.2;
const LABEL_BASELINE = 0.8;

/**
 * `drawing.pdf` → `drawing-measured.pdf`. A name that already carries the
 * suffix is left alone so repeat saves cannot build up `-measured-measured`.
 */
export function measuredFileName(name: string): string {
    const base = String(name || 'document')
        .replace(/\.pdf$/i, '')
        .replace(/[\\/]+$/, '');
    return /-measured$/i.test(base) ? base + '.pdf' : base + '-measured.pdf';
}

/**
 * Draw committed measurements into a copy of `bytes`.
 *
 * Everything is drawn in PDF user space: the caller's mapper turns the stored
 * viewport coordinates into user-space points, and pdf-lib's page origin (the
 * media box corner) is subtracted here, because pdf-lib ignores the media box
 * offset when it draws.
 */
export async function burnMeasurementsIntoPdf(input: BurnInput): Promise<BurnResult> {
    const doc = await PDFDocument.load(input.bytes, { updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pageCount = doc.getPageCount();

    const mappers = new Map<number, PageMapper | null>();
    const skippedPages = new Set<number>();
    let drawn = 0;

    for (const measurement of input.measurements || []) {
        const points = Array.isArray(measurement?.points) ? measurement.points : [];
        if (points.length === 0) continue;
        // A callout with no note only ever exists while its editor is open.
        if (measurement.type === 'callout' && calloutLines(measurement.text).length === 0) continue;
        const pageNum = points[0]?.page;

        if (!Number.isInteger(pageNum) || pageNum < 1 || pageNum > pageCount) {
            skippedPages.add(pageNum);
            continue;
        }
        if (!mappers.has(pageNum)) mappers.set(pageNum, await input.getPage(pageNum));
        const mapper = mappers.get(pageNum);
        if (!mapper) {
            skippedPages.add(pageNum);
            continue;
        }

        const page = doc.getPage(pageNum - 1);
        const box = page.getMediaBox();
        const toPage = (p: BurnPoint): Pt => {
            const user = mapper.toUserSpace(p.x, p.y);
            return { x: user.x - box.x, y: user.y - box.y };
        };

        drawMeasurement(page, measurement, points.map(toPage), font);
        drawn++;
    }

    const bytes = await doc.save({ useObjectStreams: true });
    return { bytes, drawn, skippedPages: [...skippedPages] };
}

function drawMeasurement(page: PDFPage, measurement: BurnMeasurement, pts: Pt[], font: PDFFont): void {
    const label = typeof measurement.label === 'string' ? measurement.label : '';

    if (measurement.type === 'distance' && pts.length >= 2) {
        const [a, b] = pts;
        const dir = unitVector(a, b);
        drawSegment(page, a, b);
        if (dir) {
            // Ticks at both ends, arrows pointing outwards from each end.
            drawTick(page, a, dir);
            drawTick(page, b, dir);
            drawArrow(page, a, { x: -dir.x, y: -dir.y });
            drawArrow(page, b, dir);
        }
        drawLabel(page, midpoint(a, b), label, font);
        return;
    }

    if (measurement.type === 'polyline' && pts.length >= 2) {
        for (let i = 0; i < pts.length - 1; i++) drawSegment(page, pts[i], pts[i + 1]);

        const first = unitVector(pts[0], pts[1]);
        const last = unitVector(pts[pts.length - 2], pts[pts.length - 1]);
        if (first) {
            drawTick(page, pts[0], first);
            drawArrow(page, pts[0], { x: -first.x, y: -first.y });
        }
        if (last) {
            drawTick(page, pts[pts.length - 1], last);
            drawArrow(page, pts[pts.length - 1], last);
        }
        drawLabel(page, centroid(pts), label, font);
        return;
    }

    if (measurement.type === 'area' && pts.length >= 3) {
        drawFilledPath(page, pts, AREA_FILL_OPACITY);
        for (let i = 0; i < pts.length; i++) drawSegment(page, pts[i], pts[(i + 1) % pts.length]);
        drawLabel(page, centroid(pts), label, font);
        return;
    }

    if (measurement.type === 'callout' && pts.length >= 2) {
        drawCallout(page, pts[0], pts[1], calloutLines(measurement.text), font);
    }
}

function drawSegment(page: PDFPage, a: Pt, b: Pt): void {
    if (!unitVector(a, b)) return;
    page.drawLine({
        start: a,
        end: b,
        thickness: MEASURE_STYLE.lineWidth,
        color: BURN_COLOR,
        opacity: BURN_OPACITY,
    });
}

/** A tick across the measurement at `at`, perpendicular to `along`. */
function drawTick(page: PDFPage, at: Pt, along: Pt): void {
    const half = MEASURE_STYLE.tickLength / 2;
    const perp = { x: -along.y, y: along.x };
    page.drawLine({
        start: { x: at.x - perp.x * half, y: at.y - perp.y * half },
        end: { x: at.x + perp.x * half, y: at.y + perp.y * half },
        thickness: MEASURE_STYLE.tickWidth,
        color: BURN_COLOR,
        opacity: BURN_OPACITY,
    });
}

/** Filled triangle whose tip sits on `tip`, pointing along `dir`. */
function drawArrow(page: PDFPage, tip: Pt, dir: Pt): void {
    const base = {
        x: tip.x - dir.x * MEASURE_STYLE.arrowLength,
        y: tip.y - dir.y * MEASURE_STYLE.arrowLength,
    };
    const half = MEASURE_STYLE.arrowWidth / 2;
    drawPolygon(page, [
        tip,
        { x: base.x - dir.y * half, y: base.y + dir.x * half },
        { x: base.x + dir.y * half, y: base.y - dir.x * half },
    ]);
}

function drawFilledPath(page: PDFPage, points: Pt[], opacity: number): void {
    drawPolygon(page, points, opacity);
}

/**
 * Fill a closed polygon.
 *
 * `drawSvgPath` translates to the anchor and then flips the y axis, so path
 * coordinates are authored relative to the first point with SVG's y-down
 * convention. Keeping the anchor on a real page point avoids reasoning about
 * page-space coordinates being mirrored across the origin.
 */
function drawPolygon(page: PDFPage, points: Pt[], opacity: number = BURN_OPACITY): void {
    if (points.length < 3) return;
    const origin = points[0];
    const path = 'M ' + points.map((p) => num(p.x - origin.x) + ' ' + num(-(p.y - origin.y))).join(' L ') + ' Z';
    page.drawSvgPath(path, { x: origin.x, y: origin.y, color: BURN_COLOR, opacity });
}

/**
 * Label text on a white plate, positioned like `.measure-label`: 6pt right of
 * the anchor and 10pt above it, with the first baseline inside the padding.
 * Multi-line labels (areas) keep their line breaks.
 */
function drawLabel(page: PDFPage, anchor: Pt, label: string, font: PDFFont): void {
    const lines = label.split('\n').filter((line) => line.length > 0);
    if (lines.length === 0) return;

    const size = MEASURE_STYLE.printLabelFontSize;
    const lineHeight = size * LABEL_LINE_HEIGHT;
    const widths = lines.map((line) => font.widthOfTextAtSize(line, size));
    const boxWidth = Math.max(...widths) + LABEL_PADDING_X * 2;
    const boxHeight = lines.length * lineHeight + LABEL_PADDING_Y * 2;

    const left = anchor.x + MEASURE_STYLE.labelOffsetX;
    const top = anchor.y + MEASURE_STYLE.labelOffsetY;

    page.drawRectangle({
        x: left,
        y: top - boxHeight,
        width: boxWidth,
        height: boxHeight,
        color: rgb(1, 1, 1),
        opacity: LABEL_BACKGROUND_OPACITY,
        borderColor: BURN_COLOR,
        borderOpacity: BURN_OPACITY,
        borderWidth: 0.75,
    });

    lines.forEach((line, index) => {
        page.drawText(line, {
            x: left + LABEL_PADDING_X,
            y: top - LABEL_PADDING_Y - size * LABEL_BASELINE - index * lineHeight,
            size,
            font,
            color: rgb(0, 0, 0),
        });
    });
}

/**
 * Bubble plate, leader and arrowhead for a detail callout.
 *
 * Page user space runs y-up while callout geometry is laid out y-down, so the
 * anchors are negated on the way in, and the plate is drawn with the same
 * translate-then-flip trick as drawPolygon: path coordinates are relative to
 * the plate's top-left corner, in SVG's y-down convention.
 */
function drawCallout(page: PDFPage, tip: Pt, anchor: Pt, lines: string[], font: PDFFont): void {
    if (lines.length === 0) return;

    const metrics: CalloutMetrics = {
        fontSize: MEASURE_STYLE.printCalloutFontSize,
        lineHeight: MEASURE_STYLE.calloutLineHeight,
        paddingX: MEASURE_STYLE.calloutPaddingX,
        paddingY: MEASURE_STYLE.calloutPaddingY,
        measureText: (text: string, size: number) => font.widthOfTextAtSize(text, size),
    };
    const flip = (p: Pt): Pt => ({ x: p.x, y: -p.y });

    const box = bubbleBox(flip(anchor), lines, metrics);
    const start = flip(leaderStart(box, flip(tip)));
    const dir = unitVector(start, tip);
    if (dir) {
        drawSegment(page, start, tip);
        drawArrow(page, tip, dir);
    }

    page.drawSvgPath(roundedRectPath(box.width, box.height, MEASURE_STYLE.calloutRadius), {
        x: box.left,
        y: -box.top,
        color: rgb(1, 1, 1),
        opacity: 0.9,
        borderColor: BURN_COLOR,
        borderWidth: MEASURE_STYLE.calloutBorderWidth,
        borderOpacity: BURN_OPACITY,
    });

    const lineHeight = metrics.fontSize * metrics.lineHeight;
    lines.forEach((line, index) => {
        const width = metrics.measureText(line, metrics.fontSize);
        page.drawText(line, {
            x: box.left + (box.width - width) / 2,
            y: -(box.top + metrics.paddingY + index * lineHeight + metrics.fontSize * LABEL_BASELINE),
            size: metrics.fontSize,
            font,
            color: rgb(0, 0, 0),
        });
    });
}

/** Rounded rectangle in SVG path syntax, authored y-down from its top-left. */
function roundedRectPath(width: number, height: number, radius: number): string {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    if (r === 0) {
        return 'M 0 0 L ' + num(width) + ' 0 L ' + num(width) + ' ' + num(height) + ' L 0 ' + num(height) + ' Z';
    }
    // Control-point offset for a quarter circle, 4/3 * tan(pi/8).
    const c = r * 0.5522847498307936;
    return [
        'M ' + num(r) + ' 0',
        'L ' + num(width - r) + ' 0',
        'C ' + num(width - r + c) + ' 0 ' + num(width) + ' ' + num(r - c) + ' ' + num(width) + ' ' + num(r),
        'L ' + num(width) + ' ' + num(height - r),
        'C ' +
            num(width) +
            ' ' +
            num(height - r + c) +
            ' ' +
            num(width - r + c) +
            ' ' +
            num(height) +
            ' ' +
            num(width - r) +
            ' ' +
            num(height),
        'L ' + num(r) + ' ' + num(height),
        'C ' + num(r - c) + ' ' + num(height) + ' 0 ' + num(height - r + c) + ' 0 ' + num(height - r),
        'L 0 ' + num(r),
        'C 0 ' + num(r - c) + ' ' + num(r - c) + ' 0 ' + num(r) + ' 0',
        'Z',
    ].join(' ');
}

function unitVector(from: Pt, to: Pt): Pt | null {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    if (length < 0.01) return null;
    return { x: dx / length, y: dy / length };
}

function midpoint(a: Pt, b: Pt): Pt {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function centroid(points: Pt[]): Pt {
    let x = 0;
    let y = 0;
    for (const p of points) {
        x += p.x;
        y += p.y;
    }
    return { x: x / points.length, y: y / points.length };
}

function num(value: number): string {
    if (!Number.isFinite(value)) return '0';
    return String(Math.round(value * 1000) / 1000);
}
