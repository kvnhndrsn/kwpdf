// keywords.js

let DEFAULT_LIST_NAME = "Central Supply-Only";
let KEYWORD_LISTS = {};
let DEFAULT_KEYWORDS = [];
let currentListName = DEFAULT_LIST_NAME;

async function loadKeywords() {
    try {
        const response = await fetch('./keywords.json');
        const data = await response.json();
        
        KEYWORD_LISTS = data.lists || {};
        DEFAULT_LIST_NAME = data.defaultList || "Central Supply-Only";
        
        loadCustomLists();
        
        const savedList = localStorage.getItem('tender_keyword_list');
        currentListName = (savedList && KEYWORD_LISTS[savedList]) ? savedList : DEFAULT_LIST_NAME;
        
        window.KEYWORDS = KEYWORD_LISTS[currentListName] || [];
        
    } catch (e) {
        console.error('Failed to load keywords.json:', e);
        KEYWORD_LISTS = {};
        window.KEYWORDS = [];
    }
    
    window.KEYWORD_LISTS = KEYWORD_LISTS;
    window.DEFAULT_LIST_NAME = DEFAULT_LIST_NAME;
    window.KEYWORDS = KEYWORD_LISTS[currentListName] || [];
    
    window.populateKeywordSelect = function() {
        window.keywordSelect.innerHTML = '';
        window.KEYWORDS.forEach(k => {
            if (window.searchCache[k] && window.searchCache[k].length > 0) {
                const opt = document.createElement('option');
                opt.value = k;
                opt.textContent = `${k} (${window.searchCache[k].length})`;
                if (k === window.activeKeyword) opt.selected = true;
                window.keywordSelect.appendChild(opt);
            }
        });
    };

    window.toggleKeywordManager = function() {
        const modal = document.getElementById('keywordManager');
        if (!modal) {
            console.error("Could not find keywordManager element in DOM");
            return;
        }

        const isShowing = modal.classList.toggle('show');

        if (isShowing) {
            const modalSelector = document.getElementById('listSelector');
            if (modalSelector && window.KEYWORD_LISTS) {
                modalSelector.innerHTML = '';
                for (const name of Object.keys(window.KEYWORD_LISTS)) {
                    const opt = document.createElement('option');
                    opt.value = name;
                    opt.textContent = name;
                    modalSelector.appendChild(opt);
                }
            }
            if (window.loadListIntoEditor) {
                window.loadListIntoEditor();
            }
        }
    };

    window.currentListName = currentListName;
    window.isCustomList = isCustomList;
    window.createList = createList;
    window.updateList = updateList;
    window.deleteList = deleteList;
    window.populateListSelector = populateListSelector;
    window.populateModalListSelector = populateListSelector;
    window.loadListIntoEditor = loadListIntoEditor;
    window.showNewListDialog = showNewListDialog;
    window.hideNewListDialog = hideNewListDialog;
    window.createNewList = createNewList;
    window.deleteCurrentList = deleteCurrentList;
    window.exportKeywords = exportKeywords;
    window.importKeywords = importKeywords;
}

function loadCustomLists() {
    try {
        const saved = localStorage.getItem('tender_custom_lists');
        if (saved) {
            const custom = JSON.parse(saved);
            KEYWORD_LISTS = { ...KEYWORD_LISTS, ...custom };
        }
    } catch (e) {}
}

function saveCustomLists() {
    const custom = {};
    const defaultLists = ["Central Supply-Only", "Liners", "Companies"];
    
    for (const name of Object.keys(KEYWORD_LISTS)) {
        if (!defaultLists.includes(name)) {
            custom[name] = KEYWORD_LISTS[name];
        }
    }
    localStorage.setItem('tender_custom_lists', JSON.stringify(custom));
}

function isCustomList(name) {
    const defaultLists = ["Central Supply-Only", "Liners", "Companies"];
    return !defaultLists.includes(name);
}

function createList(name, keywords) {
    KEYWORD_LISTS[name] = keywords;
    saveCustomLists();
    window.KEYWORD_LISTS = KEYWORD_LISTS;
}

function updateList(name, keywords) {
    KEYWORD_LISTS[name] = keywords;
    saveCustomLists();
    window.KEYWORD_LISTS = KEYWORD_LISTS;
}

function deleteList(name) {
    if (isCustomList(name)) {
        delete KEYWORD_LISTS[name];
        saveCustomLists();
        window.KEYWORD_LISTS = KEYWORD_LISTS;
        return true;
    }
    return false;
}

function switchKeywordList(listName) {
    if (!KEYWORD_LISTS[listName]) return false;
    
    localStorage.setItem('tender_keyword_list', listName);
    currentListName = listName;
    window.KEYWORDS = KEYWORD_LISTS[listName];
    localStorage.setItem('tender_keywords', JSON.stringify(window.KEYWORDS));
    
    return true;
}

function saveKeywords() {
    localStorage.setItem('tender_keywords', JSON.stringify(window.KEYWORDS));
    localStorage.setItem('tender_keyword_list', currentListName || DEFAULT_LIST_NAME);
}

