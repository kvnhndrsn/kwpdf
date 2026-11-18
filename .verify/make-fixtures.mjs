// Generates the browser fixtures listed in REMAINING-WORK.md so the renderer,
// DOCX engine and search paths can be exercised in a real browser.
// Output goes to dist/fixtures (dist/ is gitignored and rebuilt by build.js).
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import JSZip from 'jszip';

const out = path.resolve('dist/fixtures');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/**
 * pages: [{ lines: [{ text, x, y, size }], rotate?: number }]
 */
function buildPdf(pages) {
    const objs = [];
    const pageObjNums = [];
    const firstPageObj = 4; // 1 catalog, 2 pages, 3 font
    pages.forEach((_, i) => pageObjNums.push(firstPageObj + i * 2));

    // Image XObjects are numbered after every page/content pair, so page
    // numbers stay fixed while a page can still reference its own images.
    let imageCursor = firstPageObj + pages.length * 2;
    const pageImages = pages.map((page) => (page.images || []).map((img) => ({ ...img, num: imageCursor++ })));

    objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objs[2] = `<< /Type /Pages /Kids [${pageObjNums.map((n) => n + ' 0 R').join(' ')}] /Count ${pages.length} >>`;
    objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

    pages.forEach((page, i) => {
        const pageNum = firstPageObj + i * 2;
        const contentNum = pageNum + 1;
        const rotate = page.rotate ? ` /Rotate ${page.rotate}` : '';
        const userUnit = page.userUnit ? ` /UserUnit ${page.userUnit}` : '';
        const images = pageImages[i];
        const xobjects = images.length
            ? ` /XObject << ${images.map((img) => `/${img.name} ${img.num} 0 R`).join(' ')} >>`
            : '';
        objs[pageNum] =
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]${rotate}${userUnit} /Resources << /Font << /F1 3 0 R >>${xobjects} >> /Contents ${contentNum} 0 R >>`;

        let stream = page.stream || '';
        for (const line of page.lines || []) {
            const size = line.size || 12;
            stream += `BT /F1 ${size} Tf 1 0 0 1 ${line.x ?? 72} ${line.y} Tm (${esc(line.text)}) Tj ET\n`;
        }
        objs[contentNum] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`;

        for (const img of images) {
            objs[img.num] =
                `<< ${img.dict} /Length ${img.data.length} >>\nstream\n${img.data.toString('latin1')}endstream`;
        }
    });

    let body = '%PDF-1.4\n';
    const offsets = [];
    for (let n = 1; n < objs.length; n++) {
        if (!objs[n]) continue;
        offsets[n] = Buffer.byteLength(body, 'latin1');
        body += `${n} 0 obj\n${objs[n]}\nendobj\n`;
    }
    const xrefStart = Buffer.byteLength(body, 'latin1');
    const count = objs.length; // objects 0..count-1
    let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
    for (let n = 1; n < count; n++) {
        xref +=
            offsets[n] !== undefined ? String(offsets[n]).padStart(10, '0') + ' 00000 n \n' : '0000000000 65535 f \n';
    }
    const trailer = `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
    return Buffer.from(body + xref + trailer, 'latin1');
}

function page(lines, rotate) {
    return { lines, rotate };
}

// ── one-kw.pdf: 3 pages, deterministic keyword hits ──
fs.writeFileSync(
    path.join(out, 'one-kw.pdf'),
    buildPdf([
        page([
            { text: 'Tender 2026 - Geotextile supply schedule', y: 740, size: 16 },
            { text: 'Item 1: nonwoven geotextile separator layer', y: 700 },
            { text: 'Item 2: textile filter fabric', y: 680 },
            { text: 'Item 3: plain wording only', y: 660 },
        ]),
        page([
            { text: 'Page two repeats geotextile once.', y: 740 },
            { text: 'And a second line with textile again.', y: 720 },
        ]),
        page([{ text: 'Page three has no keyword at all.', y: 740 }]),
    ]),
);

// ── mixed.pdf: text for the keyword edge cases (short, numeric, markup) ──
fs.writeFileSync(
    path.join(out, 'mixed.pdf'),
    buildPdf([
        page([
            { text: 'Geotextile separator layer for the works.', y: 740 },
            { text: 'Textile filter fabric supplied under TE-8.', y: 720 },
            { text: 'x<b>geotextile marker for the grid escaping check.', y: 700 },
            { text: 'geo"textile variant spelling appears too.', y: 680 },
            { text: 'AI review and QC check required.', y: 660 },
            { text: 'Budget 4500 units and R&D allowance.', y: 640 },
        ]),
    ]),
);

// ── wrap.pdf: the keyword is split by a line break ──
fs.writeFileSync(
    path.join(out, 'wrap.pdf'),
    buildPdf([
        page([
            { text: 'The membrane shall be heat', y: 740 },
            { text: 'bonded to the substrate.', y: 720 },
            { text: 'Unrelated trailing sentence.', y: 700 },
        ]),
    ]),
);

// ── rotated.pdf: /Rotate 90 with multi-line text ──
fs.writeFileSync(
    path.join(out, 'rotated.pdf'),
    buildPdf([
        page(
            [
                { text: 'Rotated page geotextile first line', y: 740 },
                { text: 'second line textile here', y: 720 },
            ],
            90,
        ),
    ]),
);

// ── Image fixtures: the decoders that moved to WebAssembly in pdf.js 6 ──
// A wrong wasmUrl, a missing ICC profile or a lost codec shows up as a blank
// or miscoloured page rather than as an error, so each one is checked by pixel
// in e2e/render-fidelity.spec.js.

/** A page whose whole content is one image XObject across a fixed rectangle. */
function imagePage(dict, data, rect) {
    return {
        images: [{ name: 'Im1', dict, data }],
        stream: `q ${rect.w} 0 0 ${rect.h} ${rect.x} ${rect.y} cm /Im1 Do Q\n`,
    };
}

// cmyk.pdf: three bands — k=255, no ink, c=255 — so CMYK→RGB is checked at both
// ends of its range and once in the middle of the colour wheel.
const CMYK_W = 30;
const CMYK_H = 10;
const cmyk = Buffer.alloc(CMYK_W * CMYK_H * 4);
for (let y = 0; y < CMYK_H; y++) {
    for (let x = 0; x < CMYK_W; x++) {
        const band = Math.floor(x / 10);
        const ink = band === 0 ? [0, 0, 0, 255] : band === 1 ? [0, 0, 0, 0] : [255, 0, 0, 0];
        cmyk.set(ink, (y * CMYK_W + x) * 4);
    }
}
fs.writeFileSync(
    path.join(out, 'cmyk.pdf'),
    buildPdf([
        imagePage(
            `/Type /XObject /Subtype /Image /Width ${CMYK_W} /Height ${CMYK_H} /ColorSpace /DeviceCMYK /BitsPerComponent 8 /Filter /FlateDecode`,
            zlib.deflateSync(cmyk),
            { x: 126, y: 350, w: 360, h: 180 },
        ),
    ]),
);

// jpx.pdf: a 32×32 JPEG 2000 image, left half red, right half green. The stream
// is embedded as base64 rather than encoded here: Node has no JPEG 2000 encoder
// and the fixture has to be byte-identical everywhere. The blob was produced
// once with OpenJPEG (2.5.4, via Pillow) and is committed as text.
const JPX_IMAGE = Buffer.from(
    'AAAADGpQICANCocKAAAAFGZ0eXBqcDIgAAAAAGpwMiAAAAAtanAyaAAAABZpaGRyAAAAIAAAACAAAwcHAAAAAAAPY29scgEAAAAAABAAAAFIanAyY/9P/1EALwAAAAAAIAAAACAAAAAAAAAAAAAAACAAAAAgAAAAAAAAAAAAAwcBAQcBAQcBAf9SAAwAAAABAAUEBAAB/1wAE0BASEhQSEhQSEhQSEhQSEhQ/2QAJQABQ3JlYXRlZCBieSBPcGVuSlBFRyB2ZXJzaW9uIDIuNS40/5AACgAAAAAAwQAB/5PH1AIBz7QIBr/PtAgIN8/ADAX/f8/ACASvwfOCAAcvx9oKAAFbWrjTx9oMAAjxJtVZP8D5AYABbAfH2hAAF9ehcrHlW1PH2hIAFyxzf54q12V/wPkDABfYdXUtP8faFgAiGgntiC0BOgMiW8faGgAhbgzDzFXZIkfbI12XwPkDACIaCaBfn8faGAA2nkGrWyqYSEnt3GDH2hoANfI/436umD0HhYKEH8D5BAA2nkHi1AzYP//Z',
    'base64',
);
fs.writeFileSync(
    path.join(out, 'jpx.pdf'),
    buildPdf([
        imagePage(
            '/Type /XObject /Subtype /Image /Width 32 /Height 32 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /JPXDecode',
            JPX_IMAGE,
            { x: 146, y: 300, w: 320, h: 320 },
        ),
    ]),
);

// ── userunit.pdf: /UserUnit 2 doubles the page in device space ──
// At 100% zoom the page must measure 1224×1584 CSS px; a viewer that ignores
// UserUnit shows 612×792 at the same zoom with identical proportions, which is
// why the check is on absolute size rather than on layout.
fs.writeFileSync(
    path.join(out, 'userunit.pdf'),
    buildPdf([
        {
            userUnit: 2,
            lines: [
                { text: 'Scaled page geotextile heading', x: 72, y: 740, size: 24 },
                { text: 'second line textile here', x: 72, y: 700, size: 24 },
            ],
        },
    ]),
);

// ── large.pdf: 120 pages, keyword on 40 of them ──
const largePages = [];
for (let p = 1; p <= 120; p++) {
    const lines = [{ text: `Page ${p} of the specification.`, y: 740 }];
    if (p % 3 === 0) lines.push({ text: 'This page cites geotextile requirements.', y: 720 });
    largePages.push(page(lines));
}
fs.writeFileSync(path.join(out, 'large.pdf'), buildPdf(largePages));

// ── vector-heavy.pdf: dense drawings, for rasterisation timing ──
// large.pdf is 120 pages of Helvetica text: it measures indexing and nothing
// else. This one has thousands of path operators per page, which is what makes
// `page.render()` (and therefore Phases 0, 2 and 3) measurable at all.
const VECTOR_PAGES = 60;
const PATHS_PER_PAGE = 2500;
const vectorPages = [];
for (let p = 1; p <= VECTOR_PAGES; p++) {
    let s = '0.5 w 1 0 0 RG\n';
    for (let i = 0; i < PATHS_PER_PAGE; i++) {
        const x = 20 + ((i * 37) % 560);
        const y = 20 + ((i * 53) % 740);
        // A stroked segment plus, every so often, a filled shape and a curve,
        // so the renderer sees a realistic mix rather than one operator.
        s += `${x} ${y} m ${x + 18} ${y + 12} l S\n`;
        if (i % 7 === 0) s += `${x} ${y} 10 10 re f\n`;
        if (i % 11 === 0) s += `${x} ${y} m ${x + 9} ${y + 21} ${x + 22} ${y + 5} ${x + 30} ${y + 18} c S\n`;
    }
    s += `BT /F1 9 Tf 1 0 0 1 72 758 Tm (DETAIL SHEET ${p} - geotextile layer) Tj ET\n`;
    vectorPages.push({ stream: s });
}
fs.writeFileSync(path.join(out, 'vector-heavy.pdf'), buildPdf(vectorPages));

// ── bad.pdf: truncated PDF ──
const good = buildPdf([page([{ text: 'This file will be truncated.', y: 740 }])]);
fs.writeFileSync(path.join(out, 'bad.pdf'), good.subarray(0, Math.floor(good.length * 0.6)));

// ── DOCX helpers ──
const DOCX_CT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const DOCX_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

function paragraph(text) {
    return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}
async function writeDocx(file, paragraphs) {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', DOCX_CT);
    zip.file('_rels/.rels', DOCX_RELS);
    zip.file(
        'word/document.xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.join('')}</w:body></w:document>`,
    );
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    fs.writeFileSync(path.join(out, file), buf);
}

