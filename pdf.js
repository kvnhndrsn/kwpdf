// ========== REGEX HELPERS ==========

// Document type helpers
function getFileType(filename) {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.pdf')) return 'pdf';
    if (lower.endsWith('.docx')) return 'docx';
    if (lower.endsWith('.doc')) return 'doc';
    return null;
}

function getFileIcon(filename) {
    const type = getFileType(filename);
    if (type === 'pdf') {
        return '<svg width="16" height="16" viewBox="0 0 24 24" fill="#e53935"><path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20M9,13V19H7V13H9M15,15V19H13V15H15M11,11V19H9V11H11Z"/></svg>';
    }
    if (type === 'docx' || type === 'doc') {
        return '<svg width="16" height="16" viewBox="0 0 24 24" fill="#1976d2"><path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20M9,13V19H7V13H9M15,15V19H13V15H15M11,11V19H9V11H11Z"/></svg>';
    }
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="#757575"><path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20Z"/></svg>';
}

// Stub OCR object (Tesseract disabled)
const OCR = {
    enabled: false,
    init: async () => {},
    extractText: async () => null
};

let cachedKeywordRegex = null;
let cachedKeywordList = null;

function getKeywordRegex(keywords) {
    if (!keywords) keywords = window.KEYWORDS || [];
    if (!Array.isArray(keywords)) keywords = [];
    
    const keywordsJson = JSON.stringify(keywords);
    
    if (cachedKeywordRegex && cachedKeywordList === keywordsJson) {
        return cachedKeywordRegex;
    }
    
    if (keywords.length === 0) {
        cachedKeywordRegex = null;
        cachedKeywordList = keywordsJson;
        return cachedKeywordRegex;
    }
    
    const pattern = keywords
        .map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|');
    
    cachedKeywordRegex = new RegExp(`\\b(${pattern})\\b`, 'gi');
    cachedKeywordList = keywordsJson;
    return cachedKeywordRegex;
}

function clearKeywordRegexCache() {
    cachedKeywordRegex = null;
    cachedKeywordList = null;
}

// State
let objectUrls = [];
let activeKeyword = "";
let totalMatchesFound = 0;
let totalDocsFound = 0;
let processed = 0;
let totalFiles = 0;

let currentDocType = 'pdf';
let docContentCache = {}; // url -> { html, text, fileName }

let pdfDoc = null;
let currentDocUrl = "";
let currentScale = 1.0;
let currentPage = 1;
let totalPages = 0;

let searchResults = [];
let currentMatchIndex = -1;
let searchCache = {};

let currentLayout = localStorage.getItem('pdf_layout') || 'cards';
let expandedTreeItems = new Set();
let docDataCache = {}; // url -> { name, counts, url }

let pageHeights = {};
let renderedPages = new Set();
let renderedScales = {};
let zoomRenderTask = null;
let textPageCache = {};
let docTextCache = {};

let smoothScrollEnabled = false;
let isNavigating = false;
let ocrScanning = false;

let heatmapContainer = null;

let bgRenderRunning = false;
let bgRenderQueue = [];

// ========== CUSTOM SEARCH OVERLAY ==========

let searchOverlay = null;
let searchOverlayInput = null;
let searchOverlayResults = null;
let searchOverlayClose = null;
let customSearchResults = [];
let customSearchIndex = 0;

function initSearchOverlay() {
    const viewerContainer = document.querySelector('.viewer-container');
    const overlay = document.createElement('div');
    overlay.id = 'searchOverlay';
    overlay.className = 'search-overlay';
    overlay.innerHTML = `
        <input type="text" id="searchOverlayInput" placeholder="Search PDF... (Esc to close)" autocomplete="off">
        <span class="search-overlay-results" id="searchOverlayResults">0 / 0</span>
        <button class="search-overlay-btn" id="searchOverlayPrev" title="Previous (Shift+F3)">&#8592;</button>
        <button class="search-overlay-btn" id="searchOverlayNext" title="Next (F3)">&#8594;</button>
        <button class="search-overlay-btn search-overlay-close" id="searchOverlayClose" title="Close (Esc)">&#10005;</button>
    `;
    viewerContainer.appendChild(overlay);
    searchOverlay = overlay;
    searchOverlayInput = document.getElementById('searchOverlayInput');
    searchOverlayResults = document.getElementById('searchOverlayResults');
    searchOverlayClose = document.getElementById('searchOverlayClose');
    document.getElementById('searchOverlayPrev').addEventListener('click', customFindPrev);
    document.getElementById('searchOverlayNext').addEventListener('click', customFindNext);
    searchOverlayClose.addEventListener('click', closeSearchOverlay);
    searchOverlayInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) {
                customFindPrev();
            } else {
                customFindNext();
            }
        }
        if (e.key === 'Escape') {
            closeSearchOverlay();
        }
    });
    searchOverlayInput.addEventListener('input', () => {
        performCustomSearch(searchOverlayInput.value);
    });
}

let heatmapStyleInjected = false;

function updateHeatmap() {
    let existing = document.getElementById('heatmapContainer');
    if (!existing) {
        const style = document.createElement('style');
        style.id = 'heatmapStyle';
        style.textContent = '.hm{position:absolute;left:2px;width:10px;height:3px;background:#6b9e3a;border-radius:1px;pointer-events:none}.hm-c{background:#fc0;box-shadow:0 0 4px #fc0}';
        document.head.appendChild(style);

        heatmapContainer = document.createElement('div');
        heatmapContainer.id = 'heatmapContainer';
        heatmapContainer.style.cssText = 'position:fixed;right:0;top:60px;bottom:60px;width:18px;pointer-events:none;z-index:99999;';
        document.body.appendChild(heatmapContainer);
        existing = heatmapContainer;
    }

    if (!searchResults || !searchResults.length) {
        existing.style.display = 'none';
        return;
    }

    existing.style.display = 'block';

    let pageOffsets = {};
    let docH = 0;
    for (let i = 1; i <= totalPages; i++) {
        pageOffsets[i] = docH;
        docH += ((pageHeights[i] || 792) * currentScale) + 32;
    }

    if (docH < 50) return;

    const n = searchResults.length;
    const currIdx = currentMatchIndex;
    const viewH = existing.clientHeight || 500;

    let html = '';
    for (let i = 0; i < n; i++) {
        const r = searchResults[i];
        if (!r || !r.page) continue;

        const top = pageOffsets[r.page] || 0;
        const y = top + (r.y || 0) * currentScale;
        const pos = Math.max(0, Math.min(viewH - 4, (y / docH) * viewH));
        const cls = i === currIdx ? 'hm-c' : 'hm';

        html += '<div class="' + cls + '" style="top:' + pos + 'px"></div>';
    }

    existing.innerHTML = html;
}

function showSearchOverlay() {
    if (!searchOverlay) initSearchOverlay();
    searchOverlay.classList.add('visible');
    searchOverlayInput.value = '';
    searchOverlayInput.focus();
    customSearchResults = [];
    customSearchIndex = 0;
    searchOverlayResults.textContent = '0 / 0';
    closeMobileSidebar();
}

function closeSearchOverlay() {
    if (searchOverlay) {
        searchOverlay.classList.remove('visible');
    }
    clearCustomHighlights();
    customSearchResults = [];
    customSearchIndex = 0;
}

function performCustomSearch(query) {
    if (!query || !pdfDoc) {
        customSearchResults = [];
        customSearchIndex = 0;
        searchOverlayResults.textContent = '0 / 0';
        clearCustomHighlights();
        return;
    }

    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const localRegex = new RegExp(escaped, 'gi');
    const results = [];

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
        const cached = textPageCache[pageNum];
        if (!cached) continue;

        const pageText = cached.text;
        let match;
        while ((match = localRegex.exec(pageText)) !== null) {
            results.push({
                page: pageNum,
                startIndex: match.index,
                endIndex: match.index + match[0].length,
                text: match[0]
            });
        }

        localRegex.lastIndex = 0;
    }

    customSearchResults = results;
    customSearchIndex = 0;

    if (results.length > 0) {
        searchOverlayResults.textContent = `1 / ${results.length}`;
        customGoToMatch(0);
    } else {
        searchOverlayResults.textContent = '0 / 0';
        clearCustomHighlights();
    }
}

async function customGoToMatch(index) {
    if (customSearchResults.length === 0) return;

    customSearchIndex = ((index % customSearchResults.length) + customSearchResults.length) % customSearchResults.length;
    searchOverlayResults.textContent = `${customSearchIndex + 1} / ${customSearchResults.length}`;

    const result = customSearchResults[customSearchIndex];

    await renderPageNow(result.page);
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

        const cached = textPageCache[result.page];
        if (!cached || !cached.items) continue;

        const coords = getTextCoords(cached, result.startIndex, result.endIndex);
        if (!coords) continue;

        const mark = document.createElement('div');
        const isCurrent = (i === customSearchIndex);
        mark.className = 'custom-highlight' + (isCurrent ? ' current' : '');
        mark.style.left = (coords.startX * currentScale) + 'px';
        mark.style.top = (coords.startY * currentScale) + 'px';
        mark.style.width = ((coords.endX - coords.startX) * currentScale) + 'px';
        mark.style.height = (coords.height * currentScale) + 'px';
        pageEl.appendChild(mark);
    }

    const currentResultCoords = getTextCoords(textPageCache[currentPage], currentResult.startIndex, currentResult.endIndex);
    if (currentResultCoords) {
        const halfViewport = viewerScroll.clientHeight / 2;
        const halfHeight = (currentResultCoords.height * currentScale) / 2;
        const targetTop = pageEl.offsetTop + currentResultCoords.startY * currentScale - halfViewport + halfHeight;
        viewerScroll.scrollTo({ top: Math.max(0, targetTop), behavior: smoothScrollEnabled ? 'smooth' : 'auto' });
    }
}

function getTextCoords(cached, startIndex, endIndex) {
    if (!cached || !cached.items) return null;

    const viewHeight = cached.viewport.height;
    let startY = 0, startX = 0, endY = 0, endX = 0, height = 0;

    let charOffset = 0;
    for (const item of cached.items) {
        const itemStart = charOffset;
        const itemEnd = charOffset + item.text.length;

        if (startIndex >= itemStart && startIndex < itemEnd) {
            const frac = (startIndex - itemStart) / item.text.length;
            startX = item.transform[4] + frac * item.width;
            startY = viewHeight - (item.transform[5] + item.height);
            height = item.height;
        }

        if (endIndex > itemStart && endIndex <= itemEnd) {
            const frac = (endIndex - itemStart) / item.text.length;
            endX = item.transform[4] + frac * item.width;
            endY = viewHeight - (item.transform[5] + item.height);
            break;
        }

        charOffset = itemEnd;
    }

    if (endX === 0) endX = startX + 50;
    if (endY === 0) endY = startY;

    return { startX, startY, endX, endY, height };
}

