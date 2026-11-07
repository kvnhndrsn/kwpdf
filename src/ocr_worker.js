// Self-hosted Tesseract: build.js copies the runtime, its wasm core and the
// eng language data into dist/tesseract/. Nothing here touches a CDN, so OCR
// works offline once the app has been loaded and cannot change under a
// floating version.
const TESS_BASE = new URL('../tesseract/', self.location.href).href;

importScripts(TESS_BASE + 'tesseract.min.js');

let worker = null;
let ready = false;
const queue = [];
let currentPageNum = 0;
let currentCacheKey = '';

async function init() {
    try {
        worker = await Tesseract.createWorker('eng', 1, {
            workerPath: TESS_BASE + 'worker.min.js',
            // A directory, not a file: tesseract.js then picks the SIMD or
            // plain LSTM core to match the device.
            corePath: TESS_BASE,
            langPath: TESS_BASE.replace(/\/$/, ''),
            gzip: true,
            // The default blob worker has a blob: location, which breaks the
            // core's lookup of the .wasm file next to it when everything is
            // served from our own origin.
            workerBlobURL: false,
            logger: (m) => {
                if (m.status === 'recognizing text') {
                    self.postMessage({
                        type: 'ocr-progress',
                        progress: m.progress,
                        pageNum: currentPageNum,
                        cacheKey: currentCacheKey,
                    });
                }
            },
        });
    } catch (err) {
        // Without this, a missing runtime asset left every queued page waiting
        // for the 60s page timeout. Reject them now with the real reason.
        const message = 'OCR runtime failed to load: ' + ((err && err.message) || err);
        console.error('[OCR worker]', message);
        for (const msg of queue) {
            const data = msg.data && msg.data.data;
            if (data && data.cacheKey) {
                self.postMessage({
                    type: 'error',
                    error: message,
                    pageNum: data.pageNum,
                    cacheKey: data.cacheKey,
                });
            }
        }
        queue.length = 0;
        return;
    }

    ready = true;
    for (const msg of queue) processMessage(msg);
    queue.length = 0;
}

init();

async function processMessage(e) {
    const { task, data } = e.data;
    if (task === 'ocr-page') {
        currentPageNum = data.pageNum;
        currentCacheKey = data.cacheKey;
        try {
            const result = await worker.recognize(data.imageData);
            self.postMessage({
                type: 'ocr-result',
                text: result.data.text,
                words: result.data.words,
                imageWidth: data.imageWidth,
                imageHeight: data.imageHeight,
                pageNum: data.pageNum,
                cacheKey: data.cacheKey,
            });
        } catch (err) {
            self.postMessage({
                type: 'error',
                error: err.message,
                pageNum: data.pageNum,
                cacheKey: data.cacheKey,
            });
        }
    } else if (task === 'terminate') {
        if (worker) {
            await worker.terminate();
            worker = null;
        }
        self.close();
    }
}

self.onmessage = function (e) {
    if (!ready) {
        queue.push(e);
        return;
    }
    processMessage(e);
};
