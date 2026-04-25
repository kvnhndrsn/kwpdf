// ========== REGEX HELPERS ==========

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
        return '<img src="pdf.svg" width="16" height="16" alt="pdf">';
    }
    if (type === 'docx' || type === 'doc') {
        return '<img src="docx.svg" width="16" height="16" alt="docx">';
    }
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="#757575"><path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20Z"/></svg>';
}

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

// ========== STATE ==========

let objectUrls = [];
window.activeKeyword = "";
window.totalMatchesFound = 0;
window.totalDocsFound = 0;
window.processed = 0;
window.totalFiles = 0;

window.currentDocType = 'pdf';
let docContentCache = {};

window.pdfDoc = null;
window.currentDocUrl = "";
window.currentScale = 1.0;
window.currentPage = 1;
window.totalPages = 0;

window.searchResults = [];
window.currentMatchIndex = -1;
let searchCache = {};

window.pageHeights = {};
window.renderedPages = new Set();
window.renderedScales = {};
window.zoomRenderTask = null;
window.textPageCache = {};
let docTextCache = {};

window.isNavigating = false;
let ocrScanning = false;

window.bgRenderRunning = false;
window.bgRenderQueue = [];
window.pageObserver = null;
window.renderPageDebounce = null;

// ========== DOCX STATE ==========

let docSearchResults = [];
let docCurrentMatchIndex = -1;
let docOriginalHtml = null;

// ========== DATA CACHE ==========

window.docDataCache = {};
let basePath = '';

// ========== PDF LOADING ==========

function loadPDF(fileUrl, keyword = "") {
    if (window.currentDocUrl === fileUrl && window.pdfDoc) {
        if (keyword) {
            window.performSearch(keyword);
        }
        return;
    }

    if (window.currentLayout === 'tree' && window.currentDocUrl && window.currentDocUrl !== fileUrl) {
        window.expandedTreeItems.delete(window.currentDocUrl);
    }
    if (window.currentLayout === 'tree' && fileUrl) {
        window.expandedTreeItems.add(fileUrl);
    }
    
    window.currentDocUrl = fileUrl;
    cancelBgRender();

    if (window.pdfDoc) {
        try {
            window.pdfDoc.destroy();
        } catch (e) {
            console.warn("Error destroying previous PDF:", e);
        }
        window.pdfDoc = null;
    }

    window.viewer.style.display = '';
    window.loader.style.display = 'flex';
    window.loaderFilename.textContent = 'Loading PDF...';
    window.loaderStatus.textContent = 'Initializing...';
    window.loaderProgressFill.style.width = '10%';
    window.viewer.innerHTML = '';
    window.renderedPages.clear();
    window.renderedScales = {};
    window.pageHeights = {};
    searchCache = {};
    window.clearSearch();
    window.currentScale = 1.0;
    window.currentPage = 1;
    window.textPageCache = {};

    (async () => {
        try {
            window.pdfDoc = await pdfjsLib.getDocument(fileUrl).promise;
            window.currentDocUrl = fileUrl;
            window.totalPages = window.pdfDoc.numPages;

            window.loaderStatus.textContent = `Setting up ${window.totalPages} pages...`;
            window.loaderProgressFill.style.width = '30%';
            await setupVirtualPages();

            window.loaderStatus.textContent = 'Extracting text content...';
            window.loaderProgressFill.style.width = '60%';

            const cached = docTextCache[fileUrl];
            if (cached) {
                for (let i = 0; i < cached.pages.length; i++) {
                    window.textPageCache[i + 1] = cached.pages[i];
                }
                window.loaderProgressFill.style.width = '80%';
                await precomputeAllSearches();
            }

            window.loaderProgressFill.style.width = '100%';
            window.loader.style.display = 'none';
            window.updatePageInfo();
            window.updateZoomDisplay();
            window.pageInput.max = window.totalPages;
            window.pageTotal.textContent = window.totalPages;

            window.updateHeatmap();
            startBgRender();

            if (window.currentLayout === 'tree') {
                window.renderResultsArea();
            }

            if (keyword) {
                window.performSearch(keyword);
            }
        } catch (err) {
            window.loaderFilename.textContent = 'Error loading PDF';
            window.loaderStatus.textContent = err.message;
            window.loaderProgressFill.style.width = '0%';
            console.error('PDF load error:', err);
        }
    })();
}

