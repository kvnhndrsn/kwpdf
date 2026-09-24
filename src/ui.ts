import { state, beginDocGeneration, beginSearch } from './state';
import * as dom from './dom';
import { fn } from './cross';
import * as ocr from './ocr';
import * as measure from './measure';
import * as keywords from './keywords';
import { searchTextPages, getTextCoords, wrapIndex, countMatchesInAllDocs } from './search-controller';
import type { RenderQuality, RawSearchResult, SearchResult } from './types';

state.renderQuality = (window.localStorage.getItem('pdf_render_quality') as RenderQuality) || 'medium';
state.smoothScrollEnabled = false;
state.mobileSidebarOpen = false;
state.settingsOpen = false;
state.settingsJustToggled = false;
state.inlineSearchActive = false;
state.inlineSearchQuery = '';

let searchOverlay = null;
let searchOverlayInput = null;
let searchOverlayResults = null;
let searchPreviousFocus = null;
let customSearchResults = [];
let customSearchIndex = 0;
let _savedKeyword = '';
let _savedKeywordMode = false;

export function clearSearch() {
    state.allKeywordMode = false;
    state.globalSearchActiveDoc = '';
    state.globalSearchDocIndex = 0;
    state.activeKeyword = '';
    state.searchResults = [];
    state.searchResultsByPage = {};
    state.currentMatchIndex = -1;
    state.docSearchResults = [];
    state.docCurrentMatchIndex = -1;
    state.inlineSearchActive = false;
    state.inlineSearchQuery = '';
    _savedKeyword = '';
    _savedKeywordMode = false;
    dom.navGroup.classList.remove('active');
    dom.navSep.style.display = 'none';
    fn.clearHighlights();
    fn.renderDocHighlights();
    dom.keywordSelect.value = '';
    dom.keywordSelect.innerHTML = '';
    dom.matchInput.value = '';
    dom.matchTotal.textContent = '0';
    if (dom.inlineSearchInput) {
        dom.inlineSearchInput.value = '';
    }
    updateInlineSearchClearBtn();
    state.emit('badge-changed');
    state.emit('heatmaps-changed');
    updateToolbarState();
}

export function clearAllResults() {
    dom.resultsArea.innerHTML = '<div class="drop-zone-empty"><div class="drop-zone-empty-icon"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M24 4L24 32M24 4L16 12M24 4L32 12"/><path d="M8 28L8 40C8 41.1 8.9 42 10 42L38 42C39.1 42 40 41.1 40 40L40 28"/></svg></div><h2 class="drop-zone-empty-title">Drop files to begin scanning</h2><p class="drop-zone-empty-text">PDF &middot; DOCX &middot; ZIP &mdash; any folder or archive</p></div>';

    if (dom.globalSearchInput) {
        dom.globalSearchInput.value = '';
        state.globalSearchQuery = '';
        state.globalSearchResults = {};
        state.globalSearchActiveDoc = '';
        state.globalSearchDocResults = [];
        state.globalSearchDocIndex = 0;
        state._gsPos = -1;
        _gsPendingUrl = null;
    }

    customSearchResults = [];
    customSearchIndex = 0;
    if (searchOverlay) {
        searchOverlay.classList.remove('visible');
    }
    clearCustomHighlights();

    const kwContent = document.getElementById('kwGridContent');
    const kwFilename = document.getElementById('kwGridFilename');
    const kwOcrBtn = document.getElementById('kwGridOcrBtn');
    if (kwContent) kwContent.innerHTML = '<div class="kw-grid-empty">Select a file to view keywords</div>';
    if (kwFilename) kwFilename.textContent = 'No file selected';
    if (kwOcrBtn) kwOcrBtn.style.display = 'none';

    const viewerDropMsg = document.getElementById('viewerDropMsg');
    if (viewerDropMsg) viewerDropMsg.style.display = 'block';
    dom.statusBar.textContent = '';

    if (state.objectUrls) {
        state.objectUrls.forEach(url => {
            URL.revokeObjectURL(url);
            const pdfEntry = state.docTextCache[url];
            if (pdfEntry) {
                state.totalCacheSize -= pdfEntry._size;
                delete state.docTextCache[url];
            }
            const docxEntry = state.docContentCache[url];
            if (docxEntry) {
                state.totalCacheSize -= docxEntry._size;
                delete state.docContentCache[url];
            }
        });
    }
    state.objectUrls = [];
    state.totalMatchesFound = 0;
    state.totalDocsFound = 0;
    state.docDataCache = {};
    state.totalCacheSize = 0;
    state.emit('stats-changed');

    // Invalidate every in-flight document load, render, text extraction and
    // search so nothing can repopulate state after this clear.
    beginDocGeneration();
    beginSearch();
    fn.teardownPdf();

    state.currentDocUrl = '';
    state.currentDocType = 'pdf';
    state.currentScale = 1.0;
    document.documentElement.style.setProperty('--pdf-scale', '1');
    state.currentPage = 1;
    state.totalPages = 0;
    dom.viewer.innerHTML = '';
    state.renderedPages.clear();
    state.renderedScales = {};
    state.pageHeights = {};
    state.searchCache = {};
    clearSearch();
    state.textPageCache = {};
    state._gsPageCacheReady = false;
    state.docSearchResults = [];
    state.docCurrentMatchIndex = -1;
    state._docPageHtmls = null;
    state._docPageOffsets = null;
}

function initSearchOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'searchOverlay';
    overlay.className = 'search-overlay';
    overlay.innerHTML = '<input type="text" id="searchOverlayInput" placeholder="Search PDF... (Esc to close)" autocomplete="off">'
        + '<span class="search-overlay-results" id="searchOverlayResults">0 / 0</span>'
        + '<button class="search-overlay-btn" id="searchOverlayPrev" title="Previous (Shift+F3)" aria-label="Previous (Shift+F3)">&#8592;</button>'
        + '<button class="search-overlay-btn" id="searchOverlayNext" title="Next (F3)" aria-label="Next (F3)">&#8594;</button>'
        + '<button class="search-overlay-btn search-overlay-close" id="searchOverlayClose" title="Close (Esc)" aria-label="Close (Esc)">&#10005;</button>';
    document.querySelector('.viewer-container').appendChild(overlay);
    searchOverlay = overlay;
    searchOverlayInput = document.getElementById('searchOverlayInput');
    searchOverlayResults = document.getElementById('searchOverlayResults');
    document.getElementById('searchOverlayPrev').addEventListener('click', customFindPrev);
    document.getElementById('searchOverlayNext').addEventListener('click', customFindNext);
    document.getElementById('searchOverlayClose').addEventListener('click', closeSearchOverlay);
    searchOverlayInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) customFindPrev();
            else customFindNext();
        }
        if (e.key === 'Escape') closeSearchOverlay();
    });
    searchOverlayInput.addEventListener('input', () => performCustomSearch(searchOverlayInput.value));
}

