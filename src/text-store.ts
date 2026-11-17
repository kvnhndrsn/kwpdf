// Persist extracted document text in IndexedDB.
//
// Re-extracting a folder on every reload is the most expensive repeated work in
// the app: pdf.js has to parse every page and Mammoth every document, and the
// result is identical for identical bytes. Extraction results are stored under a
// SHA-256 of the file bytes plus its path, and hydrated by the extractors on the
// next import.
//
// Everything here fails soft. Private windows, disabled storage and quota errors
// must not turn into scan failures, so a missing cache behaves exactly like a
// first run.

import { estimatePagesSize, estimateTextEntrySize } from './cache-size';

export const TEXT_CACHE_VERSION = 1;
export const TEXT_CACHE_DB = 'kwpdf-text-cache';
const STORE = 'texts';
const OPEN_TIMEOUT_MS = 2000;
/** Skip single documents whose cached text would be unreasonably large. */
export const MAX_STORED_ENTRY_BYTES = 32 * 1024 * 1024;
/** Bounds for the whole store, not just one entry. */
export const MAX_STORED_ENTRIES = 60;
export const MAX_STORED_TOTAL_BYTES = 256 * 1024 * 1024;

interface StoredPage {
    text: string;
    viewport: any;
    items: any[] | null;
}

export interface StoredPdfText {
    key: string;
    v: number;
    type: 'pdf';
    name: string;
    savedAt: number;
    pages: StoredPage[];
}

export interface StoredDocxText {
    key: string;
    v: number;
    type: 'docx' | 'doc';
    name: string;
    savedAt: number;
    html: string;
    text: string;
}

export type StoredText = StoredPdfText | StoredDocxText;

/**
 * Accept only entries this build understands: a payload from a future version,
 * or a half-written one, is treated as a miss so the document is extracted
 * normally.
 */
export function validStoredText(value: any): StoredText | null {
    if (!value || typeof value !== 'object') return null;
    if (value.v !== TEXT_CACHE_VERSION) return null;
    if (typeof value.key !== 'string' || !value.key) return null;

    if (value.type === 'pdf') {
        if (!Array.isArray(value.pages) || value.pages.length === 0) return null;
        for (const page of value.pages) {
            if (!page || typeof page.text !== 'string') return null;
        }
        return value as StoredPdfText;
    }

    if (value.type === 'docx' || value.type === 'doc') {
        if (typeof value.html !== 'string' || typeof value.text !== 'string') return null;
        if (!value.html && !value.text) return null;
        return value as StoredDocxText;
    }

    return null;
}

function toHex(buffer: ArrayBuffer): string {
    let out = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
    return out;
}

/**
 * Cache key for a file: the SHA-256 of its bytes plus its path, so the same
 * content dropped from another folder (or renamed) keeps its own entry.
 * Returns null when WebCrypto is unavailable (non-secure contexts), which
 * disables the cache rather than falling back to a weaker identity.
 */
export async function cacheKey(
    data: ArrayBuffer | Uint8Array | null | undefined,
    name: string,
): Promise<string | null> {
    if (!data || !name) return null;
    const subtle = (globalThis as any).crypto?.subtle as SubtleCrypto | undefined;
    if (!subtle) return null;
    try {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        // The lib types pin BufferSource to ArrayBuffer-backed views; a
        // Uint8Array over shared memory is still valid input here.
        const digest = await subtle.digest('SHA-256', bytes as unknown as BufferSource);
        return toHex(digest) + '|' + name;
    } catch {
        return null;
    }
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

        // A blocked upgrade (another tab holding an old version, or a browser
        // that never fires either event) must not stall the scan.
        const timer = setTimeout(() => done(null), OPEN_TIMEOUT_MS);
        const finish = (db: IDBDatabase | null) => {
            clearTimeout(timer);
            done(db);
        };

        try {
            const request = factory.open(TEXT_CACHE_DB, TEXT_CACHE_VERSION);
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

export async function readStoredText(key: string | null | undefined): Promise<StoredText | null> {
    if (!key) return null;
    const db = await openDb();
    if (!db) return null;

    return new Promise((resolve) => {
        try {
            const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
            request.onsuccess = () => {
                db.close();
                resolve(validStoredText(request.result));
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

export async function writeStoredText(entry: StoredText): Promise<boolean> {
    if (!entry || !entry.key) return false;
    const db = await openDb();
    if (!db) return false;

    return new Promise((resolve) => {
        try {
            const transaction = db.transaction(STORE, 'readwrite');
            const store = transaction.objectStore(STORE);
            store.put(entry);

            // Prune in the same transaction so a long scan cannot leave the
            // store growing without bound. The cursor sees the entry just put.
            const all: StoredText[] = [];
            const cursorRequest = store.openCursor();
            cursorRequest.onsuccess = () => {
                const cursor = cursorRequest.result;
                if (cursor) {
                    all.push(cursor.value as StoredText);
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

/** Approximate bytes an entry occupies, using the same estimator as the live cache. */
export function storedEntrySize(entry: StoredText): number {
    return entry.type === 'pdf' ? estimatePagesSize(entry.pages) : estimateTextEntrySize(entry.html, entry.text);
}

/**
 * Keys to evict, oldest first, until both the entry-count and byte budgets fit.
 * Pure so the eviction policy can be tested without IndexedDB.
 */
export function entriesToPrune(
    entries: StoredText[],
    maxCount = MAX_STORED_ENTRIES,
    maxBytes = MAX_STORED_TOTAL_BYTES,
): string[] {
    const total = entries.reduce((sum, entry) => sum + storedEntrySize(entry), 0);
    if (entries.length <= maxCount && total <= maxBytes) return [];

    const oldestFirst = [...entries].sort((a, b) => a.savedAt - b.savedAt);
    const toDelete: string[] = [];
    let count = oldestFirst.length;
    let bytes = total;
    for (const entry of oldestFirst) {
        if (count <= maxCount && bytes <= maxBytes) break;
        toDelete.push(entry.key);
        count--;
        bytes -= storedEntrySize(entry);
    }
    return toDelete;
}

/** Save an extracted PDF's page text. Returns false when it was not stored. */
export async function storePdfText(key: string | null, name: string, pages: StoredPage[]): Promise<boolean> {
    if (!key || !Array.isArray(pages) || pages.length === 0) return false;
    if (estimatePagesSize(pages) > MAX_STORED_ENTRY_BYTES) return false;
    return writeStoredText({ key, v: TEXT_CACHE_VERSION, type: 'pdf', name, savedAt: Date.now(), pages });
}

/** Save an extracted DOCX's HTML and plain text. Returns false when skipped. */
export async function storeDocxText(
    key: string | null,
    name: string,
    type: 'docx' | 'doc',
    html: string,
    text: string,
): Promise<boolean> {
    if (!key || (!html && !text)) return false;
    if (estimateTextEntrySize(html, text) > MAX_STORED_ENTRY_BYTES) return false;
    return writeStoredText({ key, v: TEXT_CACHE_VERSION, type, name, savedAt: Date.now(), html, text });
}

/** Drop every saved extraction. Returns false when the cache is unavailable. */
export async function clearTextCache(): Promise<boolean> {
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
