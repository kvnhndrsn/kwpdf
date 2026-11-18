import {
    state,
    beginDocGeneration,
    isCurrentGeneration,
    resetDocumentState,
    dropCachedDocument,
    createKeywordCounts,
} from './state';
import * as dom from './dom';
import { fn, pdfjsLib, basePath } from './cross';
import { evictCaches, getDocTypeFromUrl } from './file-handler';
import { autoSetScale, autoDetectScale } from './measure';
import { processTextContentAsync, precomputePrefix, precomputeRemaining } from './pdf-search';
import { mark as perfMark, measure as perfMeasure } from './perf';
import { estimatePagesSize } from './cache-size';
import { cacheKey } from './text-store';
import { requestPassword } from './password-prompt';
import { errorMessage } from './error-message';

/** Pages extracted in parallel during load-time text extraction. */
const EXTRACT_CONCURRENCY = 8;

/**
 * Publish the raster cache key for a PDF opened straight from its object URL.
 *
 * The batch scan writes this key while extracting text, but a single dropped
 * file never goes through that path — it is opened here and scanned here — so
 * the content hash has to be produced on this side too. It runs after the first
 * paint is under way and the cache is optional, so a failure is silent.
 */
async function rememberContentKey(fileUrl: string, generation: number): Promise<void> {
    try {
        const doc = state.docDataCache[fileUrl];
        if (!doc) return;
        const fileRef = (doc as any).file;
        const bytes = fileRef ? await fileRef.arrayBuffer() : await (await fetch(fileUrl)).arrayBuffer();
        const key = await cacheKey(bytes, doc.name || 'document.pdf');
        if (!key || !isCurrentGeneration(generation) || state.currentDocUrl !== fileUrl) return;
        (doc as any)._rasterKey = key;
        state._rasterKey = key;
    } catch (e) {
        // A cache that cannot be keyed is a cache miss, not a broken document.
    }
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
        rotation: 0,
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

    return (async () => {
        // Set when the user dismisses the password prompt, so the rejection that
        // destroying the loading task causes is reported as "password required"
        // rather than as a broken PDF.
        let passwordCancelled = false;
        // True when the prefix stopped on a match and pages remain un-indexed.
        let needsTail = false;
        try {
            // CMaps and standard font data ship with the build: without them
            // CJK text and non-embedded standard fonts render as missing
            // glyphs. wasm/ and iccs/ do the same for JPX/JBIG2 images, ICC
            // profiles and CMYK conversion, which pdf.js 6 decodes through
            // WebAssembly — real drawings hit all three.
            //
            // There is no isEvalSupported opt-out to set any more: pdf.js 6 has
            // no host eval, and document JavaScript only runs in its sandboxed
            // QuickJS interpreter (wasm/quickjs-eval.wasm) when `enableScripting`
            // is on, which this app never enables.
            //
            // Deliberately no `ownerDocument`/`styleElement` here either: either
            // one forces pdf.js to render on the main thread instead of in its
            // renderer worker.
            perfMark('pdf:getDocument:start');
            const loadingTask = pdfjsLib.getDocument({
                url: fileUrl,
                cMapUrl: basePath + 'cmaps/',
                cMapPacked: true,
                standardFontDataUrl: basePath + 'standard_fonts/',
                wasmUrl: basePath + 'wasm/',
                iccUrl: basePath + 'iccs/',
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
                        try {
                            loadingTask.destroy();
                        } catch (e) {
                            /* already gone */
                        }
                        return;
                    }
                    updatePassword(password);
                });
            };
            const doc = await loadingTask.promise;
            perfMeasure('pdf:getDocument', 'pdf:getDocument:start');

            if (!isCurrentGeneration(generation)) {
                // A newer document won the race; discard this one. pdf.js 6
                // removed PDFDocumentProxy.destroy(), so the loading task is
                // what actually tears the document and its worker down.
                try {
                    doc.loadingTask.destroy();
                } catch (e) {}
                return;
            }

            state.pdfDoc = doc;
            state.currentDocUrl = fileUrl;
            // The raster cache key belongs to the document and is written when
            // the file is scanned, so it has to follow whichever document is
            // open. Without this the renderer read `state._rasterKey`, found it
            // undefined, and skipped both the cache read and the write.
            state._rasterKey = state.docDataCache[fileUrl]?._rasterKey;
            // Started here and awaited before the first paint: the raster cache
            // can only be consulted once the key exists, and page 1 is the page
            // the cache is for. The hash overlaps with the document parse, so
            // the wait is usually free.
            const rasterKeyReady = state._rasterKey ? Promise.resolve() : rememberContentKey(fileUrl, generation);
            state.totalPages = doc.numPages;

            dom.loaderStatus.textContent = 'Setting up ' + state.totalPages + ' pages...';
            dom.loaderProgressFill.style.width = '30%';
            perfMark('pdf:setupVirtualPages:start');
            await fn.setupVirtualPages();
            perfMeasure('pdf:setupVirtualPages', 'pdf:setupVirtualPages:start');
            if (!isCurrentGeneration(generation)) return;

            dom.loaderStatus.textContent = 'Rendering first page...';
            dom.loaderProgressFill.style.width = '45%';
            perfMark('pdf:firstRender:start');
            await rasterKeyReady;
            if (!isCurrentGeneration(generation)) return;
            if (!fn.isPageRendered(1)) await fn.renderPageNow(1);
            perfMeasure('pdf:firstRender', 'pdf:firstRender:start');
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
                perfMark('pdf:extract:start');
                const pageTextData = new Array(state.totalPages);
                let nextPage = 1;
                const workers = Array.from({ length: Math.min(EXTRACT_CONCURRENCY, state.totalPages) }, async () => {
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
                                        rotation: viewport.rotation,
                                    },
                                    items,
                                };
                            }
                        } catch (e) {
                            slot = { text: '', viewport: emptyPageViewport(pageNum), items: [] };
                        }
                        pageTextData[pageNum - 1] = slot;
                    }
                });
                await Promise.all(workers);
                perfMeasure('pdf:extract', 'pdf:extract:start');
                if (!isCurrentGeneration(generation)) return;
                dom.loaderProgressFill.style.width = '80%';
                const fileName = state.docDataCache[fileUrl]?.name || 'Document';
                cached = {
                    totalPages: state.totalPages,
                    pages: pageTextData,
                    fileName,
                    _lastAccess: Date.now(),
                    _size: estimatePagesSize(pageTextData) + fileName.length,
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
                // Only as far as the first match: that is all the landing jump
                // needs, and the rest of the pages are pure CPU the user was
                // previously waiting on. Nothing was pushed, so it cannot
                // duplicate a match.
                perfMark('pdf:precompute:start');
                const prefix = await precomputePrefix({ preferredKeyword: keyword });
                needsTail = prefix.needsTail;
                if (!isCurrentGeneration(generation)) return;
                perfMeasure('pdf:precompute', 'pdf:precompute:start');

                // Populate sidebar keyword counts from the pages indexed so far;
                // the background pass republishes them when it reaches the end.
                const counts = createKeywordCounts();
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

            dom.loaderProgressFill.style.width = '100%';
            dom.loader.style.display = 'none';
            // Interactive: readable, scrollable and jumpable before every page
            // has been indexed. `_gsPageCacheReady` keeps meaning "fully
            // indexed" and is set by the indexer when the tail lands.
            state._pdfInteractive = true;
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

            // Unchanged: still the first occurrence (lowest page, then reading
            // order) of the first keyword that appears in page order, or of the
            // explicitly requested keyword.
            if (keyword) fn.performSearch(keyword);

            // Finish the index, then probe the drawing scale — the probe re-reads
            // the file and re-renders measurement overlays, so it runs after the
            // tail rather than beside it, and well after the interactive point.
            const finishBackground = async () => {
                if (needsTail) await precomputeRemaining();
                if (!isCurrentGeneration(generation)) return;
                perfMark('pdf:autoDetectScale:start');
                const detected = await autoDetectScale(fileUrl);
                perfMeasure('pdf:autoDetectScale', 'pdf:autoDetectScale:start');
                if (!isCurrentGeneration(generation)) return;
                if (detected && autoSetScale(detected)) {
                    const scaleInput = document.getElementById('scaleInput');
                    if (scaleInput) (scaleInput as HTMLInputElement).value = '1:' + detected;
                    fn.refreshAllMeasurements();
                }
            };
            void finishBackground().catch(() => {});

            return true;
        } catch (err) {
            if (!isCurrentGeneration(generation)) return;
            if (passwordCancelled) {
                // The document is still selectable in the tree; only this attempt
                // to open it was abandoned.
                dom.loaderFilename.textContent = 'Password required';
                dom.loaderStatus.textContent = 'This PDF is password-protected. Drop it again to enter the password.';
                dom.loaderProgressFill.style.width = '0%';
                return false;
            }
            dom.loaderFilename.textContent = 'Error loading PDF';
            dom.loaderStatus.textContent = errorMessage(err);
            dom.loaderProgressFill.style.width = '0%';
            console.error('PDF load error:', err);
            return false;
        }
    })();
}

export function loadDocument(fileUrl, keyword) {
    const type = getDocTypeFromUrl(fileUrl);
    if (type === 'pdf') {
        return loadPDF(fileUrl, keyword);
    }
    if (type === 'docx' || type === 'doc') {
        return fn.loadDocxDoc(fileUrl, keyword);
    }
    return loadPDF(fileUrl, keyword);
}