function updateHeatmap() {}

function updateInlineSearchClearBtn() {
    if (!dom.inlineSearchInput || !dom.inlineSearchClear) return;
    const hasValue = dom.inlineSearchInput.value.length > 0;
    dom.inlineSearchClear.classList.toggle('visible', hasValue);
}

export function focusInlineSearch() {
    if (!dom.inlineSearchInput) {
        showSearchOverlayLegacy();
        return;
    }
    closeMobileSidebar();
    dom.inlineSearchInput.focus();
    dom.inlineSearchInput.select();
}

export function showSearchOverlayLegacy() {
    if (!searchOverlay) initSearchOverlay();
    searchPreviousFocus = document.activeElement;
    searchOverlay.classList.add('visible');
    searchOverlayInput.value = '';
    searchOverlayInput.focus();
    searchOverlayInput.placeholder = state.currentDocUrl && state.docContentCache[state.currentDocUrl]
        ? 'Search document... (Esc to close)' : 'Search PDF... (Esc to close)';

    if (state.currentDocUrl && state.docContentCache[state.currentDocUrl]) {
        state.docSearchResults = [];
        state.docCurrentMatchIndex = 0;
        fn.renderDocHighlights();
    } else {
        customSearchResults = [];
        customSearchIndex = 0;
        clearCustomHighlights();
    }

    searchOverlayResults.textContent = '0 / 0';
    closeMobileSidebar();
}

export function showSearchOverlay() {
    focusInlineSearch();
}

export function closeSearchOverlay() {
    if (searchOverlay) searchOverlay.classList.remove('visible');
    clearCustomHighlights();
    customSearchResults = [];
    customSearchIndex = 0;
    if (searchPreviousFocus) {
        searchPreviousFocus.focus();
        searchPreviousFocus = null;
    }
}

export function clearInlineSearch(restoreKeyword = true) {
    if (dom.inlineSearchInput) {
        dom.inlineSearchInput.value = '';
    }
    updateInlineSearchClearBtn();

    const wasInline = state.inlineSearchActive;
    state.inlineSearchActive = false;
    state.inlineSearchQuery = '';

    if (restoreKeyword && _savedKeyword) {
        state.activeKeyword = _savedKeyword;
        state.allKeywordMode = _savedKeywordMode;
        _savedKeyword = '';
        _savedKeywordMode = false;
        if (state.activeKeyword) {
            if (state.currentDocType === 'pdf') {
                fn.performSearch(state.activeKeyword);
            } else {
                fn.performDocSearch(state.activeKeyword);
            }
        }
        return;
    }

    _savedKeyword = '';
    _savedKeywordMode = false;

    if (wasInline) {
        clearSearch();
    }
}

function performInlineSearch(query) {
    const trimmed = query.trim();

    if (!trimmed) {
        clearInlineSearch(true);
        return;
    }

    if (!state.currentDocUrl) {
        return;
    }

    if (!state.inlineSearchActive) {
        _savedKeyword = state.activeKeyword || '';
        _savedKeywordMode = state.allKeywordMode;
    }

    state.inlineSearchActive = true;
    state.inlineSearchQuery = trimmed;
    state.activeKeyword = '';
    state.allKeywordMode = false;

    if (state.currentDocUrl && state.docContentCache[state.currentDocUrl]) {
        fn.performDocSearch(trimmed);
        updateToolbarState();
        return;
    }

    if (!state.pdfDoc) {
        return;
    }

    const rawResults = searchTextPages(state.textPageCache, state.totalPages, trimmed);

    const mappedResults = [];
    for (const r of rawResults) {
        const cached = state.textPageCache[r.page];
        if (!cached || !cached.items) continue;
        const coords = getTextCoords(cached, r.startIndex, r.endIndex);
        if (!coords) continue;
        mappedResults.push({
            page: r.page,
            x: coords.startX,
            y: coords.startY,
            width: coords.endX - coords.startX,
            height: coords.height
        });
    }

    state.searchResults = mappedResults;
    state.searchResultsByPage = {};
    mappedResults.forEach((r, i) => {
        if (!state.searchResultsByPage[r.page]) state.searchResultsByPage[r.page] = [];
        state.searchResultsByPage[r.page].push({ result: r, globalIndex: i });
    });
    state.currentMatchIndex = 0;

    dom.navGroup.classList.add('active');
    dom.keywordSelect.innerHTML = '';
    const option = document.createElement('option');
    option.value = '__inline__';
    option.textContent = `"${trimmed}" (${mappedResults.length})`;
    option.selected = true;
    option.disabled = true;
    dom.keywordSelect.appendChild(option);

    dom.matchTotal.textContent = String(mappedResults.length);
    dom.navSep.style.display = mappedResults.length > 0 ? 'inline' : 'none';

    state.emit('badge-changed');
    updateToolbarState();

    if (mappedResults.length > 0) {
        fn.renderAllHighlights();
        goToMatch(0);
    } else {
        fn.clearHighlights();
        dom.matchInput.value = '';
    }
}

function performCustomSearch(query) {
    if (state.currentDocUrl && state.docContentCache[state.currentDocUrl]) {
        if (!query) {
            state.docSearchResults = [];
            state.docCurrentMatchIndex = 0;
            searchOverlayResults.textContent = '0 / 0';
            fn.renderDocHighlights();
            return;
        }
        fn.performDocSearch(query);
        if (state.docSearchResults.length > 0) {
            searchOverlayResults.textContent = (state.docCurrentMatchIndex + 1) + ' / ' + state.docSearchResults.length;
        } else {
            searchOverlayResults.textContent = '0 / 0';
        }
        return;
    }

    if (!query || !state.pdfDoc) {
        customSearchResults = [];
        customSearchIndex = 0;
        searchOverlayResults.textContent = '0 / 0';
        clearCustomHighlights();
        return;
    }

    const rawResults = searchTextPages(state.textPageCache, state.totalPages, query);

    customSearchResults = rawResults;
    customSearchIndex = 0;

    if (rawResults.length > 0) {
        if (searchOverlayResults) searchOverlayResults.textContent = '1 / ' + rawResults.length;
        customGoToMatch(0);
    } else {
        if (searchOverlayResults) searchOverlayResults.textContent = '0 / 0';
        clearCustomHighlights();
    }
}