function getDocTypeFromUrl(url) {
    const dataCached = window.docDataCache[url];
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

function loadDocument(fileUrl, keyword = "") {
    const type = getDocTypeFromUrl(fileUrl);
    if (type === 'pdf') {
        loadPDF(fileUrl, keyword);
    } else if (type === 'docx' || type === 'doc') {
        loadDocxDoc(fileUrl, keyword);
    } else {
        loadPDF(fileUrl, keyword);
    }
}

function loadDocxDoc(fileUrl, keyword = "") {
    if (window.currentDocUrl === fileUrl && docContentCache[fileUrl]) {
        if (keyword) {
            window.cycleDocSearch(keyword);
        }
        return;
    }

    cancelBgRender();
    window.currentDocUrl = fileUrl;
    const cachedInfo = docContentCache[fileUrl];
    window.currentDocType = cachedInfo?.type || getDocTypeFromUrl(fileUrl);

    window.loader.style.display = 'flex';
    window.loaderFilename.textContent = 'Loading document...';
    window.loaderStatus.textContent = 'Parsing...';
    window.loaderProgressFill.style.width = '30%';
    window.viewer.innerHTML = '';
    window.clearSearch();
    window.textPageCache = {};

    (async () => {
        try {
            const cached = docContentCache[fileUrl];
            if (!cached) throw new Error('Document not found in cache');

            window.loaderProgressFill.style.width = '70%';
            window.loaderStatus.textContent = 'Rendering...';

            renderDocContent(cached.html, cached.text);
            window.loaderProgressFill.style.width = '100%';
            window.loader.style.display = 'none';

            window.totalPages = 1;
            window.currentPage = 1;

            window.updatePageInfo();
            window.updateZoomDisplay();
            window.pageInput.max = 1;
            window.pageTotal.textContent = '1';

            startDocSearchComputation();

            if (keyword) {
                window.cycleDocSearch(keyword);
            }
        } catch (err) {
            window.loaderFilename.textContent = 'Error loading document';
            window.loaderStatus.textContent = err.message;
            window.loaderProgressFill.style.width = '0%';
            console.error('Document load error:', err);
        }
    })();
}

function renderDocContent(html, plainText) {
    window.viewer.innerHTML = '';
    window.textPageCache[1] = { text: plainText, viewport: { width: 800, height: 600 }, items: [] };

    if (!html) {
        window.viewer.innerHTML = '<div style="padding:20px;">No content to display</div>';
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

    window.viewer.appendChild(container);
}

// ========== DOC SEARCH ==========

async function startDocSearchComputation() {
    const cached = docContentCache[window.currentDocUrl];
    if (!cached) return;

    const combinedRegex = getKeywordRegex(window.KEYWORDS);
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
        const key = window.KEYWORDS.find(k => k.toLowerCase() === lower) || lower;
        counts[key] = (counts[key] || 0) + 1;
    });

    searchCache._docCounts = counts;
    searchCache._docResults = results;
    window.populateKeywordSelect();
}

window.performDocSearch = async function(query) {
    if (!window.currentDocUrl || !docContentCache[window.currentDocUrl]) return;

    const cached = docContentCache[window.currentDocUrl];
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
        window.navGroup.classList.add('active');
        window.navSep.style.display = '';
        window.matchTotal.textContent = results.length;
        window.matchInput.max = results.length;
        window.matchInput.value = 1;
        renderDocHighlights();
        window.updateSidebarBadge();
        goToDocMatch(0);
    } else {
        window.navGroup.classList.remove('active');
        window.navSep.style.display = '';
        window.matchTotal.textContent = '0';
        window.matchInput.value = '';
    }
};