function clearCustomHighlights() {
    document.querySelectorAll('.custom-highlight').forEach(el => el.remove());
}

function customFindNext() {
    if (customSearchResults.length > 0) {
        customGoToMatch(customSearchIndex + 1);
    }
}

function customFindPrev() {
    if (customSearchResults.length > 0) {
        customGoToMatch(customSearchIndex - 1);
    }
}

// DOM refs
const viewer = document.getElementById('pdfViewer');
const viewerScroll = document.getElementById('viewerScroll');
const loader = document.getElementById('viewerLoader');
const loaderFilename = document.getElementById('loaderFilename');
const loaderStatus = document.getElementById('loaderStatus');
const loaderProgressFill = document.getElementById('loaderProgressFill');
const matchTotal = document.getElementById('matchTotal');
const navGroup = document.getElementById('navGroup');
const navSep = document.getElementById('navSep');
const zoomLevelEl = document.getElementById('zoomLevel');
const pageInput = document.getElementById('pageInput');
const pageTotal = document.getElementById('pageTotal');
const matchInput = document.getElementById('matchInput');
const keywordSelect = document.getElementById('keywordSelect');
const resultsArea = document.getElementById('results');
const progressBar = document.getElementById('progressBar');
const sidebar = document.getElementById('sidebar');
const statusBar = document.getElementById('statusBar');

function toggleTheme() {
    const html = document.documentElement;
    if (html.getAttribute('data-theme') === 'light') {
        html.setAttribute('data-theme', 'dark');
        localStorage.setItem('pdf_theme', 'dark');
    } else {
        html.setAttribute('data-theme', 'light');
        localStorage.setItem('pdf_theme', 'light');
    }
    const btn = document.querySelector('#settingsMenu button:first-child');
    if (btn) btn.textContent = html.getAttribute('data-theme') === 'light' ? 'Dark Mode' : 'Light Mode';
}

let settingsOpen = false;
let settingsJustToggled = false;

function toggleSettings(e) {
    if (e) {
        e.stopPropagation();
    }
    settingsOpen = !settingsOpen;
    
    const existing = document.getElementById('settingsMenu');
    if (!settingsOpen) {
        if (existing) existing.remove();
        return;
    }
    
    if (existing) existing.remove();
    
    settingsJustToggled = true;
    
    const btn = document.getElementById('settingsBtn');
    const rect = btn.getBoundingClientRect();
    
    const menu = document.createElement('div');
    menu.id = 'settingsMenu';
    menu.className = 'settings-menu';
    menu.style.display = 'flex';
    menu.style.position = 'fixed';
    menu.style.left = rect.left + 'px';
    menu.style.top = (rect.bottom + 4) + 'px';
    
    const themeBtn = document.createElement('button');
    const html = document.documentElement;
    themeBtn.innerHTML = '&#9728; ' + (html.getAttribute('data-theme') === 'light' ? 'Dark Mode' : 'Light Mode');
    themeBtn.onclick = toggleTheme;
    menu.appendChild(themeBtn);
    
    const animateBtn = document.createElement('button');
    animateBtn.className = 'toggle-btn';
    if (smoothScrollEnabled) animateBtn.classList.add('on');
    animateBtn.onclick = function() {
        animateBtn.classList.toggle('on');
        toggleAnimate();
    };
    
    const label = document.createElement('span');
    label.className = 'toggle-label';
    label.textContent = 'Animate PDF Scroll ';
    animateBtn.appendChild(label);
    
    const state = document.createElement('span');
    state.className = 'toggle-state';
    state.textContent = smoothScrollEnabled ? 'ON' : 'OFF';
    animateBtn.appendChild(state);
    
    menu.appendChild(animateBtn);
    
    // Layout selector
    const layoutSection = document.createElement('div');
    layoutSection.style.display = 'flex';
    layoutSection.style.flexDirection = 'column';
    layoutSection.style.gap = '4px';
    layoutSection.style.marginTop = '4px';
    layoutSection.style.paddingTop = '8px';
    layoutSection.style.borderTop = '1px solid var(--grey-600)';
    
    const layoutLabel = document.createElement('span');
    layoutLabel.className = 'toggle-label';
    layoutLabel.textContent = 'Sidebar Layout:';
    layoutLabel.style.fontSize = '0.75rem';
    layoutSection.appendChild(layoutLabel);
    
    const layoutBtns = document.createElement('div');
    layoutBtns.style.display = 'flex';
    layoutBtns.style.gap = '4px';
    
    const layouts = [
        { id: 'cards', label: 'Cards' },
        { id: 'tree', label: 'Tree' }
    ];
    
    layouts.forEach(l => {
        const btn = document.createElement('button');
        btn.textContent = l.label;
        btn.style.flex = '1';
        btn.style.padding = '6px 8px';
        btn.style.fontSize = '0.75rem';
        btn.style.border = '1px solid var(--grey-600)';
        btn.style.borderRadius = '4px';
        btn.style.background = currentLayout === l.id ? 'var(--green)' : 'transparent';
        btn.style.color = currentLayout === l.id ? 'white' : 'var(--grey-300)';
        btn.style.cursor = 'pointer';
        btn.onclick = () => {
            settingsJustToggled = true;
            setLayout(l.id);
            closeSettingsMenu();
        };
        layoutBtns.appendChild(btn);
    });
    
    layoutSection.appendChild(layoutBtns);
    menu.appendChild(layoutSection);
    
    // OCR is disabled for now - hidden
    /*
    const ocrBtn = document.createElement('button');
    ...
    */
    
    document.body.appendChild(menu);
    
    setTimeout(() => {
        document.addEventListener('click', closeSettingsOnClickOutside);
    }, 0);
}

function closeSettingsOnClickOutside(e) {
    const menu = document.getElementById('settingsMenu');
    const btn = document.getElementById('settingsBtn');
    if (settingsJustToggled) {
        settingsJustToggled = false;
        return;
    }
    if (menu && !menu.contains(e.target) && e.target !== btn) {
        menu.remove();
        settingsOpen = false;
        document.removeEventListener('click', closeSettingsOnClickOutside);
    }
}

function toggleAnimate() {
    smoothScrollEnabled = !smoothScrollEnabled;
    localStorage.setItem('pdf_smooth_scroll', smoothScrollEnabled);
    const label = document.querySelector('.toggle-state');
    if (label) label.textContent = smoothScrollEnabled ? 'ON' : 'OFF';
}

function setLayout(layout) {
    currentLayout = layout;
    localStorage.setItem('pdf_layout', layout);
    renderResultsArea();
}

function closeSettingsMenu() {
    const menu = document.getElementById('settingsMenu');
    if (menu) {
        menu.remove();
        settingsOpen = false;
    }
}

(function() {
    const savedTheme = localStorage.getItem('pdf_theme');
    if (savedTheme === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
    }
})();

// ========== SIDEBAR / SCANNING ==========

function updateStats() {
    if (totalMatchesFound > 0) {
        statusBar.textContent = `${totalMatchesFound} matches across ${totalDocsFound} document${totalDocsFound !== 1 ? 's' : ''}`;
    } else if (totalDocsFound > 0) {
        statusBar.textContent = `${totalDocsFound} document${totalDocsFound !== 1 ? 's' : ''} scanned`;
    }
}

function clearAllResults() {
    resultsArea.innerHTML = '<h1 class="status-msg">&#10548;</h1><h1 class="status-msg">Drop a folder to begin scanning</h1>';
    const viewerDropMsg = document.getElementById('viewerDropMsg');
    if (viewerDropMsg) viewerDropMsg.style.display = 'block';
    statusBar.textContent = '';
    objectUrls.forEach(url => URL.revokeObjectURL(url));
    objectUrls = [];
    totalMatchesFound = 0;
    totalDocsFound = 0;
    docDataCache = {};
    docContentCache = {};
    expandedTreeItems.clear();
    updateStats();

    pdfDoc = null;
    currentDocUrl = "";
    currentDocType = 'pdf';
    currentScale = 1.0;
    currentPage = 1;
    totalPages = 0;
    viewer.innerHTML = '';
    renderedPages.clear();
    renderedScales = {};
    pageHeights = {};
    searchCache = {};
    clearSearch();
    currentScale = 1.0;
    currentPage = 1;
    textPageCache = {};
    docSearchResults = [];
    docCurrentMatchIndex = -1;
}

async function loadPDF(fileUrl, keyword = "") {
    if (currentDocUrl === fileUrl && pdfDoc) {
        if (keyword) {
            performSearch(keyword);
        }
        return;
    }

    // Auto-expand current file in tree, collapse previous
    if (currentLayout === 'tree' && currentDocUrl && currentDocUrl !== fileUrl) {
        expandedTreeItems.delete(currentDocUrl);
    }
    if (currentLayout === 'tree' && fileUrl) {
        expandedTreeItems.add(fileUrl);
    }
    
    currentDocUrl = fileUrl; // Set current document URL early
    cancelBgRender();

    //destroy old pdf memory to be more efficient
    if (pdfDoc) {
        try {
            await pdfDoc.destroy();
        } catch (e) {
            console.warn("Error destroying previous PDF:", e);
        }
        pdfDoc = null;
    }

    loader.style.display = 'flex';
    loaderFilename.textContent = 'Loading PDF...';
    loaderStatus.textContent = 'Initializing...';
    loaderProgressFill.style.width = '10%';
    viewer.innerHTML = '';
    renderedPages.clear();
    renderedScales = {};
    pageHeights = {};
    searchCache = {};
    clearSearch();
    currentScale = 1.0;
    currentPage = 1;
    textPageCache = {};

    try {
        pdfDoc = await pdfjsLib.getDocument(fileUrl).promise;
        currentDocUrl = fileUrl;
        totalPages = pdfDoc.numPages;

        loaderStatus.textContent = `Setting up ${totalPages} pages...`;
        loaderProgressFill.style.width = '30%';
        await setupVirtualPages();

        loaderStatus.textContent = 'Extracting text content...';
        loaderProgressFill.style.width = '60%';

        const cached = docTextCache[fileUrl];
        if (cached) {
            for (let i = 0; i < cached.pages.length; i++) {
                textPageCache[i + 1] = cached.pages[i];
            }
            loaderProgressFill.style.width = '80%';
            await precomputeAllSearches();
        }

        loaderProgressFill.style.width = '100%';
        loader.style.display = 'none';
        updatePageInfo();
        updateZoomDisplay();
        pageInput.max = totalPages;
        pageTotal.textContent = totalPages;

        updateHeatmap();
        startBgRender();

        if (currentLayout === 'tree') {
            renderResultsArea();
        }

        if (keyword) {
            performSearch(keyword);
        }
    } catch (err) {
        loaderFilename.textContent = 'Error loading PDF';
        loaderStatus.textContent = err.message;
        loaderProgressFill.style.width = '0%';
        console.error('PDF load error:', err);
    }
}

