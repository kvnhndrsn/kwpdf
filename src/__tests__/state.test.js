import { describe, it, expect, beforeEach } from 'vitest';
import { state, beginDocGeneration, isCurrentGeneration, beginSearch, isCurrentSearch } from '../state';

describe('document generation', () => {
    beforeEach(() => {
        state.docGeneration = 0;
        state.searchToken = 0;
    });

    it('advances on every new document', () => {
        const first = beginDocGeneration();
        const second = beginDocGeneration();
        expect(second).toBe(first + 1);
    });

    it('invalidates a previously captured generation', () => {
        const captured = beginDocGeneration();
        expect(isCurrentGeneration(captured)).toBe(true);

        beginDocGeneration();
        expect(isCurrentGeneration(captured)).toBe(false);
    });

    it('treats a generation from another document as stale', () => {
        const stale = state.docGeneration - 1;
        expect(isCurrentGeneration(stale)).toBe(false);
    });
});

describe('search token', () => {
    beforeEach(() => {
        state.searchToken = 0;
    });

    it('advances on every new search request', () => {
        const first = beginSearch();
        const second = beginSearch();
        expect(second).toBe(first + 1);
    });

    it('invalidates an earlier in-flight search', () => {
        const stale = beginSearch();
        beginSearch();
        expect(isCurrentSearch(stale)).toBe(false);
    });

    it('keeps the newest search valid', () => {
        beginSearch();
        const latest = beginSearch();
        expect(isCurrentSearch(latest)).toBe(true);
    });
});
