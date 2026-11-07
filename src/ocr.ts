import { state } from './state';
import * as dom from './dom';
import { pdfjsLib, KEYWORDS, basePath } from './cross';
import { getKeywordRegex, normalizeKeywordMatch } from './keyword-regex';

let ocrEnabled = true;
const ocrFileState = new Map();
const workerCallbacks = new Map();
const WORKER_POOL_SIZE = typeof navigator !== 'undefined' ? Math.min(navigator.hardwareConcurrency || 2, 4) : 2;
const workerSlots = [];

const OCR_SCALE = 1.0;
const RESOLUTION_STEPS = [1200, 900, 600, 300, 150];
const STEP_TIMEOUT_MS = 60_000;
const RENDER_TIMEOUT_MS = 30_000;
const HIGHLIGHT_PAD = 3;

// Bumped by resetOcrState(). A run captures the value when it starts and stops
// dispatching as soon as it no longer matches, so a cleared library cannot keep
// OCR'ing pages (and holding 60s timers) against revoked object URLs.
let ocrResetEpoch = 0;

export function isOcrEnabled() {
    return ocrEnabled;
}

export function getOcrState(url) {
    return ocrFileState.get(url);
}

export function getOcrMatchesForKeyword(keyword, url) {
    const s = ocrFileState.get(url);
    if (!s || !s.keywordMatches) return [];
    return s.keywordMatches[keyword] || [];
}

export function initOcr() {
    const stored = localStorage.getItem('pdf_ocr_enabled');
    ocrEnabled = stored === null ? true : stored === 'true';
}

/** Stop in-flight OCR and drop every per-file result. Used when all documents
 *  are cleared, so workers cannot keep recognising pages behind revoked object
 *  URLs and results keyed by them cannot leak into a later session. */
export function resetOcrState() {
    ocrResetEpoch++;

    for (const slot of workerSlots) {
        try {
            slot.worker.terminate();
        } catch (e) {
            /* already gone */
        }
    }
    workerSlots.length = 0;

    // Settle every outstanding page promise rather than leaving its run to
    // unwind on a 60s timeout.
    for (const [, cb] of workerCallbacks) {
        cb.reject(new Error('OCR reset'));
    }
    workerCallbacks.clear();

    ocrFileState.clear();
}

export function toggleOcrGlobal() {
    ocrEnabled = !ocrEnabled;
    localStorage.setItem('pdf_ocr_enabled', String(ocrEnabled));
    state.emit('results-changed');
    return ocrEnabled;
}

export function toggleOcrForFile(url) {
    const existing = ocrFileState.get(url);
    if (existing && existing.status === 'processing') return false;

    if (existing && existing.status === 'done') {
        ocrFileState.delete(url);
        const data = state.docDataCache[url];
        if (data && data._originalCounts) {
            data.counts = { ...data._originalCounts };
            state.totalMatchesFound -= data._ocrTotalMatches || 0;
        }
        if (data) {
            delete data._originalCounts;
            delete data._ocrCounts;
            delete data._ocrTotalMatches;
        }
        state.emit('results-changed');
        state.emit('stats-changed');
        return false;
    }

    ocrFileState.set(url, { status: 'processing', texts: [], counts: {}, totalMatches: 0 });
    startOcrForFile(url).catch((err) => {
        console.error('[OCR] Error:', err);
        ocrFileState.set(url, { status: 'error', texts: [], counts: {}, totalMatches: 0 });
        state.emit('results-changed');
    });
    state.emit('results-changed');
    return true;
}

function handleWorkerMessage(e) {
    if (e.data.type === 'ocr-progress') return;
    const cb = workerCallbacks.get(e.data.cacheKey);
    if (cb) {
        workerCallbacks.delete(e.data.cacheKey);
        if (e.data.type === 'ocr-result') {
            cb.resolve(e.data);
        } else {
            cb.reject(new Error(e.data.error));
        }
    }
}

