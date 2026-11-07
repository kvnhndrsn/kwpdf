// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { countKeywordMatches } from '../file-handler';

describe('countKeywordMatches', () => {
    it('counts every hit across page texts', () => {
        const { counts, total } = countKeywordMatches(['tender here', 'nothing', 'tender and TENDER'], ['tender']);

        expect(counts).toEqual({ tender: 3 });
        expect(total).toBe(3);
    });

    it('keeps the word-boundary rule the scanner uses', () => {
        expect(countKeywordMatches(['categorical'], ['cat'])).toEqual({ counts: {}, total: 0 });
    });

    it('files case variants under the keyword spelling', () => {
        const { counts } = countKeywordMatches(['Geotextile, GEOTEXTILE'], ['geotextile']);

        expect(counts).toEqual({ geotextile: 2 });
    });

    it('counts several keywords in one pass', () => {
        const { counts, total } = countKeywordMatches(['tender and pump'], ['tender', 'pump', 'valve']);

        expect(counts).toEqual({ tender: 1, pump: 1 });
        expect(total).toBe(2);
    });

    it('returns nothing for an empty keyword list or blank pages', () => {
        expect(countKeywordMatches(['tender'], [])).toEqual({ counts: {}, total: 0 });
        expect(countKeywordMatches(['', ' '], ['tender'])).toEqual({ counts: {}, total: 0 });
        expect(countKeywordMatches([], ['tender'])).toEqual({ counts: {}, total: 0 });
    });
});