// ========== DOCX/DOC LOADING ==========

function getDocTypeFromUrl(url) {
    const dataCached = docDataCache[url];
    if (dataCached?.type) {
        return dataCached.type;
    }
    if (dataCached?.name) {
        return getFileType(dataCached.name);
    }
    if (docContentCache[url]?.type) {
        return docContentCache[url].type;
    }
    if (url.includes('.pdf')) return 'pdf';
    if (url.includes('.docx')) return 'docx';
    if (url.includes('.doc')) return 'doc';
    return null;
}

async function loadDocument(fileUrl, keyword = "") {
    const type = getDocTypeFromUrl(fileUrl);
    if (type === 'pdf') {
        loadPDF(fileUrl, keyword);
    } else if (type === 'docx' || type === 'doc') {
        loadDocxDoc(fileUrl, keyword);
    } else {
        loadPDF(fileUrl, keyword);
    }
}

async function loadDocxDoc(fileUrl, keyword = "") {
    if (currentDocUrl === fileUrl && docContentCache[fileUrl]) {
        if (keyword) {
            performDocSearch(keyword);
        }
        return;
    }

    cancelBgRender();
    currentDocUrl = fileUrl;
    const cachedInfo = docContentCache[fileUrl];
    currentDocType = cachedInfo?.type || getDocTypeFromUrl(fileUrl);

    loader.style.display = 'flex';
    loaderFilename.textContent = 'Loading document...';
    loaderStatus.textContent = 'Parsing...';
    loaderProgressFill.style.width = '30%';
    viewer.innerHTML = '';
    clearSearch();
    textPageCache = {};

    try {
        const cached = docContentCache[fileUrl];
        if (!cached) throw new Error('Document not found in cache');

        loaderProgressFill.style.width = '70%';
        loaderStatus.textContent = 'Rendering...';

        renderDocContent(cached.html, cached.text);
        loaderProgressFill.style.width = '100%';
        loader.style.display = 'none';

        totalPages = 1;
        currentPage = 1;
        totalDocsFound = totalDocsFound;

        updatePageInfo();
        updateZoomDisplay();
        pageInput.max = 1;
        pageTotal.textContent = '1';

        startDocSearchComputation();

        if (keyword) {
            performDocSearch(keyword);
        }
    } catch (err) {
        loaderFilename.textContent = 'Error loading document';
        loaderStatus.textContent = err.message;
        loaderProgressFill.style.width = '0%';
        console.error('Document load error:', err);
    }
}

function renderDocContent(html, plainText) {
    viewer.innerHTML = '';
    textPageCache[1] = { text: plainText, viewport: { width: 800, height: 600 }, items: [] };

    if (!html) {
        viewer.innerHTML = '<div style="padding:20px;">No content to display</div>';
        return;
    }

    docOriginalHtml = html;

    const container = document.createElement('div');
    container.className = 'doc-viewer';
    container.style.width = '100%';
    container.style.maxWidth = '800px';
    container.style.margin = '0 auto';
    container.style.padding = '20px';
    container.style.boxSizing = 'border-box';
    container.style.fontFamily = 'Times New Roman, serif';
    container.style.fontSize = '12pt';
    container.style.lineHeight = '1.6';
    container.style.background = 'white';
    container.style.color = 'black';
    container.style.position = 'relative';
    container.innerHTML = html;

    container.querySelectorAll('table').forEach(table => {
        table.style.borderCollapse = 'collapse';
        table.style.width = '100%';
    });
    container.querySelectorAll('td, th').forEach(cell => {
        cell.style.border = '1px solid #000';
        cell.style.padding = '4px';
    });

    viewer.appendChild(container);
}

// ========== DOC SEARCH ==========

let docSearchResults = [];
let docCurrentMatchIndex = -1;
let docOriginalHtml = null;

async function startDocSearchComputation() {
    const cached = docContentCache[currentDocUrl];
    if (!cached) return;

    const combinedRegex = getKeywordRegex(KEYWORDS);
    const text = cached.text;
    const results = [];
    let match;

    while ((match = combinedRegex.exec(text)) !== null) {
        if (match[0].length < 3) continue;
        if (!/[a-zA-Z]/.test(match[0])) continue;
        results.push({
            index: match.index,
            text: match[0],
            length: match[0].length
        });
    }

    const counts = {};
    results.forEach(r => {
        const lower = r.text.toLowerCase();
        const key = KEYWORDS.find(k => k.toLowerCase() === lower) || lower;
        counts[key] = (counts[key] || 0) + 1;
    });

    searchCache._docCounts = counts;
    searchCache._docResults = results;
    populateKeywordSelect();
}

async function performDocSearch(query) {
    if (!currentDocUrl || !docContentCache[currentDocUrl]) return;

    const cached = docContentCache[currentDocUrl];
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const localRegex = new RegExp(`\\b${escaped}\\b`, 'gi');
    const text = cached.text;
    const results = [];
    let match;

    while ((match = localRegex.exec(text)) !== null) {
        results.push({
            index: match.index,
            text: match[0],
            length: match[0].length
        });
    }

    docSearchResults = results;
    docCurrentMatchIndex = 0;

    if (results.length > 0) {
        navGroup.classList.add('active');
        navSep.style.display = '';
        matchTotal.textContent = results.length;
        matchInput.max = results.length;
        matchInput.value = 1;
        renderDocHighlights();
        updateSidebarBadge();
        goToDocMatch(0);
    } else {
        navGroup.classList.remove('active');
        navSep.style.display = '';
        matchTotal.textContent = '0';
        matchInput.value = '';
    }
}

function renderDocHighlights() {
    const container = viewer.querySelector('.doc-viewer');
    if (!container || !docOriginalHtml) return;

    container.innerHTML = docOriginalHtml;

    if (!docSearchResults.length) return;

    const currentResult = docSearchResults[docCurrentMatchIndex];
    if (!currentResult) return;

    const plainText = docContentCache[currentDocUrl]?.text || '';
    const matchText = plainText.substring(currentResult.index, currentResult.index + currentResult.length);
    const escapedMatch = matchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const searchRegex = new RegExp(escapedMatch, 'gi');

    let marked = false;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, null);
    const nodes = [];
    let node;
    while (node = walker.nextNode()) nodes.push(node);

    for (const textNode of nodes) {
        if (searchRegex.test(textNode.textContent)) {
            searchRegex.lastIndex = 0;
            const span = document.createElement('span');
            span.innerHTML = textNode.textContent.replace(searchRegex, match => {
                const isFirst = !marked;
                marked = true;
                return `<mark class="doc-highlight${isFirst ? ' current' : ''}">${match}</mark>`;
            });
            textNode.parentNode.replaceChild(span, textNode);
        }
    }

    setTimeout(() => {
        const currentMark = container.querySelector('.doc-highlight.current');
        if (currentMark) {
            currentMark.scrollIntoView({ behavior: smoothScrollEnabled ? 'smooth' : 'auto', block: 'center' });
        }
    }, 50);
}

function goToDocMatch(index) {
    if (!docSearchResults.length) return;

    docCurrentMatchIndex = ((index % docSearchResults.length) + docSearchResults.length) % docSearchResults.length;
    matchInput.value = docCurrentMatchIndex + 1;
    updateSidebarBadge();

    const result = docSearchResults[docCurrentMatchIndex];
    const plainText = docContentCache[currentDocUrl]?.text || '';
    const textLen = plainText.length;
    const targetFraction = result.index / textLen;
    const scrollHeight = viewerScroll.scrollHeight - viewerScroll.clientHeight;
    const targetTop = scrollHeight * targetFraction;

    viewerScroll.scrollTo({ top: Math.max(0, targetTop), behavior: smoothScrollEnabled ? 'smooth' : 'auto' });

    renderDocHighlights();
}

// ========== PAGE SETUP & RENDERING ==========

let pageObserver = null;

async function setupVirtualPages() {
    viewer.innerHTML = '';
    pageHeights = {};

    if (pageObserver) {
        pageObserver.disconnect();
        pageObserver = null;
    }

    const pagePromises = [];
    for (let i = 1; i <= totalPages; i++) {
        pagePromises.push(pdfDoc.getPage(i));
    }
    const pages = await Promise.all(pagePromises);

    const placeholders = [];
    for (let i = 0; i < pages.length; i++) {
        const pageNum = i + 1;
        const page = pages[i];
        const viewport = page.getViewport({ scale: 1.0 });
        pageHeights[pageNum] = viewport.height;

        const placeholder = document.createElement('div');
        placeholder.className = 'page-placeholder';
        placeholder.id = 'page-' + pageNum;
        placeholder.dataset.pageNum = pageNum;
        placeholder.style.width = viewport.width + 'px';
        placeholder.style.height = viewport.height + 'px';
        placeholder.textContent = `Page ${pageNum}`;
        placeholders.push(placeholder);
    }

    for (const p of placeholders) {
        viewer.appendChild(p);
    }

    setupPageObserver();
}

let renderPageDebounce = null;

function setupPageObserver() {
    if (pageObserver) {
        pageObserver.disconnect();
    }

    pageObserver = new IntersectionObserver((entries) => {
        if (renderPageDebounce) return;

        const pagesToRender = [];
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const pageNum = parseInt(entry.target.dataset.pageNum);
                if (pageNum && !isPageRendered(pageNum)) {
                    pagesToRender.push(pageNum);
                }
            }
        });

        if (pagesToRender.length === 0) return;

        renderPageDebounce = setTimeout(() => {
            renderPageDebounce = null;
            if (pagesToRender.length <= 3) {
                pagesToRender.forEach(p => renderPageNow(p));
            } else {
                const mid = Math.floor(pagesToRender.length / 2);
                pagesToRender.slice(0, mid).forEach(p => renderPageNow(p));
                setTimeout(() => {
                    pagesToRender.slice(mid).forEach(p => renderPageNow(p));
                }, 50);
            }
        }, 20);
    }, { root: viewerScroll, rootMargin: "500px" });

    document.querySelectorAll('[id^="page-"]').forEach(el => {
        pageObserver.observe(el);
    });
}

