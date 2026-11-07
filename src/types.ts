// ── PDF / text types ──

export interface TextItem {
    text: string;
    transform: number[];
    width: number;
    height: number;
}

export interface PageViewport {
    width: number;
    height: number;
    offsetX?: number;
    offsetY?: number;
    /** The scale-1 viewport transform (PDF → viewport space), see pdf-coords.ts */
    transform?: number[];
    rotation?: number;
}

export interface PageCacheEntry {
    text: string;
    viewport: PageViewport;
    items: TextItem[] | null;
    /** @internal */
    _lastAccess?: number;
}

export interface TextContent {
    items: Array<{ str: string; transform: number[]; width: number; height: number }>;
}

// ── Search types ──

export interface SearchResult {
    page: number;
    x: number | null;
    y: number | null;
    width: number | null;
    height: number | null;
    keyword?: string;
    ocr?: boolean;
    /** One box per line fragment when the match wraps; x/y/width/height are
     *  the first fragment, so scrolling and navigation stay unchanged. */
    boxes?: MatchCoords[];
}

export interface SearchResultsByPage {
    [pageNum: number]: Array<{ result: SearchResult; globalIndex: number }>;
}

export interface MatchCoords {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface RawSearchResult {
    page: number;
    startIndex: number;
    endIndex: number;
    text: string;
}

export interface TextCoords {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
    height: number;
    /** One box per line fragment; startX/startY/endX/endY describe the first. */
    boxes?: MatchCoords[];
}

// ── Measure types ──

export interface Point2D {
    x: number;
    y: number;
    page?: number;
}

export interface Measurement {
    id: string;
    type: 'distance' | 'polyline' | 'area';
    points: Point2D[];
    label: string;
    areaMm2?: number;
}

export interface PreviewLine {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

// ── Document cache types ──

export interface PdfCacheEntry {
    totalPages: number;
    pages: PageCacheEntry[];
    fileName: string;
    /** @internal */
    _lastAccess: number;
    /** @internal */
    _size: number;
}

export interface DocxCacheEntry {
    html: string;
    text: string;
    fileName: string;
    type: string;
    lastQuery?: string;
    /** @internal */
    _lastAccess: number;
    /** @internal */
    _size: number;
}

export interface DocDataCacheEntry {
    name: string;
    folder: string;
    fullPath: string;
    counts: Record<string, number>;
    url: string;
    type: string;
    _originalCounts?: Record<string, number>;
    _ocrCounts?: Record<string, number>;
    _ocrTotalMatches?: number;
    /** Identity of the dropped file, so a re-drop of it can be skipped. */
    _dedupeKey?: string;
}

// ── Keyword / list types ──

export interface KeywordList {
    name: string;
    keywords: string[];
}

// ── State type ──

export interface MeasurementsByDoc {
    [docKey: string]: Measurement[];
}

export type RenderQuality = 'quality' | 'medium' | 'fast';

export interface GlobalSearchDocResults {
    [docUrl: string]: SearchResult[];
}

export interface State {
    pdfDoc: any;
    currentDocUrl: string;
    currentDocType: string;
    /** Bumped whenever the active document changes; async work captures it and
     *  discards its result if it no longer matches. */
    docGeneration: number;
    /** Bumped on every new search request so stale results cannot win. */
    searchToken: number;
    totalPages: number;
    currentPage: number;
    currentScale: number;
    isNavigating: boolean;

    activeKeyword: string;
    searchResults: SearchResult[];
    searchResultsByPage: SearchResultsByPage;
    currentMatchIndex: number;
    searchCache: Record<string, SearchResult[]>;
    /** Every keyword has been precomputed for the open document. */
    searchDeduplicated: boolean;

    docSearchResults: SearchResult[];
    docCurrentMatchIndex: number;
    docOriginalHtml: string | null;
    /** DOCX: keyword counts for the open document (used by the grid/select). */
    docKeywordCounts: Record<string, number>;
    /** DOCX: every keyword match in the open document, for cycle-all. */
    docKeywordResults: any[];

    pageHeights: Record<number, number>;
    renderedPages: Set<number>;
    renderedScales: Record<number, number>;
    textPageCache: Record<number, PageCacheEntry>;
    renderTasks: Map<any, any>;
    pageObserver: IntersectionObserver | null;

    objectUrls: string[];
    docTextCache: Record<string, PdfCacheEntry>;
    docContentCache: Record<string, DocxCacheEntry>;
    docDataCache: Record<string, DocDataCacheEntry>;
    totalCacheSize: number;
    MAX_CACHE_SIZE_TOTAL: number;
    MAX_CACHE_COUNT_PER_TYPE: number;

    totalMatchesFound: number;
    totalDocsFound: number;
    processed: number;
    totalFiles: number;
    basePath: string;
    workerPool: any;

    smoothScrollEnabled: boolean;
    mobileSidebarOpen: boolean;
    settingsOpen: boolean;
    settingsJustToggled: boolean;
    touchStartDist: number;
    touchStartScale: number;

    renderQuality: RenderQuality;

    customSearchResults: SearchResult[];
    customSearchIndex: number;

    globalSearchQuery: string;
    globalSearchResults: Record<string, number>;
    globalSearchActiveDoc: string;
    globalSearchDocResults: SearchResult[];
    globalSearchDocIndex: number;
    _gsPos: number;

