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
import type { SearchResult } from './types';

/** Pages that currently carry highlight marks. */
const decoratedPages = new Set<number>();

function paint(el: HTMLElement, result: SearchResult, scale: number): void {
    el.style.left = (result.x * scale) + 'px';
    el.style.top = (result.y * scale) + 'px';
    el.style.width = (result.width * scale) + 'px';
    el.style.height = (result.height * scale) + 'px';
}

/** Bring one page's marks in line with its results, touching only what changed. */
function applyPage(pageNum: number): void {
    const pageEl = document.getElementById('page-' + pageNum);
    if (!pageEl) return;

    const existing = new Map<string, HTMLElement>();
    pageEl.querySelectorAll<HTMLElement>('.highlight-mark').forEach(el => {
        const idx = el.dataset.idx;
        if (idx !== undefined) existing.set(idx, el);
    });

    const wanted = new Map<string, SearchResult>();
    for (const { result, globalIndex } of state.searchResultsByPage[pageNum] || []) {
        if (result.x === null) continue;
        wanted.set(String(globalIndex), result);
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
        mark.dataset.idx = key;
        existing.set(key, mark);
        fragment.appendChild(mark);
    }

    const scale = state.currentScale;
    for (const [key, result] of wanted) {
        const mark = existing.get(key);
        if (!mark) continue;
        paint(mark, result, scale);
        mark.classList.toggle('current', Number(key) === state.currentMatchIndex);
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
    const prev = document.querySelector(`.highlight-mark[data-idx="${oldIndex}"]`);
    const next = document.querySelector(`.highlight-mark[data-idx="${newIndex}"]`);
    if (prev) prev.classList.remove('current');
    if (next) next.classList.add('current');
}

export function repositionHighlights(): void {
    for (const mark of document.querySelectorAll<HTMLElement>('.highlight-mark')) {
        const idx = parseInt(mark.dataset.idx);
        if (isNaN(idx)) continue;
        const result = state.searchResults[idx];
        if (!result || result.x === null) continue;
        paint(mark, result, state.currentScale);
    }
}

export function clearHighlights(): void {
    dom.viewer.querySelectorAll('.highlight-mark').forEach(el => el.remove());
    decoratedPages.clear();
}
