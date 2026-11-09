import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts, degrees, decodePDFRawStream, PDFRawStream } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/build/pdf.mjs';
import { burnMeasurementsIntoPdf, measuredFileName } from '../measure-burn';
import { calloutShape } from '../callout';

/**
 * Matrices pdf.js's PageViewport produces at scale 1 for the three pages built
 * below, i.e. what `getViewport({ scale: 1 }).transform` holds in the browser.
 * convertToPdfPoint() is Util.applyInverseTransform() of that matrix.
 */
const PLAIN = [1, 0, 0, -1, 0, 300];
const ROTATED_90 = [0, 1, 1, 0, 0, 0];
const CROPPED = [1, 0, 0, -1, -20, 300];

function mapperFrom(matrix) {
    return {
        toUserSpace(x, y) {
            const [a, b, c, d, e, f] = matrix;
            const det = a * d - b * c;
            const ix = x - e;
            const iy = y - f;
            return { x: (d * ix - c * iy) / det, y: (-b * ix + a * iy) / det };
        },
    };
}

async function makeSourcePdf() {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);

    const plain = doc.addPage([200, 300]);
    plain.drawText('original', { x: 10, y: 10, size: 8, font });

    const rotated = doc.addPage([200, 300]);
    rotated.setRotation(degrees(90));

    const cropped = doc.addPage([200, 300]);
    cropped.setCropBox(20, 30, 180, 270);

    return doc.save();
}

/** Decoded content streams of a page, so drawn operators can be read as text. */
function contentOf(doc, index) {
    const contents = doc.getPage(index).node.Contents();
    const entries = contents?.asArray ? contents.asArray() : contents ? [contents] : [];
    return entries
        .map((entry) => {
            const stream = entry instanceof PDFRawStream ? entry : doc.context.lookup(entry);
            return new TextDecoder('latin1').decode(decodePDFRawStream(stream).decode());
        })
        .join('\n');
}

/** pdf-lib writes show-text operands as hex strings. */
function hexOf(text) {
    return Buffer.from(text, 'latin1').toString('hex').toUpperCase();
}

const mappers = {
    1: mapperFrom(PLAIN),
    2: mapperFrom(ROTATED_90),
    3: mapperFrom(CROPPED),
};

function burn(bytes, measurements, getPage = (pageNum) => mappers[pageNum] || null) {
    return burnMeasurementsIntoPdf({ bytes, measurements, getPage });
}

describe('measuredFileName', () => {
    it('adds the suffix once', () => {
        expect(measuredFileName('drawing.pdf')).toBe('drawing-measured.pdf');
        expect(measuredFileName('Drawing.PDF')).toBe('Drawing-measured.pdf');
        expect(measuredFileName('plan-measured.pdf')).toBe('plan-measured.pdf');
        expect(measuredFileName('plan-MEASURED.PDF')).toBe('plan-MEASURED.pdf');
    });

    it('falls back to a usable name', () => {
        expect(measuredFileName('')).toBe('document-measured.pdf');
        expect(measuredFileName(undefined)).toBe('document-measured.pdf');
    });
});