window.cycleDocSearch = function(query) {
    if (!window.currentDocUrl || !docContentCache[window.currentDocUrl]) return;

    const cached = docContentCache[window.currentDocUrl];
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

    if (results.length === 0) return;

    const wasSameQuery = (docSearchResults.length > 0 && docContentCache[window.currentDocUrl]?.lastQuery === query);
    if (!wasSameQuery) {
        docCurrentMatchIndex = 0;
    } else {
        docCurrentMatchIndex = (docCurrentMatchIndex + 1) % results.length;
    }
    docContentCache[window.currentDocUrl].lastQuery = query;

    docSearchResults = results;

    window.navGroup.classList.add('active');
    window.navSep.style.display = '';
    window.matchTotal.textContent = results.length;
    window.matchInput.max = results.length;
    window.matchInput.value = docCurrentMatchIndex + 1;
    renderDocHighlights();
    window.updateSidebarBadge();
};

function renderDocHighlights() {
    const container = window.viewer.querySelector('.doc-viewer');
    if (!container || !docOriginalHtml) return;

    container.innerHTML = docOriginalHtml;

    if (!docSearchResults.length) return;

    const currentResult = docSearchResults[docCurrentMatchIndex];
    if (!currentResult) return;

    const plainText = docContentCache[window.currentDocUrl]?.text || '';
    const matchText = plainText.substring(currentResult.index, currentResult.index + currentResult.length);
    const escapedMatch = matchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const searchRegex = new RegExp(escapedMatch, 'gi');

    let matchCount = 0;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, null);
    const nodes = [];
    let node;
    while (node = walker.nextNode()) nodes.push(node);

    for (const textNode of nodes) {
        if (searchRegex.test(textNode.textContent)) {
            searchRegex.lastIndex = 0;
            const span = document.createElement('span');
            span.innerHTML = textNode.textContent.replace(searchRegex, match => {
                const isCurrent = (matchCount === docCurrentMatchIndex);
                matchCount++;
                return `<mark class="doc-highlight${isCurrent ? ' current' : ''}">${match}</mark>`;
            });
            textNode.parentNode.replaceChild(span, textNode);
        }
    }

    const currentMark = container.querySelector('.doc-highlight.current');
    if (currentMark) {
        currentMark.scrollIntoView({ behavior: window.smoothScrollEnabled ? 'smooth' : 'auto', block: 'center' });
    }
}

function goToDocMatch(index) {
    if (!docSearchResults.length) return;

    docCurrentMatchIndex = ((index % docSearchResults.length) + docSearchResults.length) % docSearchResults.length;
    window.matchInput.value = docCurrentMatchIndex + 1;
    window.updateSidebarBadge();

    const result = docSearchResults[docCurrentMatchIndex];
    const plainText = docContentCache[window.currentDocUrl]?.text || '';
    const textLen = plainText.length;
    const targetFraction = result.index / textLen;
    const scrollHeight = window.viewerScroll.scrollHeight - window.viewerScroll.clientHeight;
    const targetTop = scrollHeight * targetFraction;

    window.viewerScroll.scrollTo({ top: Math.max(0, targetTop), behavior: window.smoothScrollEnabled ? 'smooth' : 'auto' });

    renderDocHighlights();
}

// ========== PAGE SETUP & RENDERING ==========

async function setupVirtualPages() {
    window.viewer.innerHTML = '';
    window.pageHeights = {};

    if (window.pageObserver) {
        window.pageObserver.disconnect();
        window.pageObserver = null;
    }

    const pagePromises = [];
    for (let i = 1; i <= window.totalPages; i++) {
        pagePromises.push(window.pdfDoc.getPage(i));
    }
    const pages = await Promise.all(pagePromises);

    const placeholders = [];
    for (let i = 0; i < pages.length; i++) {
        const pageNum = i + 1;
        const page = pages[i];
        const viewport = page.getViewport({ scale: 1.0 });
        window.pageHeights[pageNum] = viewport.height;

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
        window.viewer.appendChild(p);
    }

    window.setupPageObserver();
}

