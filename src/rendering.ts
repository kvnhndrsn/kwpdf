import { state } from './state';
import * as dom from './dom';
import { fn, KEYWORDS } from './cross';
import { getFileIcon, getFileType } from './file-handler';

let _loadDocument, _cycleSearch, _cycleDocSearch, _cycleAllKeywords, _cycleAllDocKeywords, _closeMobileSidebar;

export function setCallbacks(cbs) {
    _loadDocument = cbs.loadDocument;
    _cycleSearch = cbs.cycleSearch;
    _cycleDocSearch = cbs.cycleDocSearch;
    _cycleAllKeywords = cbs.cycleAllKeywords;
    _cycleAllDocKeywords = cbs.cycleAllDocKeywords;
    _closeMobileSidebar = cbs.closeMobileSidebar;
}

function getPathParts(file, baseFolderName) {
    let fileName;
    if (file && (file.relativePath || file.name)) fileName = file.relativePath || file.name;
    else if (baseFolderName) fileName = baseFolderName;
    else fileName = '';

    if (fileName.includes('/') || fileName.includes('\\')) {
        const parts = fileName.split(/[/\\]/);
        const name = parts.pop();
        const folder = parts.join('/');
        return { name, folder };
    }
    return { name: fileName, folder: baseFolderName || state.basePath || '' };
}

export function setActiveCardFromUrl(url) {
    document.querySelectorAll('.file.active').forEach(el => el.classList.remove('active'));
    const fileItem = document.querySelector(`.tree-file-item[data-url="${CSS.escape(url)}"]`);
    if (fileItem) {
        const fileSpan = fileItem.querySelector('.file');
        if (fileSpan) fileSpan.classList.add('active');
    }
    updateKeywordGrid(url);
}

export function renderPlaceholderCard(fileName, url, file) {
    const type = getFileType(fileName);
    const { name: baseName, folder } = getPathParts(file, null);
    state.docDataCache[url] = { name: baseName, folder, fullPath: fileName, counts: {}, url, type };
    renderResultsArea();
}

export function renderCard(fileName, counts, url, file) {
    const existing = state.docDataCache[url];
    const baseName = file ? getPathParts(file, null).name : (existing?.name || fileName);
    const folder = file ? getPathParts(file, null).folder : (existing?.folder || state.basePath || '');
    const type = getFileType(fileName);
    state.docDataCache[url] = { name: baseName, folder, fullPath: fileName, counts, url, type };

    if (existing?._ocrCounts) {
        for (const [kw, c] of Object.entries(existing._ocrCounts)) {
            counts[kw] = (counts[kw] || 0) + c;
        }
        state.docDataCache[url]._originalCounts = existing._originalCounts;
        state.docDataCache[url]._ocrCounts = existing._ocrCounts;
        state.docDataCache[url]._ocrTotalMatches = existing._ocrTotalMatches;
    }

    renderResultsArea();
}

export function renderNoMatchCard(fileName, url, file) {
    const existing = state.docDataCache[url];
    const baseName = file ? getPathParts(file, null).name : (existing?.name || fileName);
    const folder = file ? getPathParts(file, null).folder : (existing?.folder || state.basePath || '');
    const type = getFileType(fileName);
    const counts = {};
    state.docDataCache[url] = { name: baseName, folder, fullPath: fileName, counts, url, type };

    if (existing?._ocrCounts) {
        for (const [kw, c] of Object.entries(existing._ocrCounts)) {
            counts[kw] = (counts[kw] || 0) + c;
        }
        state.docDataCache[url]._originalCounts = existing._originalCounts;
        state.docDataCache[url]._ocrCounts = existing._ocrCounts;
        state.docDataCache[url]._ocrTotalMatches = existing._ocrTotalMatches;
    }

    renderResultsArea();
}

function buildTreeData() {
    const root = { name: '', children: {}, docs: [] };
    Object.values(state.docDataCache).forEach(doc => {
        const folder = doc.folder || '';
        const parts = folder ? folder.split('/').filter(Boolean) : [];
        let current = root;
        for (const part of parts) {
            if (!current.children[part]) current.children[part] = { name: part, children: {}, docs: [] };
            current = current.children[part];
        }
        current.docs.push(doc);
    });
    return root;
}

