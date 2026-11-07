import type { State, SearchResult } from './types';

const _listeners: Record<string, Array<(data?: any) => void>> = {};

/**
 * The keyword-keyed search cache. Null prototype on purpose: keywords are user
 * text, so `__proto__`, `constructor` and `toString` are legitimate keys and a
 * plain `{}` would either shadow the prototype or silently drop the entry.
 */
export function createSearchCache(): Record<string, SearchResult[]> {
    return Object.create(null) as Record<string, SearchResult[]>;
}

export const state: State = {
    pdfDoc: null,
    currentDocUrl: '',
    currentDocType: 'pdf',
    docGeneration: 0,
    searchToken: 0,
    totalPages: 0,
    currentPage: 1,
    currentScale: 1.0,
    isNavigating: false,

    activeKeyword: '',
    searchResults: [],
    searchResultsByPage: {},
    currentMatchIndex: -1,
    searchCache: createSearchCache(),
    searchDeduplicated: false,

    docSearchResults: [],
    docCurrentMatchIndex: -1,
    docOriginalHtml: null,
    docKeywordCounts: {},
    docKeywordResults: [],

    pageHeights: {},
    renderedPages: new Set<number>(),
    renderedScales: {},
    textPageCache: {},
    renderTasks: new Map(),
    pageObserver: null,

    objectUrls: [],
    docTextCache: {},
    docContentCache: {},
    docDataCache: {},
    totalCacheSize: 0,
    MAX_CACHE_SIZE_TOTAL: 500 * 1024 * 1024,
    MAX_CACHE_COUNT_PER_TYPE: 30,

    totalMatchesFound: 0,
    totalDocsFound: 0,
    processed: 0,
    totalFiles: 0,
    basePath: '',
    workerPool: null,

    smoothScrollEnabled: false,
    mobileSidebarOpen: false,
    settingsOpen: false,
    settingsJustToggled: false,
    inlineSearchActive: false,
    inlineSearchQuery: '',
    _settingsPreviousFocus: null,
    touchStartDist: 0,
    touchStartScale: 1.0,

    renderQuality: 'medium',

    customSearchResults: [],
    customSearchIndex: 0,

    globalSearchQuery: '',
    globalSearchResults: {},
    globalSearchActiveDoc: '',
    globalSearchDocResults: [],
    globalSearchDocIndex: 0,
    _gsPos: -1,

    allKeywordMode: false,

    MAX_FILE_SIZE: 500 * 1024 * 1024,
    MAX_DOC_FILE_SIZE: 100 * 1024 * 1024,
    MAX_ZIP_FILE_SIZE: 500 * 1024 * 1024,
    MAX_KEYWORDS_PER_LIST: 500,
    MAX_KEYWORD_LENGTH: 200,
    MAX_TOTAL_FILES: 1000,

    on(event: string, cb: (data?: any) => void): () => void {
        (_listeners[event] ||= []).push(cb);
        return () => this.off(event, cb);
    },

    off(event: string, cb: (data?: any) => void): void {
        const arr = _listeners[event];
        if (arr) {
            const i = arr.indexOf(cb);
            if (i !== -1) arr.splice(i, 1);
        }
    },

    emit(event: string, data?: any): void {
        const arr = _listeners[event];
        if (arr) arr.slice().forEach(cb => cb(data));
    },
};

/** Start a new document generation. Any in-flight async work holding an older
 *  generation number must discard its result. */
export function beginDocGeneration(): number {
    state.docGeneration++;
    return state.docGeneration;
}

/** True while the captured generation is still the active document. */
export function isCurrentGeneration(generation: number): boolean {
    return state.docGeneration === generation;
}

/**
 * Reset everything scoped to the open document: its identity, the viewport
 * scale, the page/text caches and every search index derived from them.
 *
 * This used to be hand-copied into each loader, and the copies had already
 * drifted: the PDF path never cleared `searchResultsByPage`, the DOCX page
 * index or the active keyword, so state left over from the previous document
 * could survive a switch. Runtime handles (`pdfDoc`, observers, render tasks)
 * are released by teardownPdf(), and library-scoped caches and totals by
 * resetLibraryState().
 *
 * Deliberately leaves `docGeneration` and `searchToken` alone: bumping them is
 * what invalidates in-flight work, so resetting them would do the opposite of
 * what this function is for.
 */
export function resetDocumentState(): void {
    state.currentDocUrl = '';
    state.currentDocType = 'pdf';
    state.currentPage = 1;
    state.totalPages = 0;
    state.currentScale = 1.0;

    state.pageHeights = {};
    state.renderedPages.clear();
    state.renderedScales = {};
    state.textPageCache = {};

    state.searchCache = createSearchCache();
    state.searchDeduplicated = false;
    state.searchResults = [];
    state.searchResultsByPage = {};
    state.currentMatchIndex = -1;
    state.activeKeyword = '';
    state.allKeywordMode = false;
    state.inlineSearchActive = false;
    state.inlineSearchQuery = '';

    state.docSearchResults = [];
    state.docCurrentMatchIndex = -1;
    state.docOriginalHtml = null;
    state.docKeywordCounts = {};
    state.docKeywordResults = [];
    state._docPageHtmls = null;
    state._docPageOffsets = null;

    state._gsPageCacheReady = false;
    state.globalSearchActiveDoc = '';
    state.globalSearchDocIndex = 0;
}

/**
 * Drop a document's cached text/content and subtract `_size` exactly once.
 * Deleting an entry without accounting for it leaked the budget, so the app
 * evicted live documents while believing the cache was full; every deletion of
 * a sized entry goes through here so the two cannot drift apart again.
 * Returns true when something was actually removed.
 */
export function dropCachedDocument(url: string): boolean {
    let removed = false;

    const textEntry = state.docTextCache[url];
    if (textEntry) {
        state.totalCacheSize -= textEntry._size || 0;
        delete state.docTextCache[url];
        removed = true;
    }

    const contentEntry = state.docContentCache[url];
    if (contentEntry) {
        state.totalCacheSize -= contentEntry._size || 0;
        delete state.docContentCache[url];
        removed = true;
    }

    return removed;
}

/**
 * Reset every indexed document: the text/content caches, the object URLs, the
 * running totals and the global-search results, then the open document itself.
 * Callers are responsible for revoking object URLs and releasing measurements
 * and OCR state first, while the old document is still identifiable.
 */
export function resetLibraryState(): void {
    state.objectUrls = [];
    state.docTextCache = {};
    state.docContentCache = {};
    state.docDataCache = {};
    state.totalCacheSize = 0;

    state.totalFiles = 0;
    state.processed = 0;
    state.totalMatchesFound = 0;
    state.totalDocsFound = 0;

    state.globalSearchQuery = '';
    state.globalSearchResults = {};
    state.globalSearchDocResults = [];
    state._gsPos = -1;

    resetDocumentState();
}

/** Claim a search request; later requests invalidate earlier ones. */
export function beginSearch(): number {
    state.searchToken++;
    return state.searchToken;
}

/** True while the captured search request is still the newest one. */
export function isCurrentSearch(token: number): boolean {
    return state.searchToken === token;
}
