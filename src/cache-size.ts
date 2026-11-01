// Cache-size accounting.
//
// `evictCaches()` only needs a comparable, monotonic size per entry — not an
// exact byte count. The previous implementation called `JSON.stringify` on a
// whole document's page text purely to measure it, which serialised every page a
// second time at the exact moment a large document finished extracting. That
// temporarily doubled peak memory for a number the caller then discarded.
//
// These estimates walk the same data once and add up lengths, so they cost
// roughly nothing and allocate nothing. They read a little smaller than the
// JSON length they replace (no key quotes, no escaping), which only moves the
// eviction thresholds slightly inside a 500 MB budget that was always
// approximate.

/** Allowance for one text item: its keys, quotes and transform numbers. */
export const ITEM_OVERHEAD = 56;

/** Allowance for a page viewport: size, offsets, transform matrix, rotation. */
export const VIEWPORT_OVERHEAD = 120;

/** Allowance for a page entry's own keys and punctuation. */
export const PAGE_OVERHEAD = 40;

/** Allowance for a small entry object (e.g. a DOCX html/text record). */
export const ENTRY_OVERHEAD = 40;

/** Rough per-slot cost of an array element. */
const ARRAY_SLOT_OVERHEAD = 8;

export interface PageSizeEntry {
    text?: string;
    items?: Array<{ text?: string }> | null;
    viewport?: unknown;
}

/** Estimated size of one page's cached text, without serialising it. */
export function estimatePageSize(page: PageSizeEntry | null | undefined): number {
    if (!page) return 0;

    let size = PAGE_OVERHEAD;
    if (typeof page.text === 'string') size += page.text.length;

    const items = page.items;
    if (Array.isArray(items)) {
        size += items.length * ARRAY_SLOT_OVERHEAD;
        for (const item of items) {
            size += ITEM_OVERHEAD;
            if (item && typeof item.text === 'string') size += item.text.length;
        }
    }

    if (page.viewport) size += VIEWPORT_OVERHEAD;
    return size;
}

/** Estimated size of a document's cached page array. */
export function estimatePagesSize(pages: readonly PageSizeEntry[] | null | undefined): number {
    if (!Array.isArray(pages)) return 0;
    let size = 0;
    for (const page of pages) size += estimatePageSize(page);
    return size;
}

/** Estimated size of a text-backed entry, such as a DOCX's html and plain text. */
export function estimateTextEntrySize(html?: string | null, text?: string | null): number {
    let size = ENTRY_OVERHEAD;
    if (typeof html === 'string') size += html.length;
    if (typeof text === 'string') size += text.length;
    return size;
}
