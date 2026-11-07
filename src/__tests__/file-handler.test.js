import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getFileType, getFileIcon, evictCaches, isLegacyDocFile, LEGACY_DOC_MESSAGE } from '../file-handler';
import { state } from '../state';

describe('getFileType', () => {
    it('identifies PDF files', () => {
        expect(getFileType('document.pdf')).toBe('pdf');
        expect(getFileType('DOCUMENT.PDF')).toBe('pdf');
        expect(getFileType('path/to/file.pdf')).toBe('pdf');
    });

    it('identifies DOCX files', () => {
        expect(getFileType('document.docx')).toBe('docx');
        expect(getFileType('DOCUMENT.DOCX')).toBe('docx');
    });

    it('identifies DOC files', () => {
        expect(getFileType('document.doc')).toBe('doc');
        expect(getFileType('DOCUMENT.DOC')).toBe('doc');
    });

    it('identifies ZIP files', () => {
        expect(getFileType('archive.zip')).toBe('zip');
        expect(getFileType('ARCHIVE.ZIP')).toBe('zip');
    });

    it('returns null for unsupported extensions', () => {
        expect(getFileType('file.txt')).toBeNull();
        expect(getFileType('file.png')).toBeNull();
        expect(getFileType('file')).toBeNull();
        expect(getFileType('')).toBeNull();
    });
});

describe('isLegacyDocFile', () => {
    const header = (bytes) => new Uint8Array(bytes).buffer;

    it('recognises the OLE2 compound-file header', () => {
        expect(isLegacyDocFile(header([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1]))).toBe(true);
    });

    it('does not flag OOXML, PDF or plain text', () => {
        expect(isLegacyDocFile(header([0x50, 0x4b, 0x03, 0x04]))).toBe(false);
        expect(isLegacyDocFile(header([0x25, 0x50, 0x44, 0x46]))).toBe(false);
        expect(isLegacyDocFile(header([0x68, 0x65, 0x6c, 0x6c]))).toBe(false);
    });

    it('is safe on truncated or empty buffers', () => {
        expect(isLegacyDocFile(new ArrayBuffer(0))).toBe(false);
        expect(isLegacyDocFile(header([0xd0]))).toBe(false);
        expect(isLegacyDocFile(header([0xd0, 0xcf, 0x11]))).toBe(false);
    });

    it('tells the user what to do instead', () => {
        expect(LEGACY_DOC_MESSAGE).toContain('.docx');
    });
});

describe('getFileIcon', () => {
    it('returns SVG for PDF', () => {
        const icon = getFileIcon('test.pdf');
        expect(icon).toContain('<img');
        expect(icon).toContain('pdf.svg');
    });

    it('returns SVG for DOCX', () => {
        const icon = getFileIcon('test.docx');
        expect(icon).toContain('<img');
        expect(icon).toContain('docx.svg');
    });

    it('returns SVG for DOC', () => {
        const icon = getFileIcon('test.doc');
        expect(icon).toContain('<img');
        expect(icon).toContain('docx.svg');
    });

    it('returns generic icon for unknown types', () => {
        const icon = getFileIcon('test.txt');
        expect(icon).toContain('<svg');
        expect(icon).toContain('viewBox');
    });
});

describe('evictCaches', () => {
    const ORIGINAL = {
        textCache: state.docTextCache,
        contentCache: state.docContentCache,
        totalCacheSize: state.totalCacheSize,
        currentDocUrl: state.currentDocUrl,
        maxCount: state.MAX_CACHE_COUNT_PER_TYPE,
        maxSize: state.MAX_CACHE_SIZE_TOTAL,
    };

    function seed(count, size = 1024) {
        state.docTextCache = {};
        state.docContentCache = {};
        state.totalCacheSize = 0;
        state.currentDocUrl = '';

        for (let i = 0; i < count; i++) {
            state.docTextCache['doc' + i] = {
                totalPages: 1,
                pages: [],
                fileName: 'doc' + i + '.pdf',
                _lastAccess: i,
                _size: size,
            };
            state.totalCacheSize += size;
        }
    }

    beforeEach(() => {
        state.MAX_CACHE_COUNT_PER_TYPE = 30;
        state.MAX_CACHE_SIZE_TOTAL = 500 * 1024 * 1024;
    });

    afterEach(() => {
        state.docTextCache = ORIGINAL.textCache;
        state.docContentCache = ORIGINAL.contentCache;
        state.totalCacheSize = ORIGINAL.totalCacheSize;
        state.currentDocUrl = ORIGINAL.currentDocUrl;
        state.MAX_CACHE_COUNT_PER_TYPE = ORIGINAL.maxCount;
        state.MAX_CACHE_SIZE_TOTAL = ORIGINAL.maxSize;
    });

    it('evicts the least recently used entries back to the per-type cap', () => {
        seed(100);

        evictCaches();

        expect(Object.keys(state.docTextCache)).toHaveLength(30);
        // The 30 most recently used survive, the 70 oldest go.
        expect(state.docTextCache['doc70']).toBeDefined();
        expect(state.docTextCache['doc69']).toBeUndefined();
        expect(state.totalCacheSize).toBe(30 * 1024);
    });

    it('never evicts the document that is currently open', () => {
        seed(50);
        // The oldest entry is the open one: it must survive even though it is
        // the first candidate by last-access order.
        state.currentDocUrl = 'doc0';

        evictCaches();

        expect(state.docTextCache['doc0']).toBeDefined();
        expect(state.docTextCache['doc1']).toBeUndefined();
        // Still counts toward the cap: 29 others plus the open document.
        expect(Object.keys(state.docTextCache)).toHaveLength(30);
    });

    it('leaves the cache alone when both caps are satisfied', () => {
        seed(10);

        evictCaches();

        expect(Object.keys(state.docTextCache)).toHaveLength(10);
        expect(state.totalCacheSize).toBe(10 * 1024);
    });

    it('evicts on total size even when the count is under the cap', () => {
        seed(5, 200 * 1024 * 1024);

        evictCaches();

        // 5 x 200MB is double the budget: the three oldest go before it fits.
        expect(state.docTextCache['doc0']).toBeUndefined();
        expect(state.docTextCache['doc2']).toBeUndefined();
        expect(state.docTextCache['doc3']).toBeDefined();
        expect(state.totalCacheSize).toBe(2 * 200 * 1024 * 1024);
    });
});