    allKeywordMode: boolean;
    _gsPageCacheReady?: boolean;
    _docPageHtmls?: string[];
    _docPageOffsets?: number[];
    inlineSearchActive?: boolean;
    inlineSearchQuery?: string;
    _settingsPreviousFocus?: HTMLElement | null;

    MAX_FILE_SIZE: number;
    MAX_DOC_FILE_SIZE: number;
    MAX_ZIP_FILE_SIZE: number;
    MAX_KEYWORDS_PER_LIST: number;
    MAX_KEYWORD_LENGTH: number;
    MAX_TOTAL_FILES: number;

    on(event: string, cb: (data?: any) => void): () => void;
    off(event: string, cb: (data?: any) => void): void;
    emit(event: string, data?: any): void;
}

// ── Module registry types ──

/**
 * The cross-module function registry in `cross.ts`, one entry per `register()`
 * call. Names are listed so a typo in a lookup (`fn.performSerch`) or in a
 * registration is a compile error instead of a silent no-op; the signatures are
 * deliberately loose (the implementations live in modules whose parameters are
 * mostly untyped) and every entry is optional until its module registers it.
 */
export interface AppFunctions {
    // UI shell
    activateGlobalSearch(navigateToLast?: boolean, noScroll?: boolean): void;
    clearAllResults(): void;
    clearSearch(): void;
    closeMobileSidebar(): void;
    closeSearchOverlay(): void;
    cycleGlobalSearch(): void;
    cycleGlobalSearchPrev(): void;
    findNext(): void;
    findPrev(): void;
    goToMatch(index: number): void;
    performGlobalSearch(query: string): void;
    showSearchOverlay(): void;
    toggleSettings(event?: any): void;
    toggleTheme(): void;
    updatePageInfo(): void;
    updateZoomDisplay(): void;
    zoomIn(): void;
    zoomOut(): void;

    // Results tree and sidebar
    beginResultsBatch(): void;
    endResultsBatch(): void;
    finishResultsIfComplete(): void;
    renderCard(fileName: string, counts: any, url: string, file?: any): void;
    renderNoMatchCard(fileName: string, url: string, file?: any): void;
    renderPlaceholderCard(fileName: string, url: string, file?: any): void;
    renderResultsArea(): void;
    updateKeywordGrid(url: string): void;
    updateProgressMainThread(): void;
    updateSidebarBadge(): void;
    updateStats(): void;

    // Results panel
    openResultsPanel(url?: string): void;
    closeResultsPanel(): void;

    // Files
    handleDrop(event: any): Promise<void>;
    extractPdfText(arrayBuffer: any, fileName: string, id?: any, file?: any): Promise<any>;
    extractDocText(arrayBuffer: any, fileName: string, id?: any, file?: any): Promise<any>;
    rescanAllDocuments(): Promise<void>;
    populateKeywordSelect(): void;

    // Document loading
    loadDocument(fileUrl: string, keyword?: string): Promise<any>;
    loadDocxDoc(fileUrl: string, keyword?: string): Promise<any>;

    // PDF rendering
    setupVirtualPages(): Promise<void>;
    teardownPdf(): void;
    isPageRendered(pageNum: number): boolean;
    renderPageNow(pageNum: number, forceScale?: number | null): Promise<void>;
    setZoom(newScale: number, force?: boolean): void;
    startPrerender(): void;
    rebuildTextLayers(): void;
    setRenderQuality(quality: string): void;

    // PDF search and highlights
    precomputeAllSearches(): Promise<void>;
    performSearch(query: string): Promise<void>;
    _performSearch(...args: any[]): any;
    cycleSearch(query: string): void;
    cycleAllKeywords(): void;
    clearHighlights(): void;
    renderAllHighlights(): void;
    renderHighlightsForPage(pageNum: number): void;
    updateCurrentMatch(oldIndex: number, newIndex: number): void;
    repositionHighlights(): void;

    // DOCX
    performDocSearch(query: string): void;
    cycleDocSearch(query: string): void;
    cycleAllDocKeywords(): void;
    goToDocMatch(index: number): void;
    renderDocHighlights(): void;
    clearDocQueryCache(): void;

    // Measurement tools
    activateTool(tool: string): void;
    deactivateTool(): void;
    getActiveTool(): string;
    setScale(value: number): void;
    startCalibration(): void;
    cancelCalibration(): void;
    getIsCalibrating(): boolean;
    renderAllMeasurements(): void;
    refreshAllMeasurements(): void;
    clearMeasurements(): void;

    // OCR
    isOcrEnabled(): boolean;
    toggleOcrGlobal(): void;
    toggleOcrForFile(url: string): void;
    getOcrState(url: string): any;
    getOcrMatchesForKeyword(keyword: string, url: string): any;
    resetOcrState(): void;
}

/** Every entry is optional: a module's functions exist only after it registers. */
export type FnRegistry = { [K in keyof AppFunctions]?: AppFunctions[K] };

export interface WorkerPoolInstance {
    initialized: boolean;
    init(): void;
    runRegexOnPDFCache(pages: PageCacheEntry[], fileName: string, keywords: string[], url: string): Promise<any>;
    runRegexOnText(text: string, fileName: string, keywords: string[], type: string, url: string): Promise<any>;
    runProcessTextContent(items: any[]): Promise<any>;
}

// ── Worker types ──

export interface WorkerMessage {
    task: string;
    data: any;
    id?: number;
}