function createSlotWorker(slot) {
    const w = new Worker(WORKER_BASE + 'ocr_worker.js?h=' + __BUNDLE_HASH__);
    w.onmessage = handleWorkerMessage;
    w.onerror = () => {
        for (const [key, cb] of workerCallbacks) {
            if (cb.slot === slot) {
                cb.reject(new Error('Worker crashed'));
                workerCallbacks.delete(key);
            }
        }
        slot.worker = createSlotWorker(slot);
    };
    return w;
}

function initWorkerPool() {
    if (workerSlots.length > 0) return;
    for (let i = 0; i < WORKER_POOL_SIZE; i++) {
        const slot: { worker: Worker } = {} as { worker: Worker };
        slot.worker = createSlotWorker(slot);
        workerSlots.push(slot);
    }
}

function runOcrOnImage(slot, blob, pageNum, cacheKey, imageWidth, imageHeight, timeoutMs = STEP_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const id = cacheKey + ':' + pageNum;
        const timer = setTimeout(() => {
            workerCallbacks.delete(id);
            if (slot.worker) {
                try {
                    slot.worker.terminate();
                } catch (e) {
                    /* ignore */
                }
                slot.worker = createSlotWorker(slot);
            }
            reject(new Error('OCR page ' + pageNum + ' timed out'));
        }, timeoutMs);
        workerCallbacks.set(id, {
            slot,
            resolve: (v) => {
                clearTimeout(timer);
                resolve(v);
            },
            reject: (e) => {
                clearTimeout(timer);
                reject(e);
            },
        });
        slot.worker.postMessage({
            task: 'ocr-page',
            data: { imageData: blob, pageNum, cacheKey: id, imageWidth, imageHeight },
        });
    });
}

async function renderAndRecognize(page, pageNum, url, maxDim, timeoutMs, slot) {
    const viewport = page.getViewport({ scale: OCR_SCALE });
    const pageWidth = Math.ceil(viewport.width);
    const pageHeight = Math.ceil(viewport.height);

    let scaleFactor = 1;
    if (pageWidth > maxDim || pageHeight > maxDim) {
        scaleFactor = Math.min(maxDim / pageWidth, maxDim / pageHeight);
    }
    const renderWidth = Math.ceil(pageWidth * scaleFactor);
    const renderHeight = Math.ceil(pageHeight * scaleFactor);

    const canvas = new OffscreenCanvas(renderWidth, renderHeight);
    const ctx = canvas.getContext('2d');
    const renderTask = page.render({
        canvasContext: ctx,
        viewport: page.getViewport({ scale: OCR_SCALE * scaleFactor }),
    });
    renderTask.promise.catch(() => {});
    await Promise.race([
        renderTask.promise,
        new Promise((_, reject) =>
            setTimeout(() => {
                renderTask.cancel();
                reject(new Error('render timed out'));
            }, RENDER_TIMEOUT_MS),
        ),
    ]);
    const blob = await canvas.convertToBlob({ type: 'image/png' });

    const ocrResult = (await runOcrOnImage(slot, blob, pageNum, url, pageWidth, pageHeight, timeoutMs)) as any;
    return {
        words: ocrResult.words || [],
        imageWidth: ocrResult.imageWidth,
        imageHeight: ocrResult.imageHeight,
        flatText: ocrResult.text || '',
        scaleFactor,
    };
}

async function processPageOnWorker(pdfDoc, pageNum, url, fileName, slot) {
    const page = await pdfDoc.getPage(pageNum);
    for (const maxDim of RESOLUTION_STEPS) {
        try {
            return await renderAndRecognize(page, pageNum, url, maxDim, STEP_TIMEOUT_MS, slot);
        } catch (err) {
            console.warn(`[OCR] Page ${pageNum} failed at ${maxDim}px:`, (err as Error).message);
        }
    }
    return null;
}

