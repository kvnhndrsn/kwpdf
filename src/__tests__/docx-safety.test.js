// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { state } from '../state';
import * as dom from '../dom';
import { renderDocHighlights, sanitizeDocHtml } from '../docx-engine';

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

describe('DOCX HTML sanitisation', () => {
    it('removes scripts, event handlers and javascript URLs', () => {
        const clean = sanitizeDocHtml(
            '<p onclick="alert(1)">hi<a href="javascript:alert(1)">link</a>' +
                '<script>alert(1)</script><img src=x onerror="alert(1)"></p>',
        );

        expect(clean).toContain('hi');
        expect(clean).not.toMatch(/onclick|onerror|javascript:|<script/i);
    });

    it('keeps Mammoth-style markup and embedded images', () => {
        const clean = sanitizeDocHtml(
            '<h1>Title</h1><table><tr><td>tender</td></tr></table>' + '<img src="data:image/png;base64,iVBORw0KGgo=">',
        );

        expect(clean).toContain('<h1>Title</h1>');
        expect(clean).toContain('<table>');
        expect(clean).toContain('data:image/png;base64');
    });
});
