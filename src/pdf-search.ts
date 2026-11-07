import { state, isCurrentGeneration, beginSearch, isCurrentSearch, createSearchCache } from './state';
import * as dom from './dom';
import { getKeywordRegex, normalizeKeywordMatch } from './keyword-regex';
import { projectItemBox, unionBoxes, sameTextLine } from './pdf-coords';
import { fn, KEYWORDS } from './cross';
import { clearHighlights, renderAllHighlights } from './pdf-highlights';

state.searchResults = [];
state.currentMatchIndex = -1;
state.searchCache = createSearchCache();
state.textPageCache = {};

/**
 * Gap and line test between two text runs, measured in the direction the text
 * actually runs. A run rotated 90 or 270 degrees (its transform leans on the y
 * axis) advances along y, so its width and the gap live there and "same line"
 * is the distance on x. Comparing x for those runs misjoined lines, which
 * changed the extracted text and with it every match count on the page.
 */
function runSpacing(prevItem, item) {
    const t = item.transform;
    const p = prevItem.transform;
    // The scale factor in either orientation. t[0] is ~0 for a rotated run and
    // used to fall back to a flat 12.
    const fontSize = Math.hypot(t[0], t[1]) || 12;
    if (Math.abs(t[1]) > Math.abs(t[0])) {
        // +1 for 90 degrees (y grows along the run), -1 for 270.
        const sign = Math.sign(t[1]) || 1;
        return {
            sameLine: Math.abs(t[4] - p[4]) <= fontSize * 0.5,
            gap: sign * (t[5] - p[5]) - prevItem.width,
        };
    }
    return {
        sameLine: Math.abs(t[5] - p[5]) <= fontSize * 0.5,
        gap: t[4] - (p[4] + prevItem.width),
    };
}

export function processTextContent(textContent) {
    let pageText = '';
    const items = [];
    let prevItem = null;
    for (const item of textContent.items) {
        if (prevItem) {
            const { sameLine, gap } = runSpacing(prevItem, item);
            if (sameLine) {
                if (gap > 0) {
                    pageText += ' ';
                    items.push({ text: ' ', transform: item.transform, width: 0, height: item.height });
                }
            } else {
                const hyphenBreak = /-\s*$/.test(prevItem.str) && /^\w/.test(item.str);
                if (hyphenBreak) {
                    pageText = pageText.slice(0, -1);
                    if (items.length > 0) items[items.length - 1].text = items[items.length - 1].text.slice(0, -1);
                } else {
                    pageText += ' ';
                    items.push({ text: ' ', transform: item.transform, width: 0, height: item.height });
                }
            }
        }
        pageText += item.str;
        items.push({ text: item.str, transform: item.transform, width: item.width, height: item.height });
        prevItem = item;
    }
    return { text: pageText, items };
}

export function buildOffsetMap(textItems) {
    const offsets = [];
    let acc = 0;
    for (const item of textItems) {
        offsets.push(acc);
        acc += item.text.length;
    }
    return { offsets, length: acc };
}

export function findStartItem(pos, offsets, items) {
    let lo = 0, hi = offsets.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if (offsets[mid] <= pos) lo = mid;
        else hi = mid - 1;
    }
    return { item: items[lo], charStart: offsets[lo], index: lo };
}

export function findEndItem(endPos, startIdx, offsets, items) {
    let lo = startIdx, hi = offsets.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const itemEnd = offsets[mid] + items[mid].text.length;
        if (endPos <= itemEnd) hi = mid;
        else lo = mid + 1;
    }
    return { item: items[lo], charStart: offsets[lo], index: lo };
}

/**
 * Project a match onto the page, one box per line fragment.
 *
 * A phrase split by a line break ("heat" / "bonded") used to lose its second
 * fragment: the two boxes do not overlap, so one of them was discarded. Both
 * fragments are returned now, in reading order, and the caller paints each.
 * Runs on the same line are still unioned into a single box so ordinary
 * matches keep one mark.
 */