function renderTree(node, path = '') {
    const ul = document.createElement('ul');

    const folderNames = Object.keys(node.children).sort();
    for (const name of folderNames) {
        const child = node.children[name];
        const li = document.createElement('li');
        const folderSpan = document.createElement('span');
        folderSpan.className = 'folder open';
        // Folder names come from dropped files, so they are untrusted: build
        // the icon and label as nodes instead of interpolating into innerHTML.
        const folderIcon = document.createElement('img');
        folderIcon.src = 'icons/folder.svg';
        folderIcon.width = 16;
        folderIcon.height = 16;
        folderIcon.alt = 'folder';
        folderSpan.appendChild(folderIcon);
        folderSpan.appendChild(document.createTextNode(' ' + name));
        folderSpan.addEventListener('click', function(e) {
            e.stopPropagation();
            this.classList.toggle('open');
            const nested = this.nextElementSibling;
            if (nested && nested.classList.contains('tree-nested')) nested.classList.toggle('expanded');
        });
        li.appendChild(folderSpan);
        const childUl = renderTree(child, path ? path + '/' + name : name);
        childUl.className = 'tree-nested expanded';
        li.appendChild(childUl);
        ul.appendChild(li);
    }

    const sortedDocs = [...node.docs].sort((a, b) => a.name.localeCompare(b.name));
    for (const doc of sortedDocs) {
        const li = document.createElement('li');
        li.className = 'tree-file-item';
        li.dataset.url = doc.url;

        const fileSpan = document.createElement('span');
        fileSpan.className = 'file';
        if (doc.url === state.currentDocUrl) fileSpan.classList.add('active');
        fileSpan.innerHTML = getFileIcon(doc.name);
        const nameSpan = document.createElement('span');
        nameSpan.className = 'file-name';
        nameSpan.textContent = doc.name;
        fileSpan.appendChild(nameSpan);

        if (doc.type === 'pdf') {
            const ocrState = fn.getOcrState(doc.url);
            if (ocrState && ocrState.status === 'processing') {
                const ocrBtn = document.createElement('span');
                ocrBtn.className = 'ocr-toggle-tree ocr-pulsing';
                ocrBtn.textContent = 'OCR';
                ocrBtn.title = 'OCR in progress...';
                fileSpan.appendChild(ocrBtn);
            }
        }

        const totalMatches = (Object.values((doc as any).counts || {}).reduce((a: any, b: any) => a + b, 0) as number);
        if (totalMatches > 0) {
            const countSpan = document.createElement('span');
            countSpan.className = 'tree-count';
            let displayText: string | number = totalMatches;
            if (state.allKeywordMode && state.currentDocUrl === doc.url) {
                if (doc.type === 'pdf' && state.searchResults.length > 0 && state.currentMatchIndex >= 0) {
                    displayText = `${state.currentMatchIndex + 1}/${state.searchResults.length}`;
                } else if ((doc.type === 'docx' || doc.type === 'doc') && state.docSearchResults.length > 0 && state.docCurrentMatchIndex >= 0) {
                    displayText = `${state.docCurrentMatchIndex + 1}/${state.docSearchResults.length}`;
                }
            }
            countSpan.textContent = String(totalMatches);

            countSpan.addEventListener('click', function(e) {
                e.stopPropagation();

                const onSameDoc = state.currentDocUrl === doc.url;

                if (onSameDoc) {
                    _closeMobileSidebar();
                    if (doc.type === 'pdf') _cycleAllKeywords();
                    else _cycleAllDocKeywords();
                    renderResultsArea();
                    return;
                }

                if (!onSameDoc) {
                    _loadDocument(doc.url);
                }

                function tryActivateAndRender() {
                    const isDocReady = doc.type === 'pdf'
                        ? !!(state.pdfDoc && state.currentDocUrl === doc.url && state._gsPageCacheReady)
                        : !!state.docContentCache[doc.url];

                    if (isDocReady) {
                        _closeMobileSidebar();
                        if (doc.type === 'pdf') _cycleAllKeywords();
                        else _cycleAllDocKeywords();
                        renderResultsArea();
                    } else {
                        setTimeout(tryActivateAndRender, 200);
                    }
                }
                tryActivateAndRender();
            });

            fileSpan.appendChild(countSpan);
        }

        const searchCount = state.globalSearchResults[doc.url];
        if (searchCount > 0) {
            const searchCountSpan = document.createElement('span');
            searchCountSpan.className = 'tree-search-count';

            let displayText: string | number = searchCount;
            let isActive: boolean = state.globalSearchActiveDoc === doc.url && !!state.globalSearchQuery;
            if (isActive) {
                const results = state.globalSearchDocResults;
                const currentIdx = state.globalSearchDocIndex;
                if (results.length > 0 && currentIdx >= 0) {
                    displayText = `${currentIdx + 1}/${results.length}`;
                } else {
                    isActive = false;
                }
            }

            searchCountSpan.textContent = String(displayText);
            searchCountSpan.title = isActive ? 'Click for next match' : `Click to view ${searchCount} matches`;

            searchCountSpan.addEventListener('click', function(e) {
                e.stopPropagation();
                if (!state.globalSearchQuery) return;

                const onSameDoc = state.currentDocUrl === doc.url;
                const wasActive = state.globalSearchActiveDoc === doc.url;
                const hasResults = state.globalSearchDocResults.length > 0;

                if (onSameDoc && wasActive && hasResults) {
                    fn.cycleGlobalSearch();
                    renderResultsArea();
                    return;
                }

                if (!onSameDoc) {
                    _loadDocument(doc.url);
                }

                function tryActivateAndRender() {
                    const isDocReady = doc.type === 'pdf'
                        ? !!(state.pdfDoc && state.currentDocUrl === doc.url && state._gsPageCacheReady)
                        : !!state.docContentCache[doc.url];
                    if (isDocReady) {
                        state.globalSearchActiveDoc = doc.url;
                        fn.activateGlobalSearch();
                        renderResultsArea();
                    } else {
                        setTimeout(tryActivateAndRender, 200);
                    }
                }
                tryActivateAndRender();
            });

            fileSpan.appendChild(searchCountSpan);
        }

        fileSpan.addEventListener('click', function(e) {
            e.stopPropagation();
            const onSameDoc = state.currentDocUrl === doc.url;

            if (onSameDoc) {
                _closeMobileSidebar();
                if (doc.type === 'pdf') _cycleAllKeywords();
                else _cycleAllDocKeywords();
                renderResultsArea();
                return;
            }

            _loadDocument(doc.url);
            _closeMobileSidebar();
            renderResultsArea();

            if (state.globalSearchQuery) {
                const tryActivate = () => {
                    const isDocReady = doc.type === 'pdf'
                        ? !!(state.pdfDoc && state.currentDocUrl === doc.url && state._gsPageCacheReady)
                        : !!state.docContentCache[doc.url];
                    if (isDocReady) {
                        state.globalSearchActiveDoc = doc.url;
                        fn.activateGlobalSearch();
                        const urls = Object.keys(state.globalSearchResults)
                            .filter(u => state.globalSearchResults[u] > 0)
                            .sort((a, b) => {
                                const na = (state.docDataCache[a]?.name || a).toLowerCase();
                                const nb = (state.docDataCache[b]?.name || b).toLowerCase();
                                return na.localeCompare(nb);
                            });
                        state._gsPos = urls.indexOf(doc.url);
                        renderResultsArea();
                    } else {
                        setTimeout(tryActivate, 200);
                    }
                };
                tryActivate();
            }
        });
        li.appendChild(fileSpan);
        ul.appendChild(li);
    }
    return ul;
}

