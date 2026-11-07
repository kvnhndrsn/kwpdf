// Remember the last folder opened with the File System Access API.
//
// Directory handles are structured-cloneable, so they can be stored in
// IndexedDB and used again after a reload; the browser still asks for read
// permission on use, which is why the handle is only a shortcut, never a
// silent grant. Browsers without the API fall back to the hidden
// `<input webkitdirectory>` picker, which gives no handle and so cannot be
// remembered.

const DB_NAME = 'kwpdf-folder-handle';
const DB_VERSION = 1;
const STORE = 'handles';
const KEY = 'last-folder';
const OPEN_TIMEOUT_MS = 2000;

export interface CollectedFolder {
    files: File[];
    /** Files the per-import limit dropped. */
    truncated: number;
    folderName: string;
}

export function supportsFolderHandles(): boolean {
    return typeof (globalThis as any).showDirectoryPicker === 'function';
}

/** Ask the user for a folder. Returns null when cancelled or unsupported. */
export async function pickFolder(): Promise<any | null> {
    const picker = (globalThis as any).showDirectoryPicker;
    if (typeof picker !== 'function') return null;
    try {
        return await picker({ mode: 'read' });
    } catch {
        // AbortError covers "user cancelled"; a block would be a real problem,
        // but either way there is no folder to work with.
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

        const timer = setTimeout(() => done(null), OPEN_TIMEOUT_MS);
        const finish = (db: IDBDatabase | null) => {
            clearTimeout(timer);
            done(db);
        };

        try {
            const request = factory.open(DB_NAME, DB_VERSION);
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

export async function saveLastFolder(handle: any): Promise<boolean> {
    if (!handle) return false;
    const db = await openDb();
    if (!db) return false;

    return new Promise((resolve) => {
        try {
            const transaction = db.transaction(STORE, 'readwrite');
            transaction.objectStore(STORE).put({ key: KEY, handle });
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

export async function getLastFolder(): Promise<any | null> {
    const db = await openDb();
    if (!db) return null;

    return new Promise((resolve) => {
        try {
            const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
            request.onsuccess = () => {
                db.close();
                resolve(request.result?.handle || null);
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

export async function clearLastFolder(): Promise<boolean> {
    const db = await openDb();
    if (!db) return false;

    return new Promise((resolve) => {
        try {
            const transaction = db.transaction(STORE, 'readwrite');
            transaction.objectStore(STORE).delete(KEY);
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

/**
 * Query, then request if needed. `requestPermission` needs a user gesture, so
 * call this straight from a click handler; a prompt left un-answered counts as
 * a refusal.
 */
export async function ensureReadPermission(handle: any): Promise<boolean> {
    if (!handle || typeof handle.queryPermission !== 'function') return false;
    const options = { mode: 'read' };

    try {
        if ((await handle.queryPermission(options)) === 'granted') return true;
        if (typeof handle.requestPermission !== 'function') return false;
        return (await handle.requestPermission(options)) === 'granted';
    } catch {
        return false;
    }
}

/**
 * Read every accepted file below a directory handle.
 *
 * Paths are built the way the folder picker builds them — the folder name
 * included — so `relativePath`, measurements and the tree see the same names a
 * drop would produce. Entries are walked in name order so two imports of the
 * same folder list files identically.
 */
export async function collectFolderFiles(
    handle: any,
    maxFiles: number,
    accept: (name: string) => boolean = () => true,
): Promise<CollectedFolder> {
    const files: File[] = [];
    const folderName = handle?.name || '';
    let truncated = 0;

    const walk = async (dir: any, prefix: string): Promise<void> => {
        const entries: any[] = [];
        for await (const entry of dir.values()) entries.push(entry);
        entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));

        for (const entry of entries) {
            if (entry.kind === 'directory') {
                await walk(entry, prefix + entry.name + '/');
                continue;
            }
            if (entry.kind !== 'file' || !accept(entry.name)) continue;

            if (files.length >= maxFiles) {
                truncated++;
                continue;
            }

            try {
                const file = await entry.getFile();
                (file as any).relativePath = prefix + entry.name;
                files.push(file);
            } catch {
                // A file the browser will not hand over is skipped, like a
                // failed ZIP entry; the rest of the folder still loads.
            }
        }
    };

    if (handle && typeof handle.values === 'function') {
        await walk(handle, folderName ? folderName + '/' : '');
    }

    return { files, truncated, folderName };
}
