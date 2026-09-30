// Bounded store for raw pdf.js TextContent objects.
//
// The selection text layer needs the *original* pdf.js TextContent (per-item
// geometry plus the `styles` font map), but that object is large and must never
// be pinned into `state.docTextCache`: those entries are shared by reference
// with `state.textPageCache`, and their `_size` is measured by JSON.stringify
// before `raw` is ever attached, so `evictCaches()` could never reclaim it.
// Keeping it here, in a small LRU keyed by page, bounds it to the pages the
// user is actually looking at.

const MAX_ENTRIES = 20;

const entries = new Map<number, any>();

/** Store raw TextContent for a page, evicting the least-recently-used entry. */
export function putRawTextContent(pageNum: number, textContent: any): void {
    if (!textContent) return;
    // Re-insert so Map iteration order tracks recency.
    entries.delete(pageNum);
    entries.set(pageNum, textContent);
    while (entries.size > MAX_ENTRIES) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
    }
}

export function getRawTextContent(pageNum: number): any {
    const value = entries.get(pageNum);
    if (value === undefined) return undefined;
    entries.delete(pageNum);
    entries.set(pageNum, value);
    return value;
}

export function deleteRawTextContent(pageNum: number): void {
    entries.delete(pageNum);
}

export function clearRawTextContent(): void {
    entries.clear();
}

export function rawTextContentSize(): number {
    return entries.size;
}