function startBgRender() {
    if (bgRenderRunning || !pdfDoc) return;
    bgRenderRunning = true;

    bgRenderQueue = [];
    for (let i = 1; i <= totalPages; i++) {
        if (!isPageRendered(i)) {
            bgRenderQueue.push(i);
        }
    }

    renderNextBg();
}

async function renderNextBg() {
    if (!bgRenderQueue.length) {
        bgRenderRunning = false;
        return;
    }

    const pageNum = bgRenderQueue.shift();

    if (!isPageRendered(pageNum)) {
        await renderPageNow(pageNum);
    }

    requestAnimationFrame(renderNextBg);
}

function cancelBgRender() {
    bgRenderQueue = [];
    bgRenderRunning = false;
}

function isPageRendered(pageNum) {
    return renderedPages.has(pageNum);
}

async function renderPageNow(pageNum, forceScale = null) {
    const renderScale = forceScale || currentScale;
    const dpr = window.devicePixelRatio || 1;
    const effectiveScale = renderScale * dpr;
    
    if (renderedPages.has(pageNum) && !forceScale) {
        return;
    }
    
    if (!pdfDoc) return;
    
    renderedPages.add(pageNum);
    renderedScales[pageNum] = Math.max(renderedScales[pageNum] || 0, renderScale);

    try {
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: effectiveScale });
     
        const el = document.getElementById('page-' + pageNum);
        if (!el) return;

        const displayWidth = viewport.width / dpr;
        const displayHeight = viewport.height / dpr;

        el.className = 'pdf-page';
        el.textContent = '';
        el.style.width = displayWidth + 'px';
        el.style.height = displayHeight + 'px';

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { alpha: false });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = displayWidth + 'px';
        canvas.style.height = displayHeight + 'px';
        canvas.dataset.scale = renderScale;

        const textContent = await page.getTextContent();
        
        const vp = page.getViewport({ scale: 1.0 });
        let pageText = '';
        const textItems = [];
        for (const item of textContent.items) {
            pageText += item.str;
            textItems.push({
                text: item.str,
                transform: item.transform,
                width: item.width,
                height: item.height
            });
        }
        textPageCache[pageNum] = { text: pageText, viewport: vp, items: textItems };
        pageHeights[pageNum] = vp.height;
        
        const textLayerDiv = document.createElement('div');
        textLayerDiv.className = 'textLayer';
        textLayerDiv.style.width = displayWidth + 'px';
        textLayerDiv.style.height = displayHeight + 'px';
        
        const textViewport = page.getViewport({ scale: renderScale });
        pdfjsLib.renderTextLayer({
            textContent: textContent,
            container: textLayerDiv,
            viewport: textViewport,
            textDivs: []
        });
        
        await page.render({ canvasContext: ctx, viewport: viewport }).promise;
        
        const existingCanvas = el.querySelector('canvas');
        if (existingCanvas) {
            existingCanvas.remove();
        }
        el.appendChild(canvas);

        const existingTextLayer = el.querySelector('.textLayer');
        if (existingTextLayer) {
            existingTextLayer.remove();
        }
        el.appendChild(textLayerDiv);

        if (searchResults.length > 0) {
            renderHighlightsForPage(pageNum);
        }
    } catch (err) {
        renderedPages.delete(pageNum);
        if (err.name !== 'RenderingCancelledException') {
            console.warn('Render error:', err.message);
        }
    }
}

// ========== SEARCH ==========

async function precomputeAllSearches() {
    if (searchCache._deduplicated) return;
    
    const combinedRegex = getKeywordRegex(KEYWORDS);
    
    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
        const cached = textPageCache[pageNum];
        if (!cached) continue;

        const pageText = cached.text;
        const viewport = cached.viewport;

        if (!cached.items) {
            await fetchPageItems(pageNum);
        }
        const textItems = cached.items;
        if (!textItems) continue;

        let match;
        while ((match = combinedRegex.exec(pageText)) !== null) {
            if (match[0].length < 3) continue;
            if (!/[a-zA-Z]/.test(match[0])) continue;
            const lower = match[0].toLowerCase();
            const canonical = KEYWORDS.find(k => k.toLowerCase() === lower) || lower;
            
            if (searchCache[canonical] === undefined) {
                searchCache[canonical] = [];
            }

            const matchStart = match.index;
            const matchEnd   = match.index + match[0].length;

            let charOffset = 0;
            let startItem = null, endItem = null;
            let startItemCharStart = 0, endItemCharStart = 0;

            for (const item of textItems) {
                const itemStart = charOffset;
                const itemEnd   = charOffset + item.text.length;

                if (!startItem && matchStart >= itemStart && matchStart < itemEnd) {
                    startItem = item;
                    startItemCharStart = itemStart;
                }

                if (startItem && matchEnd > itemStart && matchEnd <= itemEnd) {
                    endItem = item;
                    endItemCharStart = itemStart;
                    break;
                }

                charOffset = itemEnd;
            }

            if (startItem) {
                const startCharFrac = startItem.text.length > 0
                    ? (matchStart - startItemCharStart) / startItem.text.length : 0;
                const sx = startItem.transform[4] + startCharFrac * startItem.width;

                const sy = viewport.height - (startItem.transform[5] + startItem.height);

                const ei = endItem || startItem;
                const eiCharStart = endItem ? endItemCharStart : startItemCharStart;
                const endCharFrac = ei.text.length > 0
                    ? (matchEnd - eiCharStart) / ei.text.length : 1;
                const endX = ei.transform[4] + endCharFrac * ei.width;

                searchCache[canonical].push({
                    page: pageNum,
                    x: sx,
                    y: sy,
                    width: Math.max(endX - sx, 4),
                    height: startItem.height
                });
            }
        }
    }
    
    searchCache._deduplicated = true;
    populateKeywordSelect();
}

async function computeSearchForQuery(query) {
    if (searchCache[query] !== undefined) return;

    if (searchCache._deduplicated) {
        return;
    }

    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const localRegex = new RegExp(`\\b${escaped}\\b`, 'gi');
    const results = [];

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
        const cached = textPageCache[pageNum];
        if (!cached) continue;

        const pageText = cached.text;
        const viewport = cached.viewport;

        if (!cached.items) {
            await fetchPageItems(pageNum);
        }
        const textItems = cached.items;
        if (!textItems) continue;

        let match;

        while ((match = localRegex.exec(pageText)) !== null) {
            if (match[0].length < 3) continue;
            if (!/[a-zA-Z]/.test(match[0])) continue;
            const matchStart = match.index;
            const matchEnd   = match.index + match[0].length;

            let charOffset = 0;
            let startItem = null, endItem = null;
            let startItemCharStart = 0, endItemCharStart = 0;

            for (const item of textItems) {
                const itemStart = charOffset;
                const itemEnd   = charOffset + item.text.length;

                if (!startItem && matchStart >= itemStart && matchStart < itemEnd) {
                    startItem = item;
                    startItemCharStart = itemStart;
                }

                if (startItem && matchEnd > itemStart && matchEnd <= itemEnd) {
                    endItem = item;
                    endItemCharStart = itemStart;
                    break;
                }

                charOffset = itemEnd;
            }

            if (startItem) {
                const startCharFrac = startItem.text.length > 0
                    ? (matchStart - startItemCharStart) / startItem.text.length : 0;
                const sx = startItem.transform[4] + startCharFrac * startItem.width;

                const sy = viewport.height - (startItem.transform[5] + startItem.height);

                const ei = endItem || startItem;
                const eiCharStart = endItem ? endItemCharStart : startItemCharStart;
                const endCharFrac = ei.text.length > 0
                    ? (matchEnd - eiCharStart) / ei.text.length : 1;
                const endX = ei.transform[4] + endCharFrac * ei.width;

                results.push({
                    page: pageNum,
                    x: sx,
                    y: sy,
                    width: Math.max(endX - sx, 4),
                    height: startItem.height
                });
            }
        }
    }

    searchCache[query] = results;
}

async function fetchPageItems(pageNum) {
    if (!pdfDoc) return null;
    const cached = textPageCache[pageNum];
    if (!cached || cached.items) return cached?.items;

    const page = await pdfDoc.getPage(pageNum);
    const content = await page.getTextContent();
    const items = [];
    for (const item of content.items) {
        items.push({
            text: item.str,
            transform: item.transform,
            width: item.width,
            height: item.height
        });
    }
    cached.items = items;
    return items;
}

async function performSearch(query) {
    if (!pdfDoc || !query) return;

    let canonicalQuery = query;
    if (searchCache[query] === undefined) {
        const lower = query.toLowerCase();
        const found = KEYWORDS.find(k => k.toLowerCase() === lower);
        if (found && searchCache[found] !== undefined) {
            canonicalQuery = found;
        }
    }

    if (searchCache[canonicalQuery] !== undefined) {
        searchResults = searchCache[canonicalQuery];
        activeKeyword = canonicalQuery;
        currentMatchIndex = 0;
        showSearchResults();
        return;
    }

    activeKeyword = canonicalQuery;
    currentMatchIndex = 0;
    clearHighlights();
    searchResults = [];

    await computeSearchForQuery(canonicalQuery);
    searchResults = searchCache[canonicalQuery] || [];

    showSearchResults();
}

function showSearchResults() {
    if (searchResults.length > 0) {
        navGroup.classList.add('active');
        navSep.style.display = '';

        matchTotal.textContent = searchResults.length;
        matchInput.max = searchResults.length;
        matchInput.value = 1;
        currentMatchIndex = 0;
        renderAllHighlights();
        populateKeywordSelect();
        updateSidebarBadge();
        updateHeatmap();
        goToMatch(0);
    } else {
        navGroup.classList.remove('active');
        navSep.style.display = '';

        matchTotal.textContent = '0';
        matchInput.value = '';
        currentMatchIndex = -1;
        updateSidebarBadge();
        populateKeywordSelect();
        updateHeatmap();
    }
}

function cycleSearch(query) {
    if (!pdfDoc || !query) return;

    if (searchCache[query] !== undefined) {
        searchResults = searchCache[query];
        activeKeyword = query;

        if (searchResults.length > 0) {
            navGroup.classList.add('active');
            navSep.style.display = '';
            currentMatchIndex = (currentMatchIndex + 1) % searchResults.length;
            matchTotal.textContent = searchResults.length;
            matchInput.max = searchResults.length;
            matchInput.value = currentMatchIndex + 1;
            renderAllHighlights();
            populateKeywordSelect();
            updateHeatmap();
            goToMatch(currentMatchIndex);
        } else {
            navGroup.classList.remove('active');
            navSep.style.display = 'none';

            matchTotal.textContent = '0';
            matchInput.value = '';
            populateKeywordSelect();
        }
        return;
    }

    performSearch(query);
}

