import { state, beginDocGeneration, isCurrentGeneration } from './state';
import * as dom from './dom';
import { fn, pdfjsLib } from './cross';
import { evictCaches } from './file-handler';
import { setScale, autoDetectScale } from './measure';
import { processTextContent, processTextContentAsync } from './pdf-search';

function getDocTypeFromUrl(url) {
    const dataCached = state.docDataCache[url];
    if (dataCached?.type) return dataCached.type;
    if (dataCached?.name) {
        const lower = dataCached.name.toLowerCase();
        if (lower.endsWith('.pdf')) return 'pdf';
        if (lower.endsWith('.docx')) return 'docx';
        if (lower.endsWith('.doc')) return 'doc';
    }
    if (state.docContentCache[url]?.type) return state.docContentCache[url].type;
    if (url.includes('.pdf')) return 'pdf';
    if (url.includes('.docx')) return 'docx';
    if (url.includes('.doc')) return 'doc';
    return null;
}

// Placeholder entry for a page whose text could not be extracted. Keeps the
// cached pages array 1:1 with real page numbers so failures never shift the
// page number of every following page.
function emptyPageViewport(pageNum) {
    const height = state.pageHeights[pageNum] || 800;
    const el = document.getElementById('page-' + pageNum);
    const width = parseFloat(el?.style.getPropertyValue('--base-w')) || 600;
    return {
        width,
        height,
        offsetX: 0,
        offsetY: 0,
        transform: [1, 0, 0, -1, 0, height],
        rotation: 0
    };
}

