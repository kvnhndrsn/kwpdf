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
    totalPages: number;
    currentPage: number;
    currentScale: number;
    isNavigating: boolean;

    activeKeyword: string;
    searchResults: SearchResult[];
    searchResultsByPage: SearchResultsByPage;
    currentMatchIndex: number;
    searchCache: Record<string, SearchResult[]>;

    docSearchResults: SearchResult[];
    docCurrentMatchIndex: number;
    docOriginalHtml: string | null;

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
    _verboseRAF: number | null;
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

export type FnRegistry = Record<string, (...args: any[]) => any>;

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