/**
 * Bulk ingestion (folder / zip scan) rebuilds the tree once per file, which is
 * O(n^2) node creation for an n-file folder. While a batch is open the tree is
 * rebuilt at most once per throttle window; the final state is always flushed
 * by endResultsBatch().
 */
let _resultsBatchDepth = 0;
let _resultsDirty = false;
let _resultsLastRenderAt = 0;
const RESULTS_RENDER_THROTTLE_MS = 250;

export function beginResultsBatch(): void {
    _resultsBatchDepth++;
}

export function endResultsBatch(): void {
    if (_resultsBatchDepth > 0) _resultsBatchDepth--;
    if (_resultsBatchDepth === 0 && _resultsDirty) flushResultsRender();
}

function flushResultsRender(): void {
    if (!_resultsDirty) return;
    _resultsDirty = false;
    _resultsLastRenderAt = Date.now();
    renderResultsAreaNow();
}

export function renderResultsArea() {
    if (_resultsBatchDepth > 0) {
        _resultsDirty = true;
        if (Date.now() - _resultsLastRenderAt >= RESULTS_RENDER_THROTTLE_MS) flushResultsRender();
        return;
    }
    renderResultsAreaNow();
}

function renderResultsAreaNow(): void {
    dom.resultsArea.innerHTML = '';
    dom.resultsArea.className = 'results-area';

    const treeData = buildTreeData();
    const treeUl = renderTree(treeData);
    treeUl.id = 'file-tree';
    dom.resultsArea.appendChild(treeUl);

    if (Object.keys(state.docDataCache).length === 0) {
        dom.resultsArea.innerHTML = '<div class="drop-zone-empty"><div class="drop-zone-empty-icon"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M24 4L24 32M24 4L16 12M24 4L32 12"/><path d="M8 28L8 40C8 41.1 8.9 42 10 42L38 42C39.1 42 40 41.1 40 40L40 28"/></svg></div><h2 class="drop-zone-empty-title">Drop files to begin scanning</h2><p class="drop-zone-empty-text">PDF &middot; DOCX &middot; ZIP &mdash; any folder or archive</p></div>';
    }

    if (state.currentDocUrl) {
        updateKeywordGrid(state.currentDocUrl);
    }
}

