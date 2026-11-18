const CACHE_NAME = 'kwpdf-423e8039';
const NETWORK_FIRST = ['/index.html', '/style.css', '/bundle.js'];
const LOCAL_ASSETS = [
    // Precached so every versioned cache holds a copy of the app shell. Besides
    // being the offline document fallback, this keeps the shell in step with
    // the CSS/JS that the same build hashed into CACHE_NAME.
    './index.html',
    './bundle.js',
    './pdf.worker.min.mjs',
    // Loaded without a query string (index.js sets rendererSrc to the plain
    // path), so it is precached the same way pdf.worker.min.mjs is. The cache
    // name still changes on every build, because the hash covers every file.
    './pdf.renderer.min.mjs',
    './keywords.json',
    './manifest.json',
    './icons/favicon.ico',
    './icons/folder.svg',
    './icons/pdf.svg',
    './icons/docx.svg',
    './icons/zip.svg',
    './icons/github.svg',
    // OCR loader and its nested worker script: small, and needed to start at
    // all. The wasm core and eng.traineddata.gz (~6 MB together) are cached on
    // first OCR use by the runtime handler below rather than on install, so a
    // visitor who never uses OCR does not download them.
    './tesseract/tesseract.min.js',
    './tesseract/worker.min.js',
    // The two runtime workers the app itself starts. Both URLs carry the build
    // hash (worker-pool.js, ocr.ts), and a cache hit needs an exact URL, so the
    // precached entry carries the same query — that is what makes a rebuilt
    // worker script impossible to serve from an older cache.
    './utils/doc_processor_worker.js?h=423e8039',
    './utils/ocr_worker.js?h=423e8039',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches
            .open(CACHE_NAME)
            .then((cache) => {
                console.log('[SW] Caching local assets');
                return Promise.all(
                    LOCAL_ASSETS.map((url) =>
                        cache.add(url).catch((err) => {
                            console.warn('[SW] Failed to cache:', url, err);
                        }),
                    ),
                );
            })
            .then(() => self.skipWaiting()),
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((names) =>
                Promise.all(
                    names.map((name) => {
                        if (name !== CACHE_NAME) {
                            console.log('[SW] Deleting old cache:', name);
                            return caches.delete(name);
                        }
                    }),
                ),
            )
            .then(() => self.clients.claim()),
    );
});

// `NETWORK_FIRST` holds paths, while a request URL is absolute. The previous
// `url.includes('./index.html')` test could never match "https://host/index.html",
// so the app shell was served cache-first and updates waited for a cache bump.
// Navigations are additionally handled as network-first at the call site: a
// Pages site opened at its directory root requests "/kwpdf/", which does not
// end in "/index.html", so a pathname-only check would still serve stale HTML
// while the freshly built CSS/JS (network-first) came from the network. That
// mismatch is what made the toolbar render with the new stylesheet against the
// previous build's markup until a refresh swapped the document over.
function isNetworkFirst(url) {
    let pathname;
    try {
        pathname = new URL(url).pathname;
    } catch (e) {
        return false;
    }
    // endsWith, not equality: Pages serves the app from a /<repo>/ sub-path.
    return NETWORK_FIRST.some((asset) => pathname.endsWith(asset));
}

/**
 * Cache API only accepts http(s) requests. Extension-origin requests (and
 * blob:/data:/opaque ones) make cache.put() reject with
 * "Request scheme 'chrome-extension' is unsupported", which surfaced as an
 * unhandled rejection and left the cache silently incomplete.
 */
function isCacheable(request) {
    try {
        const { protocol } = new URL(request.url);
        return protocol === 'http:' || protocol === 'https:';
    } catch (e) {
        return false;
    }
}

function putInCache(request, response) {
    if (!response || !response.ok) return Promise.resolve();
    if (!isCacheable(request)) return Promise.resolve();
    const copy = response.clone();
    return caches
        .open(CACHE_NAME)
        .then((cache) => cache.put(request, copy))
        .catch((err) => console.warn('[SW] Failed to cache:', request.url, err));
}

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;

    // Every top-level navigation is network-first, whatever the URL shape:
    // "/", "/kwpdf/", "/kwpdf/index.html" must all get the current document.
    if (event.request.mode === 'navigate' || isNetworkFirst(event.request.url)) {
        event.respondWith(
            fetch(event.request)
                .then((response) => {
                    putInCache(event.request, response);
                    return response;
                })
                .catch(async () => {
                    const cached = await caches.match(event.request);
                    return cached || caches.match('./index.html');
                }),
        );
        return;
    }

    event.respondWith(
        caches.match(event.request).then((cached) => {
            if (cached) {
                fetch(event.request)
                    .then((response) => {
                        putInCache(event.request, response);
                    })
                    .catch(() => {});
                return cached;
            }

            return fetch(event.request)
                .then((response) => {
                    putInCache(event.request, response);
                    return response;
                })
                .catch(() => {
                    if (event.request.destination === 'document') {
                        return caches.match('./index.html');
                    }
                });
        }),
    );
});