export function computeMatchBoxes(matchStart, matchEnd, viewport, textItems, offsetMap) {
    const start = findStartItem(matchStart, offsetMap.offsets, textItems);
    const end = findEndItem(matchEnd, start.index, offsetMap.offsets, textItems);

    const startCharFrac = start.item.text.length > 0
        ? (matchStart - start.charStart) / start.item.text.length : 0;
    const endCharFrac = end.item.text.length > 0
        ? (matchEnd - end.charStart) / end.item.text.length : 1;

    const transform = viewport && viewport.transform;

    if (!transform) {
        const offsetY = viewport.offsetY || 0;
        const sx = start.item.transform[4] + startCharFrac * start.item.width;
        const sy = (viewport.height + offsetY) - (start.item.transform[5] + start.item.height);
        const endX = end.item.transform[4] + endCharFrac * end.item.width;
        const height = start.item.height;
        const width = Math.max(endX - sx, 4);
        return [{ x: sx, y: sy, width, height }];
    }

    const boxes = [];
    let fragmentItem = null;

    for (let i = start.index; i <= end.index; i++) {
        const item = textItems[i];
        if (!item || !item.text || item.text.length === 0) continue;
        const itemStart = offsetMap.offsets[i];
        const itemEnd = itemStart + item.text.length;
        if (matchEnd <= itemStart) break;
        if (matchStart >= itemEnd) continue;

        const from = Math.max(0, (matchStart - itemStart) / item.text.length);
        const to = Math.min(1, (matchEnd - itemStart) / item.text.length);
        if (to <= from) continue;

        const box = projectItemBox(item, transform, from, to);
        if (fragmentItem && boxes.length > 0 && sameTextLine(fragmentItem, item)) {
            boxes[boxes.length - 1] = unionBoxes(boxes[boxes.length - 1], box);
        } else {
            boxes.push(box);
            fragmentItem = item;
        }
    }

    if (boxes.length === 0) {
        boxes.push(projectItemBox(start.item, transform, startCharFrac, 1));
    }
    return boxes;
}

/**
 * Single-box view of a match, kept for callers that only need an anchor.
 * `x`/`y`/`width`/`height` describe the first fragment and `boxes` carries
 * every fragment for painting.
 */
export function computeMatchCoords(matchStart, matchEnd, viewport, textItems, offsetMap) {
    const boxes = computeMatchBoxes(matchStart, matchEnd, viewport, textItems, offsetMap);
    const first = boxes[0] || { x: 0, y: 0, width: 0, height: 0 };
    return { x: first.x, y: first.y, width: first.width, height: first.height, boxes };
}

export async function precomputeAllSearches() {
    if (state.searchDeduplicated) return;

    const combinedRegex = getKeywordRegex(KEYWORDS);

    if (!combinedRegex) {
        state.searchDeduplicated = true;
        state.emit('keywords-changed');
        return;
    }

    const generation = state.docGeneration;

    for (let pageNum = 1; pageNum <= state.totalPages; pageNum++) {
        const cached = state.textPageCache[pageNum];
        if (!cached) continue;

        const pageText = cached.text;
        const viewport = cached.viewport;

        if (!cached.items) await fetchPageItems(pageNum);
        if (!isCurrentGeneration(generation)) return;
        const textItems = cached.items;
        if (!textItems || textItems.length === 0) continue;

        const offsetMap = buildOffsetMap(textItems);

        let match;
        while ((match = combinedRegex.exec(pageText)) !== null) {
            const canonical = normalizeKeywordMatch(match, KEYWORDS);
            if (!canonical) continue;

            if (state.searchCache[canonical] === undefined) state.searchCache[canonical] = [];

            const coords = computeMatchCoords(match.index, match.index + match[0].length, viewport, textItems, offsetMap);
            state.searchCache[canonical].push({ page: pageNum, ...coords });
        }
    }

    if (!isCurrentGeneration(generation)) return;
    state.searchDeduplicated = true;
    state.emit('keywords-changed');
}

