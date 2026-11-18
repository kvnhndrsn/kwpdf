import { state, isCurrentGeneration } from './state';
import * as dom from './dom';
import { fn } from './cross';
import { processTextContentAsync } from './pdf-search';
import { fitScaleForPixels } from './canvas-budget';
import { getRawTextContent, putRawTextContent, clearRawTextContent } from './raw-text-store';
import {
    readRaster,
    writeRaster,
    rasterKey,
    scaleBucket,
    RASTER_CACHE_VERSION,
    MAX_STORED_RASTER_PIXELS,
} from './raster-store';
import { mark as perfMark, measure as perfMeasure } from './perf';
import { TextLayer } from 'pdfjs-dist';

function scheduleIdle(fn, timeout = 300) {
    if ('requestIdleCallback' in window) {
        requestIdleCallback(fn, { timeout });
    } else {
        setTimeout(fn, 0);
    }
}

state.pageHeights = {};
state.renderedPages = new Set();
state.renderedScales = {};

// Active pdf.js selection text layers, keyed by page number.
// The layer div instance is kept so zoom updates can re-layout in place.
const textLayers = new Map();

// Per-page ownership token for renderPageNow. Only the newest call for a page
// may clear shared render state, so a late-finishing render cannot clobber a
// newer one.
const renderTokens = new Map();

function getCanvasContext(canvas) {
    try {
        return canvas.getContext('2d', { alpha: false });
    } catch (e) {
        return canvas.getContext('2d');
    }
}

let renderGen = 0;
let _rendering = false;
let _needsRefresh = false;
let _observerTimer = null;
let _scrollTimer = null;
let _isScrolling = false;
const MAX_CONCURRENT_RENDERS = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 6));
// Pages whose geometry is resolved per batch during document setup.
const VIRTUAL_PAGE_CHUNK = 50;
// Only render match pages this close to the current page up front.
const PRERENDER_RADIUS = 5;
// Drop canvases/text layers for pages this far from the current page.
const EVICT_RADIUS = 30;

function promiseMapConcurrent(items, fn, concurrency) {
    const results = [];
    const executing = new Set();
    let i = 0;
    return new Promise((resolve) => {
        function enqueue() {
            while (executing.size < concurrency && i < items.length) {
                const idx = i++;
                const p = Promise.resolve()
                    .then(() => fn(items[idx]))
                    .then((r) => results.push(r));
                executing.add(p);
                const clean = () => {
                    executing.delete(p);
                    enqueue();
                };
                p.then(clean, clean);
            }
            if (executing.size === 0) resolve(results);
        }
        enqueue();
    });
}

// ── initialization ──

/** Release every PDF-scoped resource: render tasks, page observer, selection
 *  layers and the pdf.js document itself. Safe to call when nothing is open. */
export function teardownPdf() {
    if (state.pageObserver) {
        state.pageObserver.disconnect();
        state.pageObserver = null;
    }

    for (const [, t] of state.renderTasks) {
        if (t && typeof t.cancel === 'function') {
            try {
                t.cancel();
            } catch (e) {}
        }
    }
    state.renderTasks.clear();
    renderTokens.clear();
    teardownTextLayers();
    removeScrollListener();

    if (state.pdfDoc) {
        try {
            // pdf.js 6 removed PDFDocumentProxy.destroy(). The loading task owns
            // the worker, so this is the only call that actually releases it.
            state.pdfDoc.loadingTask.destroy();
        } catch (e) {
            console.warn('Error destroying previous PDF:', e);
        }
    }
    state.pdfDoc = null;
    state.renderedPages.clear();
    state.renderedScales = {};
    state.pageHeights = {};
}

