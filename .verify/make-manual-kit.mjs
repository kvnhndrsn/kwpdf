// Copies the fixtures needed for the manual Part 0 pass into dist/manual/, so
// the person clicking through it can drop one folder per row instead of hunting
// for files. Run after `node .verify/make-fixtures.mjs` (and after a rebuild,
// since `npm run build` empties dist/).
import fs from 'fs';
import path from 'path';

const src = 'dist/fixtures';
const out = 'dist/manual';

fs.rmSync(out, { recursive: true, force: true });

function copy(from, to) {
    const target = path.join(out, to);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(src, from), target);
}

// 0.14: twenty documents, sixteen small and four long, so a leaked pdf.js
// document or worker has something to leak.
for (let i = 1; i <= 20; i++) {
    const n = String(i).padStart(2, '0');
    copy(i <= 16 ? 'one-kw.pdf' : 'large.pdf', 'heap-batch/doc' + n + '.pdf');
}

// 0.13 / 0.24: two short PDFs that both contain keywords, so OCR has something
// to recognise and a run finishes in well under a minute per file.
copy('one-kw.pdf', 'ocr/a.pdf');
copy('mixed.pdf', 'ocr/b.pdf');

// 0.22: the 50-page DOCX (geotextile on pages 7, 14, ... 49).
copy('waiting.docx', 'docx/waiting.docx');

console.log('manual kit written to', out);
