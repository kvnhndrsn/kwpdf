import { describe, it, expect } from 'vitest';
import fs from 'fs';

// pdf.js 6 removed `PDFDocumentProxy.prototype.destroy()` (PR #21245); the
// loading task owns the worker and document, and every one of these call sites
// used to sit inside a try/catch, so a regression fails *silently* as one leaked
// pdf.js worker per document.
//
// `State.pdfDoc` is typed `any`, so `tsc` cannot catch it either. This static
// check is the gate.

const HERE = new URL('.', import.meta.url);

function read(rel) {
    return fs.readFileSync(new URL('../' + rel, HERE), 'utf8');
}

const PROXY_DESTROY = /\b(pdfDoc|doc|pdf)\.destroy\(\)/;

describe('pdf.js 6 teardown', () => {
    for (const file of ['pdf-renderer.ts', 'pdf-loader.ts', 'file-handler.ts', 'ocr.ts']) {
        it(`${file} destroys through the loading task`, () => {
            const source = read(file);
            expect(source).not.toMatch(PROXY_DESTROY);
            expect(source).toMatch(/loadingTask\.destroy\(\)/);
        });
    }

    it('the burn round-trip test tears down through the loading task too', () => {
        expect(read('__tests__/measure-burn.test.js')).not.toMatch(PROXY_DESTROY);
    });
});
