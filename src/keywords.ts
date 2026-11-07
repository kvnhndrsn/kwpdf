import { state, createSearchCache } from './state';
import * as dom from './dom';
import { clearKeywordRegexCache } from './keyword-regex';
import { fn, setKeywords, setKeywordLists, setDefaultListName } from './cross';

let DEFAULT_LIST_NAME = 'Central Supply-Only';
// Set when keywords.json could not be fetched or parsed. The app keeps running
// (documents still open) but every scan would report zero matches, which is the
// most misleading failure a keyword scanner can have, so it is surfaced.
let keywordLoadError: string | null = null;
let KEYWORD_LISTS = {};
let BUILT_IN_LISTS = [];
let currentListName = DEFAULT_LIST_NAME;
let KEYWORDS = [];

export function getKeywords() {
    return KEYWORDS;
}

export function getKeywordLoadError() {
    return keywordLoadError;
}

/** Show or clear the persistent warning that scanning has no keyword list. */
export function showKeywordLoadError() {
    const banner = dom.keywordLoadError;
    if (!banner) return;
    if (!keywordLoadError) {
        banner.hidden = true;
        banner.removeAttribute('title');
        return;
    }
    if (dom.keywordLoadErrorText) {
        dom.keywordLoadErrorText.textContent = 'Keyword list failed to load — scanning is disabled';
    }
    banner.title = keywordLoadError;
    banner.hidden = false;
}

async function retryKeywordLoad() {
    await loadKeywords();
    populateListSelector();
    syncToBus();
    showKeywordLoadError();
    if (!keywordLoadError) fn.updateStats?.();
}

export function getKeywordLists() {
    return KEYWORD_LISTS;
}

export function getDefaultListName() {
    return DEFAULT_LIST_NAME;
}

export function getCurrentListName() {
    return currentListName;
}

export async function loadKeywords() {
    try {
        const response = await fetch('./keywords.json');
        const data = await response.json();

        KEYWORD_LISTS = data.lists || {};
        DEFAULT_LIST_NAME = data.defaultList || 'Central Supply-Only';
        BUILT_IN_LISTS = data.builtIn || [];

        loadCustomLists();

        const savedList = localStorage.getItem('tender_keyword_list');
        currentListName = savedList && KEYWORD_LISTS[savedList] ? savedList : DEFAULT_LIST_NAME;

        KEYWORDS = KEYWORD_LISTS[currentListName] || [];
        keywordLoadError = null;
    } catch (e) {
        console.error('Failed to load keywords.json:', e);
        KEYWORD_LISTS = {};
        KEYWORDS = [];
        keywordLoadError = e && e.message ? e.message : String(e);
    }
    syncToBus();
}

function loadCustomLists() {
    try {
        const saved = localStorage.getItem('tender_custom_lists');
        if (saved) {
            const custom = JSON.parse(saved);
            KEYWORD_LISTS = { ...KEYWORD_LISTS, ...custom };
        }
    } catch (e) {
        console.warn('Failed to parse custom keyword lists from localStorage:', e);
    }
}

function saveCustomLists() {
    const custom = {};

    for (const name of Object.keys(KEYWORD_LISTS)) {
        if (!BUILT_IN_LISTS.includes(name)) {
            custom[name] = KEYWORD_LISTS[name];
        }
    }
    localStorage.setItem('tender_custom_lists', JSON.stringify(custom));
}

export function isCustomList(name) {
    return !BUILT_IN_LISTS.includes(name);
}

function createList(name, words) {
    KEYWORD_LISTS[name] = words;
    setKeywordLists(KEYWORD_LISTS);
    saveCustomLists();
}

function updateList(name, words) {
    KEYWORD_LISTS[name] = words;
    setKeywordLists(KEYWORD_LISTS);
    saveCustomLists();
}

function deleteList(name) {
    if (isCustomList(name)) {
        delete KEYWORD_LISTS[name];
        setKeywordLists(KEYWORD_LISTS);
        saveCustomLists();
        return true;
    }
    return false;
}

