import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkerPool, CancelledTaskError } from '../worker-pool';

// Minimal Worker stand-in: records what was posted and lets a test drive the
// reply stream by hand, which is the only way to observe the pool's scheduling
// and cancellation without a browser.
class StubWorker {
    constructor(url) {
        this.url = url;
        this.posted = [];
        this.terminated = false;
        this.onmessage = null;
        this.onerror = null;
    }

    postMessage(data) {
        this.posted.push(data);
    }

    terminate() {
        this.terminated = true;
    }

    respond(data) {
        this.onmessage({ data });
    }

    fail(error) {
        this.onerror(error);
    }
}

let instances;

function makePool(size = 1) {
    const pool = new WorkerPool(size);
    pool.init();
    return pool;
}

describe('WorkerPool', () => {
    beforeEach(() => {
        instances = [];
        vi.stubGlobal('WORKER_BASE', 'utils/');
        vi.stubGlobal('Worker', class extends StubWorker {
            constructor(url) {
                super(url);
                instances.push(this);
            }
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('creates poolSize workers pointed at the doc processor', () => {
        makePool(3);
        expect(instances).toHaveLength(3);
        expect(instances[0].url).toBe('utils/doc_processor_worker.js');
    });

    it('adds the build hash to the worker URL when the build defines one', () => {
        vi.stubGlobal('__BUNDLE_HASH__', 'abc12345');
        makePool(1);
        expect(instances[0].url).toBe('utils/doc_processor_worker.js?h=abc12345');
    });

    it('dispatches only up to poolSize tasks and queues the rest', () => {
        const pool = makePool(2);
        for (let i = 0; i < 5; i++) pool.runRegexOnText('t' + i, 'f', ['kw'], 'docx', 'k' + i);

        expect(instances[0].posted).toHaveLength(1);
        expect(instances[1].posted).toHaveLength(1);
        expect(pool.activeCount).toBe(2);
        expect(pool.pendingCount).toBe(5);
    });

    it('hands a freed worker the next queued task', async () => {
        const pool = makePool(1);
        const first = pool.runRegexOnText('a', 'f', ['kw'], 'docx', 'k1');
        const second = pool.runRegexOnText('b', 'f', ['kw'], 'docx', 'k2');

        instances[0].respond({ type: 'regex-result', counts: { kw: 1 }, totalMatches: 1 });
        await expect(first).resolves.toMatchObject({ totalMatches: 1 });

        expect(instances[0].posted).toHaveLength(2);
        expect(instances[0].posted[1].data.cacheKey).toBe('k2');

        instances[0].respond({ type: 'regex-result', counts: {}, totalMatches: 0 });
        await expect(second).resolves.toMatchObject({ totalMatches: 0 });
    });

    it('rejects queued work stamped with an older generation when cancelled', async () => {
        const pool = makePool(1);
        pool.runRegexOnText('a', 'f', ['kw'], 'docx', 'k1'); // dispatched
        const queued = pool.runRegexOnText('b', 'f', ['kw'], 'docx', 'k2'); // queued
        const caught = queued.catch(e => e);

        expect(pool.cancelStale(pool.generation + 1)).toBe(1);

        const err = await caught;
        expect(err).toBeInstanceOf(CancelledTaskError);
        expect(err.name).toBe('CancelledTaskError');
        expect(pool.pendingCount).toBe(1); // only the in-flight task remains
    });

    it('keeps tasks belonging to the generation that is still current', async () => {
        const pool = makePool(1);
        pool.runRegexOnText('a', 'f', ['kw'], 'docx', 'k1');
        const sameGen = pool.runRegexOnText('b', 'f', ['kw'], 'docx', 'k2');
        const settled = sameGen.then(r => r, e => e);

        expect(pool.cancelStale(pool.generation)).toBe(0);
        expect(pool.pendingCount).toBe(2);

        instances[0].respond({ type: 'regex-result', counts: {}, totalMatches: 0 });
        instances[0].respond({ type: 'regex-result', counts: { kw: 2 }, totalMatches: 2 });
        await expect(settled).resolves.toMatchObject({ totalMatches: 2 });
    });

    it('rejects an in-flight result that arrives after cancellation, then frees the worker', async () => {
        const pool = makePool(1);
        const stale = pool.runRegexOnText('a', 'f', ['kw'], 'docx', 'k1');
        const staleCaught = stale.catch(e => e);

        pool.cancelStale(pool.generation + 1);
        const fresh = pool.runRegexOnText('b', 'f', ['kw'], 'docx', 'k2');
        const freshSettled = fresh.then(r => r, e => e);

        // The worker finishes the superseded job anyway; its result must not
        // reach the caller.
        instances[0].respond({ type: 'regex-result', counts: { kw: 99 }, totalMatches: 99 });

        await expect(staleCaught).resolves.toBeInstanceOf(CancelledTaskError);
        // ...and the freed worker picks up the current generation's task.
        expect(instances[0].posted).toHaveLength(2);
        expect(instances[0].posted[1].data.cacheKey).toBe('k2');

        instances[0].respond({ type: 'regex-result', counts: { kw: 1 }, totalMatches: 1 });
        await expect(freshSettled).resolves.toMatchObject({ totalMatches: 1 });
    });

    it('surfaces worker error messages as rejections', async () => {
        const pool = makePool(1);
        const task = pool.runRegexOnText('a', 'f', ['kw'], 'docx', 'k1');
        const caught = task.catch(e => e);

        instances[0].respond({ type: 'error', error: 'Worker processing failed' });
        const err = await caught;
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toBe('Worker processing failed');
    });

    it('unwraps the result of a process-text-content task', async () => {
        const pool = makePool(1);
        const task = pool.runProcessTextContent([{ str: 'hi' }]);

        instances[0].respond({ type: 'text-content-result', result: { text: 'hi', items: [] } });
        await expect(task).resolves.toEqual({ text: 'hi', items: [] });
    });

    it('settles every outstanding task on terminate and stops the workers', async () => {
        const pool = makePool(2);
        const active1 = pool.runRegexOnText('a', 'f', ['kw'], 'docx', 'k1');
        const active2 = pool.runRegexOnText('b', 'f', ['kw'], 'docx', 'k2');
        const queued = pool.runRegexOnText('c', 'f', ['kw'], 'docx', 'k3');

        const settled = Promise.all([active1, active2, queued].map(p => p.catch(e => e)));
        pool.terminate();

        for (const err of await settled) {
            expect(err).toBeInstanceOf(CancelledTaskError);
        }
        expect(instances.every(w => w.terminated)).toBe(true);
        expect(pool.pendingCount).toBe(0);
        expect(pool.initialized).toBe(false);
    });

    it('can be re-initialised after terminate', async () => {
        const pool = makePool(1);
        pool.terminate();

        pool.init();
        expect(pool.initialized).toBe(true);
        expect(instances).toHaveLength(2);

        const task = pool.runRegexOnText('a', 'f', ['kw'], 'docx', 'k1');
        instances[1].respond({ type: 'regex-result', counts: {}, totalMatches: 0 });
        await expect(task).resolves.toMatchObject({ totalMatches: 0 });
    });
});
