import { state } from './state';
import * as dom from './dom';
import { fn } from './cross';
import { processTextContentAsync } from './pdf-search';
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

function promiseMapConcurrent(items, fn, concurrency) {
    const results = [];
    const executing = new Set();
    let i = 0;
    return new Promise((resolve) => {
        function enqueue() {
            while (executing.size < concurrency && i < items.length) {
                const idx = i++;
                const p = Promise.resolve().then(() => fn(items[idx])).then(r => results.push(r));
                executing.add(p);
                const clean = () => { executing.delete(p); enqueue(); };
                p.then(clean, clean);
            }
            if (executing.size === 0) resolve(results);
        }
        enqueue();
    });
}

// ── initialization ──

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

    const pagePromises = [];
    for (let i = 1; i <= state.totalPages; i++) {
        pagePromises.push(state.pdfDoc.getPage(i).catch(() => null));
    }
    const pages = await Promise.all(pagePromises);

    for (let i = 0; i < pages.length; i++) {
        const pageNum = i + 1;
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

    setupPageObserver();
}

// ── observer ──

function setupPageObserver() {
    if (state.pageObserver) state.pageObserver.disconnect();

    dom.viewerScroll.addEventListener('scroll', () => {
        _isScrolling = true;
        clearTimeout(_scrollTimer);
        _scrollTimer = setTimeout(() => {
            _isScrolling = false;
            if (_needsRefresh && !_rendering) refreshVisiblePages();
        }, 200);
    }, { passive: true });

    state.pageObserver = new IntersectionObserver(() => {
        if (_rendering) { _needsRefresh = true; return; }
        if (_isScrolling) {
            _needsRefresh = true;
            return;
        }
        clearTimeout(_observerTimer);
        _observerTimer = setTimeout(() => refreshVisiblePages(), 50);
    }, { root: dom.viewerScroll, rootMargin: '1200px' });

    document.querySelectorAll('[id^="page-"]').forEach(el => state.pageObserver.observe(el));
}

// ── viewport range helper (used by setZoom) ──

function getViewportRange() {
    const scrollTop = dom.viewerScroll.scrollTop;
    const scrollBottom = scrollTop + dom.viewerScroll.clientHeight;
    const viewH = dom.viewerScroll.clientHeight;
    const ranges = { visible: new Set(), near: new Set(), far: new Set() };
    let top = 16;
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
        top = bottom + 32;
    }
    return ranges;
}

// ── cancel helpers ──

function cancelNonVisibleRenders(visibleSet) {
    for (const [pn, t] of state.renderTasks) {
        if (!visibleSet.has(pn)) {
            if (t && typeof t.cancel === 'function') {
                try { t.cancel(); } catch (e) {}
            }
            state.renderTasks.delete(pn);
        }
    }
}

function cancelAllRenders() {
    for (const [pn, t] of state.renderTasks) {
        if (t && typeof t.cancel === 'function') {
            try { t.cancel(); } catch (e) {}
        }
    }
    state.renderTasks.clear();
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

    const visible = [];
    for (let i = 1; i <= state.totalPages; i++) {
        const el = document.getElementById('page-' + i);
        if (!el) continue;
        const top = el.offsetTop;
        const bottom = top + el.offsetHeight;
        if (bottom > scrollTop && top < scrollBottom) {
            visible.push({ pn: i, dist: Math.abs((top + bottom) / 2 - scrollCenter) });
        }
    }
    visible.sort((a, b) => a.dist - b.dist);

    if (visible.length === 0) return;

    const visibleSet = new Set(visible.map(p => p.pn));
    cancelNonVisibleRenders(visibleSet);

    await new Promise(r => setTimeout(r, 0));
    if (gen !== renderGen) return;

    // Full-res visible pages with limited concurrency, center-first
    const toRender = visible.filter(p => (state.renderedScales[p.pn] || 0) < state.currentScale);
    if (toRender.length) {
        await promiseMapConcurrent(toRender, p => renderPageNow(p.pn).catch(() => {}), Math.min(2, MAX_CONCURRENT_RENDERS));
    }

    scheduleIdle(() => prerenderNearPages(), 300);
} finally {
    _rendering = false;
    if (_needsRefresh) {
        _needsRefresh = false;
        refreshVisiblePages();
    }
}
}

