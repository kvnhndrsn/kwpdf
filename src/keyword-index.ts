import type { SearchResult } from './types';

interface KeywordPositions {
    /** Global match indices per keyword, ascending. */
    positions: Map<string, number[]>;
}

/**
 * Per-keyword occurrence table for a results array.
 *
 * The sidebar badge and the keyword grid both ask, on every navigation, how
 * many matches a keyword has and which occurrence the current match is. Doing
 * that with `filter()` plus a prefix scan made each Next/Prev O(matches) per
 * caller; the table is built once per results array and read with a binary
 * search.
 *
 * Keyed by array identity: results arrays are replaced (never mutated) whenever
 * the result set changes.
 */
const tables = new WeakMap<object, KeywordPositions>();

function tableFor(results: SearchResult[]): KeywordPositions {
    let table = tables.get(results);
    if (table) return table;

    const positions = new Map<string, number[]>();
    for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const keyword = result && result.keyword;
        if (!keyword) continue;
        const list = positions.get(keyword);
        if (list) list.push(i);
        else positions.set(keyword, [i]);
    }

    table = { positions };
    tables.set(results, table);
    return table;
}

export interface KeywordAt {
    /** Keyword of the match, or '' when the match carries none. */
    keyword: string;
    /** 1-based occurrence of that keyword, or -1 when unknown. */
    localIndex: number;
    /** Total matches for that keyword, or 0 when unknown. */
    total: number;
}

const NONE: KeywordAt = { keyword: '', localIndex: -1, total: 0 };

/** The keyword under `index`, with its occurrence number and keyword total. */
export function keywordAt(results: SearchResult[], index: number): KeywordAt {
    if (index < 0 || index >= results.length) return NONE;

    const result = results[index];
    if (!result || !result.keyword) return NONE;

    const positions = tableFor(results).positions.get(result.keyword);
    if (!positions) return NONE;

    // Last position at or before `index`, i.e. this match's occurrence.
    let lo = 0;
    let hi = positions.length - 1;
    let at = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (positions[mid] <= index) {
            at = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }

    return { keyword: result.keyword, localIndex: at + 1, total: positions.length };
}
