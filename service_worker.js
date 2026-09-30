const CACHE_NAME = 'kwpdf-__CACHE_VERSION__';
const NETWORK_FIRST = ['./index.html', './style.css', './bundle.js'];
const LOCAL_ASSETS = [
    './bundle.js',
    './pdf.worker.min.mjs',
    './keywords.json',
    './manifest.json',
    './icons/favicon.ico',
    './icons/folder.svg',
    './icons/pdf.svg',
    './icons/docx.svg',
    './icons/zip.svg',
    './icons/github.svg',
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            console.log('[SW] Caching local assets');
            return Promise.all(
                LOCAL_ASSETS.map(url =>
                    cache.add(url).catch(err => {
                        console.warn('[SW] Failed to cache:', url, err);
                    })
                )
            );
        }).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(names =>
            Promise.all(
                names.map(name => {
                    if (name !== CACHE_NAME) {
                        console.log('[SW] Deleting old cache:', name);
                        return caches.delete(name);
                    }
                })
            )
        ).then(() => self.clients.claim())
    );
});

function isNetworkFirst(url) {
    return NETWORK_FIRST.some(asset => url.includes(asset));
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
    return caches.open(CACHE_NAME)
        .then(cache => cache.put(request, copy))
        .catch(err => console.warn('[SW] Failed to cache:', request.url, err));
}

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;

    if (isNetworkFirst(event.request.url)) {
        event.respondWith(
            fetch(event.request).then(response => {
                putInCache(event.request, response);
                return response;
            }).catch(() => caches.match(event.request))
        );
        return;
    }

    event.respondWith(
        caches.match(event.request).then(cached => {
            if (cached) {
                fetch(event.request).then(response => {
                    putInCache(event.request, response);
                }).catch(() => {});
                return cached;
            }

            return fetch(event.request).then(response => {
                putInCache(event.request, response);
                return response;
            }).catch(() => {
                if (event.request.destination === 'document') {
                    return caches.match('./index.html');
                }
            });
        })
    );
});
