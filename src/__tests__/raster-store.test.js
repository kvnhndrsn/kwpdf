import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    rasterKey,
    scaleBucket,
    entriesToPrune,
    validRasterEntry,
    readRaster,
    writeRaster,
    clearRasterCache,
    RASTER_CACHE_VERSION,
} from '../raster-store';

function entry(key, size, savedAt, page = 1) {
    return {
        key,
        v: RASTER_CACHE_VERSION,
        page,
        scale: 1,
        dpr: 1,
        quality: 'medium',
        blob: new Blob([new Uint8Array(size)]),
        savedAt,
        _size: size,
    };
}

describe('rasterKey', () => {
    it('is stable for the same parameters', () => {
        expect(rasterKey('doc|a.pdf', 3, 1.5, 2, 'medium')).toBe(rasterKey('doc|a.pdf', 3, 1.5, 2, 'medium'));
    });

    it('separates page, zoom, dpr and quality', () => {
        const base = rasterKey('doc', 1, 1, 1, 'medium');
        expect(rasterKey('doc', 2, 1, 1, 'medium')).not.toBe(base);
        expect(rasterKey('doc', 1, 2, 1, 'medium')).not.toBe(base);
        expect(rasterKey('doc', 1, 1, 2, 'medium')).not.toBe(base);
        expect(rasterKey('doc', 1, 1, 1, 'fast')).not.toBe(base);
    });

    it('is null without a document key, so an unhashed file never caches', () => {
        expect(rasterKey('', 1, 1, 1, 'medium')).toBeNull();
        expect(rasterKey(null, 1, 1, 1, 'medium')).toBeNull();
        expect(rasterKey(undefined, 1, 1, 1, 'medium')).toBeNull();
    });

    it('only reuses a bitmap inside the same zoom bucket', () => {
        expect(rasterKey('doc', 1, 1.004, 1, 'q')).toBe(rasterKey('doc', 1, 1.0, 1, 'q'));
        expect(rasterKey('doc', 1, 1.2, 1, 'q')).not.toBe(rasterKey('doc', 1, 1.0, 1, 'q'));
    });
});

describe('scaleBucket', () => {
    it('quantises to tenths and never returns a bad bucket', () => {
        expect(scaleBucket(1.04)).toBe(1);
        expect(scaleBucket(1.06)).toBe(1.1);
        expect(scaleBucket(0)).toBe(1);
        expect(scaleBucket(NaN)).toBe(1);
        expect(scaleBucket(-2)).toBe(1);
    });
});

describe('validRasterEntry', () => {
    it('accepts a well-formed entry', () => {
        expect(validRasterEntry(entry('k', 8, 1))).not.toBeNull();
    });

    it('rejects a different payload version, a missing key or an empty blob', () => {
        expect(validRasterEntry({ ...entry('k', 8, 1), v: 99 })).toBeNull();
        expect(validRasterEntry({ ...entry('k', 8, 1), key: '' })).toBeNull();
        expect(validRasterEntry({ ...entry('k', 8, 1), blob: new Blob([]) })).toBeNull();
        expect(validRasterEntry(null)).toBeNull();
    });
});

describe('entriesToPrune', () => {
    it('keeps everything inside both budgets', () => {
        expect(entriesToPrune([entry('a', 10, 1), entry('b', 10, 2)], 10, 1000)).toEqual([]);
    });

    it('evicts oldest first until the byte budget fits', () => {
        const entries = [entry('a', 40, 1), entry('b', 40, 2), entry('c', 40, 3)];
        expect(entriesToPrune(entries, 10, 80)).toEqual(['a']);
    });

    it('evicts oldest first until the count budget fits', () => {
        const entries = [entry('a', 1, 3), entry('b', 1, 1), entry('c', 1, 2)];
        expect(entriesToPrune(entries, 2, 1000)).toEqual(['b']);
    });
});

describe('graceful degradation without IndexedDB', () => {
    let original;
    beforeEach(() => {
        original = globalThis.indexedDB;
        globalThis.indexedDB = undefined;
    });
    afterEach(() => {
        globalThis.indexedDB = original;
    });

    it('reports a miss and a failed write instead of throwing', async () => {
        expect(await readRaster('k')).toBeNull();
        expect(await writeRaster(entry('k', 10, 1))).toBe(false);
        expect(await clearRasterCache()).toBe(false);
    });
});
