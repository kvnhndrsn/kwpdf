import { describe, it, expect, beforeEach } from 'vitest';
import { mark, measure, dumpPerf, dumpLongTasks, setPerfEnabled, resetPerfState } from '../perf';

describe('perf instrumentation', () => {
    beforeEach(() => resetPerfState());

    it('records nothing while disabled', () => {
        setPerfEnabled(false);
        mark('from');
        mark('to');
        measure('step', 'from', 'to');
        expect(dumpPerf()).toEqual([]);
        expect(dumpLongTasks()).toEqual({ count: 0, totalMs: 0, maxMs: 0, tasks: [] });
    });

    it('records a measure and clears it as it is returned', () => {
        if (typeof performance.mark !== 'function') return; // no User Timing here
        setPerfEnabled(true);
        mark('from');
        mark('to');
        measure('step', 'from', 'to');

        const rows = dumpPerf();
        const step = rows.find((r) => r.label === 'step');
        expect(step).toBeDefined();
        expect(typeof step.ms).toBe('number');

        // Consumed, so a second dump does not repeat the same rows.
        expect(dumpPerf()).toEqual([]);
    });

    it('swallows a measure whose marks were never set', () => {
        if (typeof performance.mark !== 'function') return;
        setPerfEnabled(true);
        expect(() => measure('missing', 'never-marked')).not.toThrow();
        expect(dumpPerf().some((r) => r.label === 'missing')).toBe(false);
    });
});
