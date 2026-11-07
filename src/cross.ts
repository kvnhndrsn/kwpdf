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

export function register(name: string, func: (...args: any[]) => any): void {
    fn[name] = func;
}

export function setPdfjsLib(v: any): void { pdfjsLib = v; }
export function setJSZip(v: any): void { JSZip = v; }
export function setMammoth(v: any): void { mammoth = v; }
export function setKeywords(v: string[]): void { KEYWORDS = v; }
export function setKeywordLists(v: Record<string, string[]>): void { KEYWORD_LISTS = v; }
export function setDefaultListName(v: string): void { DEFAULT_LIST_NAME = v; }
export function setBasePath(v: string): void { basePath = v; }