export async function setupVirtualPages() {
    dom.viewer.innerHTML = '';
    state.pageHeights = {};
    state.renderedPages.clear();
    state.renderedScales = {};

    if (state.pageObserver) {
        state.pageObserver.disconnect();
        state.pageObserver = null;
    }

    teardownTextLayers();

    const generation = state.docGeneration;

    // Resolve page geometry in chunks, inserting each chunk as it arrives.
    // Requesting every page at once and awaiting the whole batch left the viewer
    // blank until the last page resolved, and held N page proxies live.
    for (let start = 1; start <= state.totalPages; start += VIRTUAL_PAGE_CHUNK) {
        const end = Math.min(start + VIRTUAL_PAGE_CHUNK - 1, state.totalPages);
        const pages = await Promise.all(
            Array.from({ length: end - start + 1 }, (_, i) => state.pdfDoc.getPage(start + i).catch(() => null)),
        );
        if (!isCurrentGeneration(generation)) return;

        for (let i = 0; i < pages.length; i++) {
            const pageNum = start + i;
            const page = pages[i];
            if (!page) {
                state.pageHeights[pageNum] = 800;
                const placeholder = document.createElement('div');
                placeholder.className = 'page-placeholder';
                placeholder.id = 'page-' + pageNum;
                placeholder.dataset.pageNum = String(pageNum);
                placeholder.style.setProperty('--base-w', '600');
                placeholder.style.setProperty('--base-h', '800');
                dom.viewer.appendChild(placeholder);
                continue;
            }
            const viewport = page.getViewport({ scale: 1.0 });
            state.pageHeights[pageNum] = viewport.height;

            const placeholder = document.createElement('div');
            placeholder.className = 'page-placeholder';
            placeholder.id = 'page-' + pageNum;
            placeholder.dataset.pageNum = String(pageNum);
            placeholder.style.setProperty('--base-w', viewport.width);
            placeholder.style.setProperty('--base-h', viewport.height);
            dom.viewer.appendChild(placeholder);
        }

        // Let the browser paint the pages mounted so far before resolving the
        // next batch, instead of blocking the first visible page behind all of them.
        if (end < state.totalPages) {
            await new Promise((r) => requestAnimationFrame(() => r(null)));
        }
    }

    setupPageObserver();
}

// ── observer ──

let _scrollListenerAttached = false;

function onViewerScroll() {
    _isScrolling = true;
    clearTimeout(_scrollTimer);
    _scrollTimer = setTimeout(() => {
        _isScrolling = false;
        if (_needsRefresh && !_rendering) refreshVisiblePages();
    }, 200);
}

function addScrollListener() {
    if (_scrollListenerAttached) return;
    dom.viewerScroll.addEventListener('scroll', onViewerScroll, { passive: true });
    _scrollListenerAttached = true;
}

function removeScrollListener() {
    if (!_scrollListenerAttached) return;
    dom.viewerScroll.removeEventListener('scroll', onViewerScroll);
    _scrollListenerAttached = false;
    clearTimeout(_scrollTimer);
    _scrollTimer = null;
}

function setupPageObserver() {
    if (state.pageObserver) state.pageObserver.disconnect();

    addScrollListener();

    state.pageObserver = new IntersectionObserver(
        () => {
            if (_rendering) {
                _needsRefresh = true;
                return;
            }
            if (_isScrolling) {
                _needsRefresh = true;
                return;
            }
            clearTimeout(_observerTimer);
            _observerTimer = setTimeout(() => refreshVisiblePages(), 50);
        },
        { root: dom.viewerScroll, rootMargin: '1200px' },
    );

    document.querySelectorAll('[id^="page-"]').forEach((el) => state.pageObserver.observe(el));
}

// ── viewport range helper (used by setZoom) ──

function getViewportRange() {
    const scrollTop = dom.viewerScroll.scrollTop;
    const scrollBottom = scrollTop + dom.viewerScroll.clientHeight;
    const viewH = dom.viewerScroll.clientHeight;
    const ranges = { visible: new Set(), near: new Set(), far: new Set() };
    let top = 0;
    for (let i = 1; i <= state.totalPages; i++) {
        const h = (state.pageHeights[i] || 800) * state.currentScale;
        const bottom = top + h;
        const pageMid = (top + bottom) / 2;
        if (bottom > scrollTop && top < scrollBottom) {
            ranges.visible.add(i);
        } else if (pageMid > scrollTop - viewH && pageMid < scrollBottom + viewH) {
            ranges.near.add(i);
        } else if (pageMid > scrollTop - viewH * 3 && pageMid < scrollBottom + viewH * 3) {
            ranges.far.add(i);
        }
        // .pdf-page has margin:16px auto; adjacent vertical margins collapse to
        // a single 16px gap, and the first margin collapses with the viewer.
        top = bottom + 16;
    }
    return ranges;
}

/**
 * Anchor a zoom to the page under the viewport centre using cached geometry.
 * The old implementation queried offsetTop/offsetHeight of every page in the
 * DOM twice per zoom step, which is a full document layout read on ctrl+wheel.
 */