async function customGoToMatch(index) {
    if (customSearchResults.length === 0) return;

    customSearchIndex = wrapIndex(index, customSearchResults.length);
    if (searchOverlayResults) searchOverlayResults.textContent = (customSearchIndex + 1) + ' / ' + customSearchResults.length;

    const result = customSearchResults[customSearchIndex];

    await fn.renderPageNow(result.page);
    scrollToPage(result.page);
    renderAllCustomHighlights();
}

function renderAllCustomHighlights() {
    clearCustomHighlights();
    if (customSearchResults.length === 0) return;

    const currentResult = customSearchResults[customSearchIndex];
    const currentPage = currentResult.page;

    for (let i = 0; i < customSearchResults.length; i++) {
        const result = customSearchResults[i];
        if (result.page !== currentPage) continue;

        const pageEl = document.getElementById('page-' + result.page);
        if (!pageEl) continue;

        const cached = state.textPageCache[result.page];
        if (!cached || !cached.items) continue;

        const coords = getTextCoords(cached, result.startIndex, result.endIndex);
        if (!coords) continue;

        const mark = document.createElement('div');
        mark.className = 'custom-highlight' + (i === customSearchIndex ? ' current' : '');
        mark.style.left = (coords.startX * state.currentScale) + 'px';
        mark.style.top = (coords.startY * state.currentScale) + 'px';
        mark.style.width = ((coords.endX - coords.startX) * state.currentScale) + 'px';
        mark.style.height = (coords.height * state.currentScale) + 'px';
        pageEl.appendChild(mark);
    }

    const currentResultCoords = getTextCoords(state.textPageCache[currentPage], currentResult.startIndex, currentResult.endIndex);
    if (currentResultCoords) {
        const halfViewport = dom.viewerScroll.clientHeight / 2;
        const halfHeight = (currentResultCoords.height * state.currentScale) / 2;
        const pageEl = document.getElementById('page-' + currentPage);
        const targetTop = pageEl.offsetTop + currentResultCoords.startY * state.currentScale - halfViewport + halfHeight;
        dom.viewerScroll.scrollTo({ top: Math.max(0, targetTop), behavior: state.smoothScrollEnabled ? 'smooth' : 'auto' });
    }
}

function clearCustomHighlights() {
    document.querySelectorAll('.custom-highlight').forEach(el => el.remove());
}

function customFindNext() {
    if (state.currentDocUrl && state.docContentCache[state.currentDocUrl]) {
        const query = searchOverlayInput.value;
        if (query && state.docSearchResults.length > 0) {
            fn.cycleDocSearch(query);
            if (state.docSearchResults.length > 0) {
                searchOverlayResults.textContent = (state.docCurrentMatchIndex + 1) + ' / ' + state.docSearchResults.length;
            }
        }
        return;
    }

    if (customSearchResults.length > 0) customGoToMatch(customSearchIndex + 1);
}

function customFindPrev() {
    if (state.currentDocUrl && state.docContentCache[state.currentDocUrl]) {
        if (state.docSearchResults.length > 0) {
            state.docCurrentMatchIndex = (state.docCurrentMatchIndex - 1 + state.docSearchResults.length) % state.docSearchResults.length;
            fn.goToDocMatch(state.docCurrentMatchIndex);
            searchOverlayResults.textContent = (state.docCurrentMatchIndex + 1) + ' / ' + state.docSearchResults.length;
        }
        return;
    }

    if (customSearchResults.length > 0) customGoToMatch(customSearchIndex - 1);
}

export function toggleTheme() {
    const html = document.documentElement;
    html.classList.add('transitioning');
    if (html.getAttribute('data-theme') === 'light') {
        html.setAttribute('data-theme', 'dark');
        localStorage.setItem('pdf_theme', 'dark');
    } else {
        html.setAttribute('data-theme', 'light');
        localStorage.setItem('pdf_theme', 'light');
    }
    if (dom.settingsThemeBtn) {
        dom.settingsThemeBtn.innerHTML = '&#9728; ' + (html.getAttribute('data-theme') === 'light' ? 'Dark Mode' : 'Light Mode');
    }
    setTimeout(() => html.classList.remove('transitioning'), 850);
}

function updateSettingsMenu() {
    const html = document.documentElement;
    const isLight = html.getAttribute('data-theme') === 'light';
    dom.settingsThemeBtn.innerHTML = '&#9728; ' + (isLight ? 'Dark Mode' : 'Light Mode');
    dom.settingsAnimateBtn.classList.toggle('on', state.smoothScrollEnabled);
    const stateEl = dom.settingsAnimateBtn.querySelector('.toggle-state');
    if (stateEl) stateEl.textContent = state.smoothScrollEnabled ? 'ON' : 'OFF';
    dom.settingsMenu.querySelectorAll('.settings-menu-quality-btn').forEach(b => {
        b.classList.toggle('active', (b as HTMLElement).dataset.quality === state.renderQuality);
    });
}

function closeSettings() {
    dom.settingsMenu.classList.remove('visible');
    state.settingsOpen = false;
    document.removeEventListener('click', closeSettingsOnClickOutside);
    if (state._settingsPreviousFocus) {
        state._settingsPreviousFocus.focus();
        state._settingsPreviousFocus = null;
    }
}

export function toggleSettings(e?: any) {
    state.settingsOpen = !state.settingsOpen;

    if (!state.settingsOpen) {
        closeSettings();
        return;
    }

    state._settingsPreviousFocus = document.activeElement as HTMLElement | null;
    state.settingsJustToggled = true;
    const rect = dom.settingsBtn.getBoundingClientRect();
    dom.settingsMenu.style.left = rect.left + 'px';
    dom.settingsMenu.style.top = (rect.bottom + 4) + 'px';
    updateSettingsMenu();
    dom.settingsMenu.classList.add('visible');

    const firstFocusable = dom.settingsMenu.querySelector('button, a, input, select');
    if (firstFocusable) (firstFocusable as HTMLElement).focus();

    setTimeout(() => {
        document.addEventListener('click', closeSettingsOnClickOutside);
    }, 0);
}

function closeSettingsOnClickOutside(e) {
    if (state.settingsJustToggled) {
        state.settingsJustToggled = false;
        return;
    }
    if (!dom.settingsMenu.contains(e.target) && e.target !== dom.settingsBtn) {
        closeSettings();
    }
}

function toggleAnimate() {
    state.smoothScrollEnabled = !state.smoothScrollEnabled;
    localStorage.setItem('pdf_smooth_scroll', String(state.smoothScrollEnabled));
    const stateEl = dom.settingsAnimateBtn?.querySelector('.toggle-state');
    if (stateEl) stateEl.textContent = state.smoothScrollEnabled ? 'ON' : 'OFF';
}

