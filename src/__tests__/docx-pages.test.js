// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { buildPageOffsets, findPageForIndex } from '../docx-engine';

describe('DOCX page offsets', () => {
    const pages = ['First page text.', 'Second page text.', 'Third page text.'];
    const text = 'First page text. Second page text. Third page text.';

    it('starts each page where its text appears in the searched string', () => {
        const offsets = buildPageOffsets(pages, text);
        expect(offsets).toEqual([
            text.indexOf('First'),
            text.indexOf('Second'),
            text.indexOf('Third'),
        ]);
    });

    it('maps boundary indexes to the page that contains them', () => {
        const offsets = buildPageOffsets(pages, text);

        expect(findPageForIndex(0, offsets)).toBe(1);
        expect(findPageForIndex(offsets[1] - 1, offsets)).toBe(1);
        expect(findPageForIndex(offsets[1], offsets)).toBe(2);
        expect(findPageForIndex(offsets[2] - 1, offsets)).toBe(2);
        expect(findPageForIndex(offsets[2], offsets)).toBe(3);
        expect(findPageForIndex(text.length, offsets)).toBe(3);
    });

    it('keeps the table ascending when a page cannot be located', () => {
        const offsets = buildPageOffsets(['alpha', 'missing page', 'omega'], 'alpha omega');

        expect(offsets[0]).toBe(0);
        for (let i = 1; i < offsets.length; i++) {
            expect(offsets[i]).toBeGreaterThanOrEqual(offsets[i - 1]);
        }
        expect(findPageForIndex(7, offsets)).toBe(2);
        expect(findPageForIndex(1000, offsets)).toBe(3);
    });

    it('falls back to the first page for an empty table', () => {
        expect(findPageForIndex(0, [])).toBe(1);
    });
});
