import { state, beginDocGeneration, isCurrentGeneration } from './state';
import * as dom from './dom';
import { getKeywordRegex, normalizeKeywordMatch } from './keyword-regex';
import { fn, KEYWORDS } from './cross';

state.searchCache = {};
state.docSearchResults = [];
state.docCurrentMatchIndex = -1;
state.docOriginalHtml = null;
state._docPageHtmls = null;
state._docPageOffsets = null;

// ── helpers ──

function splitHtmlIntoPages(html, targetPerPage = 3000) {
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
            pages.push(currentPage.map(el => el.outerHTML).join('\n'));
            currentPage = [];
            currentLen = 0;
        }

        currentPage.push(child);
        currentLen += textLen;
    }

    if (currentPage.length > 0) {
        pages.push(currentPage.map(el => el.outerHTML).join('\n'));
    }

    return pages;
}

function textFromHtml(html) {
    const d = document.createElement('div');
    d.innerHTML = html;
    return d.textContent.replace(/\s+/g, ' ').trim();
}

function buildPageOffsets(pageTexts) {
    const offsets = [];
    let acc = 0;
    for (const t of pageTexts) {
        offsets.push(acc);
        acc += t.length;
    }
    return offsets;
}

function findPageForIndex(charIndex, offsets) {
    for (let i = offsets.length - 1; i >= 0; i--) {
        if (charIndex >= offsets[i]) return i + 1;
    }
    return 1;
}