function renderAllHighlights() {
    clearHighlights();

    for (let i = 0; i < searchResults.length; i++) {
        renderHighlightMark(searchResults[i], i);
    }
}

function renderHighlightsForPage(pageNum) {
    searchResults.forEach((result, index) => {
        if (result.page === pageNum) {
            renderHighlightMark(result, index);
        }
    });
}

function renderHighlightMark(result, index) {
    const pageEl = document.getElementById('page-' + result.page);
    if (!pageEl) return;

    const mark = document.createElement('div');
    mark.className = 'highlight-mark' + (index === currentMatchIndex ? ' current' : '');
    mark.style.left = (result.x * currentScale) + 'px';
    mark.style.top = (result.y * currentScale) + 'px';
    mark.style.width = (result.width * currentScale) + 'px';
    mark.style.height = (result.height * currentScale) + 'px';

    pageEl.appendChild(mark);
}

function clearHighlights() {
    viewer.querySelectorAll('.highlight-mark').forEach(el => el.remove());
}

function populateKeywordSelect() {
    keywordSelect.innerHTML = '';
    KEYWORDS.forEach(k => {
        if (searchCache[k] && searchCache[k].length > 0) {
            const opt = document.createElement('option');
            opt.value = k;
            opt.textContent = `${k} (${searchCache[k].length})`;
            if (k === activeKeyword) opt.selected = true;
            keywordSelect.appendChild(opt);
        }
    });
}

keywordSelect.addEventListener('change', () => {
    if (keywordSelect.value) {
        if (currentDocType === 'pdf') {
            performSearch(keywordSelect.value);
        } else {
            performDocSearch(keywordSelect.value);
        }
    }
});

function updateSidebarBadge() {
    const badges = document.querySelectorAll('.badge');
    badges.forEach(badge => {
        const k = badge.dataset.keyword;
        const total = parseInt(badge.dataset.count) || 0;
        const cardUrl = badge.closest('.doc-card').dataset.url || '';
        
        const isCurrentFile = cardUrl === currentDocUrl;
        const isActiveKeyword = k === activeKeyword;
        
        if (isCurrentFile && isActiveKeyword && currentMatchIndex >= 0) {
            const current = currentMatchIndex + 1;
            const minWidth = Math.max(2, total.toString().length);
            const currentStr = current.toString().padStart(minWidth, ' ');
            const totalStr = total.toString().padStart(minWidth, ' ');
            badge.textContent = `${k}: ${currentStr}/${totalStr}`;
        } else {
            const minWidth = Math.max(2, total.toString().length);
            const totalStr = total.toString().padStart(minWidth, ' ');
            badge.textContent = `${k}: ${totalStr}`;
        }
    });
}

// ========== ZOOM ==========

function setZoom(newScale, force = false) {
    const clampedScale = Math.max(0.5, Math.min(4.0, newScale));
    if (clampedScale === currentScale && !force) return;

    const oldScrollTop = viewerScroll.scrollTop;
    const oldScrollHeight = viewerScroll.scrollHeight;
    const scaleRatio = clampedScale / currentScale;
    const oldScale = currentScale;

    currentScale = clampedScale;
    updateZoomDisplay();

    for (let i = 1; i <= totalPages; i++) {
        const el = document.getElementById('page-' + i);
        if (!el) continue;
        const baseH = pageHeights[i] || 800;
        const cached = textPageCache[i];
        const baseW = cached ? cached.viewport.width : 600;
        el.style.width = (baseW * currentScale) + 'px';
        el.style.height = (baseH * currentScale) + 'px';
        const canvas = el.querySelector('canvas');
        if (canvas) {
            canvas.style.width = (baseW * currentScale) + 'px';
            canvas.style.height = (baseH * currentScale) + 'px';
        }
        const textLayer = el.querySelector('.textLayer');
        if (textLayer) {
            textLayer.style.width = (baseW * currentScale) + 'px';
            textLayer.style.height = (baseH * currentScale) + 'px';
        }
    }

    renderedPages.clear();
    renderedScales = {};

    requestAnimationFrame(() => {
        const newScrollHeight = viewerScroll.scrollHeight;
        const anchorFraction = oldScrollHeight > 0 ? oldScrollTop / oldScrollHeight : 0;
        const newScrollTop = anchorFraction * newScrollHeight;
        viewerScroll.scrollTop = newScrollTop + 30;

        clearHighlights();
        if (pageObserver) {
            pageObserver.disconnect();
            setupPageObserver();
        }
        if (searchResults.length > 0) {
            renderAllHighlights();
        }
        updateHeatmap();
    });
}

function zoomIn() { setZoom(currentScale + 0.15); }
function zoomOut() { setZoom(currentScale - 0.15); }

function zoomFit() {
    if (!pdfDoc || totalPages === 0) return;
    pdfDoc.getPage(1).then(page => {
        const viewport = page.getViewport({ scale: 1.0 });
        const containerWidth = viewerScroll.clientWidth - 32;
        const fitScale = Math.max(0.5, Math.min(4.0, containerWidth / viewport.width));
        setZoom(fitScale);
    });
}

function zoomActual() {
    setZoom(1.0, true);
}

function scheduleHighResRender() {
    if (zoomRenderTask) {
        zoomRenderTask.cancelled = true;
    }

    const task = { cancelled: false };
    zoomRenderTask = task;

    const visiblePages = getVisiblePages();
    
    async function renderHighRes() {
        if (task.cancelled) return;
        
        for (const pageNum of visiblePages) {
            if (task.cancelled) return;
            
            const currentScale = renderedScales[pageNum] || 1.0;
            if (currentScale < 2.0) {
                await renderPageNow(pageNum, 2.0);
            }
            
            await new Promise(r => requestAnimationFrame(r));
        }
    }

    requestAnimationFrame(renderHighRes);
}

function getVisiblePages() {
    const scrollTop = viewerScroll.scrollTop;
    const containerHeight = viewerScroll.clientHeight;
    const viewStart = scrollTop - 200;
    const viewEnd = scrollTop + containerHeight + 200;

    const visible = [];
    let offsetY = 0;

    for (let i = 1; i <= totalPages; i++) {
        const h = (pageHeights[i] || 800) * currentScale;
        const pageTop = offsetY;
        const pageBottom = offsetY + h;
        offsetY += h + 32;

        if (pageBottom > viewStart && pageTop < viewEnd) {
            visible.push(i);
        }
    }

    return visible;
}

function clearHighResRenders() {
    for (const pageNum of Object.keys(renderedScales)) {
        renderedScales[pageNum] = 0;
    }
    
    document.querySelectorAll('.pdf-page').forEach(el => {
        el.innerHTML = '';
        const pageNum = parseInt(el.dataset.pageNum);
        const h = pageHeights[pageNum] || 800;
        const cached = textPageCache[pageNum];
        const w = cached ? cached.viewport.width : 600;
        const placeholder = document.createElement('div');
        placeholder.className = 'page-placeholder';
        placeholder.id = 'page-' + pageNum;
        placeholder.dataset.pageNum = pageNum;
        placeholder.style.width = w + 'px';
        placeholder.style.height = h + 'px';
        placeholder.textContent = `Page ${pageNum}`;
        el.appendChild(placeholder);
    });
    
    if (pageObserver) {
        pageObserver.disconnect();
        setupPageObserver();
    }
}

function updateZoomDisplay() {
    zoomLevelEl.textContent = Math.round(currentScale * 100) + '%';
}

// ========== PAGE NAVIGATION ==========

function prevPage() {
    if (currentPage > 1) {
        currentPage--;
        scrollToPage(currentPage);
    }
}

function nextPage() {
    if (currentPage < totalPages) {
        currentPage++;
        scrollToPage(currentPage);
    }
}

function scrollToPage(pageNum) {
    const pageEl = document.getElementById('page-' + pageNum);
    let targetOffset = 0;
    if (pageEl) {
        targetOffset = pageEl.offsetTop;
    } else {
        for (let i = 1; i < pageNum; i++) {
            targetOffset += (pageHeights[i] * currentScale || 800) + 32;
        }
    }
    const behavior = smoothScrollEnabled && !isNavigating ? 'smooth' : 'auto';
    isNavigating = true;
    viewerScroll.scrollTo({ top: targetOffset, behavior: behavior });
    currentPage = pageNum;
    updatePageInfo();
    setTimeout(() => { isNavigating = false; }, 100);
}

function updatePageInfo() {
    pageInput.value = currentPage;
    pageInput.placeholder = totalPages > 0 ? currentPage : '0';
}

pageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        const num = parseInt(pageInput.value);
        if (num >= 1 && num <= totalPages) {
            scrollToPage(num);
            pageInput.blur();
        }
    }
});

pageInput.addEventListener('blur', () => {
    pageInput.value = currentPage;
});

// ========== SCROLL HANDLER ==========

viewerScroll.addEventListener('scroll', () => {
    if (!viewer.children.length) return;
    if (isNavigating) return;

    const scrollTop = viewerScroll.scrollTop;
    const containerHeight = viewerScroll.clientHeight;
    const scrollHeight = viewerScroll.scrollHeight;

    const midPoint = scrollTop + containerHeight / 2;

    let detectedPage = null;
    for (let i = 1; i <= totalPages; i++) {
        const pageEl = document.getElementById('page-' + i);
        if (!pageEl) continue;

        const pageTop = pageEl.offsetTop;
        const pageBottom = pageTop + pageEl.offsetHeight;

        if (midPoint < pageBottom) {
            detectedPage = i;
            break;
        }
    }

    if (!detectedPage && scrollTop + containerHeight >= scrollHeight - 50) {
        detectedPage = totalPages;
    }

    if (detectedPage && detectedPage !== currentPage) {
        currentPage = detectedPage;
        updatePageInfo();
    }

    if (searchResults.length > 0) {
        updateHeatmap();
    }
});

// ========== MATCH NAVIGATION ==========

function goToMatch(index) {
    if (searchResults.length === 0) return;

    currentMatchIndex = ((index % searchResults.length) + searchResults.length) % searchResults.length;
    matchInput.value = currentMatchIndex + 1;
    updateSidebarBadge();
    updateHeatmap();

    const result = searchResults[currentMatchIndex];

    renderPageNow(result.page).then(() => {
        const pageEl = document.getElementById('page-' + result.page);
        if (pageEl) {
            const targetTop = pageEl.offsetTop + result.y * currentScale - (viewerScroll.clientHeight / 2);
            const behavior = smoothScrollEnabled ? 'smooth' : 'auto';
            viewerScroll.scrollTo({ top: Math.max(0, targetTop), behavior: behavior });
        }

        clearHighlights();
        renderAllHighlights();
        updateHeatmap();
    });

    startPrerender();
}

matchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        const num = parseInt(matchInput.value);
        if (num >= 1 && num <= searchResults.length) {
            goToMatch(num - 1);
            matchInput.blur();
        }
    }
});

matchInput.addEventListener('blur', () => {
    matchInput.value = currentMatchIndex + 1;
});

async function startPrerender() {
    if (searchResults.length === 0) return;

    const pagesWithMatches = [...new Set(searchResults.map(r => r.page))];

    for (const pageNum of pagesWithMatches) {
        if (!isPageRendered(pageNum)) {
            await renderPageNow(pageNum);
        }
    }
}

function findNext() {
    if (currentDocType === 'pdf' && searchResults.length > 0) {
        goToMatch(currentMatchIndex + 1);
    } else if (docSearchResults.length > 0) {
        goToDocMatch(docCurrentMatchIndex + 1);
    }
}

function findPrev() {
    if (currentDocType === 'pdf' && searchResults.length > 0) {
        goToMatch(currentMatchIndex - 1);
    } else if (docSearchResults.length > 0) {
        goToDocMatch(docCurrentMatchIndex - 1);
    }
}

function clearSearch() {
    activeKeyword = '';
    searchResults = [];
    currentMatchIndex = -1;
    navGroup.classList.remove('active');
    navSep.style.display = 'none';
    clearHighlights();
    keywordSelect.value = '';
    matchInput.value = '';
    matchTotal.textContent = '0';
    updateSidebarBadge();
    updateHeatmap();
}

// ========== MOBILE ==========

let mobileSidebarOpen = false;

function closeMobileSidebar() {
    const sidebar = document.getElementById('sidebar');
    const viewer = document.querySelector('.viewer-container');
    sidebar.classList.remove('open');
    sidebar.classList.add('collapsed');
    viewer.style.height = 'calc(100% - 44px)';
    mobileSidebarOpen = false;
}

function openMobileSidebar() {
    const sidebar = document.getElementById('sidebar');
    const viewer = document.querySelector('.viewer-container');
    sidebar.classList.add('open');
    sidebar.classList.remove('collapsed');
    viewer.style.height = 'calc(100% - 44px)';
    mobileSidebarOpen = true;
}

function toggleMobileSidebar() {
    if (mobileSidebarOpen) {
        closeMobileSidebar();
    } else {
        openMobileSidebar();
    }
}

function checkMobileLayout() {
    const isMobile = window.innerWidth <= 700;
    const sidebar = document.getElementById('sidebar');
    const toggleBtn = document.querySelector('.mobile-toggle-sidebar');
    const viewer = document.querySelector('.viewer-container');
    if (toggleBtn) {
        toggleBtn.style.display = isMobile ? 'block' : 'none';
    }
    if (isMobile && !mobileSidebarOpen) {
        sidebar.classList.add('collapsed');
        sidebar.classList.remove('open');
        viewer.style.height = 'calc(100% - 44px)';
    }
}

window.addEventListener('resize', checkMobileLayout);
document.addEventListener('DOMContentLoaded', checkMobileLayout);

// ========== TOUCH ZOOM ==========

let touchStartDist = 0;
let touchStartScale = 1.0;

function getTouchDist(e) {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
}

viewerScroll.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
        touchStartDist = getTouchDist(e);
        touchStartScale = currentScale;
    }
}, { passive: true });

viewerScroll.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2) {
        e.preventDefault();
        const dist = getTouchDist(e);
        const ratio = dist / touchStartDist;
        const newScale = Math.max(0.5, Math.min(4.0, touchStartScale * ratio));
        if (Math.abs(newScale - currentScale) > 0.01) {
            setZoom(newScale);
        }
    }
}, { passive: false });

// ========== KEYBOARD SHORTCUTS ==========

const savedSmooth = localStorage.getItem('pdf_smooth_scroll');
if (savedSmooth !== null) {
    smoothScrollEnabled = savedSmooth === 'true';
}

viewerScroll.addEventListener('wheel', (e) => {
    if (e.ctrlKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        setZoom(currentScale + delta);
    }
}, { passive: false });

document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && (e.key === '+' || e.key === '=')) {
        e.preventDefault();
        zoomIn();
    }
    if (e.ctrlKey && e.key === '-') {
        e.preventDefault();
        zoomOut();
    }
    if (e.ctrlKey && e.key === 'f') {
        e.preventDefault();
        showSearchOverlay();
    }
    if (e.key === 'F3' && !e.shiftKey) {
        e.preventDefault();
        showSearchOverlay();
    }
    if (e.key === 'F3' && e.shiftKey) {
        e.preventDefault();
        if (searchOverlay && searchOverlay.classList.contains('visible')) {
            customFindPrev();
        }
    }
    if (e.key === 'g' && !e.ctrlKey && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
        e.preventDefault();
        pageInput.focus();
        pageInput.select();
    }
    if (e.key === 'Escape') {
        pageInput.blur();
        matchInput.blur();
        closeMobileSidebar();
        closeSearchOverlay();
    }
});

// ========== DRAG & DROP ==========

function getPathParts(file, baseFolderName) {
    const fileName = file.relativePath || file.name;
    
    if (fileName.includes('/') || fileName.includes('\\')) {
        const parts = fileName.split(/[/\\]/);
        const name = parts.pop();
        const folder = parts.join('/');
        return { name, folder };
    }
    
    return { name: fileName, folder: baseFolderName || basePath || '' };
}

function renderCard(fileName, counts, url, file = null) {
    const { name: baseName, folder } = getPathParts(file, null);
    const type = getFileType(fileName);
    docDataCache[url] = { name: baseName, folder, fullPath: fileName, counts, url, type };

    if (currentLayout === 'tree') {
        renderResultsArea();
        return;
    }
    const card = document.createElement('div');
    card.className = 'doc-card';
    card.dataset.url = url;
    card.dataset.type = type;
    card.onclick = () => { setActiveCard(card); loadDocument(url); closeMobileSidebar(); };
    card.innerHTML = `<div class="doc-name">${getFileIcon(fileName)} ${fileName}</div>`;

    const grid = document.createElement('div');
    grid.className = 'badge-grid';

    const keywordCounts = {};
    KEYWORDS.forEach(k => {
        const count = counts[k] || 0;
        if (count > 0) {
            keywordCounts[k] = count;
        }
    });
    card.dataset.counts = JSON.stringify(keywordCounts);

    KEYWORDS.forEach(k => {
        const count = counts[k] || 0;
        if (count > 0) {
            const b = document.createElement('div');
            b.className = 'badge';
            b.dataset.keyword = k;
            b.dataset.count = count;
            b.textContent = `${k}: ${count}`;
            b.onclick = (e) => {
                e.stopPropagation();
                setActiveCard(card);
                closeMobileSidebar();
                if (currentDocUrl === url) {
                    if (type === 'pdf') {
                        cycleSearch(k);
                    } else {
                        performDocSearch(k);
                    }
                } else {
                    loadDocument(url, k);
                }
            };
            grid.appendChild(b);
        }
    });
    card.appendChild(grid);
    resultsArea.appendChild(card);
}

function renderNoMatchCard(fileName, url, file = null) {
    const { name: baseName, folder } = getPathParts(file, null);
    const finalName = fileName;
    docDataCache[url] = { name: baseName, folder, fullPath: finalName, counts: {}, url, type };

    if (currentLayout === 'tree') {
        renderResultsArea();
        return;
    }

    const type = getFileType(fileName);
    const card = document.createElement('div');
    card.className = 'doc-card doc-card-minimal';
    card.dataset.url = url;
    card.dataset.type = type;
    card.onclick = () => { setActiveCard(card); loadDocument(url); closeMobileSidebar(); };
    card.innerHTML = `<div class="doc-name">${getFileIcon(fileName)} ${fileName}</div>`;
    resultsArea.appendChild(card);
}

function renderTreeItem(doc) {
    const item = document.createElement('div');
    item.className = 'tree-item';
    
    const totalMatches = Object.values(doc.counts).reduce((a, b) => a + b, 0);
    const isExpanded = expandedTreeItems.has(doc.url);
    const isActive = doc.url === currentDocUrl;
    
    const header = document.createElement('div');
    header.className = 'tree-header' + (isActive ? ' active' : '');

    const arrow = document.createElement('span');
    arrow.className = 'tree-arrow';
    arrow.textContent = totalMatches > 0 ? (isExpanded ? '▼' : '▶') : '│';
    arrow.onclick = (e) => {
        e.stopPropagation();
        if (totalMatches > 0) {
            if (expandedTreeItems.has(doc.url)) {
                expandedTreeItems.delete(doc.url);
            } else {
                expandedTreeItems.add(doc.url);
            }
            renderResultsArea();
        }
    };
    header.appendChild(arrow);

    const fileIcon = document.createElement('span');
    fileIcon.className = 'tree-file-icon';
    fileIcon.textContent = getFileIcon(doc.name);
    header.appendChild(fileIcon);
    
    const name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = doc.name;
    header.appendChild(name);
    
    if (totalMatches > 0) {
        const count = document.createElement('span');
        count.className = 'tree-count';
        count.textContent = totalMatches;
        header.appendChild(count);
    }

    header.onclick = () => {
        if (totalMatches > 0) {
            if (isExpanded) {
                expandedTreeItems.delete(doc.url);
            } else {
                expandedTreeItems.add(doc.url);
            }
        }
        setActiveCardFromUrl(doc.url);
        loadDocument(doc.url);
        closeMobileSidebar();
        renderResultsArea();
    };

    item.appendChild(header);

    if (isExpanded && totalMatches > 0) {
        const children = document.createElement('div');
        children.className = 'tree-children';

        KEYWORDS.forEach(k => {
            const cnt = doc.counts[k] || 0;
            if (cnt > 0) {
                const child = document.createElement('div');
                child.className = 'tree-child';
                child.onclick = () => {
                    if (doc.url === currentDocUrl) {
                        const type = getFileType(doc.url);
                        if (type === 'pdf') {
                            cycleSearch(k);
                        } else {
                            performDocSearch(k);
                        }
                    } else {
                        loadDocument(doc.url, k);
                    }
                };

                const kw = document.createElement('span');
                kw.className = 'tree-child-kw';
                kw.textContent = k;
                child.appendChild(kw);
                
                const c = document.createElement('span');
                c.className = 'tree-child-count';
                c.textContent = cnt;
                child.appendChild(c);
                
                children.appendChild(child);
            }
        });
        
        item.appendChild(children);
    }
    
    return item;
}