window.setupPageObserver = function() {
    if (window.pageObserver) {
        window.pageObserver.disconnect();
    }

    window.pageObserver = new IntersectionObserver((entries) => {
        if (window.renderPageDebounce) return;

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

        window.renderPageDebounce = setTimeout(() => {
            window.renderPageDebounce = null;
            if (pagesToRender.length <= 3) {
                pagesToRender.forEach(p => window.renderPageNow(p));
            } else {
                const mid = Math.floor(pagesToRender.length / 2);
                pagesToRender.slice(0, mid).forEach(p => window.renderPageNow(p));
                setTimeout(() => {
                    pagesToRender.slice(mid).forEach(p => window.renderPageNow(p));
                }, 50);
            }
        }, 20);
    }, { root: window.viewerScroll, rootMargin: "500px" });

    document.querySelectorAll('[id^="page-"]').forEach(el => {
        window.pageObserver.observe(el);
    });
};

function startBgRender() {
    if (window.bgRenderRunning || !window.pdfDoc) return;
    window.bgRenderRunning = true;

    window.bgRenderQueue = [];
    for (let i = 1; i <= window.totalPages; i++) {
        if (!isPageRendered(i)) {
            window.bgRenderQueue.push(i);
        }
    }

    renderNextBg();
}

async function renderNextBg() {
    if (!window.bgRenderQueue.length) {
        window.bgRenderRunning = false;
        return;
    }

    const pageNum = window.bgRenderQueue.shift();

    if (!isPageRendered(pageNum)) {
        await window.renderPageNow(pageNum);
    }

    requestAnimationFrame(renderNextBg);
}

function cancelBgRender() {
    window.bgRenderQueue = [];
    window.bgRenderRunning = false;
}

function isPageRendered(pageNum) {
    return window.renderedPages.has(pageNum);
}

window.renderPageNow = async function(pageNum, forceScale = null) {
    const renderScale = forceScale || window.currentScale;
    const dpr = window.devicePixelRatio || 1;
    const effectiveScale = renderScale * dpr;
    
    if (window.renderedPages.has(pageNum) && !forceScale) {
        return;
    }
    
    if (!window.pdfDoc) return;
    
    window.renderedPages.add(pageNum);
    window.renderedScales[pageNum] = Math.max(window.renderedScales[pageNum] || 0, renderScale);

    try {
        const page = await window.pdfDoc.getPage(pageNum);
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
        window.textPageCache[pageNum] = { text: pageText, viewport: vp, items: textItems };
        window.pageHeights[pageNum] = vp.height;
        
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

        if (window.searchResults.length > 0) {
            renderHighlightsForPage(pageNum);
        }
    } catch (err) {
        window.renderedPages.delete(pageNum);
        if (err.name !== 'RenderingCancelledException') {
            console.warn('Render error:', err.message);
        }
    }
};

// ========== SEARCH ==========

