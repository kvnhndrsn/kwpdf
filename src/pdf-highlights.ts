// Search-highlight overlay.
//
// Extracted from pdf-search.ts: that module finds matches, this one puts them
// on the page. Both entry points share a single reconcile pass — the pass a new
// search needs (`renderAllHighlights`) and the pass a page needs when its canvas
// appears (`renderHighlightsForPage`) differ only in scope, so a page that is
// already decorated is repositioned in place instead of being torn down and
// rebuilt. That matters at 200 matches a page: rebuilding removed and recreated
// every mark on every search, and re-rendered pages used to repeat the work.

import { state } from './state';
import * as dom from './dom';
import { planHighlightSync } from './highlight-plan';

/** Pages that currently carry highlight marks. */
const decoratedPages = new Set<number>();

interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
}

function paint(el: HTMLElement, box: Box, scale: number): void {
    el.style.left = box.x * scale + 'px';
    el.style.top = box.y * scale + 'px';
    el.style.width = box.width * scale + 'px';
    el.style.height = box.height * scale + 'px';
}

/** Reconcile key for a mark: `idx` on one line, `idx:part` when wrapped. */
function markKey(el: HTMLElement): string | null {
    const idx = el.dataset.idx;
    if (idx === undefined) return null;
    return el.dataset.part !== undefined ? idx + ':' + el.dataset.part : idx;
}

function setCurrentMark(index: number, on: boolean): void {
    document.querySelectorAll<HTMLElement>(`.highlight-mark[data-idx="${index}"]`).forEach((el) => {
        el.classList.toggle('current', on);
    });
}

/** Bring one page's marks in line with its results, touching only what changed. */
function applyPage(pageNum: number): void {
    const pageEl = document.getElementById('page-' + pageNum);
    if (!pageEl) return;

    const existing = new Map<string, HTMLElement>();
    pageEl.querySelectorAll<HTMLElement>('.highlight-mark').forEach((el) => {
        const key = markKey(el);
        if (key !== null) existing.set(key, el);
    });

    // A match that wraps onto a second line gets one mark per line fragment; a
    // match on one line keeps the single-key form so an existing mark is
    // repositioned instead of being recreated.
    const wanted = new Map<string, Box>();
    for (const { result, globalIndex } of state.searchResultsByPage[pageNum] || []) {
        if (result.x === null) continue;
        if (result.boxes && result.boxes.length > 0) {
            result.boxes.forEach((box, part) => wanted.set(globalIndex + ':' + part, box));
        } else {
            wanted.set(String(globalIndex), {
                x: result.x,
                y: result.y,
                width: result.width,
                height: result.height,
            });
        }
    }

    const plan = planHighlightSync(existing.keys(), wanted.keys());

    for (const key of plan.remove) {
        existing.get(key)?.remove();
        existing.delete(key);
    }

    const fragment = document.createDocumentFragment();
    for (const key of plan.create) {
        const mark = document.createElement('div');
        mark.className = 'highlight-mark';
        const [idx, part] = key.split(':');
        mark.dataset.idx = idx;
        if (part !== undefined) mark.dataset.part = part;
        existing.set(key, mark);
        fragment.appendChild(mark);
    }

    const scale = state.currentScale;
    for (const [key, box] of wanted) {
        const mark = existing.get(key);
        if (!mark) continue;
        paint(mark, box, scale);
        mark.classList.toggle('current', Number(mark.dataset.idx) === state.currentMatchIndex);
    }

    if (fragment.childNodes.length) pageEl.appendChild(fragment);

    if (wanted.size > 0) decoratedPages.add(pageNum);
    else decoratedPages.delete(pageNum);
}

/** Reconcile every page that has, or had, highlights. */
export function renderAllHighlights(): void {
    const pages = new Set<number>(decoratedPages);
    for (const key of Object.keys(state.searchResultsByPage)) {
        pages.add(Number(key));
    }
    for (const pageNum of pages) applyPage(pageNum);
}

/** Reconcile a single page, e.g. after its canvas was re-rendered. */
export function renderHighlightsForPage(pageNum: number): void {
    applyPage(pageNum);
}

export function updateCurrentMatch(oldIndex: number, newIndex: number): void {
    if (oldIndex === newIndex) return;
    // A wrapped match has several marks; all of its fragments are current.
    setCurrentMark(oldIndex, false);
    setCurrentMark(newIndex, true);
}

export function repositionHighlights(): void {
    const scale = state.currentScale;
    for (const mark of document.querySelectorAll<HTMLElement>('.highlight-mark')) {
        const idx = parseInt(mark.dataset.idx);
        if (isNaN(idx)) continue;
        const result = state.searchResults[idx];
        if (!result || result.x === null) continue;
        const part = mark.dataset.part === undefined ? -1 : Number(mark.dataset.part);
        const box = part >= 0 && result.boxes && result.boxes[part] ? result.boxes[part] : result;
        paint(mark, box, scale);
    }
}

export function clearHighlights(): void {
    dom.viewer.querySelectorAll('.highlight-mark').forEach((el) => el.remove());
    decoratedPages.clear();
}