export function closeMobileSidebar() {
    if (window.innerWidth > 600) {
        const sidebarEl = document.getElementById('sidebar');
        sidebarEl.classList.remove('collapsed', 'open');
        state.mobileSidebarOpen = false;
        return;
    }
    const sidebarEl = document.getElementById('sidebar');
    const viewerEl = document.querySelector('.viewer-container');
    sidebarEl.classList.remove('open');
    sidebarEl.classList.add('collapsed');
    (viewerEl as HTMLElement).style.height = 'calc(100% - 44px)';
    state.mobileSidebarOpen = false;
}

function openMobileSidebar() {
    if (window.innerWidth > 600) return;
    const sidebarEl = document.getElementById('sidebar');
    const viewerEl = document.querySelector('.viewer-container');
    sidebarEl.classList.add('open');
    sidebarEl.classList.remove('collapsed');
    (viewerEl as HTMLElement).style.height = 'calc(100% - 44px)';
    state.mobileSidebarOpen = true;
}

export function toggleMobileSidebar() {
    if (state.mobileSidebarOpen) closeMobileSidebar();
    else openMobileSidebar();
}

function checkMobileLayout() {
    const isMobile = window.innerWidth <= 600;
    const sidebarEl = document.getElementById('sidebar');
    const toggleBtn = document.querySelector('.mobile-toggle-sidebar');
    const viewerEl = document.querySelector('.viewer-container');
    if (toggleBtn) (toggleBtn as HTMLElement).style.display = isMobile ? 'flex' : 'none';
    if (!isMobile) {
        sidebarEl.classList.remove('collapsed', 'open');
        (viewerEl as HTMLElement).style.height = '';
        sidebarEl.style.height = '';
        state.mobileSidebarOpen = false;
    } else if (!state.mobileSidebarOpen) {
        sidebarEl.classList.add('collapsed');
        sidebarEl.classList.remove('open');
        (viewerEl as HTMLElement).style.height = 'calc(100% - 44px)';
    }
}

export function zoomIn() { fn.setZoom(state.currentScale + 0.15); }
export function zoomOut() { fn.setZoom(state.currentScale - 0.15); }

function zoomFit() {
    if (!state.pdfDoc || state.totalPages === 0) return;
    state.pdfDoc.getPage(1).then(page => {
        const viewport = page.getViewport({ scale: 1.0 });
        const containerWidth = dom.viewerScroll.clientWidth - 32;
        const fitScale = Math.max(0.5, Math.min(4.0, containerWidth / viewport.width));
        fn.setZoom(fitScale);
    });
}

function zoomActual() { fn.setZoom(1.0, true); }

function scrollToPage(pageNum) {
    const pageEl = document.getElementById('page-' + pageNum);
    let targetOffset = 0;
    if (pageEl) {
        targetOffset = pageEl.offsetTop;
    } else {
        for (let i = 1; i < pageNum; i++) {
            targetOffset += (state.pageHeights[i] * state.currentScale || 800) + 32;
        }
    }
    const behavior = state.smoothScrollEnabled && !state.isNavigating ? 'smooth' : 'auto';
    state.isNavigating = true;
    dom.viewerScroll.scrollTo({ top: targetOffset, behavior });
    state.currentPage = pageNum;
    updatePageInfo();
    setTimeout(() => { state.isNavigating = false; }, 100);
}

export function updatePageInfo() {
    dom.pageInput.value = String(state.currentPage);
    dom.pageInput.placeholder = state.totalPages > 0 ? String(state.currentPage) : '0';
    updateToolbarState();
}

export function updateZoomDisplay() {
    dom.zoomLevelEl.textContent = Math.round(state.currentScale * 100) + '%';
    updateToolbarState();
}

export function updateToolbarState() {
    const hasDoc = !!state.currentDocUrl;
    const hasDocx = state.currentDocType !== 'pdf' && hasDoc;
    const hasPdf = state.currentDocType === 'pdf' && hasDoc;

    (dom.zoomOutBtn as HTMLButtonElement).disabled = !hasDoc || state.currentScale <= 0.5;
    (dom.zoomInBtn as HTMLButtonElement).disabled = !hasDoc || state.currentScale >= 4.0;
    (dom.zoomFitBtn as HTMLButtonElement).disabled = !hasPdf;
    (dom.zoomActualBtn as HTMLButtonElement).disabled = !hasDoc;

    (dom.prevPageBtn as HTMLButtonElement).disabled = !hasDoc || state.currentPage <= 1;
    (dom.nextPageBtn as HTMLButtonElement).disabled = !hasDoc || state.currentPage >= state.totalPages;
    (dom.pageInput as HTMLInputElement).disabled = !hasDoc;

    const hasResults = (state.currentDocType === 'pdf' ? state.searchResults.length : state.docSearchResults.length) > 0;

    if (dom.searchToggleBtn) (dom.searchToggleBtn as HTMLButtonElement).disabled = !hasDoc;
    if (dom.inlineSearchInput) (dom.inlineSearchInput as HTMLInputElement).disabled = !hasDoc;
    if (dom.inlineSearchClear) (dom.inlineSearchClear as HTMLButtonElement).disabled = !hasDoc;
    (dom.keywordSelect as HTMLSelectElement).disabled = !hasDoc || dom.keywordSelect.options.length === 0;
    (dom.findPrevBtn as HTMLButtonElement).disabled = !hasResults;
    (dom.findNextBtn as HTMLButtonElement).disabled = !hasResults;
    (dom.clearSearchBtn as HTMLButtonElement).disabled = !hasResults && !state.activeKeyword && !state.inlineSearchActive;
    (dom.matchInput as HTMLInputElement).disabled = !hasResults;

    (dom.calibrateScaleBtn as HTMLButtonElement).disabled = !hasDoc;
    (dom.measureDistBtn as HTMLButtonElement).disabled = !hasDoc;
    (dom.measurePerimBtn as HTMLButtonElement).disabled = !hasDoc;
    (dom.measureAreaBtn as HTMLButtonElement).disabled = !hasDoc;
    (dom.clearMeasureBtn as HTMLButtonElement).disabled = !document.querySelector('.measure-line');
    (dom.scaleInput as HTMLInputElement).disabled = !hasDoc;
}