async function precomputeAllSearches() {
    if (searchCache._deduplicated) return;
    
    const combinedRegex = getKeywordRegex(window.KEYWORDS);
    
    for (let pageNum = 1; pageNum <= window.totalPages; pageNum++) {
        const cached = window.textPageCache[pageNum];
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
            const canonical = window.KEYWORDS.find(k => k.toLowerCase() === lower) || lower;
            
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
    window.populateKeywordSelect();
}

async function computeSearchForQuery(query) {
    if (searchCache[query] !== undefined) return;

    if (searchCache._deduplicated) {
        return;
    }

    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const localRegex = new RegExp(`\\b${escaped}\\b`, 'gi');
    const results = [];

    for (let pageNum = 1; pageNum <= window.totalPages; pageNum++) {
        const cached = window.textPageCache[pageNum];
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
    if (!window.pdfDoc) return null;
    const cached = window.textPageCache[pageNum];
    if (!cached || cached.items) return cached?.items;

    const page = await window.pdfDoc.getPage(pageNum);
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

window.performSearch = async function(query) {
    if (!window.pdfDoc || !query) return;

    let canonicalQuery = query;
    if (searchCache[query] === undefined) {
        const lower = query.toLowerCase();
        const found = window.KEYWORDS.find(k => k.toLowerCase() === lower);
        if (found && searchCache[found] !== undefined) {
            canonicalQuery = found;
        }
    }

    if (searchCache[canonicalQuery] !== undefined) {
        window.searchResults = searchCache[canonicalQuery];
        window.activeKeyword = canonicalQuery;
        window.currentMatchIndex = 0;
        window.showSearchResults();
        return;
    }

    window.activeKeyword = canonicalQuery;
    window.currentMatchIndex = 0;
    window.clearHighlights();
    window.searchResults = [];

    await computeSearchForQuery(canonicalQuery);
    window.searchResults = searchCache[canonicalQuery] || [];

    window.showSearchResults();
};

window.showSearchResults = function() {
    if (window.searchResults.length > 0) {
        window.navGroup.classList.add('active');
        window.navSep.style.display = '';

        window.matchTotal.textContent = window.searchResults.length;
        window.matchInput.max = window.searchResults.length;
        window.matchInput.value = 1;
        window.currentMatchIndex = 0;
        window.renderAllHighlights();
        window.populateKeywordSelect();
        window.updateSidebarBadge();
        window.updateHeatmap();
        window.goToMatch(0);
    } else {
        window.navGroup.classList.remove('active');
        window.navSep.style.display = '';

        window.matchTotal.textContent = '0';
        window.matchInput.value = '';
        window.currentMatchIndex = -1;
        window.updateSidebarBadge();
        window.populateKeywordSelect();
        window.updateHeatmap();
    }
};

window.cycleSearch = function(query) {
    if (!window.pdfDoc || !query) return;

    if (searchCache[query] !== undefined) {
        window.searchResults = searchCache[query];
        window.activeKeyword = query;

        if (window.searchResults.length > 0) {
            window.navGroup.classList.add('active');
            window.navSep.style.display = '';
            window.currentMatchIndex = (window.currentMatchIndex + 1) % window.searchResults.length;
            window.matchTotal.textContent = window.searchResults.length;
            window.matchInput.max = window.searchResults.length;
            window.matchInput.value = window.currentMatchIndex + 1;
            window.renderAllHighlights();
            window.populateKeywordSelect();
            window.updateHeatmap();
            window.goToMatch(window.currentMatchIndex);
        } else {
            window.navGroup.classList.remove('active');
            window.navSep.style.display = 'none';

            window.matchTotal.textContent = '0';
            window.matchInput.value = '';
            window.populateKeywordSelect();
        }
        return;
    }

    window.performSearch(query);
};

window.renderAllHighlights = function() {
    window.clearHighlights();

    for (let i = 0; i < window.searchResults.length; i++) {
        renderHighlightMark(window.searchResults[i], i);
    }
};

function renderHighlightsForPage(pageNum) {
    window.searchResults.forEach((result, index) => {
        if (result.page === pageNum) {
            renderHighlightMark(result, index);
        }
    });
}

function renderHighlightMark(result, index) {
    const pageEl = document.getElementById('page-' + result.page);
    if (!pageEl) return;

    const mark = document.createElement('div');
    mark.className = 'highlight-mark' + (index === window.currentMatchIndex ? ' current' : '');
    mark.style.left = (result.x * window.currentScale) + 'px';
    mark.style.top = (result.y * window.currentScale) + 'px';
    mark.style.width = (result.width * window.currentScale) + 'px';
    mark.style.height = (result.height * window.currentScale) + 'px';

    pageEl.appendChild(mark);
}

window.clearHighlights = function() {
    window.viewer.querySelectorAll('.highlight-mark').forEach(el => el.remove());
};

window.populateKeywordSelect = function() {
    window.keywordSelect.innerHTML = '';
    window.KEYWORDS.forEach(k => {
        if (searchCache[k] && searchCache[k].length > 0) {
            const opt = document.createElement('option');
            opt.value = k;
            opt.textContent = `${k} (${searchCache[k].length})`;
            if (k === window.activeKeyword) opt.selected = true;
            window.keywordSelect.appendChild(opt);
        }
    });
};

// ========== ZOOM ==========

window.setZoom = function(newScale, force = false) {
    const clampedScale = Math.max(0.5, Math.min(4.0, newScale));
    if (clampedScale === window.currentScale && !force) return;

    const oldScrollTop = window.viewerScroll.scrollTop;
    const oldScrollHeight = window.viewerScroll.scrollHeight;
    const scaleRatio = clampedScale / window.currentScale;

    window.currentScale = clampedScale;
    window.updateZoomDisplay();

    for (let i = 1; i <= window.totalPages; i++) {
        const el = document.getElementById('page-' + i);
        if (!el) continue;
        const baseH = window.pageHeights[i] || 800;
        const cached = window.textPageCache[i];
        const baseW = cached ? cached.viewport.width : 600;
        el.style.width = (baseW * window.currentScale) + 'px';
        el.style.height = (baseH * window.currentScale) + 'px';
        const canvas = el.querySelector('canvas');
        if (canvas) {
            canvas.style.width = (baseW * window.currentScale) + 'px';
            canvas.style.height = (baseH * window.currentScale) + 'px';
        }
        const textLayer = el.querySelector('.textLayer');
        if (textLayer) {
            textLayer.style.width = (baseW * window.currentScale) + 'px';
            textLayer.style.height = (baseH * window.currentScale) + 'px';
        }
    }

    window.renderedPages.clear();
    window.renderedScales = {};

    requestAnimationFrame(() => {
        const newScrollHeight = window.viewerScroll.scrollHeight;
        const anchorFraction = oldScrollHeight > 0 ? oldScrollTop / oldScrollHeight : 0;
        const newScrollTop = anchorFraction * newScrollHeight;
        window.viewerScroll.scrollTop = newScrollTop + 30;

        window.clearHighlights();
        if (window.pageObserver) {
            window.pageObserver.disconnect();
            window.setupPageObserver();
        }
        if (window.searchResults.length > 0) {
            window.renderAllHighlights();
        }
        window.updateHeatmap();
    });
};

// ========== CLEAR SEARCH ==========

window.clearSearch = function() {
    window.activeKeyword = '';
    window.searchResults = [];
    window.currentMatchIndex = -1;
    window.navGroup.classList.remove('active');
    window.navSep.style.display = 'none';
    window.clearHighlights();
    window.keywordSelect.value = '';
    window.matchInput.value = '';
    window.matchTotal.textContent = '0';
    window.updateSidebarBadge();
    window.updateHeatmap();
};

window.clearAllResults = function() {
    window.resultsArea.innerHTML = '<h1 class="status-msg">&#10548;</h1><h1 class="status-msg">Drop a folder to begin scanning</h1>';
    const viewerDropMsg = document.getElementById('viewerDropMsg');
    if (viewerDropMsg) viewerDropMsg.style.display = 'block';
    window.statusBar.textContent = '';
    objectUrls.forEach(url => URL.revokeObjectURL(url));
    objectUrls = [];
    window.totalMatchesFound = 0;
    window.totalDocsFound = 0;
    window.docDataCache = {};
    docContentCache = {};
    window.expandedTreeItems.clear();
    window.updateStats();

    window.pdfDoc = null;
    window.currentDocUrl = "";
    window.currentDocType = 'pdf';
    window.currentScale = 1.0;
    window.currentPage = 1;
    window.totalPages = 0;
    window.viewer.innerHTML = '';
    window.renderedPages.clear();
    window.renderedScales = {};
    window.pageHeights = {};
    searchCache = {};
    window.clearSearch();
    window.currentScale = 1.0;
    window.currentPage = 1;
    window.textPageCache = {};
    docSearchResults = [];
    docCurrentMatchIndex = -1;
};

// ========== PRERENDER ==========

window.startPrerender = async function() {
    if (window.searchResults.length === 0) return;

    const pagesWithMatches = [...new Set(window.searchResults.map(r => r.page))];

    for (const pageNum of pagesWithMatches) {
        if (!isPageRendered(pageNum)) {
            await window.renderPageNow(pageNum);
        }
    }
};

// ========== FILE PROCESSING ==========

async function processFiles(files) {
    if (files.length === 0) return;

    const viewerMsg = document.getElementById('viewerDropMsg');
    if (viewerMsg) viewerMsg.style.display = 'none';

    const statusMsgs = window.resultsArea.querySelectorAll('.status-msg');
    statusMsgs.forEach(el => el.remove());

    const ocrPrefix = OCR.enabled ? 'OCR triggered - ' : '';
    window.statusBar.textContent = `${ocrPrefix}Scanning ${files.length} documents...`;
    window.progressBar.style.width = '0%';

    window.processed = 0;
    window.totalFiles = files.length;

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
            window.statusBar.textContent = `${ocrPrefix}Scanning ${i + 1}/${files.length}: ${file.name}...`;
        }

        const type = getFileType(file.name);
        if (type === 'pdf') {
            await extractPdfText(arrayBuffer, file.name, url, file);
        } else if (type === 'docx' || type === 'doc') {
            await extractDocText(arrayBuffer, file.name, url, file);
        }

        window.updateProgressMainThread();

        if (OCR.enabled) {
            window.statusBar.textContent = `${ocrPrefix}Scanned ${i + 1}/${files.length} documents...`;
        }
    }
}

async function extractPdfText(arrayBuffer, fileName, id, file) {
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
        window.totalDocsFound++;

        window.renderCard(fileName, counts, id, file);
        window.totalMatchesFound += totalMatches;
        window.updateStats();
    } catch (err) {
        console.error('[PDF] Error processing PDF:', err);
        window.updateProgressMainThread();
    }
}

