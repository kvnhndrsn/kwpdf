// Performance instrumentation for the PDF pipeline.
//
// Off by default and a no-op when off, so hot paths can call it without a guard
// of their own. Turn it on with `?perf=1` (remembered in localStorage under
// `kwpdf_perf`) and read the table back with `__kwpdfPerf()` in the console.
//
// The point of this module is to be able to say *where* the seconds go on a
// large drawing — indexing or rasterisation — instead of guessing. Long-task
// data (Chromium only) is what turns "it feels janky" into a number.

const STORAGE_KEY = 'kwpdf_perf';

let enabled: boolean | null = null;
let observer: any = null;
const longTasks: { start: number; duration: number }[] = [];

function startLongTaskObserver(): void {
    if (observer) return;
    const PO = (globalThis as any).PerformanceObserver;
    if (!PO) return;
    try {
        observer = new PO((list: any) => {
            for (const entry of list.getEntries()) {
                longTasks.push({ start: entry.startTime, duration: entry.duration });
            }
        });
        observer.observe({ type: 'longtask', buffered: true });
    } catch (e) {
        // The entry type is not supported everywhere; no data, no failure.
        observer = null;
    }
}

/** Whether instrumentation is on. Resolved once per page load. */
export function perfEnabled(): boolean {
    if (enabled === null) {
        enabled = false;
        try {
            const params = new URLSearchParams((globalThis as any).location?.search || '');
            const query = params.get('perf');
            const storage = (globalThis as any).localStorage;
            if (query === '0') {
                storage?.removeItem(STORAGE_KEY);
            } else if (query === '1') {
                storage?.setItem(STORAGE_KEY, '1');
                enabled = true;
            } else {
                enabled = storage?.getItem(STORAGE_KEY) === '1';
            }
        } catch (e) {
            // Blocked storage must not break the app; treat it as disabled.
            enabled = false;
        }
        if (enabled) startLongTaskObserver();
    }
    return enabled;
}

/** Force the flag (tests, and the console when a URL flag is inconvenient). */
export function setPerfEnabled(value: boolean): void {
    enabled = !!value;
    if (enabled) startLongTaskObserver();
}

/** Test seam: forget the cached decision and drop collected data. */
export function resetPerfState(): void {
    enabled = null;
    if (observer) {
        try {
            observer.disconnect();
        } catch (e) {
            /* already gone */
        }
        observer = null;
    }
    longTasks.length = 0;
    try {
        performance.clearMarks();
        performance.clearMeasures();
    } catch (e) {
        /* User Timing unavailable */
    }
}

export function mark(name: string): void {
    if (!perfEnabled()) return;
    try {
        performance.mark(name);
    } catch (e) {
        /* duplicate or unsupported mark */
    }
}

/**
 * Record `label` from mark `from` to mark `to` (or to now when omitted).
 * A missing mark — an aborted, superseded or never-reached path — is not an
 * error, so a cancelled load cannot throw from here.
 */
export function measure(label: string, from: string, to?: string): void {
    if (!perfEnabled()) return;
    try {
        if (to) performance.measure(label, from, to);
        else performance.measure(label, from);
    } catch (e) {
        /* one of the marks was never set */
    }
}

/** Every measurement recorded so far, cleared as it is returned. */
export function dumpPerf(): { label: string; ms: number }[] {
    if (!perfEnabled()) return [];
    const entries = performance.getEntriesByType('measure') as PerformanceMeasure[];
    const rows = entries.map((e) => ({ label: e.name, ms: Math.round(e.duration * 10) / 10 }));
    try {
        performance.clearMarks();
        performance.clearMeasures();
    } catch (e) {
        /* nothing to clear */
    }
    return rows;
}

/** Long-task summary: count, total time and the worst main-thread block. */
export function dumpLongTasks(): { count: number; totalMs: number; maxMs: number; tasks: number[] } {
    if (!perfEnabled()) return { count: 0, totalMs: 0, maxMs: 0, tasks: [] };
    const tasks = longTasks.map((t) => Math.round(t.duration));
    return {
        count: tasks.length,
        totalMs: tasks.reduce((a, b) => a + b, 0),
        maxMs: tasks.length ? Math.max(...tasks) : 0,
        tasks,
    };
}
