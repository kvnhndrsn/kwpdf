pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.js';

// State
let objectUrls = [];
let activeKeyword = "";
let totalMatchesFound = 0;
let totalDocsFound = 0;
let processed = 0;
let totalFiles = 0;

let pdfDoc = null;
let currentDocUrl = "";
let currentScale = 1.0;
let currentPage = 1;
let totalPages = 0;

let searchResults = [];
let currentMatchIndex = -1;
let searchCache = {};

let pageHeights = {};
let renderedPages = new Set();
let renderedScales = {};
let renderTask = null;

let textPageCache = {};
let docTextCache = {};

let smoothScrollEnabled = false;
let isNavigating = false;

let bgRenderRunning = false;
let bgRenderQueue = [];

let zoomRenderTask = null;

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
const heatmapTrack = document.getElementById('heatmapTrack');

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
    updateHeatmap();
}

let settingsOpen = false;

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
    themeBtn.textContent = html.getAttribute('data-theme') === 'light' ? 'Dark Mode' : 'Light Mode';
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
    document.body.appendChild(menu);
    
    setTimeout(() => {
        document.addEventListener('click', closeSettingsOnClickOutside);
    }, 0);
}

function closeSettingsOnClickOutside(e) {
    const menu = document.getElementById('settingsMenu');
    const btn = document.getElementById('settingsBtn');
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

(function() {
    const savedTheme = localStorage.getItem('pdf_theme');
    if (savedTheme === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
    }
})();

// ========== SIDEBAR / SCANNING ==========

function updateStats() {
}

function clearAllResults() {
    if (confirm("Clear all scanned results and start fresh?")) {
        resultsArea.innerHTML = '<h1 class="status-msg">&#10548;</h1><h1 class="status-msg">Drop a folder to begin scanning</h1>';
        objectUrls.forEach(url => URL.revokeObjectURL(url));
        objectUrls = [];
        totalMatchesFound = 0;
        totalDocsFound = 0;
        updateStats();

        pdfDoc = null;
        currentDocUrl = "";
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
    }
}

async function loadPDF(fileUrl, keyword = "") {
    if (currentDocUrl === fileUrl && pdfDoc) {
        if (keyword) {
            performSearch(keyword);
        }
        return;
    }

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

        startBgRender();

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

// ========== PAGE SETUP & RENDERING ==========

let pageObserver = null;

async function setupVirtualPages() {
    viewer.innerHTML = '';
    pageHeights = {};

    if (pageObserver) {
        pageObserver.disconnect();
        pageObserver = null;
    }

    const firstPage = await pdfDoc.getPage(1);
    const firstViewport = firstPage.getViewport({ scale: 1.0 });

    for (let i = 1; i <= totalPages; i++) {
        const h = firstViewport.height;
        pageHeights[i] = h;

        const placeholder = document.createElement('div');
        placeholder.className = 'page-placeholder';
        placeholder.id = 'page-' + i;
        placeholder.dataset.pageNum = i;
        placeholder.style.width = firstViewport.width + 'px';
        placeholder.style.height = h + 'px';
        placeholder.textContent = `Page ${i}`;
        viewer.appendChild(placeholder);
    }

    setupPageObserver();
}

function setupPageObserver() {
    pageObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const pageNum = parseInt(entry.target.dataset.pageNum);
                if (pageNum && !isPageRendered(pageNum)) {
                    renderPageNow(pageNum);
                }
            }
        });
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
    for (const item of textContent.items) {
        pageText += item.str;
    }
    textPageCache[pageNum] = { text: pageText, viewport: vp };
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
}

// ========== SEARCH ==========

async function precomputeAllSearches() {
    for (const keyword of KEYWORDS) {
        if (searchCache[keyword] !== undefined) continue;
        await computeSearchForQuery(keyword);
    }
    populateKeywordSelect();
}

async function computeSearchForQuery(query) {
    if (searchCache[query] !== undefined) return;

    const source = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const localRegex = new RegExp(source, 'gi');
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

    if (searchCache[query] !== undefined) {
        searchResults = searchCache[query];
        activeKeyword = query;
        currentMatchIndex = 0;
        showSearchResults();
        return;
    }

    activeKeyword = query;
    currentMatchIndex = 0;
    clearHighlights();
    searchResults = [];

    await computeSearchForQuery(query);
    searchResults = searchCache[query] || [];

    showSearchResults();
}

