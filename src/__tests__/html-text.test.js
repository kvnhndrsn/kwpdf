// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { htmlToText } from '../html-text';

describe('htmlToText', () => {
    it('separates block elements instead of gluing words together', () => {
        expect(htmlToText('<p>heat</p><p>bonded</p>')).toBe('heat bonded');
        expect(htmlToText('<h1>Tender</h1><p>Supply of membrane</p>')).toBe('Tender Supply of membrane');
    });

    it('does not split inline content', () => {
        expect(htmlToText('<p>heat <b>bonded</b> membrane</p>')).toBe('heat bonded membrane');
    });

    it('treats list items and table cells as boundaries', () => {
        expect(htmlToText('<ul><li>one</li><li>two</li></ul>')).toBe('one two');
        expect(htmlToText('<table><tr><td>a</td><td>b</td></tr></table>')).toBe('a b');
    });

    it('turns <br> into a space', () => {
        expect(htmlToText('<p>line one<br>line two</p>')).toBe('line one line two');
    });

    it('collapses whitespace and trims', () => {
        expect(htmlToText('  <p>  spaced   out  </p>  ')).toBe('spaced out');
    });

    it('returns an empty string for empty input', () => {
        expect(htmlToText('')).toBe('');
        expect(htmlToText('<p>   </p>')).toBe('');
    });
});