function findAnchorFromGeometry(viewportCenter: number): { page: number; offset: number } | null {
    let top = 0;
    for (let i = 1; i <= state.totalPages; i++) {
        const h = (state.pageHeights[i] || 800) * state.currentScale;
        const bottom = top + h;
        if (viewportCenter >= top && viewportCenter < bottom) {
            return { page: i, offset: Math.max(0, Math.min(1, (viewportCenter - top) / h)) };
        }
        top = bottom + 16;
    }
    return null;
}

function pageTopAtScale(page: number, scale: number): number {
    let top = 0;
    for (let i = 1; i < page; i++) top += (state.pageHeights[i] || 800) * scale + 16;
    return top;
}

// ── cancel helpers ──

/**
 * True when a page still needs a raster pass.
 *
 * The scale check alone is not enough: a page whose render bailed before its
 * canvas was attached has no `renderedScales` entry, and since the viewport
 * range helper files visible pages under `visible` (never `near`), nothing else
 * would ever come back for it. Checking for a canvas in the DOM makes an
 * unpainted page self-healing on the next scroll/zoom refresh.
 */
function pageNeedsRender(pageNum: number): boolean {
    if (state.renderTasks.has(pageNum)) return false;
    const el = document.getElementById('page-' + pageNum);
    if (!el) return false;
    if (!el.querySelector('canvas')) return true;
    return (state.renderedScales[pageNum] || 0) < state.currentScale;
}

function cancelNonVisibleRenders(visibleSet) {
    for (const [pn, t] of state.renderTasks) {
        if (!visibleSet.has(pn)) {
            if (t && typeof t.cancel === 'function') {
                try {
                    t.cancel();
                } catch (e) {}
            }
            state.renderTasks.delete(pn);
        }
    }
}

function cancelAllRenders() {
    for (const t of state.renderTasks.values()) {
        if (t && typeof t.cancel === 'function') {
            try {
                t.cancel();
            } catch (e) {}
        }
    }
    state.renderTasks.clear();
}

/**
 * Release canvases and selection layers for pages far outside the viewport.
 * Without this, every page ever visited kept its canvas for the life of the
 * document, so memory grew with pages read rather than pages on screen.
 * Page geometry (`pageHeights`) is kept, so scroll math does not change and the
 * page re-renders when it comes back into range.
 */
function evictDistantPages(keep: Set<number>) {
    if (!state.pdfDoc) return;

    const current = state.searchResults[state.currentMatchIndex];
    if (current) keep.add(current.page);

    for (const pageNum of [...state.renderedPages]) {
        if (keep.has(pageNum)) continue;
        const el = document.getElementById('page-' + pageNum);
        if (!el) continue;
        if (!el.querySelector('canvas')) continue;

        const layerRef = textLayers.get(pageNum);
        if (layerRef) {
            try {
                layerRef.layer.cancel();
            } catch (e) {}
            textLayers.delete(pageNum);
        }
        el.querySelector('.textLayer')?.remove();
        el.innerHTML = '';
        el.className = 'page-placeholder';

        state.renderedPages.delete(pageNum);
        delete state.renderedScales[pageNum];
    }
}

// ── the single coordinator ──

