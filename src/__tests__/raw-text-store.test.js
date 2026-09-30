import { describe, it, expect, beforeEach } from 'vitest';
import {
    putRawTextContent,
    getRawTextContent,
    deleteRawTextContent,
    clearRawTextContent,
    rawTextContentSize,
} from '../raw-text-store';

const CAP = 20;

describe('raw text store', () => {
    beforeEach(() => {
        clearRawTextContent();
    });

    it('round-trips a value by page number', () => {
        const raw = { items: [{ str: 'hi' }], styles: {} };
        putRawTextContent(3, raw);
        expect(getRawTextContent(3)).toBe(raw);
        expect(rawTextContentSize()).toBe(1);
    });

    it('returns undefined for an unknown page', () => {
        expect(getRawTextContent(99)).toBeUndefined();
    });

    it('ignores falsy values', () => {
        putRawTextContent(1, null);
        expect(rawTextContentSize()).toBe(0);
        putRawTextContent(1, undefined);
        expect(rawTextContentSize()).toBe(0);
    });

    it('evicts the least-recently-used entry past the cap', () => {
        for (let p = 1; p <= CAP; p++) putRawTextContent(p, { p });
        expect(rawTextContentSize()).toBe(CAP);

        putRawTextContent(CAP + 1, { p: CAP + 1 });
        expect(rawTextContentSize()).toBe(CAP);
        expect(getRawTextContent(1)).toBeUndefined();
        expect(getRawTextContent(2)).toEqual({ p: 2 });
        expect(getRawTextContent(CAP + 1)).toEqual({ p: CAP + 1 });
    });

    it('treats a read as a use, so a hot page is not evicted', () => {
        for (let p = 1; p <= CAP; p++) putRawTextContent(p, { p });
        getRawTextContent(1);
        putRawTextContent(CAP + 1, { p: CAP + 1 });
        expect(getRawTextContent(1)).toEqual({ p: 1 });
        expect(getRawTextContent(2)).toBeUndefined();
    });

    it('overwrites in place without growing', () => {
        putRawTextContent(1, { v: 'a' });
        putRawTextContent(1, { v: 'b' });
        expect(rawTextContentSize()).toBe(1);
        expect(getRawTextContent(1)).toEqual({ v: 'b' });
    });

    it('deletes a single entry', () => {
        putRawTextContent(1, { v: 'a' });
        putRawTextContent(2, { v: 'b' });
        deleteRawTextContent(1);
        expect(getRawTextContent(1)).toBeUndefined();
        expect(getRawTextContent(2)).toEqual({ v: 'b' });
        expect(rawTextContentSize()).toBe(1);
    });

    it('clears everything', () => {
        for (let p = 1; p <= CAP; p++) putRawTextContent(p, { p });
        clearRawTextContent();
        expect(rawTextContentSize()).toBe(0);
        expect(getRawTextContent(1)).toBeUndefined();
    });
});