describe('burnMeasurementsIntoPdf', () => {
    it('draws a distance at the mapped position and keeps the original page', async () => {
        const bytes = await makeSourcePdf();
        const result = await burn(bytes, [
            {
                type: 'distance',
                points: [
                    { page: 1, x: 20, y: 30 },
                    { page: 1, x: 120, y: 30 },
                ],
                label: '1.00 m @ 1:100',
            },
        ]);

        expect(result.drawn).toBe(1);
        expect(result.skippedPages).toEqual([]);

        const doc = await PDFDocument.load(result.bytes);
        expect(doc.getPageCount()).toBe(3);

        const content = contentOf(doc, 0);
        // Viewport y runs down from the top, so (20,30) is PDF (20,270).
        expect(content).toContain('20 270 m');
        expect(content).toContain('120 270 l');
        expect(content).toContain(hexOf('1.00 m @ 1:100'));
        // Untouched original content survives the rewrite.
        expect(content).toContain(hexOf('original'));
    });

    it('honours the mapper for a rotated page instead of assuming a y-flip', async () => {
        const bytes = await makeSourcePdf();
        const result = await burn(bytes, [
            {
                type: 'distance',
                points: [
                    { page: 2, x: 0, y: 0 },
                    { page: 2, x: 100, y: 0 },
                ],
                label: 'rotated',
            },
        ]);

        expect(result.drawn).toBe(1);
        const doc = await PDFDocument.load(result.bytes);
        const content = contentOf(doc, 1);
        // A 90-degree page maps viewport (0,0)->(0,0) and (100,0)->(0,100).
        expect(content).toContain('0 0 m');
        expect(content).toContain('0 100 l');
        expect(content).toContain(hexOf('rotated'));
    });

    it('draws at crop-box coordinates when the page has an offset crop box', async () => {
        const bytes = await makeSourcePdf();
        const result = await burn(bytes, [
            {
                type: 'distance',
                points: [
                    { page: 3, x: 0, y: 0 },
                    { page: 3, x: 100, y: 50 },
                ],
                label: 'cropped',
            },
        ]);

        expect(result.drawn).toBe(1);
        const doc = await PDFDocument.load(result.bytes);
        const content = contentOf(doc, 2);
        expect(content).toContain('20 300 m');
        expect(content).toContain('120 250 l');
    });

    it('fills an area, closes its outline and prints both label lines', async () => {
        const bytes = await makeSourcePdf();
        const result = await burn(bytes, [
            {
                type: 'area',
                points: [
                    { page: 1, x: 20, y: 20 },
                    { page: 1, x: 120, y: 20 },
                    { page: 1, x: 120, y: 120 },
                ],
                label: 'Area: 1.00 m\u00B2\nPerim: 4.00 m @ 1:100',
            },
        ]);

        expect(result.drawn).toBe(1);
        const content = contentOf(await PDFDocument.load(result.bytes), 0);
        expect(content).toMatch(/\nh\nf\n/);
        expect(content).toContain(hexOf('Area: 1.00 m\u00B2'));
        expect(content).toContain(hexOf('Perim: 4.00 m @ 1:100'));
    });

    it('draws a callout plate on a leader that leaves its edge', async () => {
        const bytes = await makeSourcePdf();
        const tip = { page: 1, x: 30, y: 40 };
        const anchor = { page: 1, x: 120, y: 140 };
        const result = await burn(bytes, [{ type: 'callout', points: [tip, anchor], text: '150x150 SHS COL' }]);

        expect(result.drawn).toBe(1);
        const content = contentOf(await PDFDocument.load(result.bytes), 0);

        // The note is real text on the page, not a picture of one.
        expect(content).toContain(hexOf('150x150 SHS COL'));

        // Rebuild the plate with the same geometry and the same embedded font.
        // The page is 300pt tall, so viewport y becomes user-space y = 300 - y,
        // and callout.ts then works in its own y-down frame (negated y).
        const probe = await PDFDocument.create();
        const font = await probe.embedFont(StandardFonts.Helvetica);
        const tipUser = { x: tip.x, y: 300 - tip.y };
        const anchorUser = { x: anchor.x, y: 300 - anchor.y };
        const shape = calloutShape(
            { x: anchorUser.x, y: -anchorUser.y },
            { x: tipUser.x, y: -tipUser.y },
            ['150x150 SHS COL'],
            {
                // Printed callouts are drawn at their on-screen size.
                fontSize: 15,
                lineHeight: 1.25,
                paddingX: 8,
                paddingY: 4,
                radius: 6,
                tailHalfBase: 8,
                strokeWidth: 1.5,
                measureText: (text, size) => font.widthOfTextAtSize(text, size),
            },
        );
        expect(shape.tail).not.toBeNull();
        expect(shape.tail.edge).toBe('top');

        // One filled and stroked path with no leader: four rounded corners and
        // the two bowed flanks of the tail, so nothing else is drawn to the tip.
        expect((content.match(/ c\n/g) || []).length).toBe(7);
        // The tail runs all the way to the detail: the apex is the detail.
        expect(shape.tail.apex.x).toBeCloseTo(tipUser.x, 6);
        expect(shape.tail.apex.y).toBeCloseTo(-tipUser.y, 6);
    });

    it('does not burn a callout that never received text', async () => {
        const bytes = await makeSourcePdf();
        const result = await burn(bytes, [
            {
                type: 'callout',
                points: [
                    { page: 1, x: 10, y: 10 },
                    { page: 1, x: 60, y: 60 },
                ],
                text: '   ',
            },
        ]);

        expect(result.drawn).toBe(0);
        expect(result.skippedPages).toEqual([]);
        const content = contentOf(await PDFDocument.load(result.bytes), 0);
        expect(content).not.toContain(' c\n');
    });

    it('skips measurements on pages the document does not have', async () => {
        const bytes = await makeSourcePdf();
        const result = await burn(bytes, [
            {
                type: 'distance',
                points: [
                    { page: 99, x: 0, y: 0 },
                    { page: 99, x: 10, y: 0 },
                ],
                label: 'x',
            },
            {
                type: 'distance',
                points: [
                    { page: 0, x: 0, y: 0 },
                    { page: 0, x: 10, y: 0 },
                ],
                label: 'x',
            },
        ]);

        expect(result.drawn).toBe(0);
        expect(result.skippedPages).toEqual([99, 0]);
    });

    it('skips a page with no mapper and ignores empty measurements', async () => {
        const bytes = await makeSourcePdf();
        const result = await burn(
            bytes,
            [
                {
                    type: 'distance',
                    points: [
                        { page: 2, x: 0, y: 0 },
                        { page: 2, x: 10, y: 0 },
                    ],
                    label: 'x',
                },
                { type: 'distance', points: [], label: 'empty' },
            ],
            () => null,
        );

        expect(result.drawn).toBe(0);
        expect(result.skippedPages).toEqual([2]);
    });

    it('leaves the input bytes untouched', async () => {
        const bytes = await makeSourcePdf();
        const before = bytes.slice();
        await burn(bytes, [
            {
                type: 'polyline',
                points: [
                    { page: 1, x: 10, y: 10 },
                    { page: 1, x: 60, y: 40 },
                    { page: 1, x: 110, y: 10 },
                ],
                label: '3.00 m @ 1:100',
            },
        ]);

        expect(Array.from(bytes)).toEqual(Array.from(before));
    });

    it('produces a PDF whose burned labels another library can read back', async () => {
        const bytes = await makeSourcePdf();
        const result = await burn(bytes, [
            {
                type: 'distance',
                points: [
                    { page: 1, x: 20, y: 30 },
                    { page: 1, x: 120, y: 30 },
                ],
                label: '1.00 m @ 1:100',
            },
            {
                type: 'callout',
                points: [
                    { page: 1, x: 40, y: 80 },
                    { page: 1, x: 150, y: 160 },
                ],
                text: 'SEE DETAIL 3',
            },
        ]);

        // pdf.js is a second, independent reader: if it can extract the label,
        // the content stream is well formed for other viewers too.
        const pdf = await getDocument({ data: result.bytes.slice() }).promise;
        try {
            const page = await pdf.getPage(1);
            const content = await page.getTextContent();
            const text = content.items.map((item) => item.str).join(' ');
            expect(text).toContain('1.00 m @ 1:100');
            expect(text).toContain('SEE DETAIL 3');
            expect(text).toContain('original');
        } finally {
            await pdf.destroy();
        }
    });
});