async function refreshVisiblePages() {
    if (_rendering) return;
    _rendering = true;
    try {
        const gen = ++renderGen;

        const scrollTop = dom.viewerScroll.scrollTop;
        const scrollBottom = scrollTop + dom.viewerScroll.clientHeight;
        const scrollCenter = (scrollTop + scrollBottom) / 2;

        // Cached page geometry instead of offsetTop/offsetHeight reads on every
        // page (500+ forced layout reads on each scroll stop).
        const visible = [];
        let pageTop = 0;
        for (let i = 1; i <= state.totalPages; i++) {
            const pageH = (state.pageHeights[i] || 800) * state.currentScale;
            const bottom = pageTop + pageH;
            if (bottom > scrollTop && pageTop < scrollBottom) {
                visible.push({ pn: i, dist: Math.abs((pageTop + bottom) / 2 - scrollCenter) });
            }
            pageTop = bottom + 16;
        }
        visible.sort((a, b) => a.dist - b.dist);

        if (visible.length === 0) return;

        const visibleSet = new Set(visible.map((p) => p.pn));
        cancelNonVisibleRenders(visibleSet);

        await new Promise((r) => setTimeout(r, 0));
        if (gen !== renderGen) return;

        // Full-res visible pages with limited concurrency, center-first
        const toRender = visible.filter((p) => pageNeedsRender(p.pn));
        if (toRender.length) {
            await promiseMapConcurrent(
                toRender,
                (p) => renderPageNow(p.pn).catch(() => {}),
                Math.min(2, MAX_CONCURRENT_RENDERS),
            );
        }

        // Keep visible pages plus a generous neighbourhood; the rest are re-rendered
        // on demand when scrolled back to.
        const keep = new Set<number>(visibleSet);
        for (let p = state.currentPage - EVICT_RADIUS; p <= state.currentPage + EVICT_RADIUS; p++) {
            if (p >= 1 && p <= state.totalPages) keep.add(p);
        }
        evictDistantPages(keep);

        scheduleIdle(() => prerenderNearPages(), 300);
    } finally {
        _rendering = false;
        if (_needsRefresh) {
            _needsRefresh = false;
            refreshVisiblePages();
        }
    }
}

// ── raster cache ──

/**
 * The open document's content key, whichever side of the scan published it.
 *
 * A single dropped file is painted before its text scan has hashed the file, so
 * `state._rasterKey` can still be empty when the first render finishes; the key
 * lands on the document entry instead. Read both rather than assume an order.
 */
function currentRasterKey(): string | undefined {
    return state.docDataCache[state.currentDocUrl]?._rasterKey || state._rasterKey;
}

function rasterKeyFor(pageNum: number, renderScale: number, dpr: number): string | null {
    return rasterKey(currentRasterKey(), pageNum, renderScale, dpr, state.renderQuality);
}

/**
 * Paint a bitmap cached by an earlier session, or return false.
 *
 * This stands in for the raster pass only. Text, highlights and geometry still
 * come from the live document exactly as they do after a real render, so
 * nothing that reads them can tell the difference — and a changed file can
 * never hit, because the file hash is part of the key.
 */
async function tryCachedRaster(
    el: HTMLElement,
    pageNum: number,
    vp1: any,
    renderScale: number,
    dpr: number,
    generation: number,
    token: any,
): Promise<boolean> {
    if (typeof createImageBitmap !== 'function') return false;

    const key = rasterKeyFor(pageNum, renderScale, dpr);
    if (!key) return false;

    const entry = await readRaster(key);
    if (!entry) return false;
    if (!isCurrentGeneration(generation) || renderTokens.get(pageNum) !== token) return false;

    let bitmap: ImageBitmap | null = null;
    try {
        bitmap = await createImageBitmap(entry.blob);
    } catch (e) {
        return false;
    }
    if (!bitmap) return false;
    if (!isCurrentGeneration(generation) || renderTokens.get(pageNum) !== token) {
        bitmap.close();
        return false;
    }

    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = getCanvasContext(canvas);
    if (!ctx || !canvas.width || !canvas.height) {
        bitmap.close();
        return false;
    }
    ctx.drawImage(bitmap, 0, 0);
    // The canvas owns its own copy; release the decoded bitmap immediately.
    bitmap.close();

    canvas.style.width = vp1.width * state.currentScale + 'px';
    canvas.style.height = vp1.height * state.currentScale + 'px';
    canvas.dataset.scale = String(renderScale);
    canvas.dataset.rasterCached = '1';

    el.innerHTML = '';
    el.appendChild(canvas);
    state.renderedPages.add(pageNum);
    state.renderedScales[pageNum] = Math.max(state.renderedScales[pageNum] || 0, renderScale);
    return true;
}

/** How long a page has to stay put before its bitmap is worth encoding. */
const RASTER_STORE_DELAY_MS = 600;

/**
 * Encode a finished render for the next session.
 *
 * Deliberately narrow: the current page only, on idle, never while the tab is
 * hidden, and never above the pixel cap. Encoding a large canvas is itself a
 * main-thread cost, and adding one to the workload this work exists to speed up
 * would be self-defeating.
 */
