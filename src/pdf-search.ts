import { state } from './state';
import * as dom from './dom';
import { getKeywordRegex, normalizeKeywordMatch } from './keyword-regex';
import { projectItem } from './pdf-coords';
import { fn, KEYWORDS } from './cross';

state.searchResults = [];
state.currentMatchIndex = -1;
state.searchCache = {};
state.textPageCache = {};

export function processTextContent(textContent) {
    let pageText = '';
    const items = [];
    let prevItem = null;
    for (const item of textContent.items) {
        if (prevItem) {
            const fontSize = Math.abs(item.transform[0]) || 12;
            const gapX = item.transform[4] - (prevItem.transform[4] + prevItem.width);
            const gapY = Math.abs(item.transform[5] - prevItem.transform[5]);
            const sameLine = gapY <= fontSize * 0.5;
            if (sameLine) {
                if (gapX > 0) {
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
    return { item: items[lo], charStart: offsets[lo] };
}

export function computeMatchCoords(matchStart, matchEnd, viewport, textItems, offsetMap) {
    const start = findStartItem(matchStart, offsetMap.offsets, textItems);
    const end = findEndItem(matchEnd, start.index, offsetMap.offsets, textItems);

    const startCharFrac = start.item.text.length > 0
        ? (matchStart - start.charStart) / start.item.text.length : 0;
    const endCharFrac = end.item.text.length > 0
        ? (matchEnd - end.charStart) / end.item.text.length : 1;

    const transform = viewport && viewport.transform;
    let sx, sy, endX, height;
    if (transform) {
        const sp = projectItem(start.item, transform);
        const ep = projectItem(end.item, transform);
        sx = sp.x + startCharFrac * start.item.width * sp.dx;
        sy = sp.top;
        endX = ep.x + endCharFrac * end.item.width * ep.dx;
        height = Math.max(start.item.height || 0, end.item.height || 0);
    } else {
        const offsetY = viewport.offsetY || 0;
        sx = start.item.transform[4] + startCharFrac * start.item.width;
        sy = (viewport.height + offsetY) - (start.item.transform[5] + start.item.height);
        endX = end.item.transform[4] + endCharFrac * end.item.width;
        height = start.item.height;
    }

    const width = Math.max(endX - sx, 4);
    return { x: sx, y: sy, width, height };
}

export async function precomputeAllSearches() {
    if (state.searchCache._deduplicated) return;

    const combinedRegex = getKeywordRegex(KEYWORDS);

    for (let pageNum = 1; pageNum <= state.totalPages; pageNum++) {
        const cached = state.textPageCache[pageNum];
        if (!cached) continue;

        const pageText = cached.text;
        const viewport = cached.viewport;

        if (!cached.items) await fetchPageItems(pageNum);
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

    (state.searchCache as any)._deduplicated = true;
    state.emit('keywords-changed');
}

async function computeSearchForQuery(query) {
    if (state.searchCache[query] !== undefined) return;
    if (state.searchCache._deduplicated) return;

    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const localRegex = new RegExp(`\\b${escaped}\\b`, 'gi');
    const results = [];

    for (let pageNum = 1; pageNum <= state.totalPages; pageNum++) {
        const cached = state.textPageCache[pageNum];
        if (!cached) continue;

        const pageText = cached.text;
        const viewport = cached.viewport;

        if (!cached.items) await fetchPageItems(pageNum);
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

export function cycleAllKeywords() {
    if (!state.searchCache._deduplicated) return;

    const allResults = [];
    for (const [keyword, results] of Object.entries(state.searchCache)) {
        if (keyword === '_deduplicated') continue;
        for (const r of results) {
            allResults.push({ ...r, keyword });
        }
    }
    allResults.sort((a, b) => a.page - b.page || a.y - b.y);

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
    state.emit('heatmaps-changed');
    state.emit('results-changed');
    fn.startPrerender();
    fn.goToMatch(state.currentMatchIndex);
}

export async function performSearch(query) {
    if (!state.pdfDoc || !query) return;
    state.allKeywordMode = false;

    let canonicalQuery = query;
    if (state.searchCache[query] === undefined) {
        const lower = query.toLowerCase();
        const found = (KEYWORDS || []).find(k => k.toLowerCase() === lower);
        if (found && state.searchCache[found] !== undefined) canonicalQuery = found;
    }

    if (state.searchCache[canonicalQuery] !== undefined) {
        state.searchResults = state.searchCache[canonicalQuery];
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
    state.searchResults = state.searchCache[canonicalQuery] || [];
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
        state.emit('heatmaps-changed');
        fn.startPrerender();
        fn.goToMatch(0);
    } else {
        dom.navGroup.classList.remove('active');
        dom.navSep.style.display = '';
        dom.matchTotal.textContent = '0';
        dom.matchInput.value = '';
        state.currentMatchIndex = -1;
        state.emit('badge-changed');
        state.emit('keywords-changed');
        state.emit('heatmaps-changed');
    }
}

export function cycleSearch(query) {
    if (!state.pdfDoc || !query) return;
    state.allKeywordMode = false;

    if (state.searchCache[query] !== undefined) {
        const prevKeyword = state.activeKeyword;

        state.searchResults = state.searchCache[query];
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
            state.emit('heatmaps-changed');
            renderAllHighlights();
            fn.goToMatch(state.currentMatchIndex);
        } else {
            dom.navGroup.classList.remove('active');
            dom.navSep.style.display = 'none';
            dom.matchTotal.textContent = '0';
            dom.matchInput.value = '';
            state.emit('keywords-changed');
        }
        return;
    }

    performSearch(query);
}

export function renderAllHighlights() {
    clearHighlights();

    for (const pageNum in state.searchResultsByPage) {
        const pageEl = document.getElementById('page-' + pageNum);
        if (!pageEl) continue;
        const fragment = document.createDocumentFragment();
        state.searchResultsByPage[pageNum].forEach(({ result, globalIndex }) => {
            if (result.x === null) return;
            const mark = document.createElement('div');
            mark.className = 'highlight-mark' + (globalIndex === state.currentMatchIndex ? ' current' : '');
            mark.dataset.idx = String(globalIndex);
            mark.style.left = (result.x * state.currentScale) + 'px';
            mark.style.top = (result.y * state.currentScale) + 'px';
            mark.style.width = (result.width * state.currentScale) + 'px';
            mark.style.height = (result.height * state.currentScale) + 'px';
            fragment.appendChild(mark);
        });
        pageEl.appendChild(fragment);
    }
}

export function updateCurrentMatch(oldIndex, newIndex) {
    if (oldIndex === newIndex) return;
    const prev = document.querySelector(`.highlight-mark[data-idx="${oldIndex}"]`);
    const next = document.querySelector(`.highlight-mark[data-idx="${newIndex}"]`);
    if (prev) prev.classList.remove('current');
    if (next) next.classList.add('current');
}

export function repositionHighlights() {
    for (const mark of document.querySelectorAll('.highlight-mark')) {
        const el = mark as HTMLElement;
        const idx = parseInt(el.dataset.idx);
        if (isNaN(idx)) continue;
        const result = state.searchResults[idx];
        if (!result || result.x === null) continue;
        el.style.left = (result.x * state.currentScale) + 'px';
        el.style.top = (result.y * state.currentScale) + 'px';
        el.style.width = (result.width * state.currentScale) + 'px';
        el.style.height = (result.height * state.currentScale) + 'px';
    }
}

export function renderHighlightsForPage(pageNum) {
    const pageEl = document.getElementById('page-' + pageNum);
    if (!pageEl) return;
    pageEl.querySelectorAll('.highlight-mark').forEach(el => el.remove());

    const results = state.searchResultsByPage[pageNum];
    if (!results) return;

    const fragment = document.createDocumentFragment();
    results.forEach(({ result, globalIndex }) => {
        if (result.x === null) return;
        const mark = document.createElement('div');
        mark.className = 'highlight-mark' + (globalIndex === state.currentMatchIndex ? ' current' : '');
        mark.dataset.idx = String(globalIndex);
        mark.style.left = (result.x * state.currentScale) + 'px';
        mark.style.top = (result.y * state.currentScale) + 'px';
        mark.style.width = (result.width * state.currentScale) + 'px';
        mark.style.height = (result.height * state.currentScale) + 'px';
        fragment.appendChild(mark);
    });
    pageEl.appendChild(fragment);
}

export function clearHighlights() {
    dom.viewer.querySelectorAll('.highlight-mark').forEach(el => el.remove());
}

function buildSearchResultsByPage() {
    const byPage = {};
    state.searchResults.forEach((r, i) => {
        if (!byPage[r.page]) byPage[r.page] = [];
        byPage[r.page].push({ result: r, globalIndex: i });
    });
    state.searchResultsByPage = byPage;
}

export function renderPageHeatmaps() {}