async function computeSearchForQuery(query) {
    if (state.searchCache[query] !== undefined) return;
    if (state.searchDeduplicated) return;

    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const localRegex = new RegExp(`\\b${escaped}\\b`, 'gi');
    const results = [];
    const generation = state.docGeneration;

    for (let pageNum = 1; pageNum <= state.totalPages; pageNum++) {
        const cached = state.textPageCache[pageNum];
        if (!cached) continue;

        const pageText = cached.text;
        const viewport = cached.viewport;

        if (!cached.items) await fetchPageItems(pageNum);
        if (!isCurrentGeneration(generation)) return;
        const textItems = cached.items;
        if (!textItems || textItems.length === 0) continue;

        const offsetMap = buildOffsetMap(textItems);

        let match;
        while ((match = localRegex.exec(pageText)) !== null) {
            if (!normalizeKeywordMatch(match)) continue;

            const coords = computeMatchCoords(match.index, match.index + match[0].length, viewport, textItems, offsetMap);
            results.push({ page: pageNum, ...coords });
        }
    }

    if (!isCurrentGeneration(generation)) return;
    state.searchCache[query] = results;
}

export async function processTextContentAsync(textContent) {
    const pool = state.workerPool;
    if (pool && pool.initialized) {
        try {
            return await pool.runProcessTextContent(textContent.items);
        } catch (e) {
            // fall back to sync processing
        }
    }
    return processTextContent(textContent);
}

export async function fetchPageItems(pageNum) {
    if (!state.pdfDoc) return null;
    const cached = state.textPageCache[pageNum];
    if (!cached || cached.items) return cached?.items;

    try {
        const page = await state.pdfDoc.getPage(pageNum);
        const content = await page.getTextContent();
        const { items } = processTextContent(content);
        cached.items = items;
        return items;
    } catch (err) {
        console.warn('Failed to fetch page items for page ' + pageNum + ':', (err as Error).message);
        return null;
    }
}

function appendOcrResults(keyword) {
    const getter = fn.getOcrMatchesForKeyword;
    if (!getter) return;
    const matches = getter(keyword, state.currentDocUrl);
    if (!matches || matches.length === 0) return;
    for (const m of matches) {
        const hasCoords = m.x !== undefined;
        const dup = state.searchResults.some(r =>
            r.page === m.page && (hasCoords
                ? Math.abs(r.x - m.x) < 1 && Math.abs(r.y - m.y) < 1
                : r.ocr)
        );
        if (dup) continue;
        if (hasCoords) {
            state.searchResults.push({ page: m.page, x: m.x, y: m.y, width: m.width, height: m.height, ocr: true });
        } else {
            state.searchResults.push({ page: m.page, x: null, y: null, width: null, height: null, ocr: true });
        }
    }
}

let allKeywordCache: { source: any; signature: string; results: any[] } | null = null;

function allKeywordResults(): any[] {
    const cache = state.searchCache;
    let entries = 0;
    let count = 0;
    for (const [keyword, results] of Object.entries(cache)) {
        entries++;
        count += results.length;
    }
    const signature = entries + ':' + count;

    // Next/prev used to re-flatten and re-sort every match on every step. The
    // flattened list only changes when a page cache or the document does.
    if (allKeywordCache && allKeywordCache.source === cache && allKeywordCache.signature === signature) {
        return allKeywordCache.results;
    }

    const results = [];
    for (const [keyword, matches] of Object.entries(cache)) {
        for (const r of matches) {
            results.push({ ...r, keyword });
        }
    }
    results.sort((a, b) => a.page - b.page || a.y - b.y);
    allKeywordCache = { source: cache, signature, results };
    return results;
}

export function cycleAllKeywords() {
    if (!state.searchDeduplicated) return;

    const allResults = allKeywordResults();

    if (allResults.length === 0) return;

    const wasAlreadyAll = state.allKeywordMode && state.searchResults.length === allResults.length;

    state.allKeywordMode = true;
    state.activeKeyword = '';
    state.searchResults = allResults;
    buildSearchResultsByPage();

    if (wasAlreadyAll) {
        state.currentMatchIndex = (state.currentMatchIndex + 1) % allResults.length;
    } else {
        state.currentMatchIndex = 0;
    }

    dom.navGroup.classList.add('active');
    dom.navSep.style.display = '';
    dom.matchTotal.textContent = String(allResults.length);
    dom.matchInput.max = String(allResults.length);
    dom.matchInput.value = String(state.currentMatchIndex + 1);
    renderAllHighlights();
    state.emit('keywords-changed');
    state.emit('badge-changed');
    state.emit('results-changed');
    fn.startPrerender();
    fn.goToMatch(state.currentMatchIndex);
}