function scheduleRasterStore(
    canvas: HTMLCanvasElement,
    pageNum: number,
    renderScale: number,
    dpr: number,
    generation: number,
): void {
    if (typeof canvas.toBlob !== 'function') return;
    if (!canvas.width || !canvas.height) return;
    if (canvas.width * canvas.height > MAX_STORED_RASTER_PIXELS) return;
    if (document.hidden || pageNum !== state.currentPage) return;

    scheduleIdle(() => {
        if (!isCurrentGeneration(generation)) return;
        if (document.hidden || pageNum !== state.currentPage) return;
        if (!canvas.isConnected) return;
        // Resolved when the frame goes idle, not when the render finished: the
        // scan that produces the key can still be running at that point.
        const key = rasterKeyFor(pageNum, renderScale, dpr);
        if (!key) return;
        try {
            canvas.toBlob(
                (blob) => {
                    if (!blob || !isCurrentGeneration(generation)) return;
                    void writeRaster({
                        key,
                        v: RASTER_CACHE_VERSION,
                        page: pageNum,
                        scale: scaleBucket(renderScale),
                        dpr,
                        quality: state.renderQuality,
                        blob,
                        savedAt: Date.now(),
                        _size: blob.size,
                    });
                },
                'image/webp',
                0.85,
            );
        } catch (e) {
            // The cache is optional; never let it break a render.
        }
    }, RASTER_STORE_DELAY_MS);
}

// ── render a single page ──

