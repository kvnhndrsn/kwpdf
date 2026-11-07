import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * measure.ts reads its stored measurements once at import time and persists
 * them through the bare `localStorage` global, so each test installs a fake
 * store and then loads a fresh copy of the module (and of the state module
 * it talks to).
 */
function fakeStorage() {
    const data = new Map();
    return {
        data,
        getItem: (k) => (data.has(k) ? data.get(k) : null),
        setItem: (k, v) => { data.set(k, String(v)); },
        removeItem: (k) => { data.delete(k); },
        clear: () => data.clear(),
    };
}

async function loadModules(stored) {
    const storage = fakeStorage();
    storage.setItem('kwpdf_measurements', JSON.stringify(stored));
    vi.stubGlobal('localStorage', storage);
    // Rendering is queued through rAF; the delete itself must not need it.
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.resetModules();
    const { state } = await import('../state');
    const measure = await import('../measure');
    return { state, measure };
}

const A = 'docs/a.pdf';
const B = 'docs/b.pdf';
const seeded = () => ({
    [A]: [{ id: 'm1', type: 'distance', points: [], label: '1.00 m' }],
    [B]: [{ id: 'm2', type: 'distance', points: [], label: '2.00 m' }],
});

function openDoc(state, fullPath) {
    state.currentDocUrl = 'blob:' + fullPath;
    state.docDataCache[state.currentDocUrl] = { fullPath };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('clearMeasurementsForCurrentDoc', () => {
    it('removes only the open document and keeps the others', async () => {
        const { state, measure } = await loadModules(seeded());
        openDoc(state, A);

        measure.clearMeasurementsForCurrentDoc();

        expect(measure.getDocMeasurements(A)).toEqual([]);
        expect(measure.getDocMeasurements(B)).toHaveLength(1);
    });

    it('persists that removal without touching other documents', async () => {
        const { state, measure } = await loadModules(seeded());
        openDoc(state, A);

        measure.clearMeasurementsForCurrentDoc();

        const stored = JSON.parse(localStorage.getItem('kwpdf_measurements'));
        expect(stored[A]).toBeUndefined();
        expect(stored[B]).toHaveLength(1);
    });

    it('does nothing when no document is open', async () => {
        const { measure } = await loadModules(seeded());

        measure.clearMeasurementsForCurrentDoc();

        expect(measure.getDocMeasurements(A)).toHaveLength(1);
        expect(measure.getDocMeasurements(B)).toHaveLength(1);
    });
});
