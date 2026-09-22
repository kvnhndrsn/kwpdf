import type { PageCacheEntry, RawSearchResult, TextCoords, DocDataCacheEntry, PdfCacheEntry, DocxCacheEntry } from './types';
import { projectItem } from './pdf-coords';

const GS_CHUNK_SIZE = 20;

export function searchTextPages(
    textPageCache: Record<number, PageCacheEntry>,
    totalPages: number,
    query: string,
): RawSearchResult[] {
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

    return results;
}

export function getTextCoords(
    cached: PageCacheEntry,
    startIndex: number,
    endIndex: number,
): TextCoords | null {
    if (!cached || !cached.items) return null;

    const viewport = cached.viewport;
    const transform = viewport && viewport.transform;
    let startY = 0, startX = 0, endY = 0, endX = 0, height = 0;
    let charOffset = 0;

    for (const item of cached.items) {
        const itemStart = charOffset;
        const itemEnd = charOffset + item.text.length;

        if (startIndex >= itemStart && startIndex < itemEnd) {
            const frac = (startIndex - itemStart) / item.text.length;
            if (transform) {
                const p = projectItem(item, transform);
                startX = p.x + frac * item.width * p.dx;
                startY = p.top;
            } else {
                startX = item.transform[4] + frac * item.width;
                startY = (viewport.height + (viewport.offsetY || 0)) - (item.transform[5] + item.height);
            }
            height = item.height;
        }

        if (endIndex > itemStart && endIndex <= itemEnd) {
            const frac = (endIndex - itemStart) / item.text.length;
            if (transform) {
                const p = projectItem(item, transform);
                endX = p.x + frac * item.width * p.dx;
                endY = p.top;
            } else {
                endX = item.transform[4] + frac * item.width;
                endY = (viewport.height + (viewport.offsetY || 0)) - (item.transform[5] + item.height);
            }
            break;
        }

        charOffset = itemEnd;
    }

    if (endX === 0) endX = startX + 50;
    if (endY === 0) endY = startY;

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
                        for (const page of cached.pages) {
                            text += page.text + ' ';
                        }
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
                requestAnimationFrame(processChunk);
            } else {
                resolve({ results, totalMatches, filesWithMatches });
            }
        }

        requestAnimationFrame(processChunk);
    });
}
