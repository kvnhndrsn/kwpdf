// ========== PDF LOADER ==========

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
    window.cancelBgRender();

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
    window.searchCache = {};
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
            await window.setupVirtualPages();

            if (!window.isPageRendered(1)) {
                window.renderPageNow(1);
            }

            window.loaderStatus.textContent = 'Extracting text content...';
            window.loaderProgressFill.style.width = '60%';

            const cached = window.docTextCache[fileUrl];
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
            window.startBgRender();

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
        return window.getFileType(dataCached.name);
    }
    if (window.docContentCache[url]?.type) {
        return window.docContentCache[url].type;
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
        window.loadDocxDoc(fileUrl, keyword);
    } else {
        loadPDF(fileUrl, keyword);
    }
}