export function goToMatch(index) {
    if (state.searchResults.length === 0) return;

    const prevIndex = state.currentMatchIndex;
    state.currentMatchIndex = wrapIndex(index, state.searchResults.length);
    dom.matchInput.value = String(state.currentMatchIndex + 1);
    state.emit('badge-changed');
    updateHeatmap();

    const result = state.searchResults[state.currentMatchIndex];

    fn.renderPageNow(result.page).then(() => {
        const pageEl = document.getElementById('page-' + result.page);
        if (pageEl) {
            const targetTop = pageEl.offsetTop + result.y * state.currentScale - (dom.viewerScroll.clientHeight / 2);
            dom.viewerScroll.scrollTo({ top: Math.max(0, targetTop), behavior: state.smoothScrollEnabled ? 'smooth' : 'auto' });
        }
        fn.updateCurrentMatch(prevIndex, state.currentMatchIndex);
        updateHeatmap();
    });

    fn.startPrerender();
    updateToolbarState();
}

export function findNext() {
    if (state.currentDocType === 'pdf' && state.searchResults.length > 0) {
        goToMatch(state.currentMatchIndex + 1);
    } else if (state.docSearchResults.length > 0) {
        fn.goToDocMatch(state.docCurrentMatchIndex + 1);
        updateToolbarState();
    }
}

export function findPrev() {
    if (state.currentDocType === 'pdf' && state.searchResults.length > 0) {
        goToMatch(state.currentMatchIndex - 1);
    } else if (state.docSearchResults.length > 0) {
        fn.goToDocMatch(state.docCurrentMatchIndex - 1);
        updateToolbarState();
    }
}

function prevPage() {
    if (state.currentPage > 1) {
        state.currentPage--;
        scrollToPage(state.currentPage);
    }
}

function nextPage() {
    if (state.currentPage < state.totalPages) {
        state.currentPage++;
        scrollToPage(state.currentPage);
    }
}

function getTouchDist(e) {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
}

