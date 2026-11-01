import { describe, it, expect, afterEach } from 'vitest';
import { state, resetDocumentState, resetLibraryState } from '../state';

// Defaults as declared in state.ts, captured before any test mutates them. A
// field added later shows up here automatically, which is what makes the
// coverage check below able to catch it.
const DEFAULTS = {};
for (const [k, v] of Object.entries(state)) {
    if (typeof v === 'function') continue;
    DEFAULTS[k] = v;
}

// Fields resetDocumentState() deliberately leaves alone, because another owner
// is responsible for them. Anything not listed here must be restored by
// resetDocumentState(); if it is not, the coverage check fails and names it.
const OWNED_ELSEWHERE = new Set([
    // Released by teardownPdf(), which must run first (it needs the document).
    'pdfDoc',
    'pageObserver',
    'renderTasks',
    // Library scope: resetLibraryState().
    'objectUrls',
    'docTextCache',
    'docContentCache',
    'docDataCache',
    'totalCacheSize',
    'totalMatchesFound',
    'totalDocsFound',
    'processed',
    'totalFiles',
    'globalSearchQuery',
    'globalSearchResults',
    'globalSearchDocResults',
    '_gsPos',
    // Generation counters are the invalidation mechanism: resetting them would
    // let stale async work look current.
    'docGeneration',
    'searchToken',
    // Application settings and transient UI chrome, not document state.
    'basePath',
    'workerPool',
    'smoothScrollEnabled',
    'mobileSidebarOpen',
    'settingsOpen',
    'settingsJustToggled',
    '_settingsPreviousFocus',
    'touchStartDist',
    'touchStartScale',
    'renderQuality',
    'isNavigating',
    'customSearchResults',
    'customSearchIndex',
    // Limits.
    'MAX_FILE_SIZE',
    'MAX_DOC_FILE_SIZE',
    'MAX_ZIP_FILE_SIZE',
    'MAX_KEYWORDS_PER_LIST',
    'MAX_KEYWORD_LENGTH',
    'MAX_TOTAL_FILES',
    'MAX_CACHE_SIZE_TOTAL',
    'MAX_CACHE_COUNT_PER_TYPE',
]);

function dirty(value) {
    if (value instanceof Set) return new Set([999]);
    if (value instanceof Map) return new Map([['dirty', true]]);
    if (Array.isArray(value)) return [{ dirty: true }];
    if (typeof value === 'number') return 12345;
    if (typeof value === 'string') return 'DIRTY';
    if (typeof value === 'boolean') return !value;
    if (value === null || typeof value === 'object') return { dirty: true };
    return 'DIRTY';
}

function restoreDefaults() {
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (typeof v === 'function') continue;
        if (v instanceof Set) state[k] = new Set();
        else if (v instanceof Map) state[k] = new Map();
        else if (v && typeof v === 'object') state[k] = structuredClone(v);
        else state[k] = v;
    }
}

function assertDocumentFieldsReset() {
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (typeof v === 'function') continue;
        if (OWNED_ELSEWHERE.has(k)) continue;
        expect(
            state[k],
            `state.${k} is document-scoped but resetDocumentState() left it behind`,
        ).toEqual(v);
    }
}

describe('resetDocumentState', () => {
    afterEach(restoreDefaults);

    it('restores every document-scoped field to its default', () => {
        for (const [k, v] of Object.entries(DEFAULTS)) {
            if (typeof v === 'function' || OWNED_ELSEWHERE.has(k)) continue;
            state[k] = dirty(v);
        }

        resetDocumentState();

        assertDocumentFieldsReset();
    });

    it('reports a document field that nothing resets, so a new one cannot slip through', () => {
        DEFAULTS.__futureDocField = false;
        state.__futureDocField = true;
        try {
            expect(() => assertDocumentFieldsReset()).toThrow(/__futureDocField/);
        } finally {
            delete DEFAULTS.__futureDocField;
            delete state.__futureDocField;
        }
    });

    it('does not whitelist fields that no longer exist', () => {
        for (const k of OWNED_ELSEWHERE) {
            expect(k in DEFAULTS, `${k} is whitelisted but not a state field`).toBe(true);
        }
    });

    it('covers the fields whose absence caused cross-document leakage', () => {
        for (const k of [
            'searchResultsByPage',
            'currentMatchIndex',
            'activeKeyword',
            'allKeywordMode',
            'searchCache',
            'textPageCache',
            'pageHeights',
            'renderedScales',
        ]) {
            expect(OWNED_ELSEWHERE.has(k), `${k} must be reset per document`).toBe(false);
        }
    });

    it('clears the DOCX page index and the global page-cache flag', () => {
        state._docPageHtmls = ['<p>x</p>'];
        state._docPageOffsets = [0];
        state._gsPageCacheReady = true;

        resetDocumentState();

        expect(state._docPageHtmls).toBeNull();
        expect(state._docPageOffsets).toBeNull();
        expect(state._gsPageCacheReady).toBe(false);
    });

    it('leaves the generation counters alone, so in-flight work stays invalidated', () => {
        state.docGeneration = 7;
        state.searchToken = 3;

        resetDocumentState();

        expect(state.docGeneration).toBe(7);
        expect(state.searchToken).toBe(3);
    });

    it('does not touch the library-scoped document caches', () => {
        state.docTextCache = { keep: {} };
        state.docContentCache = { keep: {} };
        state.docDataCache = { keep: {} };
        state.totalCacheSize = 4096;

        resetDocumentState();

        expect(state.docTextCache).toEqual({ keep: {} });
        expect(state.docContentCache).toEqual({ keep: {} });
        expect(state.docDataCache).toEqual({ keep: {} });
        expect(state.totalCacheSize).toBe(4096);
    });
});

describe('resetLibraryState', () => {
    afterEach(restoreDefaults);

    it('clears the document caches, totals, object URLs and global search', () => {
        state.docTextCache = { a: {} };
        state.docContentCache = { b: {} };
        state.docDataCache = { c: {} };
        state.totalCacheSize = 1234;
        state.totalMatchesFound = 9;
        state.totalDocsFound = 8;
        state.processed = 5;
        state.totalFiles = 5;
        state.objectUrls = ['blob:1'];
        state.globalSearchQuery = 'pump';
        state.globalSearchResults = { a: 2 };
        state.globalSearchDocResults = [{ page: 1 }];
        state._gsPos = 4;

        resetLibraryState();

        expect(state.docTextCache).toEqual({});
        expect(state.docContentCache).toEqual({});
        expect(state.docDataCache).toEqual({});
        expect(state.totalCacheSize).toBe(0);
        expect(state.totalMatchesFound).toBe(0);
        expect(state.totalDocsFound).toBe(0);
        expect(state.processed).toBe(0);
        expect(state.totalFiles).toBe(0);
        expect(state.objectUrls).toEqual([]);
        expect(state.globalSearchQuery).toBe('');
        expect(state.globalSearchResults).toEqual({});
        expect(state.globalSearchDocResults).toEqual([]);
        expect(state._gsPos).toBe(-1);
    });

    it('also resets the open document', () => {
        state.currentDocUrl = 'blob:1';
        state.textPageCache = { 1: { text: 'x', viewport: {}, items: [] } };
        state.searchResultsByPage = { 1: [] };

        resetLibraryState();

        expect(state.currentDocUrl).toBe('');
        expect(state.textPageCache).toEqual({});
        expect(state.searchResultsByPage).toEqual({});
    });
});