export function switchKeywordList(listName) {
    if (!KEYWORD_LISTS[listName]) return false;

    localStorage.setItem('tender_keyword_list', listName);
    currentListName = listName;
    KEYWORDS = KEYWORD_LISTS[listName];
    setKeywords(KEYWORDS);
    localStorage.setItem('tender_keywords', JSON.stringify(KEYWORDS));
    clearKeywordRegexCache();

    return true;
}

/**
 * Keyword membership changed: per-document counts, the keyword grid and every
 * cached scan describe the previous list. Drop the caches, clear the open
 * document's search, and rescan the library the same way the list-change
 * handler in index.js does.
 */
function refreshScansAfterKeywordChange() {
    state.searchCache = createSearchCache();
    state.searchDeduplicated = false;
    state.activeKeyword = '';
    fn.clearDocQueryCache?.();
    fn.clearSearch();
    if (state.objectUrls.length > 0) fn.rescanAllDocuments();
}

export function populateListSelector() {
    const listSelector = dom.keywordListSelect;
    if (listSelector && KEYWORD_LISTS) {
        listSelector.innerHTML = '';
        for (const name of Object.keys(KEYWORD_LISTS)) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = `${name} (${KEYWORD_LISTS[name].length})`;
            listSelector.appendChild(opt);
        }
        const savedListName = localStorage.getItem('tender_keyword_list') || DEFAULT_LIST_NAME;
        if (KEYWORD_LISTS[savedListName]) {
            listSelector.value = savedListName;
        }
    }

    if (dom.kwListSelector && KEYWORD_LISTS) {
        dom.kwListSelector.innerHTML = '';
        for (const name of Object.keys(KEYWORD_LISTS)) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = `${name} (${KEYWORD_LISTS[name].length})`;
            dom.kwListSelector.appendChild(opt);
        }
        if (KEYWORD_LISTS[currentListName]) {
            dom.kwListSelector.value = currentListName;
        }
    }
}

let _keywordSelectSignature = '';

export function populateKeywordSelect() {
    const isDocx = state.currentDocType !== 'pdf';
    const entries: Array<{ k: string; count: number }> = [];
    KEYWORDS.forEach((k) => {
        const count = isDocx ? state.docKeywordCounts?.[k] || 0 : state.searchCache[k]?.length || 0;
        if ((count as number) > 0) entries.push({ k, count: count as number });
    });

    // Navigation emits `keywords-changed` on every match step. Rebuilding the
    // options (and the custom dropdown's menu) for the same list was pure DOM
    // churn; only the selection actually moves.
    const signature = entries.map((e) => e.k + '\u0000' + e.count).join('\u0001');
    if (signature === _keywordSelectSignature && dom.keywordSelect.options.length === entries.length) {
        for (const opt of Array.from(dom.keywordSelect.options)) {
            opt.selected = opt.value === state.activeKeyword;
        }
        return;
    }
    _keywordSelectSignature = signature;

    dom.keywordSelect.innerHTML = '';
    entries.forEach(({ k, count }) => {
        const opt = document.createElement('option');
        opt.value = k;
        opt.textContent = `${k} (${count})`;
        if (k === state.activeKeyword) opt.selected = true;
        dom.keywordSelect.appendChild(opt);
    });
}

function getFocusable(el) {
    return el.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
}

function trapFocus(modal, focusAfterClosed) {
    const prevFocus = focusAfterClosed || document.activeElement;
    const focusable = getFocusable(modal);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    first?.focus();

    function handler(e) {
        if (e.key === 'Escape') {
            if (modal === dom.keywordMenu) {
                toggleKeywordManager();
            } else if (modal.classList.contains('show')) {
                hideNewListDialog();
            }
            return;
        }
        if (e.key !== 'Tab') return;
        const isShift = e.shiftKey;
        if (isShift && document.activeElement === first) {
            e.preventDefault();
            last?.focus();
        } else if (!isShift && document.activeElement === last) {
            e.preventDefault();
            first?.focus();
        }
    }

    document.addEventListener('keydown', handler);

    modal._trapCleanup = () => {
        document.removeEventListener('keydown', handler);
        prevFocus?.focus();
    };
}