export function setupEventListeners() {
    window.addEventListener('resize', checkMobileLayout);

    /* Toolbar & sidebar buttons */
    dom.zoomOutBtn?.addEventListener('click', zoomOut);
    dom.zoomInBtn?.addEventListener('click', zoomIn);
    dom.zoomFitBtn?.addEventListener('click', zoomFit);
    dom.zoomActualBtn?.addEventListener('click', zoomActual);
    dom.prevPageBtn?.addEventListener('click', prevPage);
    dom.nextPageBtn?.addEventListener('click', nextPage);
    dom.searchToggleBtn?.addEventListener('click', showSearchOverlay);
    dom.findPrevBtn?.addEventListener('click', findPrev);
    dom.findNextBtn?.addEventListener('click', findNext);
    dom.clearSearchBtn?.addEventListener('click', clearSearch);
    dom.clearAllBtn?.addEventListener('click', clearAllResults);
    dom.kwManageBtn?.addEventListener('click', (e) => {
        keywords.toggleKeywordManager(e);
    });
    dom.settingsBtn?.addEventListener('click', toggleSettings);
    dom.mobileToggleBtn?.addEventListener('click', toggleMobileSidebar);

    /* Settings menu buttons */
    dom.settingsKwBtn?.addEventListener('click', () => {
        toggleSettings();
        keywords.toggleKeywordManager();
    });
    dom.settingsThemeBtn?.addEventListener('click', () => {
        toggleTheme();
        updateSettingsMenu();
    });
    dom.settingsAnimateBtn?.addEventListener('click', function() {
        this.classList.toggle('on');
        toggleAnimate();
    });
    dom.settingsMenu?.addEventListener('click', (e) => {
        const qualityBtn = (e.target as HTMLElement).closest('.settings-menu-quality-btn');
        if (!qualityBtn) return;
        state.settingsJustToggled = true;
        fn.setRenderQuality((qualityBtn as HTMLElement).dataset.quality);
        dom.settingsMenu.querySelectorAll('.settings-menu-quality-btn').forEach(b => {
            b.classList.toggle('active', b === qualityBtn);
        });
    });

    initGlobalSearch();

    dom.statusBar.innerHTML = '<span>Ready</span><span>#' + __BUNDLE_HASH__ + ' ' + __COMMIT_DATE__ + '</span>';
    updateToolbarState();

    /* Measurement toolbar buttons */
    dom.calibrateScaleBtn?.addEventListener('click', () => {
        measure.startCalibration();
        updateMeasureUI();
    });
    dom.measureDistBtn?.addEventListener('click', () => {
        const tool = measure.getActiveTool();
        if (tool === 'distance') measure.deactivateTool();
        else measure.activateTool('distance');
        updateMeasureUI();
    });
    dom.measurePerimBtn?.addEventListener('click', () => {
        const tool = measure.getActiveTool();
        if (tool === 'perimeter') measure.deactivateTool();
        else measure.activateTool('perimeter');
        updateMeasureUI();
    });
    dom.measureAreaBtn?.addEventListener('click', () => {
        const tool = measure.getActiveTool();
        if (tool === 'area') measure.deactivateTool();
        else measure.activateTool('area');
        updateMeasureUI();
    });
    dom.clearMeasureBtn?.addEventListener('click', () => {
        measure.clearAllMeasurements();
        updateMeasureUI();
    });

    dom.viewerScroll.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
            state.touchStartDist = getTouchDist(e);
            state.touchStartScale = state.currentScale;
        }
    }, { passive: true });

    dom.viewerScroll.addEventListener('touchmove', (e) => {
        if (e.touches.length === 2) {
            e.preventDefault();
            const dist = getTouchDist(e);
            const ratio = dist / state.touchStartDist;
            const newScale = Math.max(0.5, Math.min(4.0, state.touchStartScale * ratio));
            if (Math.abs(newScale - state.currentScale) > 0.01) fn.setZoom(newScale);
        }
    }, { passive: false });

    const savedSmooth = localStorage.getItem('pdf_smooth_scroll');
    if (savedSmooth !== null) state.smoothScrollEnabled = savedSmooth === 'true';

    dom.viewerScroll.addEventListener('wheel', (e) => {
        if (e.ctrlKey) {
            e.preventDefault();
            const delta = e.deltaY > 0 ? -0.1 : 0.1;
            fn.setZoom(state.currentScale + delta);
        }
    }, { passive: false });

    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && (e.key === '+' || e.key === '=')) { e.preventDefault(); zoomIn(); }
        if (e.ctrlKey && e.key === '-') { e.preventDefault(); zoomOut(); }
        if (e.ctrlKey && e.key === 'f') { e.preventDefault(); showSearchOverlay(); }
        if (e.key === 'F3' && !e.shiftKey) { e.preventDefault(); showSearchOverlay(); }
        if (e.key === 'F3' && e.shiftKey) {
            e.preventDefault();
            if (searchOverlay && searchOverlay.classList.contains('visible')) customFindPrev();
        }
        if (e.key === 'g' && !e.ctrlKey && !/^(INPUT|TEXTAREA|SELECT)$/i.test(document.activeElement.tagName) && document.activeElement.getAttribute('contenteditable') !== 'true' && !document.activeElement.closest?.('.custom-dropdown')) {
            e.preventDefault();
            dom.pageInput.focus();
            dom.pageInput.select();
        }
        if (e.key === 'Escape') {
            if (state.settingsOpen) {
                closeSettings();
                return;
            }
            const kwMenu = document.getElementById('keywordMenu');
            if (kwMenu && kwMenu.classList.contains('visible')) {
                keywords.toggleKeywordManager();
            }
            dom.pageInput.blur();
            dom.matchInput.blur();
            closeMobileSidebar();
            closeSearchOverlay();
            if (measure.getIsCalibrating()) {
                measure.cancelCalibration();
                updateMeasureUI();
            } else if (measure.getActiveTool()) {
                measure.deactivateTool();
                updateMeasureUI();
            }
        }
        if (e.key === 'Enter' && (measure.getActiveTool() === 'perimeter' || measure.getActiveTool() === 'area')) {
            if (measure.getActiveTool() === 'perimeter') measure.finishPerimeter();
            else measure.finishArea();
            updateMeasureUI();
        }
    });

    dom.pageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const num = parseInt(dom.pageInput.value);
            if (num >= 1 && num <= state.totalPages) { scrollToPage(num); dom.pageInput.blur(); }
        }
    });

    dom.pageInput.addEventListener('blur', () => { (dom.pageInput as HTMLInputElement).value = String(state.currentPage); });

    dom.matchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const num = parseInt(dom.matchInput.value);
            if (num >= 1 && num <= state.searchResults.length) { goToMatch(num - 1); dom.matchInput.blur(); }
            else if (num >= 1 && num <= state.docSearchResults.length) { fn.goToDocMatch(num - 1); dom.matchInput.blur(); }
        }
    });

    (dom.matchInput as HTMLInputElement).addEventListener('blur', () => {
        if (state.searchResults.length > 0) (dom.matchInput as HTMLInputElement).value = String(state.currentMatchIndex + 1);
        else if (state.docSearchResults.length > 0) (dom.matchInput as HTMLInputElement).value = String(state.docCurrentMatchIndex + 1);
    });

    dom.keywordSelect.addEventListener('change', async () => {
        if (dom.keywordSelect.value && dom.keywordSelect.value !== '__inline__') {
            clearInlineSearch(false);
            if (state.currentDocType === 'pdf') await fn.performSearch(dom.keywordSelect.value);
            else await fn.performDocSearch(dom.keywordSelect.value);
            updateToolbarState();
        }
    });

    if (dom.inlineSearchInput) {
        let inlineSearchTimer = null;

        dom.inlineSearchInput.addEventListener('input', () => {
            updateInlineSearchClearBtn();
            if (inlineSearchTimer) clearTimeout(inlineSearchTimer);
            inlineSearchTimer = setTimeout(() => {
                performInlineSearch(dom.inlineSearchInput.value);
            }, 150);
        });

        dom.inlineSearchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (inlineSearchTimer) {
                    clearTimeout(inlineSearchTimer);
                    inlineSearchTimer = null;
                    performInlineSearch(dom.inlineSearchInput.value);
                }
                if (e.shiftKey) {
                    findPrev();
                } else {
                    findNext();
                }
            } else if (e.key === 'Escape') {
                if (!dom.inlineSearchInput.value) {
                    clearInlineSearch(true);
                }
                dom.inlineSearchInput.blur();
            }
        });
    }

    if (dom.inlineSearchClear) {
        dom.inlineSearchClear.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            clearInlineSearch(true);
            if (dom.inlineSearchInput) dom.inlineSearchInput.focus();
        });
    }

    let _scrollRAF = null;
    dom.viewerScroll.addEventListener('scroll', () => {
        if (_scrollRAF) return;
        _scrollRAF = requestAnimationFrame(() => {
            _scrollRAF = null;
            if (!dom.viewer.children.length) return;
            if (state.isNavigating) return;

            const scrollTop = dom.viewerScroll.scrollTop;
            const containerHeight = dom.viewerScroll.clientHeight;
            const scrollHeight = dom.viewerScroll.scrollHeight;
            const midPoint = scrollTop + containerHeight / 2;

            let detectedPage = null;
            for (let i = 1; i <= state.totalPages; i++) {
                const pageEl = document.getElementById('page-' + i);
                if (!pageEl) continue;
                const pageTop = pageEl.offsetTop;
                const pageBottom = pageTop + pageEl.offsetHeight;
                if (midPoint < pageBottom) { detectedPage = i; break; }
            }

            if (!detectedPage && scrollTop + containerHeight >= scrollHeight - 50) detectedPage = state.totalPages;
            if (detectedPage && detectedPage !== state.currentPage) { state.currentPage = detectedPage; updatePageInfo(); }
            if (state.searchResults.length > 0) updateHeatmap();
        });
    });

    const resizer = document.getElementById('resizer');
    const sidebarEl = document.getElementById('sidebar');
    resizer.addEventListener('mousedown', (e) => {
        e.preventDefault();
        document.body.classList.add('dragging');
        const startX = e.clientX;
        const startWidth = sidebarEl.offsetWidth;
        const onMove = (e) => {
            const width = startWidth + (e.clientX - startX);
            if (width > 150 && width < 900) { sidebarEl.style.width = width + 'px'; sidebarEl.style.flexBasis = width + 'px'; }
        };
        const onUp = () => {
            document.body.classList.remove('dragging');
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    });

    const viewerContainer = document.querySelector('.viewer-container');
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(name => {
        viewerContainer.addEventListener(name, (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (name === 'dragover') (viewerContainer as HTMLElement).style.background = 'var(--grey-700)';
            if (name === 'dragleave' || name === 'drop') (viewerContainer as HTMLElement).style.background = '';
        }, false);
    });

    viewerContainer.addEventListener('drop', (e) => { fn.handleDrop(e); });

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(name => {
        dom.sidebar.addEventListener(name, (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (name === 'dragenter') dom.sidebar.classList.add('drag-over');
            if ((name === 'dragleave' && !dom.sidebar.contains((e as DragEvent).relatedTarget as Node)) || name === 'drop') dom.sidebar.classList.remove('drag-over');
        }, false);
    });

    if (dom.scaleInput) {
        const updateScale = () => {
            if (measure.getIsCalibrating()) {
                const val = dom.scaleInput.value.trim();
                if (val && !isNaN(parseFloat(val))) {
                } else {
                    dom.scaleInput.value = '';
                }
                return;
            }
            const numStr = dom.scaleInput.value.replace(/.*:/, '').replace(/[^0-9.]/g, '');
            const parsed = parseFloat(numStr);
            if (!isNaN(parsed) && parsed >= 0.001) {
                dom.scaleInput.value = '1:' + parsed;
                measure.setScale(parsed);
                measure.renderAllMeasurements();
            }
        };
        dom.scaleInput.addEventListener('change', updateScale);
        dom.scaleInput.addEventListener('blur', updateScale);
        dom.scaleInput.addEventListener('focus', () => {
            if (measure.getIsCalibrating()) {
                dom.scaleInput.select();
            } else {
                dom.scaleInput.value = '';
            }
        });
        dom.scaleInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && measure.getIsCalibrating()) {
                e.preventDefault();
                dom.scaleInput.blur();
            }
        });
        dom.scaleInput.value = '1:' + measure.getScale();
    }

    dom.viewerScroll.addEventListener('click', (e) => {
        measure.onPageClick(e);
        updateMeasureUI();
    });

    dom.viewerScroll.addEventListener('dblclick', (e) => {
        const tool = measure.getActiveTool();
        if (tool === 'perimeter') {
            measure.finishPerimeter();
            updateMeasureUI();
        } else if (tool === 'area') {
            measure.finishArea();
            updateMeasureUI();
        }
    });
}