function showSearchResults() {
    if (searchResults.length > 0) {
        navGroup.classList.add('active');
        navSep.style.display = '';
        
        matchTotal.textContent = searchResults.length;
        matchInput.max = searchResults.length;
        matchInput.value = 1;
        renderAllHighlights();
        updateHeatmap();
        populateKeywordSelect();
        updateSidebarBadge();
        goToMatch(0);
    } else {
        navGroup.classList.remove('active');
        navSep.style.display = 'none';
        
        matchTotal.textContent = '0';
        matchInput.value = '';
        updateSidebarBadge();
        updateHeatmap();
        populateKeywordSelect();
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
            updateHeatmap();
            populateKeywordSelect();
            goToMatch(currentMatchIndex);
        } else {
            navGroup.classList.remove('active');
            navSep.style.display = 'none';

            matchTotal.textContent = '0';
            matchInput.value = '';
            updateHeatmap();
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
        performSearch(keywordSelect.value);
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

function setZoom(newScale) {
    const clampedScale = Math.max(0.5, Math.min(4.0, newScale));
    if (clampedScale === currentScale) return;

    const oldScrollTop = viewerScroll.scrollTop;
    const oldScrollHeight = viewerScroll.scrollHeight;

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
        viewerScroll.scrollTop = newScrollTop;

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
    setZoom(1.0);
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
    let targetOffset = 0;
    for (let i = 1; i < pageNum; i++) {
        targetOffset += (pageHeights[i] * currentScale || 800) + 32;
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

    let offsetY = 0;
    for (let i = 1; i <= totalPages; i++) {
        const h = (pageHeights[i] || 800) * currentScale;
        const pageBottom = offsetY + h;

        if (scrollTop + containerHeight / 2 < pageBottom) {
            if (i !== currentPage) {
                currentPage = i;
                updatePageInfo();
            }
            break;
        }
        offsetY += h + 32;
    }

    updateHeatmap();
});

// ========== MATCH NAVIGATION ==========

function goToMatch(index) {
    if (searchResults.length === 0) return;

    currentMatchIndex = ((index % searchResults.length) + searchResults.length) % searchResults.length;
    matchInput.value = currentMatchIndex + 1;
    updateSidebarBadge();

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
    if (searchResults.length > 0) {
        goToMatch(currentMatchIndex + 1);
    }
}

function findPrev() {
    if (searchResults.length > 0) {
        goToMatch(currentMatchIndex - 1);
    }
}

function clearSearch() {
    activeKeyword = '';
    searchResults = [];
    currentMatchIndex = -1;
    navGroup.classList.remove('active');
    navSep.style.display = 'none';
    clearHighlights();
    updateHeatmap();
    keywordSelect.value = '';
    matchInput.value = '';
    matchTotal.textContent = '0';
    updateSidebarBadge();
}

// ========== HEATMAP ==========

function updateHeatmap() {
    if (searchResults.length === 0 || !pdfDoc) {
        heatmapTrack.innerHTML = '';
        return;
    }

    const toolbarHeight = document.querySelector('.viewer-toolbar').offsetHeight;
    const containerHeight = document.querySelector('.viewer-container').offsetHeight;
    const scrollableHeight = containerHeight - toolbarHeight;
    const heatmapTopOffset = 15;
    const heatmapBottomOffset = 25;
    const heatmapHeight = scrollableHeight - heatmapTopOffset - heatmapBottomOffset;

    if (scrollableHeight <= 0) return;

    let totalContentHeight = 0;
    for (let i = 1; i <= totalPages; i++) {
        totalContentHeight += (pageHeights[i] || 800) + 32;
    }

    heatmapTrack.innerHTML = '';

    const matchPositions = {};
    searchResults.forEach((result, index) => {
        if (!matchPositions[result.page]) matchPositions[result.page] = [];
        matchPositions[result.page].push(index);
    });

    let offsetY = 0;
    for (let i = 1; i <= totalPages; i++) {
        const pageHeight = pageHeights[i] || 800;
        const pageTop = offsetY;

        if (matchPositions[i]) {
            matchPositions[i].forEach(matchIndex => {
                const result = searchResults[matchIndex];
                const matchY = pageTop + result.y;
                const matchH = Math.max(result.height, 5);

                const progress = matchY / totalContentHeight;
                const barTop = toolbarHeight + heatmapTopOffset + progress * heatmapHeight;
                const barH = Math.max(2, (matchH / totalContentHeight) * heatmapHeight);

                const bar = document.createElement('div');
                bar.className = 'heatmap-bar' + (matchIndex === currentMatchIndex ? ' current-match' : '');

                bar.style.top = barTop + 'px';
                bar.style.height = barH + 'px';

                heatmapTrack.appendChild(bar);
            });
        }

        offsetY += pageHeight + 32;
    }
}

// ========== MOBILE (disabled) ==========

function closeMobileSidebar() {
    sidebar.classList.remove('open');
}

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
    if (e.key === 'g' && !e.ctrlKey && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
        e.preventDefault();
        pageInput.focus();
        pageInput.select();
    }
    if (e.key === 'Escape') {
        pageInput.blur();
        matchInput.blur();
        closeMobileSidebar();
    }
});