// ── render a single page ──

export async function renderPageNow(pageNum: number, forceScale: number = null) {
    const renderScale = forceScale || state.currentScale;
    const dprCaps = { quality: 99, medium: 1.5, fast: 1.0 };
    const dpr = Math.min(window.devicePixelRatio || 1, dprCaps[state.renderQuality] || 99);
    const effectiveScale = renderScale * dpr;

    if ((state.renderedScales[pageNum] || 0) >= renderScale) return;
    if (!state.pdfDoc) return;
    if (state.renderTasks.has(pageNum)) return;

    state.renderTasks.set(pageNum, null);

    try {
        const page = await state.pdfDoc.getPage(pageNum);
        if (!state.renderTasks.has(pageNum)) return;

        const viewport = page.getViewport({ scale: effectiveScale });

        const el = document.getElementById('page-' + pageNum);
        if (!el) return;

        const vp1 = page.getViewport({ scale: 1.0 });
        const displayWidth = vp1.width * state.currentScale;
        const displayHeight = vp1.height * state.currentScale;

        el.className = 'pdf-page';
        el.style.setProperty('--base-w', vp1.width);
        el.style.setProperty('--base-h', vp1.height);
        el.style.position = 'relative';

        const existingCanvas = el.querySelector('canvas');
        const hasCanvas = !!existingCanvas;
        if (!hasCanvas) {
            el.innerHTML = '<div class="page-loading"><div class="spinner"></div></div>';
        }

        const canvas = document.createElement('canvas');
        const ctx = getCanvasContext(canvas);
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = displayWidth + 'px';
        canvas.style.height = displayHeight + 'px';
        canvas.dataset.scale = String(renderScale);

        const renderTask = page.render({ canvasContext: ctx, viewport: viewport });
        state.renderTasks.set(pageNum, renderTask);

        await renderTask.promise;

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

        // Fire-and-forget text content fetch for text layer & highlights.
        // On resolve, rebuild text layer & highlights if page is still displayed.
        if (!state.textPageCache[pageNum]) {
            page.getTextContent().then(async textContent => {
                const processed = await processTextContentAsync(textContent);
                state.textPageCache[pageNum] = {
                    text: processed.text,
                    viewport: {
                        width: vp1.width,
                        height: vp1.height,
                        offsetX: vp1.offsetX,
                        offsetY: vp1.offsetY,
                        transform: vp1.transform,
                        rotation: vp1.rotation
                    },
                    items: processed.items,
                    raw: textContent,
                };
                state.pageHeights[pageNum] = vp1.height;

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
            }).catch(() => {});
        }
    } catch (err) {
        if ((err as Error).name !== 'RenderingCancelledException') {
            console.warn('Render error:', (err as Error).message);
            const pe = document.getElementById('page-' + pageNum);
            if (pe) {
                pe.innerHTML = '<div class="page-error" style="padding:20px;text-align:center;color:var(--grey-500)">Render error: ' + (err as Error).message + '</div>';
            }
        }
    } finally {
        state.renderTasks.delete(pageNum);
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
        try { existingRef.layer.cancel(); } catch (e) {}
    }

    const cached = state.textPageCache[pageNum];
    if (!cached || !state.pdfDoc) return;
    if (!el.querySelector('canvas')) return;

    requestIdleOrTimeout(async () => {
        if (!el.isConnected) return;
        let raw = cached.raw;
        try {
            const page = await state.pdfDoc.getPage(pageNum);
            if (!raw) {
                raw = await page.getTextContent();
                cached.raw = raw;
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
            el.appendChild(textLayer);

            const layer = new TextLayer({ textContentSource: raw, container: textLayer, viewport });
            textLayers.set(pageNum, { layer, div: textLayer });
            layer.render().catch(() => {});
        } catch (err) {
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
        try { ref.layer.cancel(); } catch (e) {}
    }
    textLayers.clear();
}

async function updateTextLayersAtScale(scale) {
    for (const [pageNum, ref] of textLayers) {
        try {
            if (!ref.div.isConnected) {
                textLayers.delete(pageNum);
                try { ref.layer.cancel(); } catch (e) {}
                continue;
            }
            const page = await state.pdfDoc.getPage(pageNum);
            ref.div.style.setProperty('--scale-factor', String(scale));
            ref.layer.update({ viewport: page.getViewport({ scale }) });
        } catch (e) {}
    }
}

function prerenderNearPages() {
    const ranges = getViewportRange();
    const pages: number[] = [];
    for (const pn of ranges.near) {
        const pageNum = pn as number;
        if ((state.renderedScales[pageNum] || 0) >= state.currentScale) continue;
        if (state.renderTasks.has(pageNum)) continue;
        pages.push(pageNum);
    }
    if (pages.length === 0) return;
    promiseMapConcurrent(pages, pn => renderPageNow(pn).catch(() => {}), 1);
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

    let anchorEl = null;
    let anchorOffset = 0;

    for (const el of document.querySelectorAll('[id^="page-"]')) {
        const pageTop = (el as HTMLElement).offsetTop;
        const pageBottom = pageTop + (el as HTMLElement).offsetHeight;
        if (viewportCenter >= pageTop && viewportCenter < pageBottom) {
            anchorEl = el;
            anchorOffset = Math.max(0, Math.min(1, (viewportCenter - pageTop) / (el as HTMLElement).offsetHeight));
            break;
        }
    }

    if (!anchorEl) {
        let minDist = Infinity;
        for (const el of document.querySelectorAll('[id^="page-"]')) {
            const dist = Math.abs((el as HTMLElement).offsetTop + (el as HTMLElement).offsetHeight / 2 - viewportCenter);
            if (dist < minDist) {
                minDist = dist;
                anchorEl = el;
                anchorOffset = viewportCenter < (el as HTMLElement).offsetTop ? 0 : 1;
            }
        }
    }

    const oldScale = state.currentScale;
    state.currentScale = clampedScale;
    fn.updateZoomDisplay();
    document.documentElement.style.setProperty('--pdf-scale', String(clampedScale));

    // Re-layout any existing selection text layers to the new scale immediately
    updateTextLayersAtScale(clampedScale).catch(() => {});

    const scaleRatio = clampedScale / oldScale;

    // CSS-resize all existing canvases for instant visual feedback
    for (let i = 1; i <= state.totalPages; i++) {
        const el = document.getElementById('page-' + i);
        if (!el) continue;
        const canvas = el.querySelector('canvas');
        if (!canvas) continue;
        const baseH = state.pageHeights[i] || 800;
        const cached = state.textPageCache[i];
        const baseW = cached ? cached.viewport.width : 600;
        canvas.style.width = (baseW * clampedScale) + 'px';
        canvas.style.height = (baseH * clampedScale) + 'px';
    }

    cancelAllRenders();

    if (state.searchResults.length > 0) fn.repositionHighlights();
    state.emit('heatmaps-changed');
    requestAnimationFrame(() => fn.refreshAllMeasurements());

    requestAnimationFrame(() => {
        // Force layout flush so offsetTop/offsetHeight reflect the new zoom
        void dom.viewerScroll.scrollTop;

        const ranges = getViewportRange();
        for (const pn of ranges.visible) {
            state.renderedScales[pn as number] = 0;
        }

        if (anchorEl) {
            const newTop = (anchorEl as HTMLElement).offsetTop;
            const newH = (anchorEl as HTMLElement).offsetHeight;
            dom.viewerScroll.scrollTop = Math.max(0, newTop + anchorOffset * newH - dom.viewerScroll.clientHeight / 2);
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

    const pagesWithMatches = [...new Set(state.searchResults.map(r => r.page))];
    const toRender = pagesWithMatches.filter(pn => (state.renderedScales[pn] || 0) < state.currentScale);
    if (toRender.length === 0) return;

    scheduleIdle(() => {
        promiseMapConcurrent(toRender, pn => renderPageNow(pn).catch(() => {}), Math.min(2, MAX_CONCURRENT_RENDERS));
    }, 100);
}
