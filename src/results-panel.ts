// The results panel: every match as a row, click-to-jump.
//
// The tree count used to load a document and cycle through its matches one at a
// time. Review work needs to see the whole set (file, page, keyword, snippet) and
// go straight to one, so the count now opens this panel and rows jump.

import { register } from './cross';
import * as dom from './dom';
import { buildResultRows } from './result-rows';
import type { ResultRow } from './result-rows';

/** Rows rendered at once; a large folder would otherwise build thousands of nodes. */
const MAX_ROWS = 500;

let jumpHandler: ((row: ResultRow) => void) | null = null;
let openRows: ResultRow[] = [];

export function setJumpHandler(handler: (row: ResultRow) => void): void {
    jumpHandler = handler;
}

/** Keep rows whose path, keyword or snippet contains the query. */
export function filterResultRows(rows: ResultRow[], query: string): ResultRow[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) =>
        `${row.folder ? row.folder + '/' : ''}${row.file} ${row.keyword} ${row.snippet}`.toLowerCase().includes(needle),
    );
}

export function resultRowWhere(row: ResultRow): string {
    const path = row.folder ? row.folder + '/' + row.file : row.file;
    const where = row.page === null ? (row.ocr ? 'OCR' : 'unattributed') : 'p.' + row.page;
    return path + ' · ' + where;
}

export function resultsTitle(rows: ResultRow[]): string {
    if (rows.length === 0) return 'Results';
    const files = new Set(rows.map((row) => row.url));
    if (files.size === 1) return rows[0].file + ' — results';
    return `Results (${rows.length} rows, ${files.size} files)`;
}

export function renderResultsList(rows: ResultRow[]): void {
    const list = dom.resultsPanelList;
    if (!list) return;

    list.replaceChildren();

    if (rows.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'results-panel-empty';
        empty.textContent = openRows.length === 0 ? 'No matches yet' : 'No rows match that filter';
        list.appendChild(empty);
        return;
    }

    const fragment = document.createDocumentFragment();
    for (const row of rows.slice(0, MAX_ROWS)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'results-row';
        button.dataset.url = row.url;
        button.title = resultRowWhere(row) + ' — ' + row.keyword;

        const where = document.createElement('span');
        where.className = 'results-row-where';
        where.textContent = `${resultRowWhere(row)} · ${row.keyword} ×${row.count}${row.ocr ? ' (OCR)' : ''}`;

        const snippet = document.createElement('span');
        snippet.className = 'results-row-snippet';
        snippet.textContent = row.snippet;

        button.append(where, snippet);
        button.addEventListener('click', () => jumpHandler?.(row));
        fragment.appendChild(button);
    }
    list.appendChild(fragment);

    if (rows.length > MAX_ROWS) {
        const note = document.createElement('div');
        note.className = 'results-panel-note';
        note.textContent = `Showing the first ${MAX_ROWS} of ${rows.length} rows — filter to narrow it down`;
        list.appendChild(note);
    }
}

export function applyResultsFilter(query: string): void {
    renderResultsList(filterResultRows(openRows, query));
}

export function openResultsPanel(url?: string): void {
    if (!dom.resultsPanel) return;

    const all = buildResultRows();
    openRows = url ? all.filter((row) => row.url === url) : all;

    if (dom.resultsPanelFilter) dom.resultsPanelFilter.value = '';
    renderResultsList(openRows);
    if (dom.resultsPanelTitle) dom.resultsPanelTitle.textContent = resultsTitle(openRows);

    dom.resultsPanel.classList.add('visible');
    dom.resultsPanelFilter?.focus();
}

export function closeResultsPanel(): void {
    dom.resultsPanel?.classList.remove('visible');
}

export function isResultsPanelOpen(): boolean {
    return !!dom.resultsPanel?.classList.contains('visible');
}

export function initResultsPanel(): void {
    dom.resultsPanelClose?.addEventListener('click', closeResultsPanel);
    dom.resultsPanelFilter?.addEventListener('input', () => applyResultsFilter(dom.resultsPanelFilter!.value));
    dom.resultsPanel?.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeResultsPanel();
    });
}

// The tree (rendering.ts) calls into the UI through the registry, so it can open
// the panel without importing this module's owner.
register('openResultsPanel', openResultsPanel);
register('closeResultsPanel', closeResultsPanel);
