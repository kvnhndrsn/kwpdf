import type { State } from './types';

const _listeners: Record<string, Array<(data?: any) => void>> = {};

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
    searchCache: {},

    docSearchResults: [],
    docCurrentMatchIndex: -1,
    docOriginalHtml: null,

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
    _verboseRAF: null,

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

/** Claim a search request; later requests invalidate earlier ones. */
export function beginSearch(): number {
    state.searchToken++;
    return state.searchToken;
}

/** True while the captured search request is still the newest one. */
export function isCurrentSearch(token: number): boolean {
    return state.searchToken === token;
}
