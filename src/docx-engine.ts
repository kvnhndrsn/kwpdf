import { state, beginDocGeneration, isCurrentGeneration, resetDocumentState, createSearchCache } from './state';
import * as dom from './dom';
import { getKeywordRegex, normalizeKeywordMatch } from './keyword-regex';
import { fn, KEYWORDS } from './cross';
import { htmlToText } from './html-text';
import { isLegacyDocFile, LEGACY_DOC_MESSAGE, getDocTypeFromUrl } from './file-handler';

state.searchCache = createSearchCache();
state.docSearchResults = [];
state.docCurrentMatchIndex = -1;
state.docOriginalHtml = null;
state._docPageHtmls = null;
state._docPageOffsets = null;

// Results per query for the current document. DOCX search reruns the whole
// document text through a fresh regex on every keystroke and every match step,
// but that text only changes when another document is opened.
const docQueryCache = new Map<string, any[]>();
const DOC_QUERY_CACHE_LIMIT = 20;

/** Drop per-query results after the keyword list changes. */
export function clearDocQueryCache() {
    docQueryCache.clear();
}

// Pages currently carrying <mark class="doc-highlight"> markup, so a
// re-render can restore just those instead of re-parsing every page.
const docHighlightedPages = new Set<number>();

// The marks built for one results array, indexed by match index, plus the one
// currently wearing `current`. Moving to another match only has to touch two
// of them; rebuilding every page that carries a mark re-parsed the whole
// document on each Next/Prev.
interface DocHighlightState {
    results: any[] | null;
    marks: Array<HTMLElement | undefined>;
    currentMark: HTMLElement | null;
}

let docHighlightState: DocHighlightState = { results: null, marks: [], currentMark: null };

function resetDocHighlights() {
    docHighlightState = { results: null, marks: [], currentMark: null };
    docHighlightedPages.clear();
}

// ── helpers ──

/** Split document HTML into viewer pages. Exported so the CSV export can use
 *  the same page boundaries the viewer attributed matches to. */
export function splitHtmlIntoPages(html, targetPerPage = 3000) {
    // First, split at explicit <hr> page breaks (mammoth's page break markers)
    const hrParts = html.split(/<hr\b[^>]*>/i).filter(Boolean);
    if (hrParts.length > 1) {
        const result = [];
        for (const part of hrParts) {
            // Each <hr>-delimited section may still be large — sub-split it
            const sub = splitByBlockElements(part, targetPerPage);
            result.push(...sub);
        }
        return result;
    }

    // No explicit breaks — split content into roughly equal pages
    const result = splitByBlockElements(html, targetPerPage);
    return result.length > 0 ? result : [html];
}

function splitByBlockElements(html, targetPerPage) {
    const temp = document.createElement('div');
    temp.innerHTML = html;
    const children = Array.from(temp.children);
    if (children.length === 0) return [html];

    const pages = [];
    let currentPage = [];
    let currentLen = 0;

    for (const child of children) {
        const textLen = (child.textContent || '').length;

        // If this child alone exceeds target, it gets its own page
        if (currentLen > 0 && currentLen + textLen > targetPerPage) {
            pages.push(currentPage.map((el) => el.outerHTML).join('\n'));
            currentPage = [];
            currentLen = 0;
        }

        currentPage.push(child);
        currentLen += textLen;
    }

    if (currentPage.length > 0) {
        pages.push(currentPage.map((el) => el.outerHTML).join('\n'));
    }

    return pages;
}

function textFromHtml(html) {
    return htmlToText(html);
}

export function buildPageOffsets(pageTexts, fullText) {
    const offsets = [];
    let cursor = 0;
    for (const t of pageTexts) {
        // Each page's text is trimmed, while the searched string has every
        // whitespace run collapsed, so summing page lengths leaves the table one
        // separator short at each boundary and later matches land on an earlier
        // page. Locate each page inside the searched text instead.
        let at = t ? fullText.indexOf(t, cursor) : -1;
        if (at === -1) at = cursor;
        offsets.push(at);
        cursor = at + t.length;
    }
    return offsets;
}