function renderResultsArea() {
    resultsArea.innerHTML = '';
    resultsArea.className = 'results-area' + (currentLayout === 'tree' ? ' tree-mode' : '');
    
    if (currentLayout === 'tree') {
        const docs = Object.values(docDataCache);
        
        const folders = {};
        docs.forEach(doc => {
            const folder = doc.folder || '';
            if (!folders[folder]) {
                folders[folder] = [];
            }
            folders[folder].push(doc);
        });
        
        const sortedFolders = Object.keys(folders).sort((a, b) => {
            if (a === '') return 1;
            if (b === '') return -1;
            return a.localeCompare(b);
        });
        sortedFolders.forEach(folder => {
            const folderDocs = folders[folder];
            
            if (!folder) {
                const header = document.createElement('div');
                header.className = 'tree-folder-header';
                header.textContent = 'Files in root';
                resultsArea.appendChild(header);
            } else {
                const header = document.createElement('div');
                header.className = 'tree-folder-header';
                header.textContent = folder;
                resultsArea.appendChild(header);
            }

            folderDocs.sort((a, b) => a.name.localeCompare(b.name)).forEach(doc => {
                resultsArea.appendChild(renderTreeItem(doc));
            });
        });
        
        if (docs.length === 0) {
            resultsArea.innerHTML = '<h1 class="status-msg">&#10548;</h1><h1 class="status-msg">Drop a folder to begin scanning</h1>';
        }
    } else {
        // Cards layout - re-render from docDataCache
        const docs = Object.values(docDataCache);
    docs.forEach(doc => {
        const isActive = doc.url === currentDocUrl;
        const type = getFileType(doc.name);
        if (Object.keys(doc.counts).length > 0) {
            const card = document.createElement('div');
            card.className = 'doc-card' + (isActive ? ' active' : '');
            card.dataset.url = doc.url;
            card.dataset.type = type;
            card.onclick = () => { setActiveCard(card); loadDocument(doc.url); closeMobileSidebar(); };
            card.innerHTML = `<div class="doc-name">${getFileIcon(doc.name)} ${doc.name}</div>`;

            const grid = document.createElement('div');
            grid.className = 'badge-grid';

            KEYWORDS.forEach(k => {
                const count = doc.counts[k] || 0;
                if (count > 0) {
                    const b = document.createElement('div');
                    b.className = 'badge';
                    b.dataset.keyword = k;
                    b.dataset.count = count;
                    b.textContent = `${k}: ${count}`;
                    b.onclick = (e) => {
                        e.stopPropagation();
                        setActiveCard(card);
                        closeMobileSidebar();
                        if (currentDocUrl === doc.url) {
                            if (type === 'pdf') {
                                cycleSearch(k);
                            } else {
                                performDocSearch(k);
                            }
                        } else {
                            loadDocument(doc.url, k);
                        }
                    };
                    grid.appendChild(b);
                }
            });
            card.appendChild(grid);
            resultsArea.appendChild(card);
        } else {
            const card = document.createElement('div');
            card.className = 'doc-card doc-card-minimal';
            card.dataset.url = doc.url;
            card.dataset.type = type;
            card.onclick = () => { setActiveCard(card); loadDocument(doc.url); closeMobileSidebar(); };
            card.innerHTML = `<div class="doc-name">${getFileIcon(doc.name)} ${doc.name}</div>`;
            resultsArea.appendChild(card);
        }
    });
        
        if (docs.length === 0) {
            resultsArea.innerHTML = '<h1 class="status-msg">&#10548;</h1><h1 class="status-msg">Drop a folder to begin scanning</h1>';
        }
    }
}

function setActiveCard(card) {
    document.querySelectorAll('.doc-card').forEach(c => c.classList.remove('active'));
    card.classList.add('active');
}

function setActiveCardFromUrl(url) {
    document.querySelectorAll('.doc-card').forEach(c => c.classList.remove('active'));
    const card = document.querySelector(`.doc-card[data-url="${url}"]`);
    if (card) card.classList.add('active');
    
    document.querySelectorAll('.tree-item').forEach(item => {
        const header = item.querySelector('.tree-header');
        if (header) header.classList.remove('active');
    });
    const treeItem = [...document.querySelectorAll('.tree-item')].find(item => {
        return item.querySelector('.tree-name').textContent === docDataCache[url]?.name;
    });
    if (treeItem) {
        treeItem.querySelector('.tree-header').classList.add('active');
    }

    if (currentLayout === 'tree') {
        expandedTreeItems.clear();
        expandedTreeItems.add(url);
    }
}

async function processFiles(files) {
    if (files.length === 0) return;

    const viewerMsg = document.getElementById('viewerDropMsg');
    if (viewerMsg) viewerMsg.style.display = 'none';

    const statusMsgs = resultsArea.querySelectorAll('.status-msg');
    statusMsgs.forEach(el => el.remove());

    const ocrPrefix = OCR.enabled ? 'OCR triggered - ' : '';
    statusBar.textContent = `${ocrPrefix}Scanning ${files.length} documents...`;
    progressBar.style.width = '0%';

    processed = 0;
    totalFiles = files.length;

    if (OCR.enabled) {
        console.log('[PDF] Pre-initializing OCR worker...');
        OCR.init().catch(err => console.error('[PDF] OCR init failed:', err));
    }

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const url = URL.createObjectURL(file);
        objectUrls.push(url);

        const arrayBuffer = await file.arrayBuffer();

        if (OCR.enabled) {
            statusBar.textContent = `${ocrPrefix}Scanning ${i + 1}/${files.length}: ${file.name}...`;
        }

        const type = getFileType(file.name);
        if (type === 'pdf') {
            await extractPdfText(arrayBuffer, file.name, url, file);
        } else if (type === 'docx' || type === 'doc') {
            await extractDocText(arrayBuffer, file.name, url, file);
        }

        updateProgressMainThread();

        if (OCR.enabled) {
            statusBar.textContent = `${ocrPrefix}Scanned ${i + 1}/${files.length} documents...`;
        }
    }
}

async function extractPdfText(arrayBuffer, fileName, id, file = null) {
    try {
        const fakeDoc = {
            createElement: name => name === 'canvas' ? new OffscreenCanvas(1, 1) : null,
            fonts: {}
        };
        
        const pdfData = new Uint8Array(arrayBuffer);
        
        let pageTextData;
        let numPages = 0;
        
        if (OCR.enabled) {
            console.log('[PDF] Using OCR extraction for:', fileName);
            const result = await OCR.extractText(pdfData);
            pageTextData = result.pages;
            numPages = result.numPages;
        } else {
            console.log('[PDF] Using native text extraction for:', fileName);
            const pdf = await pdfjsLib.getDocument({ data: pdfData, ownerDocument: fakeDoc }).promise;
            numPages = pdf.numPages;
            pageTextData = [];
            
            for (let p = 1; p <= numPages; p++) {
                const page = await pdf.getPage(p);
                const content = await page.getTextContent();
                const vp = page.getViewport({ scale: 1.0 });
                
                let pageText = '';
                for (const item of content.items) {
                    pageText += item.str;
                }
                const textItems = [];
                for (const item of content.items) {
                    textItems.push({
                        text: item.str,
                        transform: item.transform,
                        width: item.width,
                        height: item.height
                    });
                }
                pageTextData.push({ text: pageText, viewport: { width: vp.width, height: vp.height }, items: textItems });
            }
        }
        
        const keywords = window.KEYWORDS || [];
        const combinedRegex = getKeywordRegex(keywords);
        const counts = {};
        let totalMatches = 0;

        if (combinedRegex) {
            for (const pageData of pageTextData) {
                const text = pageData.text || '';
                let match;
                const regex = new RegExp(combinedRegex.source, 'gi');
                while ((match = regex.exec(text)) !== null) {
                    if (match[0].length < 3) continue;
                    if (!/[a-zA-Z]/.test(match[0])) continue;
                    const lower = match[0].toLowerCase();
                    const key = keywords.find(k => k.toLowerCase() === lower) || lower;
                    counts[key] = (counts[key] || 0) + 1;
                    totalMatches++;
                }
            }
        }

        console.log('[PDF] Processed', fileName, '- Found', totalMatches, 'matches');

        docTextCache[id] = { totalPages: numPages, pages: pageTextData, fileName };
        totalDocsFound++;

        renderCard(fileName, counts, id, file);
        totalMatchesFound += totalMatches;
        updateStats();
    } catch (err) {
        console.error('[PDF] Error processing PDF:', err);
        updateProgressMainThread();
    }
}

async function extractDocText(arrayBuffer, fileName, id, file = null) {
    try {
        const type = getFileType(fileName);
        let htmlContent = '';
        let plainText = '';

        if (type === 'docx' || type === 'doc') {
            const htmlResult = await mammoth.convertToHtml({ arrayBuffer: arrayBuffer });
            htmlContent = htmlResult.value;
            const textResult = await mammoth.extractRawText({ arrayBuffer: arrayBuffer });
            plainText = textResult.value.replace(/\s+/g, ' ').trim();
        }

        if (!plainText && !htmlContent) {
            console.warn('[DOC] No text extracted from:', fileName);
            updateProgressMainThread();
            return;
        }

        const keywords = window.KEYWORDS || [];
        const combinedRegex = getKeywordRegex(keywords);
        const counts = {};
        let totalMatches = 0;
        let match;

        if (combinedRegex) {
            const regex = new RegExp(combinedRegex.source, 'gi');
            while ((match = regex.exec(plainText)) !== null) {
                if (match[0].length < 3) continue;
                if (!/[a-zA-Z]/.test(match[0])) continue;
                const lower = match[0].toLowerCase();
                const key = keywords.find(k => k.toLowerCase() === lower) || lower;
                counts[key] = (counts[key] || 0) + 1;
                totalMatches++;
            }
        }

        console.log('[DOC] Processed', fileName, '- Found', totalMatches, 'matches');

        docContentCache[id] = { html: htmlContent, text: plainText, fileName, type };
        totalDocsFound++;

        renderCard(fileName, counts, id, file);
        totalMatchesFound += totalMatches;
        updateStats();
    } catch (err) {
        console.error('[DOC] Error processing document:', err);
        updateProgressMainThread();
    }
}

