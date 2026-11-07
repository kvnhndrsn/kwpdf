// One row per (document, keyword, page) for the results panel.
//
// Pages come from re-running the same keyword regex over the cached page text
// the scanner used, and OCR-only counts (which never enter the page text cache)
// become their own rows with the page left blank.

import { state } from './state';
import type { DocDataCacheEntry, State } from './types';
import { getKeywordRegex, normalizeKeywordMatch } from './keyword-regex';
import { htmlToText } from './html-text';
import { splitHtmlIntoPages } from './docx-engine';

export interface ResultRow {
    file: string;
    folder: string;
    /** Object URL of the document, so a row can be opened from the UI. */
    url: string;
    page: number | null;
    keyword: string;
    count: number;
    snippet: string;
    ocr: boolean;
}

const SNIPPET_CONTEXT = 40;

/** A short window around a match, with whitespace collapsed. */
function snippetAt(text: string, index: number, length: number): string {
    const start = Math.max(0, index - SNIPPET_CONTEXT);
    const end = Math.min(text.length, index + length + SNIPPET_CONTEXT);
    const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
    return (start > 0 ? '...' : '') + body + (end < text.length ? '...' : '');
}

interface PageHit {
    page: number;
    count: number;
    snippet: string;
}

/** Count each keyword's matches per page, keeping the first hit as the snippet. */
export function collectPageHits(pageTexts: string[], keywords: string[]): Map<string, PageHit[]> {
    const hits = new Map<string, PageHit[]>();
    const regex = getKeywordRegex(keywords);
    if (!regex) return hits;

    pageTexts.forEach((text, i) => {
        if (!text) return;
        regex.lastIndex = 0;

        const perKeyword = new Map<string, PageHit>();
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null) {
            const keyword = normalizeKeywordMatch(match, keywords);
            if (!keyword) continue;
            const seen = perKeyword.get(keyword);
            if (seen) {
                seen.count++;
            } else {
                perKeyword.set(keyword, {
                    page: i + 1,
                    count: 1,
                    snippet: snippetAt(text, match.index, match[0].length),
                });
            }
        }

        for (const [keyword, hit] of perKeyword) {
            const list = hits.get(keyword);
            if (list) list.push(hit);
            else hits.set(keyword, [hit]);
        }
    });

    return hits;
}

/** Page text for a cached document, or null when its text has been evicted. */
function pageTextsFor(doc: DocDataCacheEntry, snapshot: State): string[] | null {
    if (doc.type === 'pdf') {
        const cached = snapshot.docTextCache[doc.url];
        if (!cached || !Array.isArray(cached.pages)) return null;
        return cached.pages.map((p) => p.text || '');
    }

    const cached = snapshot.docContentCache[doc.url];
    if (!cached || !cached.html) return null;
    // Same page split the viewer uses, so the numbers match what is on screen.
    return splitHtmlIntoPages(cached.html).map(htmlToText);
}

function compareRows(a: ResultRow, b: ResultRow): number {
    const pathA = (a.folder ? a.folder + '/' : '') + a.file;
    const pathB = (b.folder ? b.folder + '/' : '') + b.file;
    if (pathA !== pathB) return pathA.localeCompare(pathB);
    const pageA = a.page === null ? Infinity : a.page;
    const pageB = b.page === null ? Infinity : b.page;
    if (pageA !== pageB) return pageA - pageB;
    return a.keyword.localeCompare(b.keyword);
}

/**
 * Build the result rows from the current library.
 *
 * `counts` already includes OCR matches; `_ocrCounts` says how many of them came
 * from OCR. Whatever the cached text cannot account for (an evicted text cache,
 * OCR-only pages) is still reported with a blank page so the totals add up to
 * the counts the tree shows.
 */
export function buildResultRows(snapshot: State = state): ResultRow[] {
    const rows: ResultRow[] = [];
    const docs = Object.values(snapshot.docDataCache || {});

    for (const doc of docs) {
        const counts = doc.counts || {};
        const keywords = Object.keys(counts).filter((k) => counts[k] > 0);
        if (keywords.length === 0) continue;

        const pageTexts = pageTextsFor(doc, snapshot);
        const pageHits = pageTexts ? collectPageHits(pageTexts, keywords) : new Map<string, PageHit[]>();

        for (const keyword of keywords) {
            let accounted = 0;

            for (const hit of pageHits.get(keyword) || []) {
                accounted += hit.count;
                rows.push({
                    file: doc.name,
                    folder: doc.folder || '',
                    url: doc.url,
                    page: hit.page,
                    keyword,
                    count: hit.count,
                    snippet: hit.snippet,
                    ocr: false,
                });
            }

            const ocrCount = doc._ocrCounts?.[keyword] || 0;
            if (ocrCount > 0) {
                accounted += ocrCount;
                rows.push({
                    file: doc.name,
                    folder: doc.folder || '',
                    url: doc.url,
                    page: null,
                    keyword,
                    count: ocrCount,
                    snippet: '',
                    ocr: true,
                });
            }

            const unattributed = counts[keyword] - accounted;
            if (unattributed > 0) {
                rows.push({
                    file: doc.name,
                    folder: doc.folder || '',
                    url: doc.url,
                    page: null,
                    keyword,
                    count: unattributed,
                    snippet: '',
                    ocr: false,
                });
            }
        }
    }

    return rows.sort(compareRows);
}
