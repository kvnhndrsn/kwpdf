import type { PageCacheEntry, RawSearchResult, TextCoords, DocDataCacheEntry, PdfCacheEntry, DocxCacheEntry } from './types';
import { projectItemBox, boxesOverlap, unionBoxes, type ProjectedBox } from './pdf-coords';

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

    if (transform) {
        // Walk the items once, projecting each run that the range touches.
        let charOffset = 0;
        let box: ProjectedBox | null = null;
        let found = false;

        for (const item of cached.items) {
            const itemStart = charOffset;
            const itemEnd = charOffset + item.text.length;
            charOffset = itemEnd;

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
    let charOffset = 0;
    let foundStart = false;
    let foundEnd = false;

    for (const item of cached.items) {
        const itemStart = charOffset;
        const itemEnd = charOffset + item.text.length;

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

        charOffset = itemEnd;
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