function resetKeywords() {
    if(confirm("Reset to original lists?")) {
        localStorage.removeItem('tender_keywords');
        localStorage.removeItem('tender_keyword_list');
        localStorage.removeItem('tender_custom_lists');
        location.reload();
    }
}

function populateListSelector() {
    const keywordLists = window.KEYWORD_LISTS || KEYWORD_LISTS;
    console.log('populateListSelector running', { keywordLists });
    
    const listSelector = document.getElementById('keywordListSelect');
    console.log('sidebar dropdown', { listSelector: !!listSelector });
    if (listSelector && keywordLists) {
        listSelector.innerHTML = '';
        for (const name of Object.keys(keywordLists)) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = `${name} (${keywordLists[name].length})`;
            listSelector.appendChild(opt);
        }
        const savedListName = localStorage.getItem('tender_keyword_list') || DEFAULT_LIST_NAME;
        if (keywordLists[savedListName]) {
            listSelector.value = savedListName;
        }
    }
    
    const modalSelector = document.getElementById('listSelector');
    console.log('modal dropdown', { modalSelector: !!modalSelector });
    if (modalSelector && keywordLists) {
        modalSelector.innerHTML = '';
        for (const name of Object.keys(keywordLists)) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = `${name} (${keywordLists[name].length})`;
            modalSelector.appendChild(opt);
            console.log('added option', name);
        }
        if (keywordLists[currentListName]) {
            modalSelector.value = currentListName;
        }
    } else {
        console.log('modalSelector not found in DOM');
    }
}

function loadListIntoEditor() {
    const listSelector = document.getElementById('listSelector');
    let listName = listSelector ? listSelector.value : window.currentListName;
    
    // If listName is empty, use default
    if (!listName && window.KEYWORDS && window.DEFAULT_LIST_NAME) {
        listName = window.DEFAULT_LIST_NAME;
    }
    
    console.log('loadListIntoEditor called', { listName, KEYWORD_LISTSKeys: Object.keys(KEYWORD_LISTS) });
    
    const keywords = KEYWORD_LISTS[listName] || [];
    const textarea = document.getElementById('keywordInput');
    textarea.value = keywords.join('\n');
    
    const deleteBtn = document.getElementById('deleteListBtn');
    if (deleteBtn) {
        deleteBtn.style.display = isCustomList(listName) ? '' : 'none';
    }
    const listInfo = document.getElementById('listInfo');
    if (listInfo) {
        listInfo.textContent = `${keywords.length} keywords`;
    }
    if (listSelector && listName) {
        listSelector.value = listName;
    }
}

function showNewListDialog() {
    const dialog = document.getElementById('newListDialog');
    if (dialog) dialog.classList.add('show');
    const input = document.getElementById('newListName');
    if (input) {
        input.value = '';
        input.focus();
    }
}

function hideNewListDialog() {
    const dialog = document.getElementById('newListDialog');
    if (dialog) dialog.classList.remove('show');
}

function createNewList() {
    const input = document.getElementById('newListName');
    const name = input.value.trim();
    if (!name) return;
    if (KEYWORD_LISTS[name]) {
        alert('A list with this name already exists.');
        return;
    }
    createList(name, []);
    hideNewListDialog();
    populateListSelector();
    const listSelector = document.getElementById('listSelector');
    if (listSelector) listSelector.value = name;
    loadListIntoEditor();
}

function deleteCurrentList() {
    const listSelector = document.getElementById('listSelector');
    const listName = listSelector ? listSelector.value : '';
    if (!listName || !isCustomList(listName)) return;
    if (!confirm(`Delete list "${listName}"?`)) return;
    deleteList(listName);
    populateListSelector();
    loadListIntoEditor();
}

function saveCurrentList() {
    const listSelector = document.getElementById('listSelector');
    const listName = listSelector ? listSelector.value : currentListName;
    const textarea = document.getElementById('keywordInput');

    const lines = textarea.value.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);

    updateList(listName, lines);
    switchKeywordList(listName);

    toggleKeywordManager();

    if (typeof performSearch === 'function') {
        performSearch();
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
    
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const data = JSON.parse(event.target.result);
                
                if (!data.keywords || !Array.isArray(data.keywords)) {
                    alert('Invalid file format. Expected keywords array.');
                    return;
                }
                
                const listName = data.name || 'Imported List';
                const keywords = data.keywords.filter(k => typeof k === 'string' && k.trim());
                
                createList(listName, keywords);
                switchKeywordList(listName);
                
                populateListSelector();
                populateModalListSelector();
                
                if (typeof performSearch === 'function') {
                    performSearch();
                }
                
                alert(`Imported "${listName}" with ${keywords.length} keywords.`);
            } catch (err) {
                alert('Failed to parse JSON file: ' + err.message);
            }
        };
        reader.readAsText(file);
    };
    
    input.click();
}

loadKeywords().then(() => populateListSelector());