export function toggleKeywordManager(e?) {
    if (e) e.stopPropagation();

    const menu = dom.keywordMenu;
    if (!menu) return;

    const isShowing = menu.classList.toggle('visible');

    if (isShowing) {
        if (dom.kwListSelector && KEYWORD_LISTS) {
            dom.kwListSelector.innerHTML = '';
            for (const name of Object.keys(KEYWORD_LISTS)) {
                const opt = document.createElement('option');
                opt.value = name;
                opt.textContent = name;
                dom.kwListSelector.appendChild(opt);
            }
        }
        loadListIntoEditor();

        const rect = dom.settingsBtn.getBoundingClientRect();
        menu.style.left = rect.left + 'px';
        menu.style.top = rect.bottom + 4 + 'px';

        trapFocus(menu, dom.settingsBtn);

        setTimeout(() => {
            document.addEventListener('click', closeKeywordMenuOnClickOutside);
        }, 0);
    } else {
        document.removeEventListener('click', closeKeywordMenuOnClickOutside);
        if (typeof (menu as any)._trapCleanup === 'function') {
            (menu as any)._trapCleanup();
            delete (menu as any)._trapCleanup;
        }
    }
}

function closeKeywordMenuOnClickOutside(e) {
    const menu = dom.keywordMenu;
    if (!menu || !menu.classList.contains('visible')) {
        document.removeEventListener('click', closeKeywordMenuOnClickOutside);
        return;
    }
    if (!menu.contains(e.target)) {
        menu.classList.remove('visible');
        document.removeEventListener('click', closeKeywordMenuOnClickOutside);
        if (typeof (menu as any)._trapCleanup === 'function') {
            (menu as any)._trapCleanup();
            delete (menu as any)._trapCleanup;
        }
    }
}

function loadListIntoEditor() {
    const listName = dom.kwListSelector ? dom.kwListSelector.value : currentListName;

    const finalName = listName || DEFAULT_LIST_NAME;
    const keywords = KEYWORD_LISTS[finalName] || [];
    dom.kwInput.value = keywords.join('\n');

    if (dom.kwDeleteListBtn) {
        dom.kwDeleteListBtn.style.display = isCustomList(finalName) ? '' : 'none';
    }
    if (dom.kwListInfo) {
        dom.kwListInfo.textContent = `${keywords.length} keywords`;
    }
    if (dom.kwListSelector && finalName) {
        dom.kwListSelector.value = finalName;
    }
}

function showNewListDialog() {
    const dialog = dom.newListDialog;
    if (!dialog) return;
    dialog.classList.add('show');
    if (dom.newListName) {
        dom.newListName.value = '';
    }

    const focusable = getFocusable(dialog);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    dom.newListName?.focus();

    function handler(e) {
        if (e.key === 'Escape') {
            hideNewListDialog();
            return;
        }
        if (e.key !== 'Tab') return;
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first?.focus();
        }
    }

    function backdrop(e) {
        if (e.target === dialog) hideNewListDialog();
    }

    document.addEventListener('keydown', handler);
    dialog.addEventListener('click', backdrop);

    (dialog as any)._trapCleanup = () => {
        document.removeEventListener('keydown', handler);
        dialog.removeEventListener('click', backdrop);
        dom.kwListSelector?.focus();
    };
}

function hideNewListDialog() {
    const dialog = dom.newListDialog;
    if (!dialog) return;
    dialog.classList.remove('show');
    if (typeof (dialog as any)._trapCleanup === 'function') {
        (dialog as any)._trapCleanup();
        delete (dialog as any)._trapCleanup;
    }
}

function createNewList() {
    const name = dom.newListName.value.trim();
    if (!name) return;
    if (KEYWORD_LISTS[name]) {
        alert('A list with this name already exists.');
        return;
    }
    createList(name, []);
    hideNewListDialog();
    populateListSelector();
    if (dom.kwListSelector) dom.kwListSelector.value = name;
    loadListIntoEditor();
}

