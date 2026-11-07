/**
 * Thrown (rejected) into callers whose work was dropped because a newer
 * document generation superseded it, or because the pool was terminated.
 * Callers should check `err instanceof CancelledTaskError` before reporting a
 * failure: a cancelled scan is not a failed one.
 */
export class CancelledTaskError extends Error {
    constructor(reason) {
        super('Worker task cancelled: ' + reason);
        this.name = 'CancelledTaskError';
    }
}

export class WorkerPool {
    constructor(poolSize) {
        this.poolSize = poolSize || Math.min(navigator.hardwareConcurrency || 4, 8);
        this.workers = [];
        this.taskQueue = [];
        this.activeWorkers = new Map();
        this.taskCallbacks = new Map();
        this.nextTaskId = 0;
        this.initialized = false;
        // Tasks are stamped with the pool's generation when queued. Bumping it
        // via cancelStale() makes everything queued under an older generation
        // stale, so a rescan cannot keep delivering counts for a library the
        // user has already replaced.
        this.generation = 0;
    }

    init() {
        if (this.initialized) return;
        // Same build-hash query as ocr.ts: without it the service worker could
        // serve a worker script from a cache that predates the build asking for
        // it. The guard is for contexts without the esbuild define (vitest),
        // where `typeof` on an undeclared identifier is safe and the query is
        // simply omitted.
        const hash = typeof __BUNDLE_HASH__ === 'string' ? '?h=' + __BUNDLE_HASH__ : '';
        for (let i = 0; i < this.poolSize; i++) {
            const worker = new Worker(WORKER_BASE + 'doc_processor_worker.js' + hash);
            worker.onmessage = (e) => this._handleWorkerMessage(worker, e);
            worker.onerror = (err) => this._handleWorkerError(worker, err);
            this.workers.push(worker);
        }
        this.initialized = true;
    }

    /**
     * Make `generation` the current one and reject every queued task that was
     * stamped with a different generation. Tasks already running are left to
     * finish (terminating a worker mid-task would cost more than waiting), but
     * their result is rejected instead of resolved when it arrives.
     *
     * @returns how many queued tasks were dropped.
     */
    cancelStale(generation) {
        this.generation = generation;

        const kept = [];
        const dropped = [];
        for (const task of this.taskQueue) {
            if (task.generation === generation) kept.push(task);
            else dropped.push(task);
        }
        this.taskQueue = kept;

        for (const task of dropped) {
            task.reject(new CancelledTaskError('superseded'));
        }

        this._processQueue();
        return dropped.length;
    }

    _handleWorkerMessage(worker, e) {
        const task = this.activeWorkers.get(worker);
        if (!task) return;

        const data = e.data;
        const stale = task.generation !== this.generation;

        if (data.type === 'progress') {
            if (stale) return;
            const callbacks = this.taskCallbacks.get(task.id);
            if (callbacks && callbacks.onProgress) {
                callbacks.onProgress(data);
            }
            return;
        }

        const callbacks = this.taskCallbacks.get(task.id);
        if (callbacks) {
            if (stale) {
                callbacks.reject(new CancelledTaskError('superseded'));
            } else if (data.type === 'error') {
                callbacks.reject(new Error(data.error || 'Worker processing failed'));
            } else {
                callbacks.resolve(data);
            }
            this.taskCallbacks.delete(task.id);
        }
        this.activeWorkers.delete(worker);
        this._processQueue();
    }

    _handleWorkerError(worker, err) {
        const task = this.activeWorkers.get(worker);
        if (task) {
            const callbacks = this.taskCallbacks.get(task.id);
            if (callbacks) {
                callbacks.reject(err);
                this.taskCallbacks.delete(task.id);
            }
            this.activeWorkers.delete(worker);
            this._processQueue();
        }
    }

    _processQueue() {
        while (this.taskQueue.length > 0) {
            const idleWorker = this.workers.find((w) => !this.activeWorkers.has(w));
            if (!idleWorker) return;

            const { taskData, resolve, reject, onProgress, generation } = this.taskQueue.shift();
            const taskId = this.nextTaskId++;

            this.activeWorkers.set(idleWorker, { id: taskId, taskData, generation });
            this.taskCallbacks.set(taskId, { resolve, reject, onProgress });

            idleWorker.postMessage(taskData);
        }
    }

    _enqueue(taskData, resolve, reject, onProgress) {
        this.taskQueue.push({ taskData, resolve, reject, onProgress, generation: this.generation });
        this._processQueue();
    }

    runRegexOnText(text, fileName, keywords, fileType, cacheKey) {
        return new Promise((resolve, reject) => {
            const taskData = {
                task: 'regex-text',
                data: {
                    text: text,
                    fileName: fileName,
                    keywords: keywords || [],
                    fileType: fileType,
                    cacheKey: cacheKey,
                },
            };

            this._enqueue(taskData, resolve, reject, null);
        });
    }

    runRegexOnPDFCache(pages, fileName, keywords, cacheKey) {
        return new Promise((resolve, reject) => {
            const taskData = {
                task: 'regex-pdf-cache',
                data: {
                    // Only the text is read by the worker. Posting whole page
                    // objects cloned every item and viewport matrix per rescan.
                    pages: pages.map((p) => (p && p.text) || ''),
                    fileName: fileName,
                    keywords: keywords || [],
                    cacheKey: cacheKey,
                },
            };

            this._enqueue(taskData, resolve, reject, null);
        });
    }

    runProcessTextContent(items) {
        return new Promise((resolve, reject) => {
            const taskData = {
                task: 'process-text-content',
                data: { items },
            };
            this._enqueue(taskData, (data) => resolve(data.result), reject, null);
        });
    }

    get pendingCount() {
        return this.taskQueue.length + this.activeWorkers.size;
    }

    get activeCount() {
        return this.activeWorkers.size;
    }

    /**
     * Stop every worker and settle every outstanding task. Without settling,
     * a caller awaiting a task that was still queued (or in flight) waits
     * forever.
     */
    terminate() {
        const error = new CancelledTaskError('pool terminated');

        const queued = this.taskQueue;
        this.taskQueue = [];
        const active = [...this.taskCallbacks.values()];
        this.taskCallbacks.clear();

        for (const callbacks of active) callbacks.reject(error);
        for (const task of queued) task.reject(error);

        this.workers.forEach((w) => w.terminate());
        this.workers = [];
        this.activeWorkers.clear();
        this.initialized = false;
    }
}
