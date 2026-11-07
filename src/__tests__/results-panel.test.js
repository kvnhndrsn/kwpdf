// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import * as dom from '../dom';
import { filterResultRows, resultRowWhere, resultsTitle, renderResultsList } from '../results-panel';

function row(extra = {}) {
    return {
        file: 'A.pdf',
        folder: 'proj',
        url: 'blob:a',
        page: 3,
        keyword: 'tender',
        count: 1,
        snippet: 'tender supply',
        ocr: false,
        ...extra,
    };
}

beforeEach(() => {
    document.body.innerHTML = '<div id="resultsPanel"></div><div id="resultsPanelList"></div>';
    dom.init();
});

describe('filterResultRows', () => {
    const rows = [
        row(),
        row({ file: 'B.docx', folder: '', url: 'blob:b', keyword: 'geotextile', snippet: 'geotextile mat' }),
    ];

    it('returns every row for an empty query', () => {
        expect(filterResultRows(rows, '   ')).toBe(rows);
    });

    it('matches on path, keyword and snippet, case-insensitively', () => {
        expect(filterResultRows(rows, 'proj/a').map((r) => r.file)).toEqual(['A.pdf']);
        expect(filterResultRows(rows, 'GEOTEX').map((r) => r.file)).toEqual(['B.docx']);
        expect(filterResultRows(rows, 'supply').map((r) => r.file)).toEqual(['A.pdf']);
    });

    it('returns nothing when the query matches no row', () => {
        expect(filterResultRows(rows, 'zzz')).toEqual([]);
    });
});

describe('resultRowWhere', () => {
    it('shows the path and page', () => {
        expect(resultRowWhere(row())).toBe('proj/A.pdf · p.3');
    });

    it('labels OCR and unattributed rows instead of a page', () => {
        expect(resultRowWhere(row({ page: null, ocr: true }))).toBe('proj/A.pdf · OCR');
        expect(resultRowWhere(row({ page: null }))).toBe('proj/A.pdf · unattributed');
    });

    it('does not invent a folder for root documents', () => {
        expect(resultRowWhere(row({ folder: '' }))).toBe('A.pdf · p.3');
    });
});

describe('resultsTitle', () => {
    it('names the file when the panel is scoped to one document', () => {
        expect(resultsTitle([row(), row({ page: 5 })])).toBe('A.pdf — results');
    });

    it('summarises rows and files for the whole library', () => {
        expect(resultsTitle([row(), row({ url: 'blob:b', file: 'B.docx' })])).toBe('Results (2 rows, 2 files)');
    });

    it('has a fallback for an empty panel', () => {
        expect(resultsTitle([])).toBe('Results');
    });
});

describe('renderResultsList', () => {
    it('renders one focusable row per match', () => {
        renderResultsList([row(), row({ page: 7, keyword: 'pump' })]);

        const buttons = document.querySelectorAll('#resultsPanelList .results-row');
        expect(buttons).toHaveLength(2);
        expect(buttons[0].tagName).toBe('BUTTON');
        expect(buttons[0].querySelector('.results-row-where').textContent).toBe('proj/A.pdf · p.3 · tender ×1');
        expect(buttons[0].querySelector('.results-row-snippet').textContent).toBe('tender supply');
        expect(buttons[1].dataset.url).toBe('blob:a');
    });

    it('marks OCR rows', () => {
        renderResultsList([row({ page: null, ocr: true, count: 4 })]);

        expect(document.querySelector('.results-row-where').textContent).toContain('OCR');
        expect(document.querySelector('.results-row-where').textContent).toContain('×4');
    });

    it('says when there is nothing to show', () => {
        renderResultsList([]);

        expect(document.querySelector('.results-panel-empty').textContent).toBe('No matches yet');
    });

    it('caps the number of rendered rows and says so', () => {
        const many = Array.from({ length: 502 }, (_, i) => row({ page: i + 1 }));
        renderResultsList(many);

        expect(document.querySelectorAll('.results-row')).toHaveLength(500);
        expect(document.querySelector('.results-panel-note').textContent).toContain('first 500 of 502');
    });
});
