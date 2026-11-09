// Burns a single callout and prints the text operators of the saved page, so
// the printed note size can be checked without opening a viewer.
import { build } from 'esbuild';
import fs from 'fs';
import { PDFDocument, StandardFonts, decodePDFRawStream, PDFRawStream } from 'pdf-lib';

const out = await build({
    entryPoints: ['src/measure-burn.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'warning',
});
fs.writeFileSync('.verify/measure-burn.bundle.mjs', out.outputFiles[0].text);
const { burnMeasurementsIntoPdf } = await import('./measure-burn.bundle.mjs');

const PAGE_H = 400;
const doc = await PDFDocument.create();
const page = doc.addPage([300, PAGE_H]);
const font = await doc.embedFont(StandardFonts.Helvetica);
page.drawText('original', { x: 10, y: 10, size: 8, font });
const bytes = await doc.save();

const result = await burnMeasurementsIntoPdf({
    bytes,
    measurements: [
        {
            type: 'callout',
            points: [
                { page: 1, x: 40, y: 60 },
                { page: 1, x: 150, y: 190 },
            ],
            text: 'PILE CAP',
        },
    ],
    getPage: async () => ({ toUserSpace: (x, y) => ({ x, y: PAGE_H - y }) }),
});

const burned = await PDFDocument.load(result.bytes);
const contents = burned.getPage(0).node.Contents();
const entries = contents?.asArray ? contents.asArray() : contents ? [contents] : [];
const text = entries
    .map((entry) => {
        const stream = entry instanceof PDFRawStream ? entry : burned.context.lookup(entry);
        return new TextDecoder('latin1').decode(decodePDFRawStream(stream).decode());
    })
    .join('\n');

console.log('drawn:', result.drawn);
console.log('size ops:', text.split('\n').filter((line) => line.includes('Tf')).join(' | ') || '(none)');
console.log('fill ops:', text.split('\n').filter((line) => line.includes(' gs') || line.includes(' ca ')).slice(0, 4).join(' | ') || '(none)');

// The bundle is scratch: leaving it behind only gives eslint a generated file
// full of pdf-lib code to complain about.
fs.rmSync('.verify/measure-burn.bundle.mjs', { force: true });
