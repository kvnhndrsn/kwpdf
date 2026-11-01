// Repeatable timings for the paths Waves 1-3 touched. Run with `npm run bench`.
//
// These are micro-benchmarks of pure logic. They do not cover rendering,
// scrolling, painting or memory — those need a browser and a real document.
//
// The fixtures are deliberately shaped to hit the cases the optimisations
// target: many matches per page, matches spread deep into a page's item list,
// a long keyword list, and a large multi-document index.

import { bench, describe } from 'vitest';
import { searchTextPages, getTextCoords, countMatchesInAllDocs } from '../search-controller';
import { normalizeKeywordMatch } from '../keyword-regex';
import { evictCaches } from '../file-handler';
import { state } from '../state';

const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'tender', 'supply', 'invoice', 'delivery', 'contract', 'price'];
const ITEM_LEN = 12;
const ITEMS_PER_PAGE = 500;
const PAGE_COUNT = 300;

function makePage(pageNum) {
    let text = '';
    const items = [];

    for (let i = 0; i < ITEMS_PER_PAGE; i++) {
        let chunk = '';
        let w = 0;
        while (chunk.length < ITEM_LEN) {
            chunk += WORDS[(pageNum + i + w++) % WORDS.length] + ' ';
        }
        chunk = chunk.slice(0, ITEM_LEN);
        text += chunk;
        items.push({
            text: chunk,
            transform: [10, 0, 0, 10, 60 + (i % 40) * 14, 700 - Math.floor(i / 40) * 14],
            width: ITEM_LEN * 5,
            height: 10,
        });
    }

    return {
        text,
        viewport: {
            width: 800,
            height: 1000,
            offsetX: 0,
            offsetY: 0,
            transform: [1, 0, 0, -1, 0, 1000],
            rotation: 0,
        },
        items,
    };
}

// 300 pages x 6,000 chars = 1.8M chars of page text.
const pageCache = {};
for (let p = 1; p <= PAGE_COUNT; p++) pageCache[p] = makePage(p);

const QUERIES = ['tender', 'supply', 'contract', 'invoice'];

describe('searchTextPages (1.8M chars over 300 pages)', () => {
    let flip = 0;

    bench('cold - query never searched before', () => {
        // A fresh cache object defeats the per-page-cache memo, which is the
        // pre-Wave-3 behaviour for every new query.
        const cache = Object.assign({}, pageCache);
        searchTextPages(cache, PAGE_COUNT, QUERIES[flip++ % QUERIES.length]);
    });

    bench('warm - same query repeated', () => {
        searchTextPages(pageCache, PAGE_COUNT, 'tender');
    });
});

describe('getTextCoords (500 matches spread across a 500-item page)', () => {
    const matches = [];
    for (let i = 0; i < ITEMS_PER_PAGE; i++) {
        const start = i * ITEM_LEN + 2;
        matches.push({ startIndex: start, endIndex: start + 6 });
    }

    const projected = pageCache[7];
    const unprojected = {
        ...pageCache[8],
        viewport: { width: 800, height: 1000, offsetY: 0 },
    };

    bench('projected through the page transform', () => {
        for (const m of matches) getTextCoords(projected, m.startIndex, m.endIndex);
    });

    bench('unprojected page', () => {
        for (const m of matches) getTextCoords(unprojected, m.startIndex, m.endIndex);
    });
});

describe('normalizeKeywordMatch', () => {
    const keywords = [];
    for (let i = 0; i < 500; i++) keywords.push('keyword ' + i);
    keywords.push('Tender');

    const match = { 0: 'Tender', length: 1 };

    bench('5,000 matches against a 500-keyword list', () => {
        for (let i = 0; i < 5000; i++) normalizeKeywordMatch(match, keywords);
    });
});

describe('countMatchesInAllDocs (400 documents)', () => {
    // The real code yields to requestAnimationFrame between chunks; running the
    // callback inline keeps the benchmark synchronous and deterministic.
    globalThis.requestAnimationFrame = (cb) => {
        cb();
        return 0;
    };

    const dataCache = {};
    const textCache = {};

    for (let d = 0; d < 400; d++) {
        const url = 'doc' + d;
        dataCache[url] = { name: url + '.pdf', type: 'pdf', url, folder: '', fullPath: '', counts: {} };

        const pages = [];
        for (let p = 0; p < 20; p++) {
            pages.push({
                text: (WORDS.join(' ') + ' tender supply ').repeat(6),
                viewport: { width: 800, height: 600 },
                items: null,
            });
        }
        textCache[url] = { totalPages: pages.length, pages, fileName: url + '.pdf', _lastAccess: d, _size: 1000 };
    }

    bench('single keystroke across the whole index', async () => {
        await countMatchesInAllDocs(dataCache, textCache, {}, 'tender', { cancelled: false });
    });
});

describe('evictCaches', () => {
    bench('populate 200 entries, then evict down to the 30-per-type cap', () => {
        state.docTextCache = {};
        state.docContentCache = {};
        state.currentDocUrl = '';
        state.totalCacheSize = 0;

        for (let i = 0; i < 200; i++) {
            state.docTextCache['doc' + i] = {
                totalPages: 1,
                pages: [],
                fileName: 'doc' + i + '.pdf',
                _lastAccess: i,
                _size: 1024,
            };
            state.totalCacheSize += 1024;
        }

        evictCaches();
    });
});