export async function renderPageNow(pageNum: number, forceScale: number = null) {
    const renderScale = forceScale || state.currentScale;
    const dprCaps = { quality: 99, medium: 1.5, fast: 1.0 };
    const dpr = Math.min(window.devicePixelRatio || 1, dprCaps[state.renderQuality] || 99);

    if ((state.renderedScales[pageNum] || 0) >= renderScale) return;
    if (!state.pdfDoc) return;
    if (state.renderTasks.has(pageNum)) return;

    const generation = state.docGeneration;
    const token = {};
    renderTokens.set(pageNum, token);

    try {
        perfMark('render:getPage:start');
        const page = await state.pdfDoc.getPage(pageNum);
        perfMeasure('render:getPage', 'render:getPage:start');
        if (!isCurrentGeneration(generation)) return;
        if (renderTokens.get(pageNum) !== token) return;

        // Claim the render slot only now that getPage has resolved. Registering
        // a null placeholder before the await left an entry that
        // cancelNonVisibleRenders() deleted, which made the old
        // `!state.renderTasks.has(pageNum)` guard abort this render with no
        // error and no retry. renderTokens is the real concurrency guard.
        if (state.renderTasks.has(pageNum)) return;
        state.renderTasks.set(pageNum, null);

        const vp1 = page.getViewport({ scale: 1.0 });
        // pdf.js no longer clamps canvas size, so do it here: a page too big to
        // rasterise silently yields an unpainted opaque-black canvas.
        const effectiveScale = fitScaleForPixels(vp1.width, vp1.height, renderScale * dpr);
        const viewport = page.getViewport({ scale: effectiveScale });

        const el = document.getElementById('page-' + pageNum);
        if (!el) return;

        const displayWidth = vp1.width * state.currentScale;
        const displayHeight = vp1.height * state.currentScale;

        el.className = 'pdf-page';
        el.style.setProperty('--base-w', vp1.width);
        el.style.setProperty('--base-h', vp1.height);
        el.style.position = 'relative';

        // A bitmap from an earlier session at this exact bucket *is* the
        // render: no drawing operators run at all.
        if (await tryCachedRaster(el, pageNum, vp1, renderScale, dpr, generation, token)) {
            if (state.textPageCache[pageNum]) {
                requestAnimationFrame(() => buildTextLayer(el, pageNum));
                if (!forceScale && state.searchResults.length > 0) {
                    scheduleIdle(() => fn.renderHighlightsForPage(pageNum));
                }
            }
            return;
        }

        const existingCanvas = el.querySelector('canvas');
        const hasCanvas = !!existingCanvas;
        if (!hasCanvas) {
            el.innerHTML = '<div class="page-loading"><div class="spinner"></div></div>';
        }

        const canvas = document.createElement('canvas');
        const ctx = getCanvasContext(canvas);
        canvas.width = viewport.width;
        canvas.height = viewport.height;

        // A 0-sized canvas can't be rendered into and is invisible-but-present;
        // an unpainted alpha:false canvas is opaque black. Never let either ship.
        if (!canvas.width || !canvas.height) {
            el.innerHTML =
                '<div class="page-error" style="padding:20px;text-align:center;color:var(--grey-500)">Page too large to display</div>';
            return;
        }
        // pdf.js primes the page itself (beginDrawing fills #fff), so this is
        // belt-and-braces: a render that resolves without painting shows white
        // instead of a black rectangle.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        canvas.style.width = displayWidth + 'px';
        canvas.style.height = displayHeight + 'px';
        canvas.dataset.scale = String(renderScale);

        const renderTask = page.render({ canvasContext: ctx, viewport: viewport });
        state.renderTasks.set(pageNum, renderTask);
        perfMark('render:paint:start');
        await renderTask.promise;
        perfMeasure('render:paint', 'render:paint:start');

        if (!isCurrentGeneration(generation)) return;
        if (renderTokens.get(pageNum) !== token) return;

        state.renderedPages.add(pageNum);
        state.renderedScales[pageNum] = Math.max(state.renderedScales[pageNum] || 0, renderScale);

        if (existingCanvas && existingCanvas !== canvas) existingCanvas.remove();
        if (hasCanvas) {
            el.appendChild(canvas);
        } else {
            el.innerHTML = '';
            el.appendChild(canvas);
        }

        if (state.textPageCache[pageNum]) {
            requestAnimationFrame(() => buildTextLayer(el, pageNum));
            if (!forceScale && state.searchResults.length > 0) scheduleIdle(() => fn.renderHighlightsForPage(pageNum));
        }

        scheduleRasterStore(canvas, pageNum, renderScale, dpr, generation);

        // Fire-and-forget text content fetch for text layer & highlights.
        // On resolve, rebuild text layer & highlights if page is still displayed.
        if (!state.textPageCache[pageNum]) {
            perfMark('render:text:start');
            page.getTextContent()
                .then(async (textContent) => {
                    perfMeasure('render:text', 'render:text:start');
                    const processed = await processTextContentAsync(textContent);
                    if (!isCurrentGeneration(generation)) return;
                    if (renderTokens.get(pageNum) !== token) return;

                    state.textPageCache[pageNum] = {
                        text: processed.text,
                        viewport: {
                            width: vp1.width,
                            height: vp1.height,
                            offsetX: vp1.offsetX,
                            offsetY: vp1.offsetY,
                            transform: vp1.transform,
                            rotation: vp1.rotation,
                        },
                        items: processed.items,
                    };
                    state.pageHeights[pageNum] = vp1.height;
                    // Raw TextContent goes to a bounded module-local store, never
                    // into docTextCache/textPageCache: those entries are shared by
                    // reference and _size is computed before `raw` exists, so
                    // evictCaches() could never reclaim it.
                    putRawTextContent(pageNum, textContent);

                    const pe = document.getElementById('page-' + pageNum);
                    if (pe && pe.isConnected && pe.querySelector('canvas')) {
                        const rect = pe.getBoundingClientRect();
                        const viewH = dom.viewerScroll.clientHeight;
                        if (rect.bottom > -500 && rect.top < viewH + 500) {
                            requestAnimationFrame(() => buildTextLayer(pe, pageNum));
                            if (state.searchResults.length > 0) {
                                scheduleIdle(() => fn.renderHighlightsForPage(pageNum));
                            }
                        }
                    }
                })
                .catch(() => {});
        }
    } catch (err) {
        if ((err as Error).name !== 'RenderingCancelledException' && isCurrentGeneration(generation)) {
            console.warn('Render error:', (err as Error).message);
            const pe = document.getElementById('page-' + pageNum);
            if (pe) {
                pe.innerHTML =
                    '<div class="page-error" style="padding:20px;text-align:center;color:var(--grey-500)">Render error: ' +
                    (err as Error).message +
                    '</div>';
            }
        }
    } finally {
        if (renderTokens.get(pageNum) === token) {
            renderTokens.delete(pageNum);
            state.renderTasks.delete(pageNum);
        }
    }
}

// ── text layer ──
//
// Selection / copy is provided by pdf.js's own TextLayer (per-run spans laid
// out on the actual document font, stretched to the PDF advance widths and
// rotated as needed). This keeps the highlighted range and the copied text in
// sync with the canvas glyphs, fixing the previously-offset character mapping.

