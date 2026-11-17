// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { state } from '../state';
import * as dom from '../dom';
import { renderDocHighlights } from '../docx-engine';

describe('DOCX highlight rendering', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="pdfViewer"><div class="docx-wrapper"><div id="page-1"></div></div></div>';
        dom.init();
        state._docPageHtmls = ['<p>placeholder</p>'];
        state.docSearchResults = [];
        state.docCurrentMatchIndex = 0;
        state.smoothScrollEnabled = false;
        Element.prototype.scrollIntoView = () => {};
    });

    it('never turns hostile document text into live markup', () => {
        const page = document.getElementById('page-1');
        page.appendChild(document.createTextNode('<img src=x onerror="window.__xss=1"> tender'));
        state.docSearchResults = [{ text: 'tender', page: 1, index: 0, length: 6 }];

        renderDocHighlights();

        expect(page.querySelector('img')).toBeNull();
        expect(window.__xss).toBeUndefined();
        expect(page.querySelector('mark.doc-highlight')?.textContent).toBe('tender');
        expect(page.textContent).toContain('<img src=x onerror');
    });
});
