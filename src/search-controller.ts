import type { PageCacheEntry, RawSearchResult, TextCoords, DocDataCacheEntry, PdfCacheEntry, DocxCacheEntry } from './types';
import { projectItemBox, boxesOverlap, unionBoxes, type ProjectedBox } from './pdf-coords';

const GS_CHUNK_SIZE = 20;

/** How many distinct queries to remember per page cache. */
const QUERY_CACHE_LIMIT = 12;

// Inline/global search rescans every page of the document on each debounced
// keystroke and again whenever a match is re-navigated. Page text only changes
// when the page cache itself does, which the revision below detects.
const queryResultCache = new WeakMap<object, Map<string, { revision: string; results: RawSearchResult[] }>>();

function cacheRevision(textPageCache: Record<number, PageCacheEntry>, totalPages: number): string {
    let present = 0;
    let chars = 0;
    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
        const cached = textPageCache[pageNum];
        if (!cached) continue;
        present++;
        chars += cached.text.length;
    }
    return totalPages + ':' + present + ':' + chars;
}

export function searchTextPages(
    textPageCache: Record<number, PageCacheEntry>,
    totalPages: number,
    query: string,
): RawSearchResult[] {
    const revision = cacheRevision(textPageCache, totalPages);
    let byQuery = queryResultCache.get(textPageCache as object);
    if (byQuery) {
        const hit = byQuery.get(query);
        // Copy so callers own their array and can never corrupt the cache.
        if (hit && hit.revision === revision) return hit.results.slice();
    }

    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'gi');
    const results: RawSearchResult[] = [];

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
        const cached = textPageCache[pageNum];
        if (!cached) continue;
        const pageText = cached.text;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(pageText)) !== null) {
            results.push({
                page: pageNum,
                startIndex: match.index,
                endIndex: match.index + match[0].length,
                text: match[0],
            });
        }
        regex.lastIndex = 0;
    }

    if (!byQuery) {
        byQuery = new Map();
        queryResultCache.set(textPageCache as object, byQuery);
    } else if (byQuery.size >= QUERY_CACHE_LIMIT) {
        const oldest = byQuery.keys().next();
        if (!oldest.done) byQuery.delete(oldest.value);
    }
    // Store a copy as well, so mutating the array we hand back cannot corrupt
    // the entry a later call would hit.
    byQuery.set(query, { revision, results: results.slice() });

    return results;
}

interface ItemOffsets {
    items: NonNullable<PageCacheEntry['items']>;
    offsets: number[];
}

// Match geometry needs each item's start offset. Items are fixed for the life
// of a cache entry, so walk them once instead of re-walking the whole page from
// index 0 for every match on it.
const itemOffsetsCache = new WeakMap<object, ItemOffsets>();

function getItemOffsets(cached: PageCacheEntry): ItemOffsets | null {
    const items = cached.items;
    if (!items) return null;
    const memo = itemOffsetsCache.get(cached as object);
    if (memo && memo.items === items) return memo;

    const offsets = new Array<number>(items.length);
    let acc = 0;
    for (let i = 0; i < items.length; i++) {
        offsets[i] = acc;
        acc += items[i].text.length;
    }

    const entry: ItemOffsets = { items, offsets };
    itemOffsetsCache.set(cached as object, entry);
    return entry;
}

/** Index of the first item whose character range ends after `index`. */
function findItemAt(offsets: number[], items: ItemOffsets['items'], index: number): number {
    let lo = 0;
    let hi = offsets.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (offsets[mid] + items[mid].text.length > index) hi = mid;
        else lo = mid + 1;
    }
    return lo;
}

