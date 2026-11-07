// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import {
    collectFolderFiles,
    ensureReadPermission,
    getLastFolder,
    saveLastFolder,
    clearLastFolder,
    supportsFolderHandles,
    pickFolder,
} from '../last-folder';

function fileEntry(name, options = {}) {
    return {
        name,
        kind: 'file',
        async getFile() {
            if (options.fail) throw new Error('unreadable');
            return new File([options.content || 'x'], name);
        },
    };
}

function dirEntry(name, entries) {
    return {
        name,
        kind: 'directory',
        async *values() {
            for (const entry of entries) yield entry;
        },
    };
}

const isDocument = (name) => name.endsWith('.pdf') || name.endsWith('.docx');

afterEach(() => {
    delete globalThis.showDirectoryPicker;
});

describe('supportsFolderHandles', () => {
    it('is false without the API', () => {
        expect(supportsFolderHandles()).toBe(false);
    });

    it('is true once showDirectoryPicker exists', () => {
        globalThis.showDirectoryPicker = async () => null;
        expect(supportsFolderHandles()).toBe(true);
    });
});

describe('pickFolder', () => {
    it('returns null when the API is missing or the user cancels', async () => {
        expect(await pickFolder()).toBeNull();

        globalThis.showDirectoryPicker = async () => {
            throw new DOMException('cancelled', 'AbortError');
        };
        expect(await pickFolder()).toBeNull();
    });

    it('returns the picked handle', async () => {
        const handle = dirEntry('proj', []);
        globalThis.showDirectoryPicker = async () => handle;

        expect(await pickFolder()).toBe(handle);
    });
});

describe('collectFolderFiles', () => {
    it('walks nested folders in name order and sets picker-style paths', async () => {
        const root = dirEntry('root', [
            fileEntry('b.pdf'),
            dirEntry('sub', [fileEntry('c.docx'), fileEntry('notes.txt')]),
            fileEntry('a.pdf'),
        ]);

        const { files, truncated, folderName } = await collectFolderFiles(root, 10, isDocument);

        expect(folderName).toBe('root');
        expect(truncated).toBe(0);
        expect(files.map((f) => f.relativePath)).toEqual(['root/a.pdf', 'root/b.pdf', 'root/sub/c.docx']);
        expect(files.map((f) => f.name)).toEqual(['a.pdf', 'b.pdf', 'c.docx']);
    });

    it('counts files dropped by the import limit', async () => {
        const root = dirEntry('root', [fileEntry('a.pdf'), fileEntry('b.pdf'), fileEntry('c.pdf')]);

        const { files, truncated } = await collectFolderFiles(root, 1, isDocument);

        expect(files).toHaveLength(1);
        expect(truncated).toBe(2);
    });

    it('skips unreadable entries without failing the folder', async () => {
        const root = dirEntry('root', [fileEntry('bad.pdf', { fail: true }), fileEntry('ok.pdf')]);

        const { files } = await collectFolderFiles(root, 10, isDocument);

        expect(files.map((f) => f.name)).toEqual(['ok.pdf']);
    });

    it('ignores unaccepted files and returns nothing for a non-handle', async () => {
        const root = dirEntry('root', [fileEntry('image.png')]);

        expect((await collectFolderFiles(root, 10, isDocument)).files).toEqual([]);
        expect(await collectFolderFiles(null, 10, isDocument)).toEqual({ files: [], truncated: 0, folderName: '' });
    });
});

describe('ensureReadPermission', () => {
    const handle = (query, request) => ({
        queryPermission: async () => query,
        requestPermission: request ? async () => request : undefined,
    });

    it('accepts an already granted handle without prompting', async () => {
        expect(await ensureReadPermission(handle('granted'))).toBe(true);
    });

    it('requests permission when it is still a prompt', async () => {
        expect(await ensureReadPermission(handle('prompt', 'granted'))).toBe(true);
        expect(await ensureReadPermission(handle('prompt', 'denied'))).toBe(false);
    });

    it('treats a missing or throwing handle as refused', async () => {
        expect(await ensureReadPermission(null)).toBe(false);
        expect(await ensureReadPermission({})).toBe(false);
        expect(
            await ensureReadPermission({
                queryPermission: async () => {
                    throw new Error('nope');
                },
            }),
        ).toBe(false);
    });
});

describe('stored handle without IndexedDB', () => {
    it('degrades to "no folder remembered"', async () => {
        expect(await getLastFolder()).toBeNull();
        expect(await saveLastFolder({ name: 'root' })).toBe(false);
        expect(await saveLastFolder(null)).toBe(false);
        expect(await clearLastFolder()).toBe(false);
    });
});
