import { describe, it, expect } from 'vitest';
import { planHighlightSync } from '../highlight-plan';

describe('planHighlightSync', () => {
    it('creates everything when no marks exist yet', () => {
        expect(planHighlightSync([], ['0', '1', '2'])).toEqual({
            create: ['0', '1', '2'],
            update: [],
            remove: [],
        });
    });

    it('only repositions when the result set is unchanged', () => {
        expect(planHighlightSync(['0', '1'], ['0', '1'])).toEqual({
            create: [],
            update: ['0', '1'],
            remove: [],
        });
    });

    it('adds marks when a page gains results', () => {
        expect(planHighlightSync(['0'], ['0', '1', '2'])).toEqual({
            create: ['1', '2'],
            update: ['0'],
            remove: [],
        });
    });

    it('drops marks that no longer match a result', () => {
        expect(planHighlightSync(['0', '7', '8'], ['0'])).toEqual({
            create: [],
            update: ['0'],
            remove: ['7', '8'],
        });
    });

    it('handles a completely different result set in one pass', () => {
        expect(planHighlightSync(['0', '1'], ['2', '3'])).toEqual({
            create: ['2', '3'],
            update: [],
            remove: ['0', '1'],
        });
    });

    it('is order-independent and ignores duplicates', () => {
        const plan = planHighlightSync(['2', '1', '1'], ['1', '2']);
        expect(plan.create).toEqual([]);
        expect(plan.remove).toEqual([]);
        expect(plan.update.sort()).toEqual(['1', '2']);
    });
});