// ========== DRAG & DROP ==========

function renderCard(name, counts, url) {
    const card = document.createElement('div');
    card.className = 'doc-card';
    card.dataset.url = url;
    card.onclick = () => { setActiveCard(card); loadPDF(url); closeMobileSidebar(); };
    card.innerHTML = `<div class="doc-name">${name}</div>`;

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
                    cycleSearch(k);
                } else {
                    loadPDF(url, k);
                }
            };
            grid.appendChild(b);
        }
    });
    card.appendChild(grid);
    resultsArea.appendChild(card);
}

function renderNoMatchCard(name, url) {
    const card = document.createElement('div');
    card.className = 'doc-card doc-card-minimal';
    card.onclick = () => { setActiveCard(card); loadPDF(url); closeMobileSidebar(); };
    card.innerHTML = `<div class="doc-name">${name}</div>`;
    resultsArea.appendChild(card);
}

function setActiveCard(card) {
    document.querySelectorAll('.doc-card').forEach(c => c.classList.remove('active'));
    card.classList.add('active');
}

async function processFiles(files) {
    if (files.length === 0) return;

    resultsArea.innerHTML = `<p class="scanning-msg">Scanning ${files.length} documents...</p>`;
    progressBar.style.width = '0%';

    processed = 0;
    totalFiles = files.length;

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const url = URL.createObjectURL(file);
        objectUrls.push(url);

        const arrayBuffer = await file.arrayBuffer();
        
        await extractPdfText(arrayBuffer, file.name, url);
        
        updateProgressMainThread();
    }
}