function deleteCurrentList() {
    const listName = dom.kwListSelector ? dom.kwListSelector.value : '';
    if (!listName || !isCustomList(listName)) return;
    if (!confirm(`Delete list "${listName}"?`)) return;
    deleteList(listName);
    populateListSelector();
    // Deleting the active list leaves KEYWORDS pointing at the deleted array;
    // move to the list the selector fell back to before rescanning.
    if (listName === currentListName) {
        const next = dom.kwListSelector ? dom.kwListSelector.value : '';
        if (next && KEYWORD_LISTS[next]) switchKeywordList(next);
    }
    loadListIntoEditor();
    refreshScansAfterKeywordChange();
}

function saveCurrentList() {
    const listName = dom.kwListSelector ? dom.kwListSelector.value : currentListName;

    const lines = dom.kwInput.value
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(0, state.MAX_KEYWORDS_PER_LIST)
        .map((k) => k.slice(0, state.MAX_KEYWORD_LENGTH));

    updateList(listName, lines);
    switchKeywordList(listName);

    toggleKeywordManager();
    refreshScansAfterKeywordChange();
}

function exportKeywords() {
    const listName = currentListName || DEFAULT_LIST_NAME;
    const keywords = KEYWORD_LISTS[listName] || [];

    const data = {
        name: listName,
        keywords: keywords,
        exported: new Date().toISOString(),
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `${listName.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_keywords.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function importKeywords() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';

    input.addEventListener('change', (e) => {
        const file = (e.target as HTMLInputElement).files[0];
        if (!file) return;
        if (file.size > 1024 * 1024) {
            alert('File too large. Maximum import size is 1 MB.');
            return;
        }

        const reader = new FileReader();
        reader.addEventListener('load', (event) => {
            try {
                const text = (event.target as FileReader).result as string;
                if (text.length > 1024 * 1024) {
                    alert('File content too large.');
                    return;
                }
                const data = JSON.parse(text);
                if (!data || typeof data !== 'object' || Array.isArray(data)) {
                    alert('Invalid file format: expected a JSON object.');
                    return;
                }
                if (!Array.isArray(data.keywords)) {
                    alert('Invalid file format: "keywords" must be an array.');
                    return;
                }
                if (data.name && typeof data.name !== 'string') {
                    alert('Invalid file format: "name" must be a string.');
                    return;
                }

                const listName = (data.name || 'Imported List').slice(0, 100);
                const words = data.keywords
                    .filter((k) => typeof k === 'string' && k.trim())
                    .map((k) => k.trim())
                    .slice(0, state.MAX_KEYWORDS_PER_LIST);

                createList(listName, words);
                switchKeywordList(listName);
                populateListSelector();
                // The selector now shows the imported list, so the editor must too;
                // otherwise Save & Apply would write the previous list's words over it.
                loadListIntoEditor();
                refreshScansAfterKeywordChange();

                alert(`Imported "${listName}" with ${words.length} keywords.`);
            } catch (err) {
                alert('Failed to parse JSON file: ' + err.message);
            }
        });
        reader.readAsText(file);
    });

    input.click();
}

export function setupKeywordManager() {
    dom.kwListSelector?.addEventListener('change', loadListIntoEditor);
    dom.kwNewListBtn?.addEventListener('click', showNewListDialog);
    dom.kwDeleteListBtn?.addEventListener('click', deleteCurrentList);
    dom.kwExportBtn?.addEventListener('click', exportKeywords);
    dom.kwImportBtn?.addEventListener('click', importKeywords);
    dom.kwCancelBtn?.addEventListener('click', toggleKeywordManager);
    dom.kwSaveBtn?.addEventListener('click', saveCurrentList);
    dom.keywordRetryBtn?.addEventListener('click', retryKeywordLoad);
    dom.hideNewListBtn?.addEventListener('click', hideNewListDialog);
    dom.createNewListBtn?.addEventListener('click', createNewList);
    dom.newListName?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') createNewList();
    });
}

function syncToBus() {
    setKeywords(KEYWORDS);
    setKeywordLists(KEYWORD_LISTS);
    setDefaultListName(DEFAULT_LIST_NAME);
}

export function initKeywordBridge() {
    syncToBus();
}

export function syncKeywordsToWindow() {
    syncToBus();
}
