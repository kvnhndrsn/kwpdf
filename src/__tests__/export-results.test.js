// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { buildResultRows, collectPageHits, escapeCsvField, toCsv, CSV_HEADER } from '../export-results';

function doc(name, folder, url, counts, extra = {}) {
    return { name, folder, fullPath: (folder ? folder + '/' : '') + name, url, type: 'pdf', counts, ...extra };
}

function pdfPages(pages) {
    return {
        totalPages: pages.length,
        pages: pages.map((text) => ({ text })),
        fileName: 'x',
        _lastAccess: 0,
        _size: 0,
    };
}

function snapshot() {
    return {
        docDataCache: {
            'blob:a': doc('A.pdf', 'proj', 'blob:a', { tender: 5 }, { _ocrCounts: { tender: 2 } }),
            'blob:b': doc('B.docx', '', 'blob:b', { heat: 3 }, { type: 'docx' }),
            'blob:c': doc('C.pdf', '', 'blob:c', { tender: 4 }),
            'blob:e': doc('E.pdf', '', 'blob:e', { tender: 10 }),
            'blob:d': doc('D.pdf', '', 'blob:d', {}),
        },
        docTextCache: {
            'blob:a': pdfPages(['tender here', 'nothing', 'tender and tender']),
            'blob:e': pdfPages(['tender']),
        },
        docContentCache: {
            'blob:b': {
                html: '<p>heat bonded</p><hr><p>no heat? heat</p>',
                text: '',
                fileName: 'B.docx',
                type: 'docx',
                _lastAccess: 0,
                _size: 0,
            },
        },
    };
}

const forFile = (rows, name) => rows.filter((r) => r.file === name);

describe('collectPageHits', () => {
    it('counts per page and keeps the first hit as the snippet', () => {
        const hits = collectPageHits(['tender here', 'nothing', 'tender, tender'], ['tender']);

        expect(hits.get('tender')).toEqual([
            { page: 1, count: 1, snippet: 'tender here' },
            { page: 3, count: 2, snippet: 'tender, tender' },
        ]);
    });

    it('files case variants under the keyword spelling', () => {
        const hits = collectPageHits(['Tender and TENDER'], ['tender']);

        expect(hits.get('tender')).toHaveLength(1);
        expect(hits.get('tender')[0].count).toBe(2);
    });
});

describe('buildResultRows', () => {
    it('emits one row per document, keyword and page', () => {
        const rows = buildResultRows(snapshot());

        expect(forFile(rows, 'A.pdf').map((r) => [r.page, r.count, r.ocr])).toEqual([
            [1, 1, false],
            [3, 2, false],
            [null, 2, true],
        ]);
        expect(forFile(rows, 'B.docx').map((r) => [r.page, r.count])).toEqual([
            [1, 1],
            [2, 2],
        ]);
    });

    it('keeps the totals equal to the counts the tree shows', () => {
        const rows = buildResultRows(snapshot());
        const total = (name) => forFile(rows, name).reduce((sum, r) => sum + r.count, 0);

        expect(total('A.pdf')).toBe(5);
        expect(total('B.docx')).toBe(3);
        expect(total('C.pdf')).toBe(4);
        expect(total('E.pdf')).toBe(10);
    });

    it('exports a keyword whose page text has been evicted without a page', () => {
        const rows = forFile(buildResultRows(snapshot()), 'C.pdf');

        expect(rows).toEqual([
            { file: 'C.pdf', folder: '', page: null, keyword: 'tender', count: 4, snippet: '', ocr: false },
        ]);
    });

    it('exports what the cached text cannot account for as a blank-page row', () => {
        const rows = forFile(buildResultRows(snapshot()), 'E.pdf');

        expect(rows.map((r) => [r.page, r.count])).toEqual([
            [1, 1],
            [null, 9],
        ]);
    });

    it('flags OCR rows and never emits a negative remainder', () => {
        const rows = forFile(buildResultRows(snapshot()), 'A.pdf');

        expect(rows.filter((r) => r.ocr)).toHaveLength(1);
        expect(rows.find((r) => r.ocr).page).toBe(null);
        expect(rows.every((r) => r.count > 0)).toBe(true);
    });

    it('skips documents without matches and sorts by path, page and keyword', () => {
        const rows = buildResultRows(snapshot());
        const paths = rows.map((r) => (r.folder ? r.folder + '/' : '') + r.file);

        expect(rows.some((r) => r.file === 'D.pdf')).toBe(false);
        expect([...paths].sort((a, b) => a.localeCompare(b))).toEqual(paths);
    });
});

describe('escapeCsvField', () => {
    it('leaves simple values alone', () => {
        expect(escapeCsvField('report.pdf')).toBe('report.pdf');
        expect(escapeCsvField(12)).toBe('12');
        expect(escapeCsvField(null)).toBe('');
    });

    it('quotes commas, quotes and newlines', () => {
        expect(escapeCsvField('a,b')).toBe('"a,b"');
        expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
        expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
        expect(escapeCsvField('crlf\r\nhere')).toBe('"crlf\r\nhere"');
    });

    it('quotes leading and trailing whitespace so it survives a round trip', () => {
        expect(escapeCsvField(' padded ')).toBe('" padded "');
    });
});

describe('toCsv', () => {
    it('writes the header, one line per row and CRLF endings', () => {
        const csv = toCsv([
            {
                file: 'a,b.pdf',
                folder: 'x',
                page: 2,
                keyword: 'say "hi"',
                count: 1,
                snippet: 'line1\nline2',
                ocr: true,
            },
            { file: 'c.pdf', folder: '', page: null, keyword: 'heat', count: 3, snippet: '', ocr: false },
        ]);
        const lines = csv.split('\r\n');

        expect(lines[0]).toBe(CSV_HEADER.join(','));
        expect(lines[1]).toBe('"a,b.pdf",x,2,"say ""hi""",1,"line1\nline2",yes');
        expect(lines[2]).toBe('c.pdf,,,heat,3,,');
        expect(csv.endsWith('\r\n')).toBe(true);
    });
});
