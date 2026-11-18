// Persistent raster cache.
//
// Re-opening the same drawing re-executes every drawing operator on every page.
// The text cache (`text-store.ts`) already avoids re-extracting text; this
// persists the *pixels* so a page visited at the same zoom in an earlier session
// can be painted without rasterising it at all.
//
// A cached bitmap is only ever a substitute for `page.render()` at the exact
// scale/DPR bucket it was captured at. Everything else about a page — geometry
// (`pageHeights`), the text layer, highlights, measurements — still comes from
// the live document, so the cache can never change layout or selection.
//
// Everything here fails soft, exactly like the text store: no IndexedDB, a
// blocked upgrade, a quota error or a disabled private window all mean "cache
// off", never a failed render.

export const RASTER_CACHE_VERSION = 1;
export const RASTER_CACHE_DB = 'kwpdf-raster-cache';
const STORE = 'rasters';
const OPEN_TIMEOUT_MS = 2000;

/** Bounds for the whole store. Rasters are far bigger than text entries. */
export const MAX_RASTER_ENTRIES = 60;
export const MAX_RASTER_TOTAL_BYTES = 64 * 1024 * 1024;
/** Above this the encode is too expensive to be worth scheduling. */
export const MAX_STORED_RASTER_PIXELS = 8 * 1024 * 1024;
/** Do not start writing unless the origin reports at least this much headroom. */
const MIN_QUOTA_HEADROOM = 96 * 1024 * 1024;

export interface StoredRaster {
    key: string;
    v: number;
    page: number;
    /** Zoom quantised by `scaleBucket`. */
    scale: number;
    /** Device-pixel ratio the bitmap was rasterised at. */
    dpr: number;
    quality: string;
    blob: Blob;
    savedAt: number;
    /** Approximate bytes, for the LRU budget. */
    _size: number;
}

/**
 * Quantise a zoom level so a bitmap is only reused where it is visually
 * identical: 0.1 steps, which is under the 0.5-step zoom increments the toolbar
 * actually applies and well inside a pixel of drift at typical page widths.
 */
export function scaleBucket(scale: number): number {
    if (!isFinite(scale) || scale <= 0) return 1;
    return Math.round(scale * 10) / 10;
}

/**
 * Cache key: the document's content hash + page + exact render parameters.
 *
 * The file hash is in the doc key, so a changed file can never hit an old
 * bitmap. The DPR is in here because the same zoom at 2x is a different raster.
 */
export function rasterKey(
    docKey: string | null | undefined,
    page: number,
    scale: number,
    dpr: number,
    quality: string,
): string | null {
    if (!docKey) return null;
    if (!Number.isFinite(page) || page < 1) return null;
    return `${docKey}|${page}|${scaleBucket(scale)}|${Number.isFinite(dpr) && dpr > 0 ? dpr : 1}|${quality}`;
}

/** Reject anything this build cannot use; a half-written entry is a miss. */
export function validRasterEntry(value: any): StoredRaster | null {
    if (!value || typeof value !== 'object') return null;
    if (value.v !== RASTER_CACHE_VERSION) return null;
    if (typeof value.key !== 'string' || !value.key) return null;
    if (!(value.blob instanceof Blob)) return null;
    if (!value.blob.size) return null;
    return value as StoredRaster;
}

/** Bytes an entry is charged against the budget. */
export function rasterEntrySize(entry: StoredRaster): number {
    return entry._size || entry.blob?.size || 0;
}

/**
 * Keys to evict, oldest first, until both budgets fit. Pure, so the policy is
 * tested without IndexedDB.
 */
export function entriesToPrune(
    entries: StoredRaster[],
    maxCount = MAX_RASTER_ENTRIES,
    maxBytes = MAX_RASTER_TOTAL_BYTES,
): string[] {
    const total = entries.reduce((sum, entry) => sum + rasterEntrySize(entry), 0);
    if (entries.length <= maxCount && total <= maxBytes) return [];

    const oldestFirst = [...entries].sort((a, b) => a.savedAt - b.savedAt);
    const toDelete: string[] = [];
    let count = entries.length;
    let bytes = total;
    for (const entry of oldestFirst) {
        if (count <= maxCount && bytes <= maxBytes) break;
        toDelete.push(entry.key);
        count--;
        bytes -= rasterEntrySize(entry);
    }
    return toDelete;
}