async function extractDocText(arrayBuffer, fileName, id, file) {
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
            window.updateProgressMainThread();
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
        window.totalDocsFound++;

        window.renderCard(fileName, counts, id, file);
        window.totalMatchesFound += totalMatches;
        window.updateStats();
    } catch (err) {
        console.error('[DOC] Error processing document:', err);
        window.updateProgressMainThread();
    }
}

// ========== DROP HANDLING ==========

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
        const statusMsgs = window.resultsArea.querySelectorAll('.status-msg');
        statusMsgs.forEach(el => el.remove());
        window.statusBar.textContent = 'No supported files found in folder';
        window.progressBar.style.width = '0%';
    } else {
        processFiles(filesToProcess);
    }
}

window.sidebar.addEventListener('drop', handleDrop);

const viewerContainer = document.querySelector('.viewer-container');

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
        for (const entry of entries) await traverseFileTree(entry, fileList, currentPath);
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

// ========== RESCAN ==========

async function rescanAllDocuments() {
    console.log('[PDF] rescanAllDocuments called, OCR.enabled:', OCR.enabled);
    
    const viewerMsg = document.getElementById('viewerDropMsg');
    if (viewerMsg) viewerMsg.style.display = 'none';
    
    const ocrPrefix = OCR.enabled ? 'OCR triggered - ' : '';
    window.statusBar.textContent = `${ocrPrefix}Scanning ${objectUrls.length} documents...`;
    window.progressBar.style.width = '0%';
    
    window.resultsArea.innerHTML = '';
    
    window.totalMatchesFound = 0;
    window.totalDocsFound = 0;
    
    if (OCR.enabled) {
        console.log('[PDF] OCR mode enabled, re-extracting all documents with OCR');
        ocrScanning = true;
        
        await OCR.init().catch(err => console.error('[PDF] OCR init failed:', err));
        
        for (let i = 0; i < objectUrls.length; i++) {
            const url = objectUrls[i];
            const cached = docTextCache[url];
            const fileName = cached?.fileName || `Document ${i + 1}`;
            
            window.statusBar.textContent = `${ocrPrefix}Scanning ${i + 1}/${objectUrls.length}: ${fileName}...`;
            
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
            window.progressBar.style.width = pct + '%';
        }
        ocrScanning = false;
        console.log('[PDF] OCR rescan complete');
    } else {
        const combinedRegex = getKeywordRegex(window.KEYWORDS);
        
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
                    const originalKey = window.KEYWORDS.find(k => k.toLowerCase() === lowerMatch) || lowerMatch;
                    counts[originalKey] = (counts[originalKey] || 0) + 1;
                    fileTotalMatches++;
                }
            }
            
            const fileName = cached.fileName || `Document ${i + 1}`;
            window.totalDocsFound++;
            
            if (fileTotalMatches > 0) {
                window.renderCard(fileName, counts, url);
                window.totalMatchesFound += fileTotalMatches;
            } else {
                window.renderNoMatchCard(fileName, url);
            }
            
            const pct = Math.round(((i + 1) / objectUrls.length) * 100);
            window.progressBar.style.width = pct + '%';
        }
    }
    
    window.updateStats();
    
    if (window.totalMatchesFound === 0) {
        window.statusBar.textContent = "No matches found";
    } else {
        window.statusBar.textContent = `${window.totalMatchesFound} matches across ${window.totalDocsFound} document${window.totalDocsFound !== 1 ? 's' : ''}`;
    }
}

