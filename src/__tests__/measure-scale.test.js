import { describe, it, expect, vi, beforeEach } from 'vitest';

// A tiny in-memory localStorage so the scale flag can be exercised in Node.
const store = new Map();
globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
};

describe('measurement scale precedence', () => {
    beforeEach(() => {
        store.clear();
        vi.resetModules();
    });

    it('auto-detection never overwrites a user-chosen scale', async () => {
        const measure = await import('../measure');

        measure.setScale(50);
        expect(measure.getScale()).toBe(50);

        expect(measure.autoSetScale(100)).toBe(false);
        expect(measure.getScale()).toBe(50);
    });

    it('auto-detection applies while no user choice exists', async () => {
        const measure = await import('../measure');

        expect(measure.autoSetScale(75)).toBe(true);
        expect(measure.getScale()).toBe(75);
    });

    it('remembers a user choice across a reload', async () => {
        const first = await import('../measure');
        first.setScale(50);

        vi.resetModules();
        const reloaded = await import('../measure');
        expect(reloaded.getScale()).toBe(50);
        expect(reloaded.autoSetScale(100)).toBe(false);
    });
});