// Mammoth drops <w:br w:type="page"/>, so the DOCX fixture relies on the
// engine's own pagination: splitByBlockElements() gives a block that alone
// exceeds the 3,000-character target its own page. One ~2,000-character
// paragraph therefore equals one page, deterministically.
const filler = (n) => Array.from({ length: n }, (_, i) => `clause ${i + 1}`).join(' ');
// Returns paragraph *text*; wrapping it in paragraph() here would nest <w:p>
// inside <w:p>, which makes mammoth's w:t node contain an element child.
function fillerText(label) {
    const body = `Section ${label}. ` + filler(120) + '. ';
    return body.padEnd(1900, 'x');
}

// ── repeated-3.docx: "tender" three times on page 1, one late hit per later page ──
const repeated = [paragraph('Tender page one: tender appears three times here, tender. ' + 'y'.repeat(1500))];
for (let p = 2; p <= 11; p++) {
    repeated.push(paragraph(fillerText(p) + ` ends with tender.`));
}
await writeDocx('repeated-3.docx', repeated);

// ── waiting.docx: 50 pages for import timing ──
const waiting = [];
for (let p = 1; p <= 50; p++) {
    waiting.push(paragraph(fillerText(p) + (p % 7 === 0 ? ' geotextile.' : '')));
}
await writeDocx('waiting.docx', waiting);

// ── two-folders: duplicate basenames in different folders ──
fs.mkdirSync(path.join(out, 'two-folders/A'), { recursive: true });
fs.mkdirSync(path.join(out, 'two-folders/B'), { recursive: true });
fs.writeFileSync(
    path.join(out, 'two-folders/A/drawing.pdf'),
    buildPdf([page([{ text: 'Drawing A with geotextile.', y: 740 }])]),
);
fs.writeFileSync(
    path.join(out, 'two-folders/B/drawing.pdf'),
    buildPdf([page([{ text: 'Drawing B with textile.', y: 740 }])]),
);

// ── folder with an HTML-ish name ──
fs.mkdirSync(path.join(out, 'html-folder/<b>x</b>'), { recursive: true });
fs.writeFileSync(
    path.join(out, 'html-folder/<b>x</b>/plain.pdf'),
    buildPdf([page([{ text: 'Inside a folder named with markup.', y: 740 }])]),
);

console.log('fixtures written to', out);
