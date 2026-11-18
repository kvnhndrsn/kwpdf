import type { FnRegistry } from './types';

export const fn: FnRegistry = {};
export let pdfjsLib: any = null;
export let JSZip: any = null;
export let mammoth: any = null;
export let KEYWORDS: string[] = [];
export let KEYWORD_LISTS: Record<string, string[]> = {};
export let DEFAULT_LIST_NAME = 'Central Supply-Only';
// Directory the app was loaded from, so pdf.js can find its CMaps and standard
// font data next to the bundle instead of assuming the site root.
export let basePath = './';

export function register<K extends keyof FnRegistry>(name: K, func: NonNullable<FnRegistry[K]>): void {
    fn[name] = func;
}

export function setPdfjsLib(v: any): void {
    pdfjsLib = v;
}
export function setJSZip(v: any): void {
    JSZip = v;
}
export function setMammoth(v: any): void {
    mammoth = v;
}
export function setKeywords(v: string[]): void {
    KEYWORDS = v;
}

/**
 * Resolves once the keyword list has been loaded (or its load has failed).
 *
 * Anything that scans a document must wait for this. A scan that starts first
 * measures against an empty or stale list, publishes a wrong total, and the user
 * sees the count change under them a moment later. Lives here rather than in
 * keywords.ts so the scan path does not have to import that module.
 */
let markKeywordsReadyFn: () => void = () => {};
const keywordsReadyPromise = new Promise<void>((resolve) => {
    markKeywordsReadyFn = resolve;
});

export function whenKeywordsReady(): Promise<void> {
    return keywordsReadyPromise;
}

export function markKeywordsReady(): void {
    markKeywordsReadyFn();
}
export function setKeywordLists(v: Record<string, string[]>): void {
    KEYWORD_LISTS = v;
}
export function setDefaultListName(v: string): void {
    DEFAULT_LIST_NAME = v;
}
export function setBasePath(v: string): void {
    basePath = v;
}