function buildTextLayer(el, pageNum) {
    const existingRef = textLayers.get(pageNum);
    if (existingRef) {
        if (existingRef.div.isConnected) return;
        textLayers.delete(pageNum);
        try {
            existingRef.layer.cancel();
        } catch (e) {}
    }

    const cached = state.textPageCache[pageNum];
    if (!cached || !state.pdfDoc) return;
    if (!el.querySelector('canvas')) return;

    const generation = state.docGeneration;

    requestIdleOrTimeout(async () => {
        if (!el.isConnected) return;
        if (!isCurrentGeneration(generation)) return;
        let raw = getRawTextContent(pageNum);
        try {
            const page = await state.pdfDoc.getPage(pageNum);
            if (!isCurrentGeneration(generation)) return;
            if (!raw) {
                raw = await page.getTextContent();
                if (!isCurrentGeneration(generation)) return;
                putRawTextContent(pageNum, raw);
            }
            if (textLayers.has(pageNum)) return;
            if (!el.isConnected || !el.querySelector('canvas')) return;

            const scale = state.currentScale;
            const viewport = page.getViewport({ scale });

            const prevLayerDiv = el.querySelector('.textLayer');
            if (prevLayerDiv) prevLayerDiv.remove();

            const textLayer = document.createElement('div');
            textLayer.className = 'textLayer';
            textLayer.style.setProperty('--scale-factor', String(scale));
            // pdf.js 6 sizes runs as --total-scale-factor = zoom x /UserUnit.
            // A page whose unit is not 1 (common on engineering sheets) lays
            // every glyph out at the wrong size unless it is told.
            textLayer.style.setProperty('--user-unit', String((viewport as any).userUnit || 1));
            textLayer.dataset.mainRotation = String(viewport.rotation || 0);
            el.appendChild(textLayer);

            const layer = new TextLayer({ textContentSource: raw, container: textLayer, viewport });
            textLayers.set(pageNum, { layer, div: textLayer });
            layer.render().catch(() => {
                // A failed render must not leave a connected but empty layer
                // behind, or this page can never rebuild its selection layer.
                if (textLayers.get(pageNum)?.layer !== layer) return;
                textLayers.delete(pageNum);
                if (textLayer.isConnected) textLayer.remove();
            });
        } catch (err) {
            if (!isCurrentGeneration(generation)) return;
            console.warn('Text layer error:', (err as Error).message);
            textLayers.delete(pageNum);
        }
    });
}

function requestIdleOrTimeout(run) {
    if ('requestIdleCallback' in window) {
        requestIdleCallback(run, { timeout: 400 });
    } else {
        setTimeout(run, 0);
    }
}

function teardownTextLayers() {
    for (const [, ref] of textLayers) {
        try {
            ref.layer.cancel();
        } catch (e) {}
    }
    textLayers.clear();
    clearRawTextContent();
}

async function updateTextLayersAtScale(scale) {
    const generation = state.docGeneration;
    for (const [pageNum, ref] of textLayers) {
        try {
            if (!ref.div.isConnected) {
                textLayers.delete(pageNum);
                try {
                    ref.layer.cancel();
                } catch (e) {}
                continue;
            }
            const page = await state.pdfDoc.getPage(pageNum);
            if (!isCurrentGeneration(generation)) return;
            if (textLayers.get(pageNum)?.layer !== ref.layer) continue;
            const viewport = page.getViewport({ scale });
            ref.div.style.setProperty('--scale-factor', String(scale));
            ref.div.style.setProperty('--user-unit', String((viewport as any).userUnit || 1));
            ref.div.dataset.mainRotation = String(viewport.rotation || 0);
            ref.layer.update({ viewport });
        } catch (e) {}
    }
}

function prerenderNearPages() {
    const ranges = getViewportRange();
    const pages: number[] = [];
    for (const pn of ranges.near) {
        const pageNum = pn as number;
        if (!pageNeedsRender(pageNum)) continue;
        pages.push(pageNum);
    }
    if (pages.length === 0) return;
    promiseMapConcurrent(pages, (pn) => renderPageNow(pn).catch(() => {}), 1);
}

// ── public helpers ──

export function isPageRendered(pageNum) {
    return state.renderedPages.has(pageNum);
}

export function setRenderQuality(q) {
    state.renderQuality = q;
    localStorage.setItem('pdf_render_quality', q);
    const ranges = getViewportRange();
    for (const pn of ranges.visible) state.renderedScales[pn as number] = 0;
    refreshVisiblePages();
}