function styleTables(container) {
    container.querySelectorAll('table').forEach(table => {
        table.style.borderCollapse = 'collapse';
        table.style.width = '100%';
    });
    container.querySelectorAll('td, th').forEach(cell => {
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

    state.currentDocUrl = fileUrl;
    const cachedInfo = state.docContentCache[fileUrl];
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
    state.textPageCache = {};

    (async () => {
        try {
            let cached = state.docContentCache[fileUrl];
            if (!cached) {
                dom.loaderFilename.textContent = 'Re-scanning DOCX...';
                const blobUrl = state.objectUrls.find(url => url === fileUrl);
                if (blobUrl) {
                    const response = await fetch(blobUrl);
                    const arrayBuffer = await response.arrayBuffer();
                    if (!isCurrentGeneration(generation)) return;
                    const fileName = state.docDataCache[fileUrl]?.name || 'Document';
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
                const counts = state.searchCache._docCounts;
                if (counts) {
                    for (const [k, v] of Object.entries(counts)) {
                        if ((v as unknown as number) > 0) { keyword = k; break; }
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
    state._docPageOffsets = buildPageOffsets(pageTexts);
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
    results.forEach(r => {
        counts[r.keyword] = (counts[r.keyword] || 0) + 1;
    });

    (state.searchCache as any)._docCounts = counts;
    (state.searchCache as any)._docResults = results;
    state.emit('keywords-changed');
}

export function cycleAllDocKeywords() {
    const allResults = state.searchCache._docResults;
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
    renderDocHighlights();
    state.emit('badge-changed');
    goToDocMatch(state.docCurrentMatchIndex);
}

export function performDocSearch(query) {
    if (!state.currentDocUrl || !state.docContentCache[state.currentDocUrl]) return;
    state.allKeywordMode = false;

    const cached = state.docContentCache[state.currentDocUrl];
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const localRegex = new RegExp(`\\b${escaped}\\b`, 'gi');
    const text = cached.text;
    const results = [];
    let match;

    while ((match = localRegex.exec(text)) !== null) {
        const page = state._docPageOffsets ? findPageForIndex(match.index, state._docPageOffsets) : 1;
        results.push({ index: match.index, text: match[0], length: match[0].length, page });
    }

    state.docSearchResults = results;
    state.docCurrentMatchIndex = 0;

    if (results.length > 0) {
        dom.navGroup.classList.add('active');
        dom.navSep.style.display = '';
        dom.matchTotal.textContent = String(results.length);
        (dom.matchInput as HTMLInputElement).max = String(results.length);
        (dom.matchInput as HTMLInputElement).value = '1';
        renderDocHighlights();
        state.emit('badge-changed');
        goToDocMatch(0);
    } else {
        dom.navGroup.classList.remove('active');
        dom.navSep.style.display = 'none';
        dom.matchTotal.textContent = '0';
        dom.matchInput.value = '';
    }
}

export function cycleDocSearch(query) {
    if (!state.currentDocUrl || !state.docContentCache[state.currentDocUrl]) return;
    state.allKeywordMode = false;

    const cached = state.docContentCache[state.currentDocUrl];
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const localRegex = new RegExp(`\\b${escaped}\\b`, 'gi');
    const text = cached.text;
    const results = [];
    let match;

    while ((match = localRegex.exec(text)) !== null) {
        const page = state._docPageOffsets ? findPageForIndex(match.index, state._docPageOffsets) : 1;
        results.push({ index: match.index, text: match[0], length: match[0].length, page });
    }

    if (results.length === 0) return;

    const wasSameQuery = state.docSearchResults.length > 0 && state.docContentCache[state.currentDocUrl]?.lastQuery === query;
    state.docCurrentMatchIndex = (!wasSameQuery) ? 0 : (state.docCurrentMatchIndex + 1) % results.length;
    if (state.docContentCache[state.currentDocUrl]) state.docContentCache[state.currentDocUrl].lastQuery = query;

    state.docSearchResults = results;

    dom.navGroup.classList.add('active');
    dom.navSep.style.display = '';
    dom.matchTotal.textContent = String(results.length);
    (dom.matchInput as HTMLInputElement).max = String(results.length);
    (dom.matchInput as HTMLInputElement).value = String(state.docCurrentMatchIndex + 1);
    renderDocHighlights();
    state.emit('badge-changed');
    goToDocMatch(state.docCurrentMatchIndex);
}

export function renderDocHighlights() {
    const wrapper = dom.viewer.querySelector('.docx-wrapper');
    if (!wrapper || !state._docPageHtmls) return;

    const pageHtmls = state._docPageHtmls;

    // Restore all pages to original HTML
    const pages = wrapper.querySelectorAll('.docx-page');
    pages.forEach((page, i) => {
        if (i < pageHtmls.length) {
            page.innerHTML = pageHtmls[i];
            styleTables(page);
        }
    });

    if (!state.docSearchResults.length) return;

    const currentResult = state.docSearchResults[state.docCurrentMatchIndex];
    if (!currentResult) return;

    // Group results by page
    const resultsByPage = {};
    state.docSearchResults.forEach((r, idx) => {
        const p = r.page || 1;
        if (!resultsByPage[p]) resultsByPage[p] = [];
        resultsByPage[p].push({ ...r, matchIndex: idx });
    });

    // Apply highlights per page — search each page's own text independently
    for (const pageNumStr in resultsByPage) {
        const pageNum = parseInt(pageNumStr);
        const pageEl = document.getElementById('page-' + pageNum);
        if (!pageEl) continue;

        const pageText = state.textPageCache[pageNum]?.text || '';
        const pageResults = resultsByPage[pageNum];

        // Build a single regex matching any of the result texts (word-bounded, matching search)
        const uniqueTerms = [...new Set(pageResults.map(r => r.text))];
        const combinedPattern = uniqueTerms.map(t => '\\b' + (t as string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').join('|');
        const combinedRegex = new RegExp(combinedPattern, 'gi');

        // Walk text nodes
        const walker = document.createTreeWalker(pageEl, NodeFilter.SHOW_TEXT, null as any);
        const nodes = [];
        let node;
        while (node = walker.nextNode()) nodes.push(node);

        let nodeAccum = 0;
        for (const textNode of nodes) {
            combinedRegex.lastIndex = 0;
            const content = textNode.textContent;
            if (combinedRegex.test(content)) {
                combinedRegex.lastIndex = 0;
                const span = document.createElement('span');
                span.innerHTML = content.replace(combinedRegex, match => {
                    const lower = match.toLowerCase();
                    const matchingResult = pageResults.find(r => r.text.toLowerCase() === lower);
                    const isCurrent = matchingResult && matchingResult.matchIndex === state.docCurrentMatchIndex;
                    return `<mark class="doc-highlight${isCurrent ? ' current' : ''}">${match}</mark>`;
                });
                textNode.parentNode.replaceChild(span, textNode);
            }
            nodeAccum += content.length;
        }
    }

    const currentMark = document.querySelector('.doc-highlight.current');
    if (currentMark) {
        currentMark.scrollIntoView({ behavior: state.smoothScrollEnabled ? 'smooth' : 'auto', block: 'center' });
    }
}

export function goToDocMatch(index) {
    if (!state.docSearchResults.length) return;

    state.docCurrentMatchIndex = ((index % state.docSearchResults.length) + state.docSearchResults.length) % state.docSearchResults.length;
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

function getDocTypeFromUrl(url) {
    const dataCached = state.docDataCache[url];
    if (dataCached?.type) return dataCached.type;
    if (dataCached?.name) return getFileTypeSimple(dataCached.name);
    if (state.docContentCache[url]?.type) return state.docContentCache[url].type;
    if (url.includes('.pdf')) return 'pdf';
    if (url.includes('.docx')) return 'docx';
    if (url.includes('.doc')) return 'doc';
    return null;
}

function getFileTypeSimple(filename) {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.pdf')) return 'pdf';
    if (lower.endsWith('.docx')) return 'docx';
    if (lower.endsWith('.doc')) return 'doc';
    return null;
}