export function updateMeasureUI() {
    const active = measure.getActiveTool();
    const calibrating = measure.getIsCalibrating();
    dom.measureDistBtn?.classList.toggle('active-tool', active === 'distance');
    dom.measurePerimBtn?.classList.toggle('active-tool', active === 'perimeter');
    dom.measureAreaBtn?.classList.toggle('active-tool', active === 'area');
    dom.calibrateScaleBtn?.classList.toggle('active-tool', calibrating);
    updateToolbarState();
}

window.addEventListener('beforeunload', () => {
    if (state.objectUrls) {
        state.objectUrls.forEach(url => URL.revokeObjectURL(url));
        state.objectUrls = [];
    }
});

(function initTheme() {
    const savedTheme = localStorage.getItem('pdf_theme');
    if (savedTheme === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
    } else {
        document.documentElement.setAttribute('data-theme', 'light');
        if (!savedTheme) localStorage.setItem('pdf_theme', 'light');
    }
})();

state.touchStartDist = 0;
state.touchStartScale = 1.0;
state.pageObserver = null;

// ── Global search across all loaded files ──

let globalSearchTimer = null;
let _gsPendingUrl = null;
let _gsCancelRef = { cancelled: false };

export function activateGlobalSearch(navigateToLast?: any, noScroll?: any) {
    const query = state.globalSearchQuery;
    if (!query) return;

    if (state.currentDocUrl && state.docContentCache[state.currentDocUrl]) {
        fn.performDocSearch(query);
        state.globalSearchDocResults = state.docSearchResults;
        state.globalSearchDocIndex = state.docCurrentMatchIndex;
        if (navigateToLast && state.docSearchResults.length > 0) {
            fn.goToDocMatch(state.docSearchResults.length - 1);
            state.globalSearchDocIndex = state.docCurrentMatchIndex;
        }
        return;
    }

    if (!state.pdfDoc) return;

    const results = searchTextPages(state.textPageCache, state.totalPages, query);

    customSearchResults = results;
    customSearchIndex = noScroll ? -1 : 0;
    state.globalSearchDocResults = results as unknown as SearchResult[];
    state.globalSearchDocIndex = 0;

    if (results.length > 0) {
        if (noScroll) {
            // populate state without scrolling
            clearCustomHighlights();
        } else if (navigateToLast) {
            customGoToMatch(results.length - 1);
            state.globalSearchDocIndex = customSearchIndex;
        } else {
            customGoToMatch(0);
        }
    } else {
        clearCustomHighlights();
    }
}

function _findCustomResultAfterScroll() {
    const scrollTop = dom.viewerScroll.scrollTop;
    const viewportCenter = scrollTop + dom.viewerScroll.clientHeight / 2;
    for (let i = 0; i < customSearchResults.length; i++) {
        const r = customSearchResults[i];
        const pageEl = document.getElementById('page-' + r.page);
        if (!pageEl) continue;
        const cached = state.textPageCache[r.page];
        if (!cached || !cached.items) continue;
        const coords = getTextCoords(cached, r.startIndex, r.endIndex);
        if (!coords) continue;
        const resultTop = pageEl.offsetTop + coords.startY * state.currentScale;
        if (resultTop > viewportCenter + 5) return i;
    }
    return -1;
}

function _findCustomResultBeforeScroll() {
    const scrollTop = dom.viewerScroll.scrollTop;
    const viewportCenter = scrollTop + dom.viewerScroll.clientHeight / 2;
    let bestIdx = -1;
    for (let i = 0; i < customSearchResults.length; i++) {
        const r = customSearchResults[i];
        const pageEl = document.getElementById('page-' + r.page);
        if (!pageEl) continue;
        const cached = state.textPageCache[r.page];
        if (!cached || !cached.items) continue;
        const coords = getTextCoords(cached, r.startIndex, r.endIndex);
        if (!coords) continue;
        const resultTop = pageEl.offsetTop + coords.startY * state.currentScale;
        if (resultTop < viewportCenter - 5) bestIdx = i;
    }
    return bestIdx;
}

export function cycleGlobalSearch() {
    if (state.currentDocUrl && state.docContentCache[state.currentDocUrl]) {
        fn.findNext();
        state.globalSearchDocIndex = state.docCurrentMatchIndex;
        state.globalSearchDocResults = state.docSearchResults;
        return;
    }

    if (customSearchResults.length > 0) {
        customGoToMatch(customSearchIndex + 1);
        state.globalSearchDocIndex = customSearchIndex;
        state.globalSearchDocResults = [...customSearchResults];
    }
}

export function cycleGlobalSearchPrev() {
    if (state.currentDocUrl && state.docContentCache[state.currentDocUrl]) {
        fn.findPrev();
        state.globalSearchDocIndex = state.docCurrentMatchIndex;
        state.globalSearchDocResults = state.docSearchResults;
        return;
    }

    if (customSearchResults.length > 0) {
        customGoToMatch(customSearchIndex - 1);
        state.globalSearchDocIndex = customSearchIndex;
        state.globalSearchDocResults = [...customSearchResults];
    }
}