async function rescanWithNewKeywords() {
    if (!window.pdfDoc || !window.currentDocUrl) return;

    const combinedRegex = getKeywordRegex(window.KEYWORDS);
    let totalMatches = 0;
    const docCounts = {};

    for (let pageNum = 1; pageNum <= window.totalPages; pageNum++) {
        const cached = window.textPageCache[pageNum];
        if (!cached) continue;
        const text = cached.text;
        let match;
        const regex = new RegExp(combinedRegex.source, 'gi');
        while ((match = regex.exec(text)) !== null) {
            if (match[0].length < 3) continue;
            if (!/[a-zA-Z]/.test(match[0])) continue;
            totalMatches++;
            const key = window.KEYWORDS.find(k => k.toLowerCase() === match[0].toLowerCase()) || match[0].toLowerCase();
            docCounts[key] = (docCounts[key] || 0) + 1;
        }
    }

    const activeCard = window.viewer.querySelector('.doc-card.active, .tree-header.active')?.closest('.doc-card') || window.viewer.querySelector('.doc-card.active');
    if (activeCard) {
        const cardName = activeCard.querySelector('.doc-name').textContent;
        const badgeGrid = activeCard.querySelector('.badge-grid');
        if (badgeGrid) {
            badgeGrid.innerHTML = '';
            window.KEYWORDS.forEach(k => {
                const count = docCounts[k] || 0;
                if (count > 0) {
                    const b = document.createElement('div');
                    b.className = 'badge';
                    b.textContent = `${k}: ${count}`;
                    b.onclick = (e) => {
                        e.stopPropagation();
                        window.cycleSearch(k);
                    };
                    badgeGrid.appendChild(b);
                }
            });
        }
    }

    window.totalMatchesFound = totalMatches;
    window.updateStats();
    precomputeAllSearches();
}

