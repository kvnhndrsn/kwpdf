// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { state } from '../state';
import * as dom from '../dom';
import {
    renderAllHighlights,
    renderHighlightsForPage,
    updateCurrentMatch,
    repositionHighlights,
    clearHighlights,
} from '../pdf-highlights';

const PAGES = 3;

function setupDom() {
    document.body.innerHTML = '<div id="viewerScroll"><div id="pdfViewer"></div></div>';
    const viewer = document.getElementById('pdfViewer');
    for (let i = 1; i <= PAGES; i++) {
        const page = document.createElement('div');
        page.id = 'page-' + i;
        page.className = 'pdf-page';
        viewer.appendChild(page);
    }
    dom.init();
}

function result(page, x, y = 10, width = 20, height = 5) {
    return { page, x, y, width, height };
}

function setResults(results) {
    state.searchResults = results;
    const byPage = {};
    results.forEach((r, i) => {
        (byPage[r.page] ||= []).push({ result: r, globalIndex: i });
    });
    state.searchResultsByPage = byPage;
}

function marks(page) {
    return Array.from(document.querySelectorAll('#page-' + page + ' .highlight-mark'));
}

describe('highlight overlay (DOM)', () => {
    beforeEach(() => {
        setupDom();
        state.searchResults = [];
        state.searchResultsByPage = {};
        state.currentMatchIndex = 0;
        state.currentScale = 1;
        state.allKeywordMode = false;
    });

    it('creates one mark per visible result, scaled to the current zoom', () => {
        setResults([result(1, 100, 50, 20, 5), result(1, 10, 20, 30, 6)]);
        state.currentScale = 2;

        renderAllHighlights();

        const m = marks(1);
        expect(m).toHaveLength(2);
        expect(m[0].dataset.idx).toBe('0');
        expect(m[0].style.left).toBe('200px');
        expect(m[0].style.top).toBe('100px');
        expect(m[0].style.width).toBe('40px');
        expect(m[0].style.height).toBe('10px');
        expect(m[1].dataset.idx).toBe('1');
        expect(m[1].style.left).toBe('20px');
    });

    it('marks only the active match as current', () => {
        setResults([result(1, 10), result(1, 30)]);
        state.currentMatchIndex = 1;

        renderAllHighlights();

        const m = marks(1);
        expect(m[0].classList.contains('current')).toBe(false);
        expect(m[1].classList.contains('current')).toBe(true);
    });

    it('repositions existing marks instead of recreating them', () => {
        setResults([result(1, 10)]);
        renderAllHighlights();
        const first = marks(1)[0];

        state.currentScale = 3;
        renderAllHighlights();

        const after = marks(1);
        expect(after).toHaveLength(1);
        expect(after[0]).toBe(first);
        expect(after[0].style.left).toBe('30px');
    });

    it('removes marks whose result disappeared and repaints the survivors', () => {
        setResults([result(1, 10), result(1, 30)]);
        renderAllHighlights();
        const [first, second] = marks(1);

        setResults([result(1, 50)]);
        renderAllHighlights();

        const after = marks(1);
        expect(after).toHaveLength(1);
        expect(after[0]).toBe(first);
        expect(after[0].style.left).toBe('50px');
        expect(second.isConnected).toBe(false);
    });

    it('clears marks from a page that no longer has results', () => {
        setResults([result(1, 10), result(2, 10)]);
        renderAllHighlights();
        expect(marks(2)).toHaveLength(1);

        setResults([result(1, 10)]);
        renderAllHighlights();

        expect(marks(1)).toHaveLength(1);
        expect(marks(2)).toHaveLength(0);
    });

    it('rebuilds a page that was re-rendered and wiped its content', () => {
        setResults([result(1, 10)]);

        renderHighlightsForPage(1);
        expect(marks(1)).toHaveLength(1);

        document.getElementById('page-1').innerHTML = '';
        renderHighlightsForPage(1);
        expect(marks(1)).toHaveLength(1);
        expect(marks(1)[0].style.left).toBe('10px');
    });

    it('touches only the requested page', () => {
        setResults([result(1, 10), result(2, 20)]);
        renderAllHighlights();
        const page2Mark = marks(2)[0];

        state.searchResultsByPage[1][0].result.x = 99;
        renderHighlightsForPage(1);

        expect(marks(1)[0].style.left).toBe('99px');
        expect(marks(2)[0]).toBe(page2Mark);
        expect(marks(2)[0].style.left).toBe('20px');
    });

    it('skips OCR-only results that carry no coordinates', () => {
        setResults([{ page: 1, x: null, y: null, width: null, height: null, ocr: true }]);

        renderAllHighlights();

        expect(marks(1)).toHaveLength(0);
    });

    it('moves the current class between matches', () => {
        setResults([result(1, 10), result(1, 30)]);
        renderAllHighlights();

        updateCurrentMatch(0, 1);

        const m = marks(1);
        expect(m[0].classList.contains('current')).toBe(false);
        expect(m[1].classList.contains('current')).toBe(true);
    });

    it('rescales every mark on reposition', () => {
        setResults([result(1, 10, 20)]);
        renderAllHighlights();

        state.currentScale = 3;
        repositionHighlights();

        const m = marks(1)[0];
        expect(m.style.left).toBe('30px');
        expect(m.style.top).toBe('60px');
        expect(m.style.width).toBe('60px');
        expect(m.style.height).toBe('15px');
    });

    it('removes every mark on clear and forgets which pages were decorated', () => {
        setResults([result(1, 10), result(2, 10)]);
        renderAllHighlights();
        expect(document.querySelectorAll('.highlight-mark')).toHaveLength(2);

        clearHighlights();
        expect(document.querySelectorAll('.highlight-mark')).toHaveLength(0);

        // Nothing left to reconcile against: a later pass must not resurrect
        // the pages that were decorated before the clear.
        state.searchResultsByPage = {};
        renderAllHighlights();
        expect(document.querySelectorAll('.highlight-mark')).toHaveLength(0);
    });

    it('paints one mark per line fragment of a wrapped match', () => {
        setResults([{
            page: 1,
            x: 10,
            y: 20,
            width: 20,
            height: 5,
            boxes: [
                { x: 10, y: 20, width: 20, height: 5 },
                { x: 10, y: 40, width: 40, height: 5 },
            ],
        }]);
        state.currentMatchIndex = 0;

        renderAllHighlights();

        const m = marks(1);
        expect(m).toHaveLength(2);
        expect(m[0].style.top).toBe('20px');
        expect(m[1].style.top).toBe('40px');
        expect(m[1].style.width).toBe('40px');
        expect(m.every(el => el.dataset.idx === '0')).toBe(true);
        expect(m.every(el => el.classList.contains('current'))).toBe(true);
    });

    it('moves the current class across every fragment of a wrapped match', () => {
        setResults([
            {
                page: 1,
                x: 10,
                y: 20,
                width: 20,
                height: 5,
                boxes: [
                    { x: 10, y: 20, width: 20, height: 5 },
                    { x: 10, y: 30, width: 20, height: 5 },
                ],
            },
            result(1, 60),
        ]);
        renderAllHighlights();

        updateCurrentMatch(0, 1);

        const m = marks(1);
        const fragments = m.filter(el => el.dataset.idx === '0');
        expect(fragments).toHaveLength(2);
        expect(fragments.every(el => !el.classList.contains('current'))).toBe(true);
        expect(m.filter(el => el.dataset.idx === '1')[0].classList.contains('current')).toBe(true);
    });

    it('keeps each fragment scaled on reposition', () => {
        setResults([{
            page: 1,
            x: 10,
            y: 20,
            width: 20,
            height: 5,
            boxes: [
                { x: 10, y: 20, width: 20, height: 5 },
                { x: 10, y: 30, width: 10, height: 5 },
            ],
        }]);
        renderAllHighlights();

        state.currentScale = 2;
        repositionHighlights();

        const m = marks(1);
        expect(m[0].style.left).toBe('20px');
        expect(m[1].style.top).toBe('60px');
        expect(m[1].style.width).toBe('20px');
    });
});