function loadPDF(fileUrl, keyword = '') {
    if (state.currentDocUrl === fileUrl && state.pdfDoc) {
        if (keyword) fn.performSearch(keyword);
        return;
    }

    const generation = beginDocGeneration();

    state.currentDocUrl = fileUrl;
    state.currentDocType = 'pdf';

    fn.teardownPdf();

    dom.viewer.style.display = '';
    dom.loader.style.display = 'flex';
    dom.loaderFilename.textContent = 'Loading PDF...';
    dom.loaderStatus.textContent = 'Initializing...';
    dom.loaderProgressFill.style.width = '10%';
    dom.viewer.innerHTML = '';
    state.renderedPages.clear();
    state.renderedScales = {};
    state.pageHeights = {};
    state.searchCache = {};
    fn.clearSearch();
    state.currentScale = 1.0;
    document.documentElement.style.setProperty('--pdf-scale', '1');
    state.currentPage = 1;
    state.textPageCache = {};
    state._gsPageCacheReady = false;

    (async () => {
        try {
            const loadingTask = pdfjsLib.getDocument(fileUrl);
            const doc = await loadingTask.promise;

            if (!isCurrentGeneration(generation)) {
                // A newer document won the race; discard this one.
                try { doc.destroy(); } catch (e) {}
                return;
            }

            state.pdfDoc = doc;
            state.currentDocUrl = fileUrl;
            state.totalPages = doc.numPages;

            dom.loaderStatus.textContent = 'Setting up ' + state.totalPages + ' pages...';
            dom.loaderProgressFill.style.width = '30%';
            await fn.setupVirtualPages();
            if (!isCurrentGeneration(generation)) return;

            dom.loaderStatus.textContent = 'Rendering first page...';
            dom.loaderProgressFill.style.width = '45%';
            if (!fn.isPageRendered(1)) await fn.renderPageNow(1);
            if (!isCurrentGeneration(generation)) return;

            dom.loaderStatus.textContent = 'Extracting text content...';
            dom.loaderProgressFill.style.width = '60%';

            let cached = state.docTextCache[fileUrl];
            if (cached && cached.pages && cached.pages.length > 0 && !cached.pages[0]?.viewport?.transform) {
                // Cache written by an older/other extraction path (no viewport
                // transform → wrong coords for rotated/offset-box pages). Rebuild.
                delete state.docTextCache[fileUrl];
                cached = null;
            }
            if (!cached) {
                dom.loaderFilename.textContent = 'Extracting text from loaded PDF...';
                const docRef = doc;
                const extractPromises = [];
                for (let p = 1; p <= state.totalPages; p++) {
                    extractPromises.push(
                        docRef.getPage(p).then(page =>
                            page.getTextContent().then(content => ({
                                pageNum: p,
                                content,
                                viewport: page.getViewport({ scale: 1.0 })
                            })).catch(() => ({ pageNum: p, content: null, viewport: null }))
                        ).catch(() => ({ pageNum: p, content: null, viewport: null }))
                    );
                }
                const allResults = await Promise.all(extractPromises);
                if (!isCurrentGeneration(generation)) return;

                const textPromises = allResults.map(async ({ pageNum, content, viewport }) => {
                    if (!content) {
                        return { text: '', viewport: emptyPageViewport(pageNum), items: [] };
                    }
                    const { text, items } = await processTextContentAsync(content);
                    return {
                        text,
                        viewport: {
                            width: viewport.width,
                            height: viewport.height,
                            offsetX: viewport.offsetX,
                            offsetY: viewport.offsetY,
                            transform: viewport.transform,
                            rotation: viewport.rotation
                        },
                        items
                    };
                });
                const pageTextData = await Promise.all(textPromises);
                if (!isCurrentGeneration(generation)) return;
                dom.loaderProgressFill.style.width = '80%';
                const fileName = state.docDataCache[fileUrl]?.name || 'Document';
                cached = {
                    totalPages: state.totalPages,
                    pages: pageTextData,
                    fileName,
                    _lastAccess: Date.now(),
                    _size: JSON.stringify(pageTextData).length + fileName.length
                };
                state.docTextCache[fileUrl] = cached;
                state.totalCacheSize += cached._size;
                evictCaches();
            }
            if (cached) {
                cached._lastAccess = Date.now();
                for (let i = 0; i < cached.pages.length; i++) {
                    state.textPageCache[i + 1] = cached.pages[i];
                }
                dom.loaderProgressFill.style.width = '80%';
                fn.rebuildTextLayers();
                await fn.precomputeAllSearches();
                if (!isCurrentGeneration(generation)) return;
                state._gsPageCacheReady = true;

                // Populate sidebar keyword counts from search results
                const counts = {};
                for (const [kw, matches] of Object.entries(state.searchCache)) {
                    if (kw === '_deduplicated') continue;
                    counts[kw] = matches.length;
                }
                if (state.docDataCache[fileUrl]) {
                    state.docDataCache[fileUrl].counts = counts;
                }
            }

            // Auto-detect measurement scale from embedded metadata or page text
            const detected = await autoDetectScale(fileUrl);
            if (!isCurrentGeneration(generation)) return;
            if (detected) {
                setScale(detected);
                const scaleInput = document.getElementById('scaleInput');
                if (scaleInput) (scaleInput as HTMLInputElement).value = '1:' + detected;
                fn.refreshAllMeasurements();
            }

            dom.loaderProgressFill.style.width = '100%';
            dom.loader.style.display = 'none';
            fn.updatePageInfo();
            fn.updateZoomDisplay();
            dom.pageInput.max = String(state.totalPages);
            dom.pageTotal.textContent = String(state.totalPages);

            state.emit('heatmaps-changed');
            fn.refreshAllMeasurements();

            state.emit('results-changed');

            if (!keyword) {
                const entries = Object.entries(state.searchCache);
                for (const [k, v] of entries) {
                    if (k !== '_deduplicated' && v.length > 0) {
                        keyword = k;
                        break;
                    }
                }
            }

            if (keyword) fn.performSearch(keyword);
        } catch (err) {
            if (!isCurrentGeneration(generation)) return;
            dom.loaderFilename.textContent = 'Error loading PDF';
            dom.loaderStatus.textContent = err.message;
            dom.loaderProgressFill.style.width = '0%';
            console.error('PDF load error:', err);
        }
    })();
}

export function loadDocument(fileUrl, keyword) {
    const type = getDocTypeFromUrl(fileUrl);
    if (type === 'pdf') {
        loadPDF(fileUrl, keyword);
    } else if (type === 'docx' || type === 'doc') {
        fn.loadDocxDoc(fileUrl, keyword);
    } else {
        loadPDF(fileUrl, keyword);
    }
}