function updateProgressMainThread() {
    processed++;
    progressBar.style.width = `${Math.round((processed / totalFiles) * 100)}%`;
    
    if (processed === totalFiles) {
        renderResultsArea();
        if (totalMatchesFound === 0) {
            statusBar.textContent = "No matches found";
        } else {
            statusBar.textContent = `${totalMatchesFound} matches across ${totalDocsFound} document${totalDocsFound !== 1 ? 's' : ''}`;
        }
    }
}

async function handleDrop(e) {
    const entries = [];
    if (e.dataTransfer.items) {
        for (let i = 0; i < e.dataTransfer.items.length; i++) {
            const entry = e.dataTransfer.items[i].webkitGetAsEntry();
            if (entry) entries.push(entry);
        }
    }
    basePath = '';
    let filesToProcess = [];
    for (const entry of entries) {
        if (entry.isFile && entry.name.toLowerCase().endsWith('.zip')) {
            const zipFile = await new Promise((resolve) => entry.file(resolve));
            basePath = zipFile.name.replace(/\.zip$/i, '');
            filesToProcess = filesToProcess.concat(await extractAllFromZip(zipFile));
        } else {
            await traverseFileTree(entry, filesToProcess, '');
            basePath = entry.name;
        }
    }

    if (filesToProcess.length === 0) {
        const viewerMsg = document.getElementById('viewerDropMsg');
        if (viewerMsg) viewerMsg.style.display = 'none';
        const statusMsgs = resultsArea.querySelectorAll('.status-msg');
        statusMsgs.forEach(el => el.remove());
        statusBar.textContent = 'No supported files found in folder';
        progressBar.style.width = '0%';
    } else {
        processFiles(filesToProcess);
    }
}

let sidebarDragging = false;
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(name => {
    sidebar.addEventListener(name, (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (name === 'dragenter') {
            sidebarDragging = true;
            sidebar.classList.add('drag-over');
        }
        if ((name === 'dragleave' && !sidebar.contains(e.relatedTarget)) || name === 'drop') {
            sidebar.classList.remove('drag-over');
            sidebarDragging = false;
        }
    }, false);
});

sidebar.addEventListener('drop', handleDrop);

const viewerContainer = document.querySelector('.viewer-container');
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(name => {
    viewerContainer.addEventListener(name, (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (name === 'dragover') viewerContainer.style.background = "var(--grey-700)";
        if (name === 'dragleave' || name === 'drop') viewerContainer.style.background = "";
    }, false);
});

viewerContainer.addEventListener('drop', handleDrop);

let basePath = '';

async function traverseFileTree(item, fileList, baseDir = '') {
    const currentPath = baseDir ? baseDir + '/' + item.name : item.name;
    const type = getFileType(item.name);
    if (item.isFile && type) {
        const file = await new Promise((resolve) => item.file(resolve));
        file.relativePath = currentPath;
        fileList.push(file);
    } else if (item.isDirectory) {
        const dirReader = item.createReader();
        const entries = await new Promise((resolve) => dirReader.readEntries(resolve));
        for (let entry of entries) await traverseFileTree(entry, fileList, currentPath);
    }
}

document.getElementById('folderInput').addEventListener('change', async (e) => {
    let filesToProcess = [];
    for (const file of e.target.files) {
        const type = getFileType(file.name);
        if (file.name.toLowerCase().endsWith('.zip')) {
            filesToProcess = filesToProcess.concat(await extractAllFromZip(file));
        } else if (type) {
            file.relativePath = file.webkitRelativePath || file.name;
            filesToProcess.push(file);
        }
    }
    processFiles(filesToProcess);
});

async function extractAllFromZip(zipFile) {
    const zip = await JSZip.loadAsync(zipFile);
    const extracted = [];
    const promises = [];
    zip.forEach((path, entry) => {
        if (!entry.dir) {
            const type = getFileType(path);
            if (type) {
                let mimeType = 'application/pdf';
                if (type === 'docx') mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
                else if (type === 'doc') mimeType = 'application/msword';
                promises.push(entry.async("blob").then(blob => {
                    const file = new File([blob], path, { type: mimeType });
                    file.relativePath = path;
                    extracted.push(file);
                }));
            }
        }
    });
    await Promise.all(promises);
    return extracted;
}

// ========== RESIZER ==========

(function() {
    const resizer = document.getElementById("resizer");
    const sidebar = document.getElementById("sidebar");
    resizer.addEventListener("mousedown", (e) => {
        e.preventDefault();
        document.body.classList.add("dragging");
        const startX = e.clientX;
        const startWidth = sidebar.offsetWidth;
        const onMove = (e) => {
            const width = startWidth + (e.clientX - startX);
            if (width > 150 && width < 900) {
                sidebar.style.width = width + "px";
                sidebar.style.flexBasis = width + "px";
            }
        };
        const onUp = () => {
            document.body.classList.remove("dragging");
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    });
})();

// ========== KEYWORDS INIT ==========

const keywordListSelect = document.getElementById('keywordListSelect');

keywordListSelect.addEventListener('change', () => {
    const listName = keywordListSelect.value;
    if (window.switchKeywordList && window.switchKeywordList(listName)) {
        searchCache = {};
        clearSearch();
        if (objectUrls.length > 0) {
            rescanAllDocuments();
        }
    }
});

async function rescanAllDocuments() {
    console.log('[PDF] rescanAllDocuments called, OCR.enabled:', OCR.enabled);
    
    const viewerMsg = document.getElementById('viewerDropMsg');
    if (viewerMsg) viewerMsg.style.display = 'none';
    
    const ocrPrefix = OCR.enabled ? 'OCR triggered - ' : '';
    statusBar.textContent = `${ocrPrefix}Scanning ${objectUrls.length} documents...`;
    progressBar.style.width = '0%';
    
    resultsArea.innerHTML = '';
    
    totalMatchesFound = 0;
    totalDocsFound = 0;
    let matchedInSession = 0;
    
    if (OCR.enabled) {
        console.log('[PDF] OCR mode enabled, re-extracting all documents with OCR');
        ocrScanning = true;
        
        // Pre-initialize OCR
        await OCR.init().catch(err => console.error('[PDF] OCR init failed:', err));
        
        for (let i = 0; i < objectUrls.length; i++) {
            const url = objectUrls[i];
            const cached = docTextCache[url];
            const fileName = cached?.fileName || `Document ${i + 1}`;
            
            statusBar.textContent = `${ocrPrefix}Scanning ${i + 1}/${objectUrls.length}: ${fileName}...`;
            
            try {
                const response = await fetch(url);
                const blob = await response.blob();
                const arrayBuffer = await blob.arrayBuffer();
                delete docTextCache[url];
                await extractPdfText(arrayBuffer, fileName, url);
            } catch (err) {
                console.error('[PDF] OCR rescan error:', err);
            }
            
            const pct = Math.round(((i + 1) / objectUrls.length) * 100);
            progressBar.style.width = pct + '%';
        }
        ocrScanning = false;
        console.log('[PDF] OCR rescan complete');
    } else {
        const combinedRegex = getKeywordRegex(KEYWORDS);
        
        for (let i = 0; i < objectUrls.length; i++) {
            const url = objectUrls[i];
            const cached = docTextCache[url];
            
            if (!cached) continue;
            
            const counts = {};
            let fileTotalMatches = 0;
            
            for (let p = 0; p < cached.pages.length; p++) {
                const text = cached.pages[p].text;
                let match;
                const regex = new RegExp(combinedRegex.source, 'gi');
                while ((match = regex.exec(text)) !== null) {
                    if (match[0].length < 3) continue;
                    if (!/[a-zA-Z]/.test(match[0])) continue;
                    const lowerMatch = match[0].toLowerCase();
                    const originalKey = KEYWORDS.find(k => k.toLowerCase() === lowerMatch) || lowerMatch;
                    counts[originalKey] = (counts[originalKey] || 0) + 1;
                    fileTotalMatches++;
                }
            }
            
            const fileName = cached.fileName || `Document ${i + 1}`;
            totalDocsFound++;
            
            if (fileTotalMatches > 0) {
                renderCard(fileName, counts, url);
                totalMatchesFound += fileTotalMatches;
                matchedInSession++;
            } else {
                renderNoMatchCard(fileName, url);
            }
            
            const pct = Math.round(((i + 1) / objectUrls.length) * 100);
            progressBar.style.width = pct + '%';
        }
    }
    
    updateStats();
    
    if (totalMatchesFound === 0) {
        statusBar.textContent = "No matches found";
    } else {
        statusBar.textContent = `${totalMatchesFound} matches across ${totalDocsFound} document${totalDocsFound !== 1 ? 's' : ''}`;
    }
}

async function rescanWithNewKeywords() {
    if (!pdfDoc || !currentDocUrl) return;

    const combinedRegex = getKeywordRegex(KEYWORDS);
    let totalMatches = 0;
    const docCounts = {};

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
        const cached = textPageCache[pageNum];
        if (!cached) continue;
        const text = cached.text;
        let match;
        const regex = new RegExp(combinedRegex.source, 'gi');
        while ((match = regex.exec(text)) !== null) {
            if (match[0].length < 3) continue;
            if (!/[a-zA-Z]/.test(match[0])) continue;
            totalMatches++;
            const key = KEYWORDS.find(k => k.toLowerCase() === match[0].toLowerCase()) || match[0].toLowerCase();
            docCounts[key] = (docCounts[key] || 0) + 1;
        }
    }

    const activeCard = document.querySelector('.doc-card.active');
    if (activeCard) {
        const cardName = activeCard.querySelector('.doc-name').textContent;
        activeCard.querySelector('.badge-grid').innerHTML = '';
        KEYWORDS.forEach(k => {
            const count = docCounts[k] || 0;
            if (count > 0) {
                const b = document.createElement('div');
                b.className = 'badge';
                b.textContent = `${k}: ${count}`;
                b.onclick = (e) => {
                    e.stopPropagation();
                    cycleSearch(k);
                };
                activeCard.querySelector('.badge-grid').appendChild(b);
            }
        });
    }

    totalMatchesFound = totalMatches;
    updateStats();
    precomputeAllSearches();
}

document.addEventListener('DOMContentLoaded', async () => {
    if (typeof loadKeywords === 'function') {
        await loadKeywords();
    }
    populateListSelector();
});

/**
 * UI Bridge: Toggles the Keyword Management Modal
 */
function toggleKeywordManager() {
    const modal = document.getElementById('keywordManager');
    if (!modal) {
        console.error("Could not find keywordManager element in DOM");
        return;
    }

    const isShowing = modal.classList.toggle('show');

    if (isShowing) {
        if (typeof populateModalListSelector === 'function') {
            populateModalListSelector();
        }
        if (typeof loadListIntoEditor === 'function') {
            loadListIntoEditor();
        }
    }
}