// ========== KEYWORDS INIT ==========

const keywordListSelect = document.getElementById('keywordListSelect');

keywordListSelect.addEventListener('change', () => {
    const listName = keywordListSelect.value;
    if (window.switchKeywordList && window.switchKeywordList(listName)) {
        searchCache = {};
        window.clearSearch();
        if (objectUrls.length > 0) {
            rescanAllDocuments();
        }
    }
});

function populateListSelector() {
    if (typeof window.getKeywordLists === 'function') {
        const lists = window.getKeywordLists();
        keywordListSelect.innerHTML = '';
        lists.forEach(list => {
            const opt = document.createElement('option');
            opt.value = list.name;
            opt.textContent = list.name;
            if (list.name === window.currentKeywordList) opt.selected = true;
            keywordListSelect.appendChild(opt);
        });
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    if (typeof window.loadKeywords === 'function') {
        await window.loadKeywords();
    }
    populateListSelector();
    window.setupEventListeners();
});

// ========== KEYWORD MANAGER ==========

window.toggleKeywordManager = function() {
    const modal = document.getElementById('keywordManager');
    if (!modal) {
        console.error("Could not find keywordManager element in DOM");
        return;
    }

    const isShowing = modal.classList.toggle('show');

    if (isShowing) {
        if (typeof window.populateModalListSelector === 'function') {
            window.populateModalListSelector();
        }
        if (typeof window.loadListIntoEditor === 'function') {
            window.loadListIntoEditor();
        }
    }
};