// ── zoom ──

export function setZoom(newScale, force = false) {
    const clampedScale = Math.max(0.5, Math.min(4.0, newScale));
    if (clampedScale === state.currentScale && !force) return;

    // DOCX zoom: scale wrapper width, text reflows naturally
    if (state.currentDocType !== 'pdf') {
        state.currentScale = clampedScale;
        fn.updateZoomDisplay();
        document.documentElement.style.setProperty('--docx-scale', String(clampedScale));
        return;
    }

    const viewportCenter = dom.viewerScroll.scrollTop + dom.viewerScroll.clientHeight / 2;
    const oldScrollLeft = dom.viewerScroll.scrollLeft;

    // Cached geometry instead of two full-document DOM walks per zoom step.
    const anchor = findAnchorFromGeometry(viewportCenter);

    state.currentScale = clampedScale;
    fn.updateZoomDisplay();
    document.documentElement.style.setProperty('--pdf-scale', String(clampedScale));

    // Re-layout any existing selection text layers to the new scale immediately
    updateTextLayersAtScale(clampedScale).catch(() => {});

    // CSS-resize existing canvases for instant visual feedback. Only rendered
    // pages can own a canvas, so iterating totalPages spent two DOM queries per
    // page (2,000 at the 1,000-page cap) on every single zoom step.
    for (const pageNum of state.renderedPages) {
        const el = document.getElementById('page-' + pageNum);
        if (!el) continue;
        const canvas = el.querySelector('canvas');
        if (!canvas) continue;
        const baseH = state.pageHeights[pageNum] || 800;
        const cached = state.textPageCache[pageNum];
        const baseW = cached ? cached.viewport.width : 600;
        canvas.style.width = baseW * clampedScale + 'px';
        canvas.style.height = baseH * clampedScale + 'px';
    }

    cancelAllRenders();

    if (state.searchResults.length > 0) fn.repositionHighlights();
    requestAnimationFrame(() => fn.refreshAllMeasurements());

    requestAnimationFrame(() => {
        // Force layout flush so offsetTop/offsetHeight reflect the new zoom
        void dom.viewerScroll.scrollTop;

        const ranges = getViewportRange();
        for (const pn of ranges.visible) {
            state.renderedScales[pn as number] = 0;
        }

        if (anchor) {
            const newTop = pageTopAtScale(anchor.page, clampedScale);
            const newH = (state.pageHeights[anchor.page] || 800) * clampedScale;
            dom.viewerScroll.scrollTop = Math.max(0, newTop + anchor.offset * newH - dom.viewerScroll.clientHeight / 2);
            dom.viewerScroll.scrollLeft = oldScrollLeft;
        }
        refreshVisiblePages();
    });
}

// ── rebuild text layers after cache population ──

export function rebuildTextLayers() {
    for (const pageNum of state.renderedPages) {
        const el = document.getElementById('page-' + pageNum);
        if (!el || !el.isConnected) continue;
        const canvas = el.querySelector('canvas');
        if (!canvas) continue;
        if (!state.textPageCache[pageNum]) continue;

        if (!textLayers.has(pageNum)) {
            requestAnimationFrame(() => buildTextLayer(el, pageNum));
        }
    }
    if (textLayers.size > 0) updateTextLayersAtScale(state.currentScale).catch(() => {});
}

// ── search result pre-render ──

export function startPrerender() {
    if (state.searchResults.length === 0) return;
    if (_rendering) return;

    // A common keyword can hit hundreds of pages. Rasterising all of them up
    // front was the biggest CPU/canvas spike during search; only the current
    // page's neighbourhood is worth pre-rendering, the rest arrives on navigate.
    const pagesWithMatches = new Set<number>();
    for (const r of state.searchResults) {
        if (Math.abs(r.page - state.currentPage) <= PRERENDER_RADIUS) {
            pagesWithMatches.add(r.page);
        }
    }
    const toRender = [...pagesWithMatches].filter((pn) => pageNeedsRender(pn));
    if (toRender.length === 0) return;

    scheduleIdle(() => {
        promiseMapConcurrent(toRender, (pn) => renderPageNow(pn).catch(() => {}), Math.min(2, MAX_CONCURRENT_RENDERS));
    }, 100);
}