async function startOcrForFile(url) {
    const cacheEntry = state.docTextCache[url];
    if (!cacheEntry) {
        ocrFileState.set(url, { status: 'error', texts: [], counts: {}, totalMatches: 0 });
        state.emit('results-changed');
        return;
    }

    const numPages = cacheEntry.totalPages || 0;
    if (!numPages) {
        ocrFileState.set(url, { status: 'error', texts: [], counts: {}, totalMatches: 0 });
        state.emit('results-changed');
        return;
    }

    const lowerName = (cacheEntry.fileName || '').toLowerCase();
    if (!lowerName.endsWith('.pdf')) {
        ocrFileState.set(url, { status: 'error', texts: [], counts: {}, totalMatches: 0 });
        state.emit('results-changed');
        return;
    }

    initWorkerPool();
    const resetEpoch = ocrResetEpoch;

    const fileName = cacheEntry.fileName || 'document';

    let pdfDoc;
    try {
        if (state.currentDocUrl === url && state.pdfDoc) {
            pdfDoc = state.pdfDoc;
        } else {
            const response = await fetch(url);
            const arrayBuffer = await response.arrayBuffer();
            const pdfData = new Uint8Array(arrayBuffer);
            pdfDoc = await pdfjsLib.getDocument({
                data: pdfData,
                cMapUrl: basePath + 'cmaps/',
                cMapPacked: true,
                standardFontDataUrl: basePath + 'standard_fonts/',
                isEvalSupported: false,
            }).promise;
        }
    } catch (err) {
        console.error('[OCR] Failed to load PDF for OCR:', err);
        ocrFileState.set(url, { status: 'error', texts: [], counts: {}, totalMatches: 0 });
        state.emit('results-changed');
        return;
    }

    const actualNumPages = pdfDoc.numPages;
    const pageWordData = [];
    const pageScaleFactors = [];

    const totalToProcess = Math.min(actualNumPages, numPages);

    dom.statusBar.textContent = 'OCR scanning ' + fileName + '...';
    dom.progressBar.style.width = '0%';

    let nextPage = 1;
    let completed = 0;
    const ocrStartTime = Date.now();

    const globalPulse = setInterval(() => {
        const elapsed = Math.floor((Date.now() - ocrStartTime) / 1000);
        dom.statusBar.textContent = `OCR ${completed}/${totalToProcess} pages - ${elapsed}s - ${fileName}`;
    }, 2000);

    await new Promise<void>((resolve) => {
        function checkCompletion() {
            if (completed >= totalToProcess) resolve();
        }

        function dispatchNext(slot) {
            if (resetEpoch !== ocrResetEpoch) {
                resolve();
                return;
            }

            const pageNum = nextPage++;
            if (pageNum > totalToProcess) {
                checkCompletion();
                return;
            }

            processPageOnWorker(pdfDoc, pageNum, url, fileName, slot)
                .then((result) => {
                    if (resetEpoch !== ocrResetEpoch) {
                        resolve();
                        return;
                    }
                    if (result) {
                        pageWordData[pageNum - 1] = {
                            words: result.words,
                            imageWidth: result.imageWidth,
                            imageHeight: result.imageHeight,
                            flatText: result.flatText,
                        };
                        pageScaleFactors[pageNum - 1] = result.scaleFactor;
                    } else {
                        pageWordData[pageNum - 1] = null;
                    }
                    completed++;
                    dom.progressBar.style.width = Math.round((completed / totalToProcess) * 100) + '%';
                    dispatchNext(slot);
                })
                .catch(() => {
                    if (resetEpoch !== ocrResetEpoch) {
                        resolve();
                        return;
                    }
                    pageWordData[pageNum - 1] = null;
                    completed++;
                    dom.progressBar.style.width = Math.round((completed / totalToProcess) * 100) + '%';
                    dispatchNext(slot);
                });
        }

        for (const slot of workerSlots) dispatchNext(slot);
    });

    clearInterval(globalPulse);

    // Reset while this run was in flight: the pool now belongs to whoever comes
    // next, so leave it alone and publish nothing.
    if (resetEpoch !== ocrResetEpoch) return;

    for (const slot of workerSlots) {
        try {
            slot.worker.terminate();
        } catch (e) {
            /* ignore */
        }
    }
    workerSlots.length = 0;

    if (state.currentDocUrl !== url) {
        try {
            pdfDoc.destroy();
        } catch (e) {
            /* ignore */
        }
    }

    const keywords = KEYWORDS || [];
    const combinedRegex = getKeywordRegex(keywords);
    const counts = {};
    let totalMatches = 0;
    const keywordMatches = {};

    const keywordMap = new Map();
    for (const k of keywords) {
        keywordMatches[k] = [];
        keywordMap.set(k.toLowerCase(), k);
    }

    for (let p = 0; p < pageWordData.length; p++) {
        const pageData = pageWordData[p];
        if (!pageData) continue;

        const pageNum = p + 1;

        if (combinedRegex && pageData.flatText) {
            const regex = new RegExp(combinedRegex.source, 'gi');
            let match;
            while ((match = regex.exec(pageData.flatText)) !== null) {
                const key = normalizeKeywordMatch(match, keywordMap);
                if (!key) continue;
                counts[key] = (counts[key] || 0) + 1;
                totalMatches++;
            }
        }

        if (!combinedRegex) continue;

        const sf = pageScaleFactors[p] || 1;
        const effectiveScale = OCR_SCALE * sf;

        const wordRegex = new RegExp(combinedRegex.source, 'gi');
        for (const word of pageData.words || []) {
            const wordText = (word.text || '').trim();
            // Same rule as normalizeKeywordMatch: short and numeric keywords
            // ("AI", "QC", "4500") are valid, so do not filter them out here.
            if (!wordText) continue;

            wordRegex.lastIndex = 0;
            let m;
            let matchedOnWord = false;
            while ((m = wordRegex.exec(wordText)) !== null) {
                const key = normalizeKeywordMatch(m, keywordMap);
                if (!key) continue;
                if (!matchedOnWord) {
                    matchedOnWord = true;
                    const bbox = word.bbox;
                    if (!bbox || bbox.x0 === undefined) break;

                    const x = bbox.x0 / effectiveScale - HIGHLIGHT_PAD;
                    const y = bbox.y0 / effectiveScale - HIGHLIGHT_PAD;
                    const width = (bbox.x1 - bbox.x0) / effectiveScale + HIGHLIGHT_PAD * 2;
                    const height = (bbox.y1 - bbox.y0) / effectiveScale + HIGHLIGHT_PAD * 2;

                    keywordMatches[key].push({ page: pageNum, x, y, width, height });
                }
            }
        }
    }

    // The file's OCR state was cleared while this run was in flight (e.g.
    // "Clear all"): drop the result instead of resurrecting a finished entry
    // and inflating the match totals for a document that no longer exists.
    if (ocrFileState.get(url)?.status !== 'processing') return;

    const docData = state.docDataCache[url];
    if (docData) {
        docData._originalCounts = { ...docData.counts };
        docData._ocrCounts = counts;
        docData._ocrTotalMatches = totalMatches;
        for (const [kw, c] of Object.entries(counts)) {
            docData.counts[kw] = (docData.counts[kw] || 0) + (c as number);
        }
    }

    ocrFileState.set(url, { status: 'done', pageWordData, counts, totalMatches, keywordMatches });
    state.totalMatchesFound += totalMatches;
    state.emit('results-changed');
    state.emit('stats-changed');
    dom.statusBar.textContent = 'OCR done - ' + fileName + ': ' + totalMatches + ' new matches';
    dom.progressBar.style.width = '100%';
    setTimeout(() => {
        dom.progressBar.style.width = '0%';
    }, 800);
}
