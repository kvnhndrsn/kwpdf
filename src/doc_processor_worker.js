// doc_processor_worker.js - Web worker for REGEX MATCHING ONLY
// Text extraction (PDF.js, Mammoth) stays on main thread

// Trim, drop blank entries and collapse case-insensitive duplicates. Must stay
// in step with normalizeKeywordList() in keyword-regex.ts: a blank entry would
// become an empty alternative (`\b()\b`), whose zero-length global match never
// advances lastIndex and hangs the scan.
function normalizeKeywordList(keywords) {
    const seen = new Set();
    const unique = [];
    for (const raw of keywords || []) {
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

// Helper: Create keyword regex from keywords array
function getKeywordRegex(keywords) {
    const unique = normalizeKeywordList(keywords);
    if (unique.length === 0) return null;
    const pattern = unique
        .map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|');
    return new RegExp(`\\b(${pattern})\\b`, 'gi');
}

// One map per scan, not a linear scan per match: the same keyword resolution
// the main thread already does in keyword-regex.ts.
function getCanonicalMap(keywords) {
    const map = new Map();
    for (const k of normalizeKeywordList(keywords)) {
        const lower = k.toLowerCase();
        if (!map.has(lower)) map.set(lower, k);
    }
    return map;
}

// Mirrors normalizeKeywordMatch() in keyword-regex.ts. Short and numeric
// keywords are legitimate ("AI", "QC", "4500"); only an empty match is not.
function normalizeKeywordMatch(match, canonical) {
    if (!match[0]) return null;
    const lower = match[0].toLowerCase();
    return canonical.get(lower) || lower;
}

// Process regex matching on text (for DOCX or plain text)
function processRegexOnText(text, keywords) {
    const counts = {};
    let totalMatches = 0;
    const combinedRegex = getKeywordRegex(keywords);
    const canonical = getCanonicalMap(keywords);

    if (combinedRegex && text) {
        let match;
        const regex = new RegExp(combinedRegex.source, 'gi');
        while ((match = regex.exec(text)) !== null) {
            const key = normalizeKeywordMatch(match, canonical);
            if (!key) continue;
            counts[key] = (counts[key] || 0) + 1;
            totalMatches++;
        }
    }

    return { counts, totalMatches };
}

// Process regex on PDF page text data (for rescan with PDF cache)
function processRegexOnPDFCache(pages, keywords) {
    const counts = {};
    let totalMatches = 0;

    const combinedRegex = getKeywordRegex(keywords);
    const canonical = getCanonicalMap(keywords);

    if (combinedRegex) {
        for (let i = 0; i < pages.length; i++) {
            // The pool sends page text only; items and viewports are never used here.
            const text = pages[i] || '';

            if (text) {
                let match;
                const regex = new RegExp(combinedRegex.source, 'gi');
                while ((match = regex.exec(text)) !== null) {
                    const key = normalizeKeywordMatch(match, canonical);
                    if (!key) continue;
                    counts[key] = (counts[key] || 0) + 1;
                    totalMatches++;
                }
            }
        }
    }

    return { counts, totalMatches };
}

// Must stay in step with runSpacing() in pdf-search.ts: the worker and the
// main-thread extractor have to produce the same page text, or a scanned
// document's counts change depending on which path processed it.
function runSpacing(prevItem, item) {
    const t = item.transform;
    const p = prevItem.transform;
    const fontSize = Math.hypot(t[0], t[1]) || 12;
    if (Math.abs(t[1]) > Math.abs(t[0])) {
        // Rotated 90 (+1) or 270 (-1) degrees: the run advances along y.
        const sign = Math.sign(t[1]) || 1;
        return {
            sameLine: Math.abs(t[4] - p[4]) <= fontSize * 0.5,
            gap: sign * (t[5] - p[5]) - prevItem.width,
        };
    }
    return {
        sameLine: Math.abs(t[5] - p[5]) <= fontSize * 0.5,
        gap: t[4] - (p[4] + prevItem.width),
    };
}

// Copy of `processTextContent` from src/pdf-search.ts, which is the canonical
// implementation. This worker cannot import that module, so spacing, hyphen
// joining and rotated-run rules must be kept identical by hand: a difference
// here silently changes the text — and the match counts — of scanned pages.
function processTextContentOnItems(items) {
    let pageText = '';
    const processed = [];
    let prevItem = null;
    for (const item of items) {
        if (prevItem) {
            const { sameLine, gap } = runSpacing(prevItem, item);
            if (sameLine) {
                if (gap > 0) {
                    pageText += ' ';
                    processed.push({ text: ' ', transform: item.transform, width: 0, height: item.height });
                }
            } else {
                const hyphenBreak = /-\s*$/.test(prevItem.str) && /^\w/.test(item.str);
                if (hyphenBreak) {
                    pageText = pageText.slice(0, -1);
                    if (processed.length > 0) processed[processed.length - 1].text = processed[processed.length - 1].text.slice(0, -1);
                } else {
                    pageText += ' ';
                    processed.push({ text: ' ', transform: item.transform, width: 0, height: item.height });
                }
            }
        }
        pageText += item.str;
        processed.push({ text: item.str, transform: item.transform, width: item.width, height: item.height });
        prevItem = item;
    }
    return { text: pageText, items: processed };
}

// Main message handler
self.onmessage = function(e) {
    const { task, data } = e.data;

    switch (task) {
        case 'regex-text':
            {
                const result = processRegexOnText(data.text, data.keywords);
                self.postMessage({
                    type: 'regex-result',
                    fileName: data.fileName,
                    cacheKey: data.cacheKey,
                    fileType: data.fileType,
                    counts: result.counts,
                    totalMatches: result.totalMatches
                });
            }
            break;

        case 'regex-pdf-cache':
            {
                const result = processRegexOnPDFCache(data.pages, data.keywords);
                self.postMessage({
                    type: 'regex-result',
                    fileName: data.fileName,
                    cacheKey: data.cacheKey,
                    fileType: 'pdf',
                    counts: result.counts,
                    totalMatches: result.totalMatches
                });
            }
            break;

        case 'process-text-content':
            {
                const result = processTextContentOnItems(data.items);
                self.postMessage({ type: 'text-content-result', result });
            }
            break;

        default:
            self.postMessage({ type: 'error', error: 'Unknown task: ' + task });
    }
};
