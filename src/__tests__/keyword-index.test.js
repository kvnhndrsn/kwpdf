import { describe, it, expect } from 'vitest';
import { keywordAt } from '../keyword-index';

function results(list) {
    return list.map((keyword, i) => ({ page: 1, x: null, y: null, width: null, height: null, index: i, keyword }));
}

describe('keywordAt', () => {
    const rows = results(['alpha', 'beta', 'alpha', 'alpha', 'beta']);

    it('reports the occurrence number and the keyword total', () => {
        expect(keywordAt(rows, 0)).toEqual({ keyword: 'alpha', localIndex: 1, total: 3 });
        expect(keywordAt(rows, 2)).toEqual({ keyword: 'alpha', localIndex: 2, total: 3 });
        expect(keywordAt(rows, 3)).toEqual({ keyword: 'alpha', localIndex: 3, total: 3 });
        expect(keywordAt(rows, 4)).toEqual({ keyword: 'beta', localIndex: 2, total: 2 });
    });

    it('returns nothing for matches without a keyword or out-of-range indices', () => {
        expect(keywordAt(rows, -1)).toEqual({ keyword: '', localIndex: -1, total: 0 });
        expect(keywordAt(rows, 99)).toEqual({ keyword: '', localIndex: -1, total: 0 });
        expect(keywordAt([{ page: 1 }], 0)).toEqual({ keyword: '', localIndex: -1, total: 0 });
        expect(keywordAt([], 0)).toEqual({ keyword: '', localIndex: -1, total: 0 });
    });

    it('stays consistent for a large result set', () => {
        const many = [];
        for (let i = 0; i < 5000; i++) many.push({ page: 1, keyword: i % 2 === 0 ? 'even' : 'odd' });
        expect(keywordAt(many, 4999)).toEqual({ keyword: 'odd', localIndex: 2500, total: 2500 });
        expect(keywordAt(many, 4998)).toEqual({ keyword: 'even', localIndex: 2500, total: 2500 });
        expect(keywordAt(many, 0)).toEqual({ keyword: 'even', localIndex: 1, total: 2500 });
    });

    it('keys the table by array identity', () => {
        const first = results(['alpha']);
        expect(keywordAt(first, 0).total).toBe(1);

        // A different array with a different keyword must not reuse the table.
        const second = results(['beta']);
        expect(keywordAt(second, 0)).toEqual({ keyword: 'beta', localIndex: 1, total: 1 });
        expect(keywordAt(first, 0)).toEqual({ keyword: 'alpha', localIndex: 1, total: 1 });
    });
});
