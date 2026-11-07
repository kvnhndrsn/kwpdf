import { state, beginDocGeneration, isCurrentGeneration, resetDocumentState, dropCachedDocument } from './state';
import * as dom from './dom';
import { fn, pdfjsLib, basePath } from './cross';
import { evictCaches } from './file-handler';
import { setScale, autoDetectScale } from './measure';
import { processTextContent, processTextContentAsync } from './pdf-search';
import { estimatePagesSize } from './cache-size';
import { requestPassword } from './password-prompt';

/** Pages extracted in parallel during load-time text extraction. */
const EXTRACT_CONCURRENCY = 8;

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

    // Everything the previous document left behind: scale, page caches, search
    // results, highlights and the DOCX page index.
    resetDocumentState();
    state.currentDocUrl = fileUrl;
    state.currentDocType = 'pdf';

    fn.teardownPdf();

    dom.viewer.style.display = '';
    dom.loader.style.display = 'flex';
    dom.loaderFilename.textContent = 'Loading PDF...';
    dom.loaderStatus.textContent = 'Initializing...';
    dom.loaderProgressFill.style.width = '10%';
    dom.viewer.innerHTML = '';
    fn.clearSearch();
    document.documentElement.style.setProperty('--pdf-scale', '1');

    (async () => {
        // Set when the user dismisses the password prompt, so the rejection that
        // destroying the loading task causes is reported as "password required"
        // rather than as a broken PDF.
        let passwordCancelled = false;
        try {
            // CMaps and standard font data ship with the build: without them
            // CJK text and non-embedded standard fonts render as missing
            // glyphs. isEvalSupported is off so no PDF can reach `new Function`.
            const loadingTask = pdfjsLib.getDocument({
                url: fileUrl,
                cMapUrl: basePath + 'cmaps/',
                cMapPacked: true,
                standardFontDataUrl: basePath + 'standard_fonts/',
                isEvalSupported: false,
            });
            // Without this handler pdf.js rejects an encrypted document outright.
            // It calls back again with reason 2 when the password was wrong.
            loadingTask.onPassword = (updatePassword, reason) => {
                if (!isCurrentGeneration(generation)) return;
                const fileName = state.docDataCache[fileUrl]?.name || 'This PDF';
                requestPassword(fileName, reason === 2).then((password) => {
                    if (!isCurrentGeneration(generation)) return;
                    if (password === null) {
                        passwordCancelled = true;
                        try { loadingTask.destroy(); } catch (e) { /* already gone */ }
                        return;
                    }
                    updatePassword(password);
                });
            };
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
                dropCachedDocument(fileUrl);
                cached = null;
            }
            if (!cached) {
                dom.loaderFilename.textContent = 'Extracting text from loaded PDF...';
                const docRef = doc;
                // Bounded concurrency, processing each page as it lands:
                // fanning out all N getPage+getTextContent pairs at once (one
                // Promise.all over the whole document) holds every page's parse
                // state, decoded streams and raw TextContent live simultaneously,
                // which is what pushes large tenders into worker-termination / OOM
                // territory. Here only EXTRACT_CONCURRENCY raw pages are ever in
                // flight; each is converted to its compact text/items form before
                // the next is requested, so the raw payload becomes garbage
                // immediately instead of being pinned until every page is done.
                const pageTextData = new Array(state.totalPages);
                let nextPage = 1;
                const workers = Array.from(
                    { length: Math.min(EXTRACT_CONCURRENCY, state.totalPages) },
                    async () => {
                        while (nextPage <= state.totalPages) {
                            if (!isCurrentGeneration(generation)) return;
                            const p = nextPage++;
                            const pageNum = p;
                            let slot: any;
                            try {
                                const page = await docRef.getPage(pageNum);
                                const viewport = page.getViewport({ scale: 1.0 });
                                let content = null;
                                try {
                                    content = await page.getTextContent();
                                } catch (e) {
                                    content = null;
                                }

                                if (!content) {
                                    slot = { text: '', viewport: emptyPageViewport(pageNum), items: [] };
                                } else {
                                    const { text, items } = await processTextContentAsync(content);
                                    content = null;
                                    slot = {
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
                                }
                            } catch (e) {
                                slot = { text: '', viewport: emptyPageViewport(pageNum), items: [] };
                            }
                            pageTextData[pageNum - 1] = slot;
                        }
                    }
                );
                await Promise.all(workers);
                if (!isCurrentGeneration(generation)) return;
                dom.loaderProgressFill.style.width = '80%';
                const fileName = state.docDataCache[fileUrl]?.name || 'Document';
                cached = {
                    totalPages: state.totalPages,
                    pages: pageTextData,
                    fileName,
                    _lastAccess: Date.now(),
                    _size: estimatePagesSize(pageTextData) + fileName.length
                };
                dropCachedDocument(fileUrl);
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
                    counts[kw] = matches.length;
                }
                if (state.docDataCache[fileUrl]) {
                    state.docDataCache[fileUrl].counts = counts;
                }
                // Single-document loads never go through the batch counter path,
                // so refresh the derived totals once the counts exist.
                state.emit('stats-changed');
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

            fn.refreshAllMeasurements();

            state.emit('results-changed');

            if (!keyword) {
                const entries = Object.entries(state.searchCache);
                for (const [k, v] of entries) {
                    if (v.length > 0) {
                        keyword = k;
                        break;
                    }
                }
            }

            if (keyword) fn.performSearch(keyword);
        } catch (err) {
            if (!isCurrentGeneration(generation)) return;
            if (passwordCancelled) {
                // The document is still selectable in the tree; only this attempt
                // to open it was abandoned.
                dom.loaderFilename.textContent = 'Password required';
                dom.loaderStatus.textContent = 'This PDF is password-protected. Drop it again to enter the password.';
                dom.loaderProgressFill.style.width = '0%';
                return;
            }
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
