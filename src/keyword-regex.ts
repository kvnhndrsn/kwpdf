let cachedKeywordRegex: RegExp | null = null;
let cachedKeywordList: string | null = null;

// `normalizeKeywordMatch` runs once per match — thousands of times per
// document. Resolving the canonical casing through a Map turns that inner loop
// from a linear scan with a toLowerCase per keyword into one lookup.
let canonicalSource: string[] | null = null;
let canonicalLength = -1;
let canonicalMap: Map<string, string> | null = null;

function getCanonicalMap(keywords: string[]): Map<string, string> {
    if (canonicalMap && canonicalSource === keywords && canonicalLength === keywords.length) {
        return canonicalMap;
    }

    const map = new Map<string, string>();
    for (const k of keywords) {
        const keyword = typeof k === 'string' ? k.trim() : '';
        if (!keyword) continue;
        const lower = keyword.toLowerCase();
        // First spelling wins, matching Array.prototype.find order.
        if (!map.has(lower)) map.set(lower, keyword);
    }

    canonicalSource = keywords;
    canonicalLength = keywords.length;
    canonicalMap = map;
    return map;
}

/**
 * Trim, drop blank entries and collapse case-insensitive duplicates.
 *
 * A blank entry used to become an empty alternative (`\b()\b`), which matches
 * zero characters at every word boundary. A zero-length global match never
 * advances `lastIndex`, so every scan loop that consumes this regex spun
 * forever. Duplicates only add redundant alternatives, but they also decide
 * which spelling the counts are filed under, so they are removed here too.
 */
export function normalizeKeywordList(keywords: string[]): string[] {
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const raw of keywords) {
        if (typeof raw !== 'string') continue;
        const keyword = raw.trim();
        if (!keyword) continue;
        const lower = keyword.toLowerCase();
        if (seen.has(lower)) continue;
        seen.add(lower);
        unique.push(keyword);
    }
    return unique;
}

export function getKeywordRegex(keywords: string[] | null | undefined): RegExp | null {
    if (!keywords) return null;
    if (!Array.isArray(keywords)) return null;

    const keywordsJson = JSON.stringify(keywords);

    if (cachedKeywordRegex && cachedKeywordList === keywordsJson) {
        // The instance is shared across callers and is stateful (global flag).
        // Any early exit leaves lastIndex behind, so always start from zero.
        cachedKeywordRegex.lastIndex = 0;
        return cachedKeywordRegex;
    }

    const unique = normalizeKeywordList(keywords);
    if (unique.length === 0) {
        cachedKeywordRegex = null;
        cachedKeywordList = keywordsJson;
        return cachedKeywordRegex;
    }

    const pattern = unique.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

    cachedKeywordRegex = new RegExp(`\\b(${pattern})\\b`, 'gi');
    cachedKeywordList = keywordsJson;
    return cachedKeywordRegex;
}

export function clearKeywordRegexCache(): void {
    cachedKeywordRegex = null;
    cachedKeywordList = null;
    canonicalSource = null;
    canonicalLength = -1;
    canonicalMap = null;
}

/**
 * Map a regex match back to its keyword.
 *
 * Matches used to be rejected unless they were at least three characters long
 * and contained an ASCII letter, which silently dropped every short or numeric
 * keyword the user had added (`AI`, `QC`, `RFI`, `4500`) and reported "no
 * matches" for text that was plainly there. The keyword list is the user's, so
 * a match is reported; the only thing that cannot be counted is an empty one.
 * Keep this rule identical in doc_processor_worker.js and ocr.ts.
 */
export function normalizeKeywordMatch(
    match: RegExpExecArray,
    keywords?: string[] | Map<string, string> | null,
): string | null {
    if (!match[0]) return null;
    const lower = match[0].toLowerCase();
    if (keywords) {
        if (keywords instanceof Map) return keywords.get(lower) || lower;
        if (Array.isArray(keywords)) return getCanonicalMap(keywords).get(lower) || lower;
        return lower;
    }
    return lower;
}
