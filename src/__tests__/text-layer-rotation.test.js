import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDocument } from 'pdfjs-dist/build/pdf.mjs';
import { processTextContent, buildOffsetMap, computeMatchCoords } from '../pdf-search';
import { getTextCoords } from '../search-controller';

const here = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(here, '..', 'style.css'), 'utf8');

/** Build a one-page PDF with the given /Rotate and a single text run. */
function buildPdf(rotate) {
    const objs = [];
    const add = body => { objs.push(body); return objs.length; };

    const content = 'BT /F1 24 Tf 72 700 Td (ROTATED PAGE TEXT) Tj ET';
    const contentObj = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const fontObj = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    const pageObj = objs.length + 1;
    const pagesObj = objs.length + 2;
    add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Rotate ${rotate} /Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentObj} 0 R >>`);
    add(`<< /Type /Pages /Kids [${pageObj} 0 R] /Count 1 >>`);
    const catalogObj = objs.length + 1;
    add(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);

    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    objs.forEach((body, i) => {
        offsets.push(Buffer.byteLength(pdf, 'latin1'));
        pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = Buffer.byteLength(pdf, 'latin1');
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= objs.length; i++) {
        pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    }
    pdf += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogObj} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

async function loadPage(rotate) {
    const doc = await getDocument({ data: buildPdf(rotate), disableWorker: true }).promise;
    return doc.getPage(1);
}

/** Pull the transform declared for a rotation out of the real stylesheet. */
function cssTransformFor(rotation) {
    const re = new RegExp(
        `\\.textLayer\\[data-main-rotation="${rotation}"\\]\\s*\\{[^}]*?transform:\\s*([^;]+);`,
    );
    const match = css.match(re);
    if (!match) return null;
    return match[1].trim();
}

/**
 * Minimal evaluator for the rotate/translate forms used by the stylesheet.
 * Functions apply right-to-left, matching CSS semantics.
 */
function applyCssTransform(value, point, self) {
    const fns = value.match(/[a-zA-Z]+\([^)]*\)/g) || [];
    let [x, y] = point;
    for (const fn of fns.reverse()) {
        const [name, argText] = fn.match(/([a-zA-Z]+)\(([^)]*)\)/).slice(1);
        const args = argText.split(',').map(s => s.trim());
        if (name === 'rotate') {
            const rad = (parseFloat(args[0]) * Math.PI) / 180;
            const c = Math.cos(rad);
            const s = Math.sin(rad);
            [x, y] = [c * x - s * y, s * x + c * y];
        } else if (name === 'translateX') {
            x += percent(args[0], self.width);
        } else if (name === 'translateY') {
            y += percent(args[0], self.height);
        } else if (name === 'translate') {
            x += percent(args[0], self.width);
            y += percent(args[1], self.height);
        }
    }
    return [x, y];
}

function percent(token, basis) {
    if (token.endsWith('%')) return (parseFloat(token) / 100) * basis;
    return parseFloat(token);
}

/** Replicate the matrix pdf.js TextLayer uses to place a run. */
function utilTransform(m1, m2) {
    return [
        m1[0] * m2[0] + m1[2] * m2[1],
        m1[1] * m2[0] + m1[3] * m2[1],
        m1[0] * m2[2] + m1[2] * m2[3],
        m1[1] * m2[2] + m1[3] * m2[3],
        m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
        m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
    ];
}

describe('text layer on rotated pages', () => {
    it('declares a container transform for every non-zero page rotation', () => {
        for (const rotation of [90, 180, 270]) {
            expect(cssTransformFor(rotation), `missing rule for ${rotation}deg`).toBeTruthy();
        }
    });

    it('keeps the layer transform-origin at 0 0 (rotation pivot)', () => {
        const block = css.match(/\.textLayer\s*\{([^}]*)\}/);
        expect(block).toBeTruthy();
        expect(block[1]).toMatch(/transform-origin:\s*0 0/);
    });

    // The text layer is laid out in unrotated page space, then rotated onto the
    // canvas. If these ever disagree again, selection and copy silently land on
    // the wrong glyphs for rotated scans/drawings.
    for (const rotate of [0, 90, 180, 270]) {
        it(`maps every text run onto its canvas position at /Rotate ${rotate}`, async () => {
            const page = await loadPage(rotate);
            const viewport = page.getViewport({ scale: 1 });
            const raw = viewport.rawDims;
            const textContent = await page.getTextContent();
            const item = textContent.items.find(i => i.str);
            expect(item).toBeTruthy();

            // Layer-space origin, exactly as pdf.js TextLayer computes it.
            const self = [1, 0, 0, -1, -raw.pageX, raw.pageY + raw.pageHeight];
            const tx = utilTransform(self, item.transform);
            const layerPoint = [tx[4], tx[5]];

            // Where that glyph is actually painted on the rotated canvas.
            const canvasPoint = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);

            const cssTransform = rotate === 0 ? '' : cssTransformFor(rotate);
            expect(cssTransform, `no stylesheet transform for ${rotate}deg`).not.toBeNull();
            const mapped = applyCssTransform(cssTransform || '', layerPoint, {
                width: raw.pageWidth,
                height: raw.pageHeight,
            });

            expect(mapped[0]).toBeCloseTo(canvasPoint[0], 2);
            expect(mapped[1]).toBeCloseTo(canvasPoint[1], 2);
        });
    }

    it('produces a layer box that lands exactly on the rotated canvas', async () => {
        for (const rotate of [0, 90, 180, 270]) {
            const page = await loadPage(rotate);
            const viewport = page.getViewport({ scale: 1 });
            const raw = viewport.rawDims;

            // Corners of the unrotated layer box.
            const corners = [[0, 0], [raw.pageWidth, 0], [0, raw.pageHeight], [raw.pageWidth, raw.pageHeight]];
            const cssTransform = rotate === 0 ? '' : cssTransformFor(rotate);
            const mapped = corners.map(c => applyCssTransform(cssTransform || '', c, {
                width: raw.pageWidth,
                height: raw.pageHeight,
            }));

            const xs = mapped.map(m => m[0]);
            const ys = mapped.map(m => m[1]);
            const minX = Math.min(...xs), maxX = Math.max(...xs);
            const minY = Math.min(...ys), maxY = Math.max(...ys);

            expect(minX).toBeCloseTo(0, 2);
            expect(minY).toBeCloseTo(0, 2);
            expect(maxX).toBeCloseTo(viewport.width, 2);
            expect(maxY).toBeCloseTo(viewport.height, 2);
        }
    });
});

/**
 * End-to-end: a keyword highlight produced from real extracted text must
 * actually cover the glyphs the canvas paints, on rotated pages as well.
 */
describe('keyword highlights on rotated pages', () => {
    const needle = 'ROTATED';

    for (const rotate of [0, 90, 180, 270]) {
        it(`covers the real glyph run at /Rotate ${rotate}`, async () => {
            const page = await loadPage(rotate);
            const viewport = page.getViewport({ scale: 1 });
            const textContent = await page.getTextContent();
            const processed = processTextContent(textContent);
            const offsetMap = buildOffsetMap(processed.items);

            const start = processed.text.indexOf(needle);
            expect(start).toBeGreaterThanOrEqual(0);

            const box = computeMatchCoords(start, start + needle.length, {
                width: viewport.width,
                height: viewport.height,
                offsetX: viewport.offsetX,
                offsetY: viewport.offsetY,
                transform: viewport.transform,
                rotation: viewport.rotation,
            }, processed.items, offsetMap);

            // The run's real glyph corners, projected the way pdf.js paints them.
            const item = processed.items.find(i => i.text.includes(needle));
            expect(item).toBeTruthy();
            const t = item.transform;
            const startFrac = (start - offsetMap.offsets[processed.items.indexOf(item)]) / item.text.length;
            const endFrac = (start + needle.length - offsetMap.offsets[processed.items.indexOf(item)]) / item.text.length;
            const h = item.height;
            const corners = [
                [t[4] + item.width * startFrac, t[5]],
                [t[4] + item.width * endFrac, t[5]],
                [t[4] + item.width * endFrac, t[5] + h],
                [t[4] + item.width * startFrac, t[5] + h],
            ].map(([x, y]) => viewport.convertToViewportPoint(x, y));

            const gx = corners.map(c => c[0]);
            const gy = corners.map(c => c[1]);
            const minX = Math.min(...gx), maxX = Math.max(...gx);
            const minY = Math.min(...gy), maxY = Math.max(...gy);

            // The highlight box must contain the painted run on both axes.
            expect(box.x).toBeLessThanOrEqual(minX + 0.5);
            expect(box.y).toBeLessThanOrEqual(minY + 0.5);
            expect(box.x + box.width).toBeGreaterThanOrEqual(maxX - 0.5);
            expect(box.y + box.height).toBeGreaterThanOrEqual(maxY - 0.5);
            // And must not be the degenerate 4px sliver.
            expect(box.width).toBeGreaterThan(1);
            expect(box.height).toBeGreaterThan(1);
        });
    }

    it('getTextCoords agrees with the glyph box on a rotated page', async () => {
        const page = await loadPage(90);
        const viewport = page.getViewport({ scale: 1 });
        const textContent = await page.getTextContent();
        const processed = processTextContent(textContent);

        const cached = {
            text: processed.text,
            viewport: {
                width: viewport.width,
                height: viewport.height,
                offsetX: viewport.offsetX,
                offsetY: viewport.offsetY,
                transform: viewport.transform,
                rotation: viewport.rotation,
            },
            items: processed.items,
        };

        const start = processed.text.indexOf(needle);
        const coords = getTextCoords(cached, start, start + needle.length);
        expect(coords).not.toBeNull();

        const item = processed.items.find(i => i.text.includes(needle));
        const baseline = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
        expect(coords.startX).toBeLessThanOrEqual(baseline[0] + 0.5);
        expect(coords.startY).toBeLessThanOrEqual(baseline[1] + 0.5);
        expect(coords.height).toBeGreaterThan(1);
        expect(coords.endX).toBeGreaterThan(coords.startX);
    });
});