export function findPageForIndex(charIndex, offsets) {
    // Offsets are ascending: find the last page whose text starts at or before
    // charIndex. Called once per match, so a linear backwards scan over a long
    // document's pages showed up in navigation latency.
    let lo = 0;
    let hi = offsets.length - 1;
    let page = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (offsets[mid] <= charIndex) {
            page = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return page + 1;
}

function computeDocResults(query) {
    const cachedResults = docQueryCache.get(query);
    if (cachedResults) return cachedResults;

    const cached = state.docContentCache[state.currentDocUrl];
    if (!cached) return [];

    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const localRegex = new RegExp(`\\b${escaped}\\b`, 'gi');
    const text = cached.text;
    const results = [];
    let match;

    while ((match = localRegex.exec(text)) !== null) {
        const page = state._docPageOffsets ? findPageForIndex(match.index, state._docPageOffsets) : 1;
        results.push({ index: match.index, text: match[0], length: match[0].length, page });
    }

    if (docQueryCache.size >= DOC_QUERY_CACHE_LIMIT) {
        const oldest = docQueryCache.keys().next();
        if (!oldest.done) docQueryCache.delete(oldest.value);
    }
    docQueryCache.set(query, results);
    return results;
}

function styleTables(container) {
    container.querySelectorAll('table').forEach((table) => {
        table.style.borderCollapse = 'collapse';
        table.style.width = '100%';
    });
    container.querySelectorAll('td, th').forEach((cell) => {
        cell.style.border = '1px solid #000';
        cell.style.padding = '4px';
    });
}

export function loadDocxDoc(fileUrl, keyword = '') {
    if (state.currentDocUrl === fileUrl && state.docContentCache[fileUrl]) {
        if (keyword) cycleDocSearch(keyword);
        return;
    }

    const generation = beginDocGeneration();

    const cachedInfo = state.docContentCache[fileUrl];

    // Previous document's scale, page caches, search results, highlights and
    // PDF page index — the DOCX path used to leave most of it behind.
    resetDocumentState();

    state.currentDocUrl = fileUrl;
    docQueryCache.clear();
    resetDocHighlights();
    state.currentDocType = cachedInfo?.type || getDocTypeFromUrl(fileUrl);

    // Release the previous PDF: keeping it alive would let in-flight render
    // callbacks paint a PDF canvas into the DOCX page elements below.
    fn.teardownPdf();

    dom.loader.style.display = 'flex';
    dom.loaderFilename.textContent = 'Loading document...';
    dom.loaderStatus.textContent = 'Parsing...';
    dom.loaderProgressFill.style.width = '30%';
    dom.viewer.innerHTML = '';
    fn.clearSearch();

    (async () => {
        try {
            let cached = state.docContentCache[fileUrl];
            if (!cached) {
                dom.loaderFilename.textContent = 'Re-scanning DOCX...';
                const blobUrl = state.objectUrls.find((url) => url === fileUrl);
                if (blobUrl) {
                    const response = await fetch(blobUrl);
                    const arrayBuffer = await response.arrayBuffer();
                    if (!isCurrentGeneration(generation)) return;
                    const fileName = state.docDataCache[fileUrl]?.name || 'Document';
                    // Mammoth cannot read the legacy binary format; say so in the
                    // loader instead of letting the extraction fail and then
                    // reporting "Document not found in cache".
                    if (isLegacyDocFile(arrayBuffer) || state.currentDocType === 'doc') {
                        dom.loaderFilename.textContent = 'Unsupported document';
                        dom.loaderStatus.textContent = LEGACY_DOC_MESSAGE;
                        dom.loaderProgressFill.style.width = '0%';
                        return;
                    }
                    await fn.extractDocText(arrayBuffer, fileName, fileUrl, null);
                    if (!isCurrentGeneration(generation)) return;
                    cached = state.docContentCache[fileUrl];
                }
            }
            if (!cached) throw new Error('Document not found in cache');
            cached._lastAccess = Date.now();

            dom.loaderProgressFill.style.width = '70%';
            dom.loaderStatus.textContent = 'Rendering...';

            renderDocContent(cached.html, cached.text);
            if (!isCurrentGeneration(generation)) return;
            state.currentScale = 1.0;
            document.documentElement.style.setProperty('--docx-scale', '1');
            dom.loaderProgressFill.style.width = '100%';
            dom.loader.style.display = 'none';

            fn.updatePageInfo();
            fn.updateZoomDisplay();
            dom.pageInput.max = String(state.totalPages);
            dom.pageTotal.textContent = String(state.totalPages);

            startDocSearchComputation();
            if (!isCurrentGeneration(generation)) return;

            if (!keyword) {
                const counts = state.docKeywordCounts;
                if (counts) {
                    for (const [k, v] of Object.entries(counts)) {
                        if ((v as unknown as number) > 0) {
                            keyword = k;
                            break;
                        }
                    }
                }
            }

            if (keyword) cycleDocSearch(keyword);
        } catch (err) {
            if (!isCurrentGeneration(generation)) return;
            dom.loaderFilename.textContent = 'Error loading document';
            dom.loaderStatus.textContent = err.message;
            dom.loaderProgressFill.style.width = '0%';
            console.error('Document load error:', err);
        }
    })();
}

function renderDocContent(html, plainText) {
    dom.viewer.innerHTML = '';
    resetDocHighlights();

    if (!html) {
        dom.viewer.innerHTML = '<div style="padding:20px;">No content to display</div>';
        state.totalPages = 1;
        state.currentPage = 1;
        return;
    }

    state.docOriginalHtml = html;
    const pageHtmls = splitHtmlIntoPages(html);
    const pageTexts = pageHtmls.map(textFromHtml);
    state._docPageHtmls = pageHtmls;
    state._docPageOffsets = buildPageOffsets(pageTexts, plainText);
    state.totalPages = pageHtmls.length;
    state.currentPage = 1;

    const wrapper = document.createElement('div');
    wrapper.className = 'docx-wrapper';
    wrapper.id = 'docxWrapper';

    pageHtmls.forEach((pageHtml, i) => {
        const pn = i + 1;
        const el = document.createElement('div');
        el.className = 'docx-page';
        el.id = 'page-' + pn;
        el.innerHTML = pageHtml;
        styleTables(el);
        wrapper.appendChild(el);

        state.textPageCache[pn] = { text: pageTexts[i], viewport: { width: 800, height: 600 }, items: [] };
    });

    dom.viewer.appendChild(wrapper);
}

function startDocSearchComputation() {
    const cached = state.docContentCache[state.currentDocUrl];
    if (!cached) return;

    const combinedRegex = getKeywordRegex(KEYWORDS);
    const text = cached.text;
    const results = [];
    let match;

    if (combinedRegex) {
        while ((match = combinedRegex.exec(text)) !== null) {
            const key = normalizeKeywordMatch(match, KEYWORDS);
            if (!key) continue;
            const page = state._docPageOffsets ? findPageForIndex(match.index, state._docPageOffsets) : 1;
            results.push({ index: match.index, text: match[0], length: match[0].length, page, keyword: key });
        }
    }

    const counts = {};
    results.forEach((r) => {
        counts[r.keyword] = (counts[r.keyword] || 0) + 1;
    });

    state.docKeywordCounts = counts;
    state.docKeywordResults = results;
    state.emit('keywords-changed');
}

export function cycleAllDocKeywords() {
    const allResults = state.docKeywordResults;
    if (!allResults || allResults.length === 0) return;

    const wasAlreadyAll = state.allKeywordMode && state.docSearchResults.length === allResults.length;

    state.allKeywordMode = true;
    state.activeKeyword = '';
    state.docSearchResults = allResults;

    if (wasAlreadyAll) {
        state.docCurrentMatchIndex = (state.docCurrentMatchIndex + 1) % allResults.length;
    } else {
        state.docCurrentMatchIndex = 0;
    }

    dom.navGroup.classList.add('active');
    dom.navSep.style.display = '';
    dom.matchTotal.textContent = String(allResults.length);
    (dom.matchInput as HTMLInputElement).max = String(allResults.length);
    (dom.matchInput as HTMLInputElement).value = String(state.docCurrentMatchIndex + 1);
    // goToDocMatch() renders the highlights; doing it here as well re-parsed
    // every marked page twice per step.
    state.emit('badge-changed');
    goToDocMatch(state.docCurrentMatchIndex);
}

export function performDocSearch(query) {
    if (!state.currentDocUrl || !state.docContentCache[state.currentDocUrl]) return;
    state.allKeywordMode = false;

    const results = computeDocResults(query);

    state.docSearchResults = results;
    state.docCurrentMatchIndex = 0;
    if (state.docContentCache[state.currentDocUrl]) state.docContentCache[state.currentDocUrl].lastQuery = query;

    if (results.length > 0) {
        dom.navGroup.classList.add('active');
        dom.navSep.style.display = '';
        dom.matchTotal.textContent = String(results.length);
        (dom.matchInput as HTMLInputElement).max = String(results.length);
        (dom.matchInput as HTMLInputElement).value = '1';
        state.emit('badge-changed');
        goToDocMatch(0);
    } else {
        // No hits: remove the previous query's marks, which renderDocHighlights
        // restores from the page HTML before it early-returns.
        state.docCurrentMatchIndex = -1;
        renderDocHighlights();
        dom.navGroup.classList.remove('active');
        dom.navSep.style.display = 'none';
        dom.matchTotal.textContent = '0';
        dom.matchInput.value = '';
    }
}

export function cycleDocSearch(query) {
    if (!state.currentDocUrl || !state.docContentCache[state.currentDocUrl]) return;
    state.allKeywordMode = false;

    const results = computeDocResults(query);

    if (results.length === 0) {
        state.docSearchResults = [];
        state.docCurrentMatchIndex = -1;
        renderDocHighlights();
        dom.navGroup.classList.remove('active');
        dom.navSep.style.display = 'none';
        dom.matchTotal.textContent = '0';
        dom.matchInput.value = '';
        state.emit('badge-changed');
        return;
    }

    const wasSameQuery =
        state.docSearchResults.length > 0 && state.docContentCache[state.currentDocUrl]?.lastQuery === query;
    state.docCurrentMatchIndex = !wasSameQuery ? 0 : (state.docCurrentMatchIndex + 1) % results.length;
    if (state.docContentCache[state.currentDocUrl]) state.docContentCache[state.currentDocUrl].lastQuery = query;

    state.docSearchResults = results;

    dom.navGroup.classList.add('active');
    dom.navSep.style.display = '';
    dom.matchTotal.textContent = String(results.length);
    (dom.matchInput as HTMLInputElement).max = String(results.length);
    (dom.matchInput as HTMLInputElement).value = String(state.docCurrentMatchIndex + 1);
    // goToDocMatch() renders the highlights; doing it here as well re-parsed
    // every marked page twice per step.
    state.emit('badge-changed');
    goToDocMatch(state.docCurrentMatchIndex);
}

export function renderDocHighlights() {
    const wrapper = dom.viewer.querySelector('.docx-wrapper');
    if (!wrapper || !state._docPageHtmls) return;

    const pageHtmls = state._docPageHtmls;
    const results = state.docSearchResults;

    // Same result set as last time, so the marks are already in the DOM: moving
    // to another match is a class toggle on two elements. A mark that is no
    // longer connected means its page was re-rendered elsewhere, and the page
    // markup has to be rebuilt below.
    if (docHighlightState.results === results) {
        const next = docHighlightState.marks[state.docCurrentMatchIndex];
        if (!next || next.isConnected) {
            if (docHighlightState.currentMark && docHighlightState.currentMark !== next) {
                docHighlightState.currentMark.classList.remove('current');
            }
            if (next) {
                next.classList.add('current');
                next.scrollIntoView({ behavior: state.smoothScrollEnabled ? 'smooth' : 'auto', block: 'center' });
            }
            docHighlightState.currentMark = next || null;
            return;
        }
    }

    // Restore only the pages that actually carry highlight markup. Rewriting
    // every page's innerHTML on each match step re-parses the whole document
    // just to move the `current` class on one of them.
    for (const pageNum of docHighlightedPages) {
        const pageEl = document.getElementById('page-' + pageNum);
        const html = pageHtmls[pageNum - 1];
        if (!pageEl || html === undefined) continue;
        pageEl.innerHTML = html;
        styleTables(pageEl);
    }
    docHighlightedPages.clear();
    docHighlightState = { results, marks: [], currentMark: null };

    if (!results.length) return;

    const currentResult = results[state.docCurrentMatchIndex];
    if (!currentResult) return;

    // Group results by page
    const resultsByPage = {};
    results.forEach((r, idx) => {
        const p = r.page || 1;
        if (!resultsByPage[p]) resultsByPage[p] = [];
        resultsByPage[p].push({ ...r, matchIndex: idx });
    });

    // Apply highlights per page — search each page's own text independently
    for (const pageNumStr in resultsByPage) {
        const pageNum = parseInt(pageNumStr);
        const pageEl = document.getElementById('page-' + pageNum);
        if (!pageEl) continue;

        const pageResults = resultsByPage[pageNum];

        // Build a single regex matching any of the result texts (word-bounded, matching search)
        const uniqueTerms = [...new Set(pageResults.map((r) => r.text))];

        // A term can occur several times on a page. Consume the page's results
        // for that term in document order: `find`-ing by text always returned
        // occurrence 1, so the current mark never moved past it.
        const pending = new Map<string, any[]>();
        for (const r of pageResults) {
            const key = (r.text as string).toLowerCase();
            const bucket = pending.get(key);
            if (bucket) bucket.push(r);
            else pending.set(key, [r]);
        }
        const combinedPattern = uniqueTerms
            .map((t) => '\\b' + (t as string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b')
            .join('|');
        const combinedRegex = new RegExp(combinedPattern, 'gi');

        // Walk text nodes
        const walker = document.createTreeWalker(pageEl, NodeFilter.SHOW_TEXT, null as any);
        const nodes = [];
        let node;
        while ((node = walker.nextNode())) nodes.push(node);

        let replaced = false;
        for (const textNode of nodes) {
            combinedRegex.lastIndex = 0;
            const content = textNode.textContent;
            if (combinedRegex.test(content)) {
                combinedRegex.lastIndex = 0;
                const span = document.createElement('span');
                span.innerHTML = content.replace(combinedRegex, (match) => {
                    const lower = match.toLowerCase();
                    const bucket = pending.get(lower);
                    const matchingResult = bucket && bucket.length ? bucket.shift() : undefined;
                    const isCurrent = !!matchingResult && matchingResult.matchIndex === state.docCurrentMatchIndex;
                    // The match is document text, not markup: a keyword that
                    // happens to look like a tag must not become one.
                    const safe = match.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    const mi = matchingResult ? ` data-mi="${matchingResult.matchIndex}"` : '';
                    return `<mark class="doc-highlight${isCurrent ? ' current' : ''}"${mi}>${safe}</mark>`;
                });
                textNode.parentNode.replaceChild(span, textNode);
                replaced = true;
            }
        }
        if (replaced) docHighlightedPages.add(pageNum);
    }

    // Index the marks by match so the next navigation is a class toggle.
    const marks: Array<HTMLElement | undefined> = new Array(results.length);
    wrapper.querySelectorAll<HTMLElement>('mark.doc-highlight[data-mi]').forEach((el) => {
        const mi = Number(el.dataset.mi);
        if (Number.isInteger(mi) && mi >= 0 && mi < marks.length) marks[mi] = el;
    });

    const currentMark = document.querySelector<HTMLElement>('.doc-highlight.current');
    docHighlightState = { results, marks, currentMark };

    if (currentMark) {
        currentMark.scrollIntoView({ behavior: state.smoothScrollEnabled ? 'smooth' : 'auto', block: 'center' });
    }
}

export function goToDocMatch(index) {
    if (!state.docSearchResults.length) return;

    state.docCurrentMatchIndex =
        ((index % state.docSearchResults.length) + state.docSearchResults.length) % state.docSearchResults.length;
    (dom.matchInput as HTMLInputElement).value = String(state.docCurrentMatchIndex + 1);
    state.emit('badge-changed');

    const result = state.docSearchResults[state.docCurrentMatchIndex];
    const pageNum = result.page || 1;
    const pageEl = document.getElementById('page-' + pageNum);
    if (pageEl) {
        pageEl.scrollIntoView({ behavior: state.smoothScrollEnabled ? 'smooth' : 'auto', block: 'start' });
    }
    renderDocHighlights();
}