function openDb(): Promise<IDBDatabase | null> {
    return new Promise((resolve) => {
        const factory = (globalThis as any).indexedDB as IDBFactory | undefined;
        if (!factory) {
            resolve(null);
            return;
        }

        let settled = false;
        const done = (db: IDBDatabase | null) => {
            if (settled) return;
            settled = true;
            resolve(db);
        };

        const timer = setTimeout(() => done(null), OPEN_TIMEOUT_MS);
        const finish = (db: IDBDatabase | null) => {
            clearTimeout(timer);
            done(db);
        };

        try {
            const request = factory.open(RASTER_CACHE_DB, RASTER_CACHE_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
            };
            request.onsuccess = () => finish(request.result);
            request.onerror = () => finish(null);
            request.onblocked = () => finish(null);
        } catch {
            finish(null);
        }
    });
}

/** Read one bitmap. Resolves null for every kind of miss, including errors. */
export async function readRaster(key: string | null | undefined): Promise<StoredRaster | null> {
    if (!key) return null;
    const db = await openDb();
    if (!db) return null;

    return new Promise((resolve) => {
        try {
            const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
            request.onsuccess = () => {
                db.close();
                resolve(validRasterEntry(request.result));
            };
            request.onerror = () => {
                db.close();
                resolve(null);
            };
        } catch {
            db.close();
            resolve(null);
        }
    });
}

/**
 * Room left for this origin, or null when the browser cannot say.
 * A raster write is never worth an eviction fight with the text cache.
 */
async function hasQuotaHeadroom(size: number): Promise<boolean> {
    const storage = (globalThis as any).navigator?.storage;
    if (!storage?.estimate) return true;
    try {
        const { usage, quota } = await storage.estimate();
        if (!quota) return true;
        return quota - (usage || 0) > size + MIN_QUOTA_HEADROOM;
    } catch {
        return true;
    }
}

/** Store one bitmap. Returns false when it was skipped or could not be saved. */
export async function writeRaster(entry: StoredRaster): Promise<boolean> {
    if (!validRasterEntry(entry)) return false;
    if (!(await hasQuotaHeadroom(entry._size))) return false;

    const db = await openDb();
    if (!db) return false;

    return new Promise((resolve) => {
        try {
            const transaction = db.transaction(STORE, 'readwrite');
            const store = transaction.objectStore(STORE);
            store.put(entry);

            // Prune in the same transaction so a long session cannot grow the
            // store without bound; the cursor sees the entry just written.
            const all: StoredRaster[] = [];
            const cursorRequest = store.openCursor();
            cursorRequest.onsuccess = () => {
                const cursor = cursorRequest.result;
                if (cursor) {
                    const value = cursor.value;
                    if (value && typeof value === 'object') all.push(value as StoredRaster);
                    cursor.continue();
                    return;
                }
                for (const key of entriesToPrune(all)) store.delete(key);
            };

            transaction.oncomplete = () => {
                db.close();
                resolve(true);
            };
            const fail = () => {
                db.close();
                resolve(false);
            };
            transaction.onerror = fail;
            transaction.onabort = fail;
        } catch {
            db.close();
            resolve(false);
        }
    });
}

/** Drop every cached bitmap. Returns false when the cache is unavailable. */
export async function clearRasterCache(): Promise<boolean> {
    const db = await openDb();
    if (!db) return false;

    return new Promise((resolve) => {
        try {
            const transaction = db.transaction(STORE, 'readwrite');
            transaction.objectStore(STORE).clear();
            transaction.oncomplete = () => {
                db.close();
                resolve(true);
            };
            const fail = () => {
                db.close();
                resolve(false);
            };
            transaction.onerror = fail;
            transaction.onabort = fail;
        } catch {
            db.close();
            resolve(false);
        }
    });
}