export function updateStats() {
    if (state.globalSearchQuery) {
        const total = Object.values(state.globalSearchResults).reduce((a, b) => a + b, 0);
        const files = Object.keys(state.globalSearchResults).length;
        if (total > 0) {
            dom.statusBar.textContent = `${total} global match${total !== 1 ? 'es' : ''} for "${state.globalSearchQuery}" in ${files} file${files !== 1 ? 's' : ''}`;
        } else {
            dom.statusBar.textContent = `No matches for "${state.globalSearchQuery}"`;
        }
        return;
    }

    // Derive the totals from the index rather than the incrementally maintained
    // counters: a single-document load never updated them, so the status bar
    // reported "0 matches across 0 documents" after a one-file drop.
    const docs = Object.values(state.docDataCache);
    let matches = 0;
    for (const doc of docs) {
        for (const n of Object.values(doc.counts || {})) matches += n as number;
    }
    if (matches > 0) {
        dom.statusBar.textContent = `${matches} matches across ${docs.length} document${docs.length !== 1 ? 's' : ''}`;
    } else if (docs.length > 0) {
        dom.statusBar.textContent = `${docs.length} document${docs.length !== 1 ? 's' : ''} scanned`;
    }
}

export function updateSidebarBadge() {
    const results = state.currentDocType === 'pdf' ? state.searchResults : state.docSearchResults;
    let currentKeyword = '';
    let keywordLocalIndex = -1;
    let keywordTotal = 0;

    if (state.allKeywordMode && state.currentMatchIndex >= 0 && results.length > 0) {
        const idx = state.currentMatchIndex;
        const currentResult = results[idx];
        if (currentResult && currentResult.keyword) {
            currentKeyword = currentResult.keyword;
            keywordTotal = results.filter(r => r.keyword === currentKeyword).length;
            keywordLocalIndex = 0;
            for (let i = 0; i <= idx; i++) {
                if (results[i].keyword === currentKeyword) keywordLocalIndex++;
            }
        }
    }

    const curFileItem = state.currentDocUrl ? document.querySelector(`.tree-file-item[data-url="${CSS.escape(state.currentDocUrl)}"]`) : null;
    if (curFileItem) {
        const countSpan = curFileItem.querySelector('.tree-count');
        if (countSpan) {
            const isPdf = state.currentDocType === 'pdf';
            const kwResults = isPdf ? state.searchResults : state.docSearchResults;
            const kwIndex = isPdf ? state.currentMatchIndex : state.docCurrentMatchIndex;
            if (state.allKeywordMode && kwResults.length > 0 && kwIndex >= 0) {
                countSpan.textContent = `${kwIndex + 1}/${kwResults.length}`;
            } else {
                const doc = state.docDataCache[state.currentDocUrl];
                if (doc) {
                    const total = Object.values(doc.counts).reduce((a, b) => a + b, 0);
                    countSpan.textContent = String(total || 0);
                }
            }
        }
    }

    document.querySelectorAll('.kw-grid-cell').forEach(cell => {
        const k = (cell as HTMLElement).dataset.keyword;
        const total = parseInt((cell as HTMLElement).dataset.count) || 0;
        const countSpan = cell.querySelector('.kw-cell-count');
        
        const isActiveKeyword = k === state.activeKeyword;
        const isAllKeywordActive = state.allKeywordMode && k === currentKeyword;

        if ((isActiveKeyword || isAllKeywordActive) && state.currentMatchIndex >= 0) {
            const displayTotal = isAllKeywordActive ? keywordTotal : total;
            const displayIndex = isAllKeywordActive ? keywordLocalIndex : state.currentMatchIndex + 1;
            if (countSpan) countSpan.textContent = `${displayIndex}/${displayTotal}`;
            cell.classList.add('active');
        } else {
            if (countSpan) countSpan.textContent = String(total);
            cell.classList.remove('active');
        }
    });
}

