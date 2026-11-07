// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { state } from '../state';
import * as dom from '../dom';
import { fn } from '../cross';
import { renderResultsArea, setCallbacks } from '../rendering';

let loadDocument;
let closeMobileSidebar;

beforeEach(() => {
    document.body.innerHTML = '<div id="results"></div>';
    dom.init();

    for (const url of Object.keys(state.docDataCache)) delete state.docDataCache[url];
    state.currentDocUrl = null;

    loadDocument = vi.fn();
    closeMobileSidebar = vi.fn();
    setCallbacks({
        loadDocument,
        cycleSearch: vi.fn(),
        cycleDocSearch: vi.fn(),
        cycleAllKeywords: vi.fn(),
        cycleAllDocKeywords: vi.fn(),
        closeMobileSidebar,
    });

    fn.getOcrState = () => null;

    state.docDataCache['blob:a'] = {
        name: 'A.pdf',
        folder: 'proj/sub',
        fullPath: 'proj/sub/A.pdf',
        counts: { tender: 3 },
        url: 'blob:a',
        type: 'pdf',
    };
    state.docDataCache['blob:b'] = {
        name: 'B.docx',
        folder: 'proj',
        fullPath: 'proj/B.docx',
        counts: {},
        url: 'blob:b',
        type: 'docx',
    };

    renderResultsArea();
});

const key = (el, keyName) =>
    el.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true }));

describe('results tree keyboard access', () => {
    it('makes file rows focusable buttons', () => {
        const row = document.querySelector('.tree-file-item .file');

        expect(row.getAttribute('role')).toBe('button');
        expect(row.tabIndex).toBe(0);
        expect(row.textContent).toContain('A.pdf');
    });

    it('activates a file row with Enter', () => {
        const row = document.querySelector('.tree-file-item .file');

        key(row, 'Enter');

        expect(loadDocument).toHaveBeenCalledWith('blob:a');
        expect(closeMobileSidebar).toHaveBeenCalled();
    });

    it('activates a file row with Space', () => {
        const row = document.querySelector('.tree-file-item .file');

        key(row, ' ');

        expect(loadDocument).toHaveBeenCalledWith('blob:a');
    });

    it('exposes folders as expandable buttons', () => {
        const folder = document.querySelector('.folder');

        expect(folder.getAttribute('role')).toBe('button');
        expect(folder.tabIndex).toBe(0);
        expect(folder.getAttribute('aria-label')).toBe('proj');
        expect(folder.getAttribute('aria-expanded')).toBe('true');
        expect(folder.classList.contains('open')).toBe(true);
        expect(folder.nextElementSibling.classList.contains('expanded')).toBe(true);
    });

    it('collapses and expands a folder from the keyboard', () => {
        const folder = document.querySelector('.folder');
        const nested = folder.nextElementSibling;

        key(folder, 'Enter');

        expect(folder.classList.contains('open')).toBe(false);
        expect(folder.getAttribute('aria-expanded')).toBe('false');
        expect(nested.classList.contains('expanded')).toBe(false);

        key(folder, ' ');

        expect(folder.classList.contains('open')).toBe(true);
        expect(folder.getAttribute('aria-expanded')).toBe('true');
        expect(nested.classList.contains('expanded')).toBe(true);
    });

    it('keeps the match count spans out of the tab order', () => {
        const count = document.querySelector('.tree-count');

        expect(count.getAttribute('role')).toBe(null);
        expect(count.tabIndex).toBe(-1);
        expect(count.textContent).toBe('3');
    });
});