let _gsPendingNavigate = 0;

function _gsNavigate(dir) {
    if (!state.globalSearchQuery) return;

    // Still waiting for a previous file jump to complete
    if (_gsPendingUrl) return;

    const docUrls = Object.keys(state.globalSearchResults)
        .filter(url => state.globalSearchResults[url] > 0)
        .sort((a, b) => {
            const nameA = (state.docDataCache[a]?.name || a).toLowerCase();
            const nameB = (state.docDataCache[b]?.name || b).toLowerCase();
            return nameA.localeCompare(nameB);
        });

    if (docUrls.length === 0) return;

    // Detect if we're at the start/end of results in the current file
    let atEnd = false, atStart = false;
    if (state.currentDocUrl && state.docContentCache[state.currentDocUrl]) {
        atEnd = state.docCurrentMatchIndex >= state.docSearchResults.length - 1;
        atStart = state.docCurrentMatchIndex <= 0;
    } else if (customSearchResults.length > 0) {
        atEnd = customSearchIndex >= customSearchResults.length - 1;
        atStart = customSearchIndex <= 0;
    } else {
        atEnd = atStart = true;
    }

    if (dir > 0 && !atEnd) {
        cycleGlobalSearch();
        state.emit('results-changed');
        return;
    }
    if (dir < 0 && !atStart) {
        cycleGlobalSearchPrev();
        state.emit('results-changed');
        return;
    }

    // Per-file state is empty (fresh search) — activate in current file if it has results
    if (state.currentDocUrl && state.globalSearchResults[state.currentDocUrl] > 0) {
        state.globalSearchActiveDoc = state.currentDocUrl;
        if (state.currentDocUrl && state.docContentCache[state.currentDocUrl]) {
            activateGlobalSearch(dir < 0);
        } else {
            activateGlobalSearch(false, true);
            if (dir > 0) cycleGlobalSearch();
            else cycleGlobalSearchPrev();
        }
        state.emit('results-changed');
        return;
    }

    // No more results in current file — jump to next/prev file
    if (state._gsPos < 0) {
        state._gsPos = dir > 0 ? 0 : docUrls.length - 1;
    } else {
        state._gsPos = ((state._gsPos + dir) % docUrls.length + docUrls.length) % docUrls.length;
    }
    _gsJumpToDoc(docUrls[state._gsPos], dir < 0);
}

export function performGlobalSearch(query) {
    if (globalSearchTimer) {
        clearTimeout(globalSearchTimer);
        globalSearchTimer = null;
    }
    _gsCancelRef.cancelled = true;
    _gsCancelRef = { cancelled: false };
    _gsPendingUrl = null;
    _gsPendingNavigate = 0;

    const trimmed = query.trim();
    if (!trimmed) {
        state.globalSearchQuery = '';
        state.globalSearchResults = {};
        state.emit('stats-changed');
        state.emit('results-changed');
        return;
    }

    state.globalSearchQuery = trimmed;
    state.globalSearchResults = {};
    state.globalSearchActiveDoc = '';
    state.globalSearchDocResults = [];
    state.globalSearchDocIndex = 0;
    state.docSearchResults = [];
    state.docCurrentMatchIndex = -1;
    customSearchResults = [];
    customSearchIndex = 0;
    state.searchResults = [];
    state.currentMatchIndex = -1;
    state._gsPos = -1;

    const totalFiles = Object.keys(state.docDataCache).length;
    dom.statusBar.textContent = `Searching ${totalFiles} file${totalFiles !== 1 ? 's' : ''} for "${trimmed}"...`;

    countMatchesInAllDocs(
        state.docDataCache,
        state.docTextCache,
        state.docContentCache,
        trimmed,
        _gsCancelRef,
    ).then(result => {
        if (!result) return;

        const { results, totalMatches, filesWithMatches } = result;
        state.globalSearchResults = results;

        if (totalMatches > 0) {
            dom.statusBar.textContent = `${totalMatches} global match${totalMatches !== 1 ? 'es' : ''} for "${trimmed}" in ${filesWithMatches} file${filesWithMatches !== 1 ? 's' : ''}`;
        } else {
            dom.statusBar.textContent = `No matches for "${trimmed}"`;
        }

        state.emit('results-changed');

        if (_gsPendingNavigate) {
            const dir = _gsPendingNavigate;
            _gsPendingNavigate = 0;
            _gsNavigate(dir);
        }
    });
}

function _gsJumpToDoc(url, navigateToLast) {
    _gsPendingUrl = url;
    const requestedUrl = url;
    const poll = () => {
        if (state.currentDocUrl !== requestedUrl) {
            if (_gsPendingUrl === requestedUrl) _gsPendingUrl = null;
            return;
        }
        const doc = state.docDataCache[url];
        const isReady = doc?.type === 'pdf'
            ? !!(state.pdfDoc && state.currentDocUrl === url && state._gsPageCacheReady)
            : !!state.docContentCache[url];
        if (isReady) {
            _gsPendingUrl = null;
            state.globalSearchActiveDoc = url;
            activateGlobalSearch(navigateToLast);
            state.emit('results-changed');
        } else {
            setTimeout(poll, 200);
        }
    };

    if (state.currentDocUrl !== url) {
        fn.loadDocument(url);
    }
    poll();
}

function flushAndNavigate(dir) {
    const val = dom.globalSearchInput.value.trim();
    if (globalSearchTimer) clearTimeout(globalSearchTimer);
    globalSearchTimer = null;
    if (val && val !== state.globalSearchQuery) {
        performGlobalSearch(val);
        _gsPendingNavigate = dir;
    } else {
        _gsNavigate(dir);
    }
}

function initGlobalSearch() {
    dom.globalSearchInput.addEventListener('input', () => {
        if (globalSearchTimer) clearTimeout(globalSearchTimer);
        globalSearchTimer = setTimeout(() => {
            performGlobalSearch(dom.globalSearchInput.value);
        }, 500);
    });

    dom.globalSearchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            dom.globalSearchInput.value = '';
            dom.globalSearchInput.blur();
            performGlobalSearch('');
            return;
        }

        if (e.key === 'Enter') {
            e.preventDefault();
            flushAndNavigate(1);
        }
    });

    dom.gsPrevBtn.addEventListener('click', () => flushAndNavigate(-1));
    dom.gsNextBtn.addEventListener('click', () => flushAndNavigate(1));

    dom.gsClearBtn.addEventListener('click', () => {
        dom.globalSearchInput.value = '';
        dom.globalSearchInput.focus();
        performGlobalSearch('');
    });
}