export function updateKeywordGrid(url) {
    const content = document.getElementById('kwGridContent');
    const filenameEl = document.getElementById('kwGridFilename');
    const ocrBtn = document.getElementById('kwGridOcrBtn');
    if (!content) return;

    const doc = state.docDataCache[url];

    if (!doc) {
        if (filenameEl) filenameEl.textContent = 'No file selected';
        content.innerHTML = '<div class="kw-grid-empty">No file selected</div>';
        if (ocrBtn) ocrBtn.style.display = 'none';
        return;
    }

    if (filenameEl) filenameEl.textContent = doc.name || '';

    if (ocrBtn) {
        if (fn.isOcrEnabled() && doc.type === 'pdf') {
            const ocrState = fn.getOcrState(url);
            ocrBtn.className = 'kw-ocr-btn' + (ocrState && ocrState.status === 'done' ? ' active' : ocrState && ocrState.status === 'processing' ? ' ocr-pulsing' : '');
            ocrBtn.textContent = ocrState && ocrState.status === 'done' ? 'OCR\u2713' : 'OCR';
            ocrBtn.title = 'Run OCR on this file';
            ocrBtn.style.display = '';
            ocrBtn.onclick = (e) => { e.stopPropagation(); fn.toggleOcrForFile(url); };
        } else {
            ocrBtn.style.display = 'none';
        }
    }

    const keywords = KEYWORDS || [];
    const cells: HTMLElement[] = [];

    let akwCurrentKeyword = '';
    let akwKeywordLocalIndex = -1;
    let akwKeywordTotal = 0;
    const akwResults = state.currentDocType === 'pdf' ? state.searchResults : state.docSearchResults;
    if (state.allKeywordMode && state.currentMatchIndex >= 0 && akwResults.length > 0) {
        const idx = state.currentMatchIndex;
        const cr = akwResults[idx];
        if (cr && cr.keyword) {
            akwCurrentKeyword = cr.keyword;
            akwKeywordTotal = akwResults.filter(r => r.keyword === akwCurrentKeyword).length;
            akwKeywordLocalIndex = 0;
            for (let i = 0; i <= idx; i++) {
                if (akwResults[i].keyword === akwCurrentKeyword) akwKeywordLocalIndex++;
            }
        }
    }

    keywords.forEach(k => {
        const count = doc.counts[k] || 0;
        if (count <= 0) return;

        let isActive = k === state.activeKeyword;
        let countText = String(count);
        if (state.allKeywordMode && state.currentMatchIndex >= 0) {
            isActive = k === akwCurrentKeyword;
            if (isActive) countText = `${akwKeywordLocalIndex}/${akwKeywordTotal}`;
        } else if (isActive && state.currentMatchIndex >= 0) {
            countText = `${state.currentMatchIndex + 1}/${count}`;
        }

        // Keywords are user-editable, so never interpolate them into HTML: a
        // quote or a tag would break out of the attribute or the cell.
        const cell = document.createElement('div');
        cell.className = 'kw-grid-cell' + (isActive ? ' active' : '');
        cell.dataset.keyword = k;
        cell.dataset.count = String(count);

        const nameEl = document.createElement('span');
        nameEl.className = 'kw-cell-name';
        nameEl.textContent = k;

        const countEl = document.createElement('span');
        countEl.className = 'kw-cell-count';
        countEl.textContent = countText;

        cell.append(nameEl, countEl);
        cell.addEventListener('click', () => {
            state.allKeywordMode = false;
            _closeMobileSidebar();
            if (state.currentDocUrl === url) {
                if (doc?.type === 'pdf') _cycleSearch(k);
                else _cycleDocSearch(k);
            } else {
                _loadDocument(url, k);
            }
        });
        cells.push(cell);
    });

    if (cells.length === 0) {
        content.innerHTML = '<div class="kw-grid-empty">No keyword matches</div>';
    } else {
        content.replaceChildren(...cells);
    }
}

export function updateProgressMainThread() {
    state.processed++;
    dom.progressBar.style.width = `${Math.round((state.processed / state.totalFiles) * 100)}%`;
    if (state.processed === state.totalFiles) {
        renderResultsArea();
        if (state.globalSearchQuery) {
            fn.performGlobalSearch(state.globalSearchQuery);
        } else {
            dom.statusBar.textContent = state.totalMatchesFound === 0
                ? 'No matches found'
                : `${state.totalMatchesFound} matches across ${state.totalDocsFound} document${state.totalDocsFound !== 1 ? 's' : ''}`;
        }
        if (state.currentDocUrl) {
            updateKeywordGrid(state.currentDocUrl);
        }
    }
}
