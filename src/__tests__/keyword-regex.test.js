import { describe, it, expect } from 'vitest';
import { getKeywordRegex, normalizeKeywordMatch, clearKeywordRegexCache } from '../keyword-regex';

describe('getKeywordRegex', () => {
    it('returns null for null input', () => {
        expect(getKeywordRegex(null)).toBeNull();
    });

    it('returns null for non-array input', () => {
        expect(getKeywordRegex('string')).toBeNull();
        expect(getKeywordRegex(123)).toBeNull();
        expect(getKeywordRegex({})).toBeNull();
    });

    it('returns null for empty array', () => {
        expect(getKeywordRegex([])).toBeNull();
    });

    it('builds a regex matching any of the keywords', () => {
        const re = getKeywordRegex(['foo', 'bar']);
        expect(re).toBeInstanceOf(RegExp);
        expect(re.test('foo bar')).toBe(true);
        expect(re.test('baz')).toBe(false);
    });

    it('escapes special regex characters', () => {
        const re = getKeywordRegex(['foo.bar', 'foo+bar']);
        expect(re).toBeInstanceOf(RegExp);
        expect('foo.bar').toMatch(re);
        expect('foo+bar').toMatch(re);
        expect('fooxbar').not.toMatch(re);
    });

    it('uses word boundaries', () => {
        const re = getKeywordRegex(['foo']);
        expect('foo').toMatch(re);
        expect('foobar').not.toMatch(re);
        expect('barfoo').not.toMatch(re);
    });

    it('is case insensitive', () => {
        const re = getKeywordRegex(['Foo']);
        expect('foo').toMatch(re);
        expect('FOO').toMatch(re);
        expect('Foo').toMatch(re);
    });

    it('caches results based on keywords identity', () => {
        clearKeywordRegexCache();
        const re1 = getKeywordRegex(['a', 'b']);
        const re2 = getKeywordRegex(['a', 'b']);
        expect(re1).toBe(re2);
    });

    it('returns different regex for different keywords', () => {
        clearKeywordRegexCache();
        const re1 = getKeywordRegex(['a']);
        const re2 = getKeywordRegex(['b']);
        expect(re1).not.toBe(re2);
    });
});

describe('normalizeKeywordMatch', () => {
    it('returns null for matches shorter than 3 characters', () => {
        expect(normalizeKeywordMatch(['ab'])).toBeNull();
        expect(normalizeKeywordMatch(['a'])).toBeNull();
    });

    it('returns null for non-alpha matches', () => {
        expect(normalizeKeywordMatch(['123'])).toBeNull();
        expect(normalizeKeywordMatch(['!!!'])).toBeNull();
        // '1a2' contains a letter so it is valid
        expect(normalizeKeywordMatch(['1a2'])).toBe('1a2');
    });

    it('lowercases the match when no keywords provided', () => {
        expect(normalizeKeywordMatch(['Foo'])).toBe('foo');
        expect(normalizeKeywordMatch(['TEST'])).toBe('test');
    });

    it('finds canonical form in keywords array', () => {
        const keywords = ['FooBar', 'hello'];
        // returns the canonical cased version from the keywords array
        expect(normalizeKeywordMatch(['foobar'], keywords)).toBe('FooBar');
        expect(normalizeKeywordMatch(['Hello'], keywords)).toBe('hello');
    });

    it('returns lowercase match if keyword not found', () => {
        const keywords = ['foo'];
        expect(normalizeKeywordMatch(['bar'], keywords)).toBe('bar');
    });

    it('looks up in Map if provided', () => {
        const map = new Map([['foo', 'FooBar'], ['bar', 'BarBaz']]);
        expect(normalizeKeywordMatch(['foo'], map)).toBe('FooBar');
        expect(normalizeKeywordMatch(['baz'], map)).toBe('baz');
    });
});

describe('normalizeKeywordMatch canonical cache', () => {
    it('keeps the spelling of the keyword list it is given', () => {
        expect(normalizeKeywordMatch(['foobar'], ['FooBar'])).toBe('FooBar');
        expect(normalizeKeywordMatch(['foobar'], ['FOOBAR'])).toBe('FOOBAR');
    });

    it('prefers the first spelling when a list repeats a keyword', () => {
        expect(normalizeKeywordMatch(['foo'], ['Foo', 'foo'])).toBe('Foo');
    });

    it('notices a list that grew in place', () => {
        const keywords = ['Foo'];
        expect(normalizeKeywordMatch(['foo'], keywords)).toBe('Foo');

        keywords.push('Bar');

        expect(normalizeKeywordMatch(['bar'], keywords)).toBe('Bar');
    });

    it('still resolves after the regex cache is cleared', () => {
        const keywords = ['FooBar'];
        expect(normalizeKeywordMatch(['foobar'], keywords)).toBe('FooBar');

        clearKeywordRegexCache();

        expect(normalizeKeywordMatch(['foobar'], keywords)).toBe('FooBar');
    });
});
