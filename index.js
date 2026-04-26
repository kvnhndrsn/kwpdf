// ========== INDEX.JS ==========
// Main entry point - coordinates all modules

// Event listener for keyword list changes
const keywordListSelect = document.getElementById('keywordListSelect');

keywordListSelect.addEventListener('change', () => {
    const listName = keywordListSelect.value;
    if (window.switchKeywordList && window.switchKeywordList(listName)) {
        window.searchCache = {};
        window.clearSearch();
        if (window.objectUrls.length > 0) {
            window.rescanAllDocuments();
        }
    }
});

function populateListSelector() {
    const keywordListSelect = document.getElementById('keywordListSelect');
    if (!keywordListSelect) return;
    
    keywordListSelect.innerHTML = '';
    for (const name of Object.keys(window.KEYWORD_LISTS || {})) {
        const opt = document.createElement('option');
        opt.value = name;
        const list = window.KEYWORD_LISTS[name] || [];
        opt.textContent = `${name} (${list.length})`;
        keywordListSelect.appendChild(opt);
    }
    
    const savedListName = localStorage.getItem('tender_keyword_list') || window.DEFAULT_LIST_NAME;
    if (window.KEYWORD_LISTS && window.KEYWORD_LISTS[savedListName]) {
        keywordListSelect.value = savedListName;
    }
}

// ========== INITIALIZATION ==========

document.addEventListener('DOMContentLoaded', async () => {
    if (typeof window.loadKeywords === 'function') {
        await window.loadKeywords();
    }
    populateListSelector();
    window.setupEventListeners();
});