async function extractPdfText(arrayBuffer, fileName, id) {
    try {
        const fakeDoc = {
            createElement: name => name === 'canvas' ? new OffscreenCanvas(1, 1) : null,
            fonts: {}
        };
        
        const pdfData = new Uint8Array(arrayBuffer);
        const pdf = await pdfjsLib.getDocument({ data: pdfData, ownerDocument: fakeDoc }).promise;
        
        const pageTextData = [];
        
        for (let p = 1; p <= pdf.numPages; p++) {
            const page = await pdf.getPage(p);
            const content = await page.getTextContent();
            const vp = page.getViewport({ scale: 1.0 });
            
            let pageText = '';
            for (const item of content.items) {
                pageText += item.str;
            }
            pageTextData.push({ text: pageText, viewport: { width: vp.width, height: vp.height } });
        }
        
        const keywords = window.KEYWORDS || [];
    if (keywords.length === 0) {
        console.warn('No keywords available, skipping processing');
        return;
    }
    
    const combinedRegex = new RegExp(keywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
    const counts = {};
    let totalMatches = 0;
    
    for (const pageData of pageTextData) {
        const matches = pageData.text.match(combinedRegex) || [];
        for (const match of matches) {
            const lower = match.toLowerCase();
            const key = keywords.find(k => k.toLowerCase() === lower) || lower;
            counts[key] = (counts[key] || 0) + 1;
            totalMatches++;
        }
    }
        
        if (totalMatches > 0) {
            docTextCache[id] = { totalPages: pdf.numPages, pages: pageTextData, fileName };
            renderCard(fileName, counts, id);
            totalMatchesFound += totalMatches;
            totalDocsFound++;
            updateStats();
        } else {
            renderNoMatchCard(fileName, id);
        }
    } catch (err) {
        console.error('Error processing PDF:', err);
    }
}

function updateProgressMainThread() {
    processed++;
    progressBar.style.width = `${Math.round((processed / totalFiles) * 100)}%`;
    
    if (processed === totalFiles) {
        if (resultsArea.querySelector('.scanning-msg')) {
            resultsArea.querySelector('.scanning-msg').remove();
        }
        
        if (totalDocsFound === 0) {
            resultsArea.innerHTML = "<p class='status-msg'>No matches found in the selected folder.</p>";
        } else {
            const summary = document.createElement('p');
            summary.className = 'status-msg';
            summary.style.marginTop = '12px';
            summary.style.color = 'var(--green-light)';
            summary.textContent = `Done — ${totalDocsFound} document${totalDocsFound !== 1 ? 's' : ''} with matches`;
            resultsArea.appendChild(summary);
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
    let filesToProcess = [];
    for (const entry of entries) {
        if (entry.isFile && entry.name.toLowerCase().endsWith('.zip')) {
            const zipFile = await new Promise((resolve) => entry.file(resolve));
            filesToProcess = filesToProcess.concat(await extractPdfsFromZip(zipFile));
        } else {
            await traverseFileTree(entry, filesToProcess);
        }
    }
    if (filesToProcess.length > 0) {
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

async function traverseFileTree(item, fileList) {
    if (item.isFile && item.name.toLowerCase().endsWith('.pdf')) {
        fileList.push(await new Promise((resolve) => item.file(resolve)));
    } else if (item.isDirectory) {
        const dirReader = item.createReader();
        const entries = await new Promise((resolve) => dirReader.readEntries(resolve));
        for (let entry of entries) await traverseFileTree(entry, fileList);
    }
}

document.getElementById('folderInput').addEventListener('change', async (e) => {
    let filesToProcess = [];
    for (const file of e.target.files) {
        if (file.name.toLowerCase().endsWith('.zip')) {
            filesToProcess = filesToProcess.concat(await extractPdfsFromZip(file));
        } else if (file.name.toLowerCase().endsWith('.pdf')) {
            filesToProcess.push(file);
        }
    }
    processFiles(filesToProcess);
});

async function extractPdfsFromZip(zipFile) {
    const zip = await JSZip.loadAsync(zipFile);
    const extracted = [];
    const promises = [];
    zip.forEach((path, entry) => {
        if (!entry.dir && path.toLowerCase().endsWith('.pdf')) {
            promises.push(entry.async("blob").then(blob => {
                extracted.push(new File([blob], entry.name, { type: "application/pdf" }));
            }));
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

function populateListSelector() {
    keywordListSelect.innerHTML = '';
    for (const name of Object.keys(KEYWORD_LISTS)) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = `${name} (${KEYWORD_LISTS[name].length})`;
        keywordListSelect.appendChild(opt);
    }
    const savedListName = localStorage.getItem('tender_keyword_list') || DEFAULT_LIST_NAME;
    if (KEYWORD_LISTS[savedListName]) {
        keywordListSelect.value = savedListName;
    }
}

keywordListSelect.addEventListener('change', () => {
    const listName = keywordListSelect.value;
    if (switchKeywordList(listName)) {
        searchCache = {};
        clearSearch();
        if (objectUrls.length > 0) {
            rescanAllDocuments();
        }
    }
});

async function rescanAllDocuments() {
    resultsArea.innerHTML = '<p class="scanning-msg">Rescanning documents...</p>';
    progressBar.style.width = '0%';
    
    totalMatchesFound = 0;
    totalDocsFound = 0;
    let matchedInSession = 0;
    
    const combinedRegex = new RegExp(KEYWORDS.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
    
    for (let i = 0; i < objectUrls.length; i++) {
        const url = objectUrls[i];
        const cached = docTextCache[url];
        
        if (!cached) continue;
        
        const counts = {};
        let fileTotalMatches = 0;
        
        for (let p = 0; p < cached.pages.length; p++) {
            const text = cached.pages[p].text;
            const matches = text.match(combinedRegex) || [];
            matches.forEach(match => {
                const lowerMatch = match.toLowerCase();
                const originalKey = KEYWORDS.find(k => k.toLowerCase() === lowerMatch) || lowerMatch;
                counts[originalKey] = (counts[originalKey] || 0) + 1;
                fileTotalMatches++;
            });
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
    
    if (resultsArea.querySelector('.scanning-msg')) {
        resultsArea.querySelector('.scanning-msg').remove();
    }
    
    updateStats();
    
    const summary = document.createElement('p');
    summary.className = 'status-msg';
    summary.style.marginTop = '12px';
    summary.style.color = 'var(--green-light)';
    summary.textContent = `Done — ${matchedInSession} document${matchedInSession !== 1 ? 's' : ''} with matches`;
    resultsArea.appendChild(summary);
}

async function rescanWithNewKeywords() {
    if (!pdfDoc || !currentDocUrl) return;

    const combinedRegex = new RegExp(KEYWORDS.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
    let totalMatches = 0;
    const docCounts = {};

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
        const cached = textPageCache[pageNum];
        if (!cached) continue;
        const matches = cached.text.match(combinedRegex) || [];
        totalMatches += matches.length;
        matches.forEach(m => {
            const key = KEYWORDS.find(k => k.toLowerCase() === m.toLowerCase()) || m.toLowerCase();
            docCounts[key] = (docCounts[key] || 0) + 1;
        });
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

populateListSelector();

if (typeof saved === 'undefined' || !window.KEYWORDS) {
    const _saved = localStorage.getItem('tender_keywords');
    if (_saved) {
        try {
            window.KEYWORDS = JSON.parse(_saved);
        } catch {}
    }
}

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