export function getTextCoords(
    cached: PageCacheEntry,
    startIndex: number,
    endIndex: number,
): TextCoords | null {
    if (!cached || !cached.items) return null;

    const table = getItemOffsets(cached);
    if (!table) return null;
    const { items, offsets } = table;
    // Everything before this item ends at or before startIndex, so the original
    // walk from index 0 skipped it anyway.
    const first = findItemAt(offsets, items, startIndex);

    const viewport = cached.viewport;
    const transform = viewport && viewport.transform;

    if (transform) {
        // Walk the items once, projecting each run that the range touches.
        let box: ProjectedBox | null = null;
        let found = false;

        for (let i = first; i < items.length; i++) {
            const item = items[i];
            const itemStart = offsets[i];
            const itemEnd = itemStart + item.text.length;

            if (endIndex <= itemStart) break;
            if (startIndex >= itemEnd) continue;

            const from = Math.max(0, (startIndex - itemStart) / item.text.length);
            const to = Math.min(1, (endIndex - itemStart) / item.text.length);
            if (to <= from) continue;

            const itemBox = projectItemBox(item, transform, from, to);
            box = box && boxesOverlap(box, itemBox) ? unionBoxes(box, itemBox) : (box ?? itemBox);
            found = true;
        }

        if (!found || !box) return null;
        return {
            startX: box.x,
            startY: box.y,
            endX: box.x + box.width,
            endY: box.y + box.height,
            height: box.height
        };
    }

    let startY = 0, startX = 0, endY = 0, endX = 0, height = 0;
    let foundStart = false;
    let foundEnd = false;

    for (let i = first; i < items.length; i++) {
        const item = items[i];
        const itemStart = offsets[i];
        const itemEnd = itemStart + item.text.length;

        if (!foundStart && startIndex >= itemStart && startIndex < itemEnd) {
            const frac = (startIndex - itemStart) / item.text.length;
            startX = item.transform[4] + frac * item.width;
            startY = (viewport.height + (viewport.offsetY || 0)) - (item.transform[5] + item.height);
            height = item.height;
            foundStart = true;
        }

        if (endIndex > itemStart && endIndex <= itemEnd) {
            const frac = (endIndex - itemStart) / item.text.length;
            endX = item.transform[4] + frac * item.width;
            endY = (viewport.height + (viewport.offsetY || 0)) - (item.transform[5] + item.height);
            foundEnd = true;
            break;
        }
    }

    if (!foundStart) return null;
    if (!foundEnd) { endX = startX + 50; endY = startY; }

    return { startX, startY, endX, endY, height };
}

export function wrapIndex(index: number, length: number): number {
    if (length === 0) return 0;
    return ((index % length) + length) % length;
}

export interface GlobalCounts {
    results: Record<string, number>;
    totalMatches: number;
    filesWithMatches: number;
}

// Global search re-concatenates every indexed document's full text on each
// keystroke. The joined string only changes when the entry's page array does.
const joinedTextCache = new WeakMap<object, { pages: any[]; text: string }>();

function joinedPageText(entry: PdfCacheEntry): string {
    const pages = entry.pages;
    const memo = joinedTextCache.get(entry as object);
    if (memo && memo.pages === pages) return memo.text;

    let text = '';
    for (const page of pages) {
        text += page.text + ' ';
    }

    joinedTextCache.set(entry as object, { pages, text });
    return text;
}

/**
 * Run the next global-search chunk.
 *
 * requestAnimationFrame is paused while a tab is hidden, so a global search
 * started and then backgrounded used to stop mid-library and only finish once
 * the user came back to the tab. Fall back to a task when the document is not
 * visible; the chunk size keeps that from blocking input.
 */
function scheduleChunk(run: () => void): void {
    if (typeof document !== 'undefined' && document.hidden) {
        setTimeout(run, 0);
        return;
    }
    requestAnimationFrame(run);
}

export function countMatchesInAllDocs(
    docDataCache: Record<string, DocDataCacheEntry>,
    docTextCache: Record<string, PdfCacheEntry>,
    docContentCache: Record<string, DocxCacheEntry>,
    query: string,
    cancelRef: { cancelled: boolean },
): Promise<GlobalCounts | null> {
    return new Promise(resolve => {
        const trimmed = query.trim();
        if (!trimmed) {
            resolve({ results: {}, totalMatches: 0, filesWithMatches: 0 });
            return;
        }

        const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped, 'gi');
        const results: Record<string, number> = {};
        let totalMatches = 0;
        let filesWithMatches = 0;
        const entries = Object.entries(docDataCache);
        let idx = 0;

        function processChunk() {
            if (cancelRef.cancelled) {
                resolve(null);
                return;
            }

            const end = Math.min(idx + GS_CHUNK_SIZE, entries.length);
            for (; idx < end; idx++) {
                const [url, doc] = entries[idx];
                let text = '';

                if ((doc.type === 'docx' || doc.type === 'doc') && docContentCache[url]) {
                    text = docContentCache[url].text || '';
                } else if (doc.type === 'pdf' && docTextCache[url]) {
                    const cached = docTextCache[url];
                    if (cached.pages) {
                        text = joinedPageText(cached);
                    }
                }

                if (text) {
                    regex.lastIndex = 0;
                    let count = 0;
                    let m: RegExpExecArray | null;
                    while ((m = regex.exec(text)) !== null) count++;
                    if (count > 0) {
                        results[url] = count;
                        totalMatches += count;
                        filesWithMatches++;
                    }
                }
            }

            if (idx < entries.length) {
                scheduleChunk(processChunk);
            } else {
                resolve({ results, totalMatches, filesWithMatches });
            }
        }

        scheduleChunk(processChunk);
    });
}
