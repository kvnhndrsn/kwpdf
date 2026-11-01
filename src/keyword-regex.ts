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
        const lower = k.toLowerCase();
        // First spelling wins, matching Array.prototype.find order.
        if (!map.has(lower)) map.set(lower, k);
    }

    canonicalSource = keywords;
    canonicalLength = keywords.length;
    canonicalMap = map;
    return map;
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

    if (keywords.length === 0) {
        cachedKeywordRegex = null;
        cachedKeywordList = keywordsJson;
        return cachedKeywordRegex;
    }

    const pattern = keywords
        .map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|');

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

export function normalizeKeywordMatch(
    match: RegExpExecArray,
    keywords?: string[] | Map<string, string> | null
): string | null {
    if (match[0].length < 3) return null;
    if (!/[a-zA-Z]/.test(match[0])) return null;
    const lower = match[0].toLowerCase();
    if (keywords) {
        if (keywords instanceof Map) return keywords.get(lower) || lower;
        if (Array.isArray(keywords)) return getCanonicalMap(keywords).get(lower) || lower;
        return lower;
    }
    return lower;
}
