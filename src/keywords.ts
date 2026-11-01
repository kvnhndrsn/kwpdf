import { state } from './state';
import * as dom from './dom';
import { clearKeywordRegexCache, getKeywordRegex } from './keyword-regex';
import { fn, setKeywords, setKeywordLists, setDefaultListName } from './cross';

let DEFAULT_LIST_NAME = 'Central Supply-Only';
let KEYWORD_LISTS = {};
let BUILT_IN_LISTS = [];
let currentListName = DEFAULT_LIST_NAME;
let KEYWORDS = [];

export function getKeywords() {
    return KEYWORDS;
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
        currentListName = (savedList && KEYWORD_LISTS[savedList]) ? savedList : DEFAULT_LIST_NAME;

        KEYWORDS = KEYWORD_LISTS[currentListName] || [];
    } catch (e) {
        console.error('Failed to load keywords.json:', e);
        KEYWORD_LISTS = {};
        KEYWORDS = [];
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

function saveKeywords() {
    localStorage.setItem('tender_keywords', JSON.stringify(KEYWORDS));
    localStorage.setItem('tender_keyword_list', currentListName || DEFAULT_LIST_NAME);
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

export function populateKeywordSelect() {
    dom.keywordSelect.innerHTML = '';
    const isDocx = state.currentDocType !== 'pdf';
    KEYWORDS.forEach(k => {
        const count = isDocx
            ? ((state.searchCache as any)._docCounts?.[k] || 0)
            : (state.searchCache[k]?.length || 0);
        if ((count as number) > 0) {
            const opt = document.createElement('option');
            opt.value = k;
            opt.textContent = `${k} (${count})`;
            if (k === state.activeKeyword) opt.selected = true;
            dom.keywordSelect.appendChild(opt);
        }
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
        menu.style.top = (rect.bottom + 4) + 'px';

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
    loadListIntoEditor();
}

function saveCurrentList() {
    const listName = dom.kwListSelector ? dom.kwListSelector.value : currentListName;

    const lines = dom.kwInput.value.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .slice(0, state.MAX_KEYWORDS_PER_LIST)
        .map(k => k.slice(0, state.MAX_KEYWORD_LENGTH));

    updateList(listName, lines);
    switchKeywordList(listName);

    toggleKeywordManager();
    if (typeof fn._performSearch === 'function') {
        fn._performSearch();
    }
}

function exportKeywords() {
    const listName = currentListName || DEFAULT_LIST_NAME;
    const keywords = KEYWORD_LISTS[listName] || [];

    const data = {
        name: listName,
        keywords: keywords,
        exported: new Date().toISOString()
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
                    .filter(k => typeof k === 'string' && k.trim())
                    .map(k => k.trim())
                    .slice(0, state.MAX_KEYWORDS_PER_LIST);

                createList(listName, words);
                switchKeywordList(listName);
                populateListSelector();

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