export async function performSearch(query) {
    if (!state.pdfDoc || !query) return;
    state.allKeywordMode = false;

    const generation = state.docGeneration;
    const token = beginSearch();

    let canonicalQuery = query;
    if (state.searchCache[query] === undefined) {
        const lower = query.toLowerCase();
        const found = (KEYWORDS || []).find(k => k.toLowerCase() === lower);
        if (found && state.searchCache[found] !== undefined) canonicalQuery = found;
    }

    if (state.searchCache[canonicalQuery] !== undefined) {
        // Copy so appendOcrResults cannot mutate the shared cache array.
        state.searchResults = [...state.searchCache[canonicalQuery]];
        appendOcrResults(canonicalQuery);
        buildSearchResultsByPage();
        state.activeKeyword = canonicalQuery;
        state.currentMatchIndex = 0;
        showSearchResults();
        return;
    }

    state.activeKeyword = canonicalQuery;
    state.currentMatchIndex = 0;
    clearHighlights();
    state.searchResults = [];

    await computeSearchForQuery(canonicalQuery);
    if (!isCurrentGeneration(generation) || !isCurrentSearch(token)) return;

    state.searchResults = [...(state.searchCache[canonicalQuery] || [])];
    appendOcrResults(canonicalQuery);
    buildSearchResultsByPage();

    showSearchResults();
}

function showSearchResults() {
    if (state.searchResults.length > 0) {
        dom.navGroup.classList.add('active');
        dom.navSep.style.display = '';
        dom.matchTotal.textContent = String(state.searchResults.length);
        dom.matchInput.max = String(state.searchResults.length);
        dom.matchInput.value = '1';
        state.currentMatchIndex = 0;
        renderAllHighlights();
        state.emit('keywords-changed');
        state.emit('badge-changed');
        fn.startPrerender();
        fn.goToMatch(0);
    } else {
        // A cached query with no hits must still clear the marks painted by the
        // previous query, otherwise they stay on the page with no result behind
        // them.
        clearHighlights();
        state.searchResultsByPage = {};
        dom.navGroup.classList.remove('active');
        dom.navSep.style.display = '';
        dom.matchTotal.textContent = '0';
        dom.matchInput.value = '';
        state.currentMatchIndex = -1;
        state.emit('badge-changed');
        state.emit('keywords-changed');
    }
}

export function cycleSearch(query) {
    if (!state.pdfDoc || !query) return;
    state.allKeywordMode = false;

    if (state.searchCache[query] !== undefined) {
        const prevKeyword = state.activeKeyword;

        state.searchResults = [...state.searchCache[query]];
        appendOcrResults(query);
        buildSearchResultsByPage();
        state.activeKeyword = query;

        if (state.searchResults.length > 0) {
            dom.navGroup.classList.add('active');
            dom.navSep.style.display = '';
            const wasSameQuery = prevKeyword === query && state.currentMatchIndex >= 0;
            state.currentMatchIndex = wasSameQuery
                ? (state.currentMatchIndex + 1) % state.searchResults.length
                : 0;
            dom.matchTotal.textContent = String(state.searchResults.length);
            dom.matchInput.max = String(state.searchResults.length);
            dom.matchInput.value = String(state.currentMatchIndex + 1);
            state.emit('keywords-changed');
            renderAllHighlights();
            fn.goToMatch(state.currentMatchIndex);
        } else {
            clearHighlights();
            state.searchResultsByPage = {};
            dom.navGroup.classList.remove('active');
            dom.navSep.style.display = 'none';
            dom.matchTotal.textContent = '0';
            dom.matchInput.value = '';
            state.currentMatchIndex = -1;
            state.emit('keywords-changed');
        }
        return;
    }

    performSearch(query);
}

function buildSearchResultsByPage() {
    const byPage = {};
    state.searchResults.forEach((r, i) => {
        if (!byPage[r.page]) byPage[r.page] = [];
        byPage[r.page].push({ result: r, globalIndex: i });
    });
    state.searchResultsByPage = byPage;
}
