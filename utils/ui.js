// ========== STATE ==========

window.currentLayout = window.localStorage.getItem('pdf_layout') || 'cards';
window.expandedTreeItems = new Set();
window.smoothScrollEnabled = false;
window.mobileSidebarOpen = false;
window.settingsOpen = false;
window.settingsJustToggled = false;
window.docDataCache = {};

// ========== DOM REFS ==========

const viewer = document.getElementById('pdfViewer');
const viewerScroll = document.getElementById('viewerScroll');
const loader = document.getElementById('viewerLoader');
const loaderFilename = document.getElementById('loaderFilename');
const loaderStatus = document.getElementById('loaderStatus');
const loaderProgressFill = document.getElementById('loaderProgressFill');
const matchTotal = document.getElementById('matchTotal');
const navGroup = document.getElementById('navGroup');
const navSep = document.getElementById('navSep');
const zoomLevelEl = document.getElementById('zoomLevel');
const pageInput = document.getElementById('pageInput');
const pageTotal = document.getElementById('pageTotal');
const matchInput = document.getElementById('matchInput');
const keywordSelect = document.getElementById('keywordSelect');
const resultsArea = document.getElementById('results');
const progressBar = document.getElementById('progressBar');
const sidebar = document.getElementById('sidebar');
const statusBar = document.getElementById('statusBar');

// Attach DOM refs to window for pdf.js access
window.viewer = viewer;
window.viewerScroll = viewerScroll;
window.loader = loader;
window.loaderFilename = loaderFilename;
window.loaderStatus = loaderStatus;
window.loaderProgressFill = loaderProgressFill;
window.matchTotal = matchTotal;
window.navGroup = navGroup;
window.navSep = navSep;
window.zoomLevelEl = zoomLevelEl;
window.pageInput = pageInput;
window.pageTotal = pageTotal;
window.matchInput = matchInput;
window.keywordSelect = keywordSelect;
window.resultsArea = resultsArea;
window.progressBar = progressBar;
window.sidebar = sidebar;
window.statusBar = statusBar;

// ========== SEARCH OVERLAY ==========

let searchOverlay = null;
let searchOverlayInput = null;
let searchOverlayResults = null;
let customSearchResults = [];
let customSearchIndex = 0;
let heatmapContainer = null;

window.initSearchOverlay = function() {
    const viewerContainer = document.querySelector('.viewer-container');
    const overlay = document.createElement('div');
    overlay.id = 'searchOverlay';
    overlay.className = 'search-overlay';
    overlay.innerHTML = `
        <input type="text" id="searchOverlayInput" placeholder="Search PDF... (Esc to close)" autocomplete="off">
        <span class="search-overlay-results" id="searchOverlayResults">0 / 0</span>
        <button class="search-overlay-btn" id="searchOverlayPrev" title="Previous (Shift+F3)">&#8592;</button>
        <button class="search-overlay-btn" id="searchOverlayNext" title="Next (F3)">&#8594;</button>
        <button class="search-overlay-btn search-overlay-close" id="searchOverlayClose" title="Close (Esc)">&#10005;</button>
    `;
    viewerContainer.appendChild(overlay);
    searchOverlay = overlay;
    searchOverlayInput = document.getElementById('searchOverlayInput');
    searchOverlayResults = document.getElementById('searchOverlayResults');
    document.getElementById('searchOverlayPrev').addEventListener('click', window.customFindPrev);
    document.getElementById('searchOverlayNext').addEventListener('click', window.customFindNext);
    document.getElementById('searchOverlayClose').addEventListener('click', window.closeSearchOverlay);
    searchOverlayInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) {
                window.customFindPrev();
            } else {
                window.customFindNext();
            }
        }
        if (e.key === 'Escape') {
            window.closeSearchOverlay();
        }
    });
    searchOverlayInput.addEventListener('input', () => {
        window.performCustomSearch(searchOverlayInput.value);
    });
};

window.updateHeatmap = function() {
    let existing = document.getElementById('heatmapContainer');
    if (!existing) {
        const style = document.createElement('style');
        style.id = 'heatmapStyle';
        style.textContent = '.hm{position:absolute;left:2px;width:10px;height:3px;background:#6b9e3a;border-radius:1px;pointer-events:none}.hm-c{background:#fc0;box-shadow:0 0 4px #fc0}';
        document.head.appendChild(style);

        heatmapContainer = document.createElement('div');
        heatmapContainer.id = 'heatmapContainer';
        heatmapContainer.style.cssText = 'position:fixed;right:0;top:60px;bottom:60px;width:18px;pointer-events:none;z-index:99999;';
        document.body.appendChild(heatmapContainer);
        existing = heatmapContainer;
    }

    if (!window.searchResults || !window.searchResults.length) {
        existing.style.display = 'none';
        return;
    }

    existing.style.display = 'block';

    let pageOffsets = {};
    let docH = 0;
    for (let i = 1; i <= window.totalPages; i++) {
        pageOffsets[i] = docH;
        docH += ((window.pageHeights[i] || 792) * window.currentScale) + 32;
    }

    if (docH < 50) return;

    const n = window.searchResults.length;
    const currIdx = window.currentMatchIndex;
    const viewH = existing.clientHeight || 500;

    let html = '';
    for (let i = 0; i < n; i++) {
        const r = window.searchResults[i];
        if (!r || !r.page) continue;

        const top = pageOffsets[r.page] || 0;
        const y = top + (r.y || 0) * window.currentScale;
        const pos = Math.max(0, Math.min(viewH - 4, (y / docH) * viewH));
        const cls = i === currIdx ? 'hm-c' : 'hm';

        html += '<div class="' + cls + '" style="top:' + pos + 'px"></div>';
    }

    existing.innerHTML = html;
};

window.showSearchOverlay = function() {
    if (!searchOverlay) window.initSearchOverlay();
    searchOverlay.classList.add('visible');
    searchOverlayInput.value = '';
    searchOverlayInput.focus();
    customSearchResults = [];
    customSearchIndex = 0;
    searchOverlayResults.textContent = '0 / 0';
    window.closeMobileSidebar();
};

window.closeSearchOverlay = function() {
    if (searchOverlay) {
        searchOverlay.classList.remove('visible');
    }
    window.clearCustomHighlights();
    customSearchResults = [];
    customSearchIndex = 0;
};

window.performCustomSearch = function(query) {
    if (!query || !window.pdfDoc) {
        customSearchResults = [];
        customSearchIndex = 0;
        searchOverlayResults.textContent = '0 / 0';
        window.clearCustomHighlights();
        return;
    }

    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const localRegex = new RegExp(escaped, 'gi');
    const results = [];

    for (let pageNum = 1; pageNum <= window.totalPages; pageNum++) {
        const cached = window.textPageCache[pageNum];
        if (!cached) continue;

        const pageText = cached.text;
        let match;
        while ((match = localRegex.exec(pageText)) !== null) {
            results.push({
                page: pageNum,
                startIndex: match.index,
                endIndex: match.index + match[0].length,
                text: match[0]
            });
        }

        localRegex.lastIndex = 0;
    }

    customSearchResults = results;
    customSearchIndex = 0;

    if (results.length > 0) {
        searchOverlayResults.textContent = `1 / ${results.length}`;
        window.customGoToMatch(0);
    } else {
        searchOverlayResults.textContent = '0 / 0';
        window.clearCustomHighlights();
    }
};

window.customGoToMatch = async function(index) {
    if (customSearchResults.length === 0) return;

    customSearchIndex = ((index % customSearchResults.length) + customSearchResults.length) % customSearchResults.length;
    searchOverlayResults.textContent = `${customSearchIndex + 1} / ${customSearchResults.length}`;

    const result = customSearchResults[customSearchIndex];

    await window.renderPageNow(result.page);
    window.scrollToPage(result.page);
    window.renderAllCustomHighlights();
};

window.renderAllCustomHighlights = function() {
    window.clearCustomHighlights();
    if (customSearchResults.length === 0) return;

    const currentResult = customSearchResults[customSearchIndex];
    const currentPage = currentResult.page;

    for (let i = 0; i < customSearchResults.length; i++) {
        const result = customSearchResults[i];
        if (result.page !== currentPage) continue;

        const pageEl = document.getElementById('page-' + result.page);
        if (!pageEl) continue;

        const cached = window.textPageCache[result.page];
        if (!cached || !cached.items) continue;

        const coords = window.getTextCoords(cached, result.startIndex, result.endIndex);
        if (!coords) continue;

        const mark = document.createElement('div');
        const isCurrent = (i === customSearchIndex);
        mark.className = 'custom-highlight' + (isCurrent ? ' current' : '');
        mark.style.left = (coords.startX * window.currentScale) + 'px';
        mark.style.top = (coords.startY * window.currentScale) + 'px';
        mark.style.width = ((coords.endX - coords.startX) * window.currentScale) + 'px';
        mark.style.height = (coords.height * window.currentScale) + 'px';
        pageEl.appendChild(mark);
    }

    const currentResultCoords = window.getTextCoords(window.textPageCache[currentPage], currentResult.startIndex, currentResult.endIndex);
    if (currentResultCoords) {
        const halfViewport = viewerScroll.clientHeight / 2;
        const halfHeight = (currentResultCoords.height * window.currentScale) / 2;
        const targetTop = pageEl.offsetTop + currentResultCoords.startY * window.currentScale - halfViewport + halfHeight;
        viewerScroll.scrollTo({ top: Math.max(0, targetTop), behavior: window.smoothScrollEnabled ? 'smooth' : 'auto' });
    }
};

window.getTextCoords = function(cached, startIndex, endIndex) {
    if (!cached || !cached.items) return null;

    const viewHeight = cached.viewport.height;
    let startY = 0, startX = 0, endY = 0, endX = 0, height = 0;

    let charOffset = 0;
    for (const item of cached.items) {
        const itemStart = charOffset;
        const itemEnd = charOffset + item.text.length;

        if (startIndex >= itemStart && startIndex < itemEnd) {
            const frac = (startIndex - itemStart) / item.text.length;
            startX = item.transform[4] + frac * item.width;
            startY = viewHeight - (item.transform[5] + item.height);
            height = item.height;
        }

        if (endIndex > itemStart && endIndex <= itemEnd) {
            const frac = (endIndex - itemStart) / item.text.length;
            endX = item.transform[4] + frac * item.width;
            endY = viewHeight - (item.transform[5] + item.height);
            break;
        }

        charOffset = itemEnd;
    }

    if (endX === 0) endX = startX + 50;
    if (endY === 0) endY = startY;

    return { startX, startY, endX, endY, height };
};

window.clearCustomHighlights = function() {
    document.querySelectorAll('.custom-highlight').forEach(el => el.remove());
};

window.customFindNext = function() {
    if (customSearchResults.length > 0) {
        window.customGoToMatch(customSearchIndex + 1);
    }
};

window.customFindPrev = function() {
    if (customSearchResults.length > 0) {
        window.customGoToMatch(customSearchIndex - 1);
    }
};

// ========== THEME / SETTINGS ==========

window.toggleTheme = function() {
    const html = document.documentElement;
    if (html.getAttribute('data-theme') === 'light') {
        html.setAttribute('data-theme', 'dark');
        localStorage.setItem('pdf_theme', 'dark');
    } else {
        html.setAttribute('data-theme', 'light');
        localStorage.setItem('pdf_theme', 'light');
    }
    const btn = document.querySelector('#settingsMenu button:first-child');
    if (btn) btn.textContent = html.getAttribute('data-theme') === 'light' ? 'Dark Mode' : 'Light Mode';
};

window.toggleSettings = function(e) {
    if (e) {
        e.stopPropagation();
    }
    window.settingsOpen = !window.settingsOpen;
    
    const existing = document.getElementById('settingsMenu');
    if (!window.settingsOpen) {
        if (existing) existing.remove();
        return;
    }
    
    if (existing) existing.remove();
    
    window.settingsJustToggled = true;
    
    const btn = document.getElementById('settingsBtn');
    const rect = btn.getBoundingClientRect();
    
    const menu = document.createElement('div');
    menu.id = 'settingsMenu';
    menu.className = 'settings-menu';
    menu.style.display = 'flex';
    menu.style.position = 'fixed';
    menu.style.left = rect.left + 'px';
    menu.style.top = (rect.bottom + 4) + 'px';
    
    const themeBtn = document.createElement('button');
    const html = document.documentElement;
    themeBtn.innerHTML = '&#9728; ' + (html.getAttribute('data-theme') === 'light' ? 'Dark Mode' : 'Light Mode');
    themeBtn.onclick = window.toggleTheme;
    menu.appendChild(themeBtn);
    
    const animateBtn = document.createElement('button');
    animateBtn.className = 'toggle-btn';
    if (window.smoothScrollEnabled) animateBtn.classList.add('on');
    animateBtn.onclick = function() {
        animateBtn.classList.toggle('on');
        window.toggleAnimate();
    };
    
    const label = document.createElement('span');
    label.className = 'toggle-label';
    label.textContent = 'Animate PDF Scroll ';
    animateBtn.appendChild(label);
    
    const state = document.createElement('span');
    state.className = 'toggle-state';
    state.textContent = window.smoothScrollEnabled ? 'ON' : 'OFF';
    animateBtn.appendChild(state);
    
    menu.appendChild(animateBtn);
    
    const layoutSection = document.createElement('div');
    layoutSection.style.display = 'flex';
    layoutSection.style.flexDirection = 'column';
    layoutSection.style.gap = '4px';
    layoutSection.style.marginTop = '4px';
    layoutSection.style.paddingTop = '8px';
    layoutSection.style.borderTop = '1px solid var(--grey-600)';
    
    const layoutLabel = document.createElement('span');
    layoutLabel.className = 'toggle-label';
    layoutLabel.textContent = 'Sidebar Layout:';
    layoutLabel.style.fontSize = '0.75rem';
    layoutSection.appendChild(layoutLabel);
    
    const layoutBtns = document.createElement('div');
    layoutBtns.style.display = 'flex';
    layoutBtns.style.gap = '4px';
    
    const layouts = [
        { id: 'cards', label: 'Cards' },
        { id: 'tree', label: 'Tree' }
    ];
    
    layouts.forEach(l => {
        const btn = document.createElement('button');
        btn.textContent = l.label;
        btn.style.flex = '1';
        btn.style.padding = '6px 8px';
        btn.style.fontSize = '0.75rem';
        btn.style.border = '1px solid var(--grey-600)';
        btn.style.borderRadius = '4px';
        btn.style.background = window.currentLayout === l.id ? 'var(--green)' : 'transparent';
        btn.style.color = window.currentLayout === l.id ? 'white' : 'var(--grey-300)';
        btn.style.cursor = 'pointer';
        btn.onclick = () => {
            window.settingsJustToggled = true;
            window.setLayout(l.id);
            window.closeSettingsMenu();
        };
        layoutBtns.appendChild(btn);
    });
    
    layoutSection.appendChild(layoutBtns);
    menu.appendChild(layoutSection);
    
    document.body.appendChild(menu);
    
    setTimeout(() => {
        document.addEventListener('click', window.closeSettingsOnClickOutside);
    }, 0);
};

window.closeSettingsOnClickOutside = function(e) {
    const menu = document.getElementById('settingsMenu');
    const btn = document.getElementById('settingsBtn');
    if (window.settingsJustToggled) {
        window.settingsJustToggled = false;
        return;
    }
    if (menu && !menu.contains(e.target) && e.target !== btn) {
        menu.remove();
        window.settingsOpen = false;
        document.removeEventListener('click', window.closeSettingsOnClickOutside);
    }
};

window.toggleAnimate = function() {
    window.smoothScrollEnabled = !window.smoothScrollEnabled;
    localStorage.setItem('pdf_smooth_scroll', window.smoothScrollEnabled);
    const label = document.querySelector('.toggle-state');
    if (label) label.textContent = window.smoothScrollEnabled ? 'ON' : 'OFF';
};

window.setLayout = function(layout) {
    window.currentLayout = layout;
    localStorage.setItem('pdf_layout', layout);
    window.renderResultsArea();
};

window.closeSettingsMenu = function() {
    const menu = document.getElementById('settingsMenu');
    if (menu) {
        menu.remove();
        window.settingsOpen = false;
    }
};

// ========== MOBILE SIDEBAR ==========

window.closeMobileSidebar = function() {
    const sidebarEl = document.getElementById('sidebar');
    const viewerEl = document.querySelector('.viewer-container');
    sidebarEl.classList.remove('open');
    sidebarEl.classList.add('collapsed');
    viewerEl.style.height = 'calc(100% - 44px)';
    window.mobileSidebarOpen = false;
};

window.openMobileSidebar = function() {
    const sidebarEl = document.getElementById('sidebar');
    const viewerEl = document.querySelector('.viewer-container');
    sidebarEl.classList.add('open');
    sidebarEl.classList.remove('collapsed');
    viewerEl.style.height = 'calc(100% - 44px)';
    window.mobileSidebarOpen = true;
};

window.toggleMobileSidebar = function() {
    if (window.mobileSidebarOpen) {
        window.closeMobileSidebar();
    } else {
        window.openMobileSidebar();
    }
};

window.checkMobileLayout = function() {
    const isMobile = window.innerWidth <= 700;
    const sidebarEl = document.getElementById('sidebar');
    const toggleBtn = document.querySelector('.mobile-toggle-sidebar');
    const viewerEl = document.querySelector('.viewer-container');
    if (toggleBtn) {
        toggleBtn.style.display = isMobile ? 'block' : 'none';
    }
    if (isMobile && !window.mobileSidebarOpen) {
        sidebarEl.classList.add('collapsed');
        sidebarEl.classList.remove('open');
        viewerEl.style.height = 'calc(100% - 44px)';
    }
};

// ========== RESULTS RENDERING ==========

window.getPathParts = function(file, baseFolderName) {
    const fileName = file.relativePath || file.name;
    
    if (fileName.includes('/') || fileName.includes('\\')) {
        const parts = fileName.split(/[/\\]/);
        const name = parts.pop();
        const folder = parts.join('/');
        return { name, folder };
    }
    
    return { name: fileName, folder: baseFolderName || window.basePath || '' };
};

window.renderCard = function(fileName, counts, url, file) {
    const { name: baseName, folder } = window.getPathParts(file, null);
    const type = window.getFileType(fileName);
    window.docDataCache[url] = { name: baseName, folder, fullPath: fileName, counts, url, type };

    if (window.currentLayout === 'tree') {
        window.renderResultsArea();
        return;
    }
    const card = document.createElement('div');
    card.className = 'doc-card';
    card.dataset.url = url;
    card.dataset.type = type;
    card.onclick = () => { window.setActiveCard(card); window.loadDocument(url); window.closeMobileSidebar(); };
    card.innerHTML = `<div class="doc-name">${window.getFileIcon(fileName)} ${fileName}</div>`;

    const grid = document.createElement('div');
    grid.className = 'badge-grid';

    const keywordCounts = {};
    window.KEYWORDS.forEach(k => {
        const count = counts[k] || 0;
        if (count > 0) {
            keywordCounts[k] = count;
        }
    });
    card.dataset.counts = JSON.stringify(keywordCounts);

    window.KEYWORDS.forEach(k => {
        const count = counts[k] || 0;
        if (count > 0) {
            const b = document.createElement('div');
            b.className = 'badge';
            b.dataset.keyword = k;
            b.dataset.count = count;
            b.textContent = `${k}: ${count}`;
            b.onclick = (e) => {
                e.stopPropagation();
                window.setActiveCard(card);
                window.closeMobileSidebar();
                if (window.currentDocUrl === url) {
                    if (type === 'pdf') {
                        window.cycleSearch(k);
                    } else {
                        window.cycleDocSearch(k);
                    }
                } else {
                    window.loadDocument(url, k);
                }
            };
            grid.appendChild(b);
        }
    });
    card.appendChild(grid);
    resultsArea.appendChild(card);
};

window.renderNoMatchCard = function(fileName, url, file) {
    const { name: baseName, folder } = window.getPathParts(file, null);
    const finalName = fileName;
    window.docDataCache[url] = { name: baseName, folder, fullPath: finalName, counts: {}, url, type: window.getFileType(fileName) };

    if (window.currentLayout === 'tree') {
        window.renderResultsArea();
        return;
    }

    const type = window.getFileType(fileName);
    const card = document.createElement('div');
    card.className = 'doc-card doc-card-minimal';
    card.dataset.url = url;
    card.dataset.type = type;
    card.onclick = () => { window.setActiveCard(card); window.loadDocument(url); window.closeMobileSidebar(); };
    card.innerHTML = `<div class="doc-name">${window.getFileIcon(fileName)} ${fileName}</div>`;
    resultsArea.appendChild(card);
};

window.renderTreeItem = function(doc) {
    const item = document.createElement('div');
    item.className = 'tree-item';
    
    const totalMatches = Object.values(doc.counts).reduce((a, b) => a + b, 0);
    const isExpanded = window.expandedTreeItems.has(doc.url);
    const isActive = doc.url === window.currentDocUrl;
    
    const header = document.createElement('div');
    header.className = 'tree-header' + (isActive ? ' active' : '');

    const arrow = document.createElement('span');
    arrow.className = 'tree-arrow';
    arrow.textContent = totalMatches > 0 ? (isExpanded ? '▼' : '▶') : '│';
    arrow.onclick = (e) => {
        e.stopPropagation();
        if (totalMatches > 0) {
            if (window.expandedTreeItems.has(doc.url)) {
                window.expandedTreeItems.delete(doc.url);
            } else {
                window.expandedTreeItems.add(doc.url);
            }
            window.renderResultsArea();
        }
    };
    header.appendChild(arrow);

    const fileIcon = document.createElement('span');
    fileIcon.className = 'tree-file-icon';
    fileIcon.innerHTML = window.getFileIcon(doc.name);
    header.appendChild(fileIcon);
    
    const name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = doc.name;
    header.appendChild(name);
    
    if (totalMatches > 0) {
        const count = document.createElement('span');
        count.className = 'tree-count';
        count.textContent = totalMatches;
        header.appendChild(count);
    }

    header.onclick = () => {
        if (totalMatches > 0) {
            if (isExpanded) {
                window.expandedTreeItems.delete(doc.url);
            } else {
                window.expandedTreeItems.add(doc.url);
            }
        }
        window.setActiveCardFromUrl(doc.url);
        window.loadDocument(doc.url);
        window.closeMobileSidebar();
        window.renderResultsArea();
    };

    item.appendChild(header);

    if (isExpanded && totalMatches > 0) {
        const children = document.createElement('div');
        children.className = 'tree-children';

        window.KEYWORDS.forEach(k => {
            const cnt = doc.counts[k] || 0;
            if (cnt > 0) {
                const child = document.createElement('div');
                child.className = 'tree-child';
                child.onclick = () => {
                    if (doc.url === window.currentDocUrl) {
                        const type = doc.type;
                        if (type === 'pdf') {
                            window.cycleSearch(k);
                        } else {
                            window.cycleDocSearch(k);
                        }
                    } else {
                        window.loadDocument(doc.url, k);
                    }
                };

                const kw = document.createElement('span');
                kw.className = 'tree-child-kw';
                kw.textContent = k;
                child.appendChild(kw);
                
                const c = document.createElement('span');
                c.className = 'tree-child-count';
                c.textContent = cnt;
                child.appendChild(c);
                
                children.appendChild(child);
            }
        });
        
        item.appendChild(children);
    }
    
    return item;
};

window.renderResultsArea = function() {
    resultsArea.innerHTML = '';
    resultsArea.className = 'results-area' + (window.currentLayout === 'tree' ? ' tree-mode' : '');
    
    if (window.currentLayout === 'tree') {
        const docs = Object.values(window.docDataCache);
        
        const folders = {};
        docs.forEach(doc => {
            const folder = doc.folder || '';
            if (!folders[folder]) {
                folders[folder] = [];
            }
            folders[folder].push(doc);
        });
        
        const sortedFolders = Object.keys(folders).sort((a, b) => {
            if (a === '') return 1;
            if (b === '') return -1;
            return a.localeCompare(b);
        });
        sortedFolders.forEach(folder => {
            const folderDocs = folders[folder];
            
            if (!folder) {
                const header = document.createElement('div');
                header.className = 'tree-folder-header';
                header.textContent = 'Files in root';
                resultsArea.appendChild(header);
            } else {
                const header = document.createElement('div');
                header.className = 'tree-folder-header';
                header.textContent = folder;
                resultsArea.appendChild(header);
            }

            folderDocs.sort((a, b) => a.name.localeCompare(b.name)).forEach(doc => {
                resultsArea.appendChild(window.renderTreeItem(doc));
            });
        });
        
        if (docs.length === 0) {
            resultsArea.innerHTML = '<h1 class="status-msg">&#10548;</h1><h1 class="status-msg">Drop a folder to begin scanning</h1>';
        }
    } else {
        const docs = Object.values(window.docDataCache);
        docs.forEach(doc => {
            const isActive = doc.url === window.currentDocUrl;
            const type = window.getFileType(doc.name);
            if (Object.keys(doc.counts).length > 0) {
                const card = document.createElement('div');
                card.className = 'doc-card' + (isActive ? ' active' : '');
                card.dataset.url = doc.url;
                card.dataset.type = type;
                card.onclick = () => { window.setActiveCard(card); window.loadDocument(doc.url); window.closeMobileSidebar(); };
                card.innerHTML = `<div class="doc-name">${window.getFileIcon(doc.name)} ${doc.name}</div>`;

                const grid = document.createElement('div');
                grid.className = 'badge-grid';

                window.KEYWORDS.forEach(k => {
                    const count = doc.counts[k] || 0;
                    if (count > 0) {
                        const b = document.createElement('div');
                        b.className = 'badge';
                        b.dataset.keyword = k;
                        b.dataset.count = count;
                        b.textContent = `${k}: ${count}`;
                        b.onclick = (e) => {
                            e.stopPropagation();
                            window.setActiveCard(card);
                            window.closeMobileSidebar();
                            if (window.currentDocUrl === doc.url) {
                                if (type === 'pdf') {
                                    window.cycleSearch(k);
                                } else {
                                    window.cycleDocSearch(k);
                                }
                            } else {
                                window.loadDocument(doc.url, k);
                            }
                        };
                        grid.appendChild(b);
                    }
                });
                card.appendChild(grid);
                resultsArea.appendChild(card);
            } else {
                const card = document.createElement('div');
                card.className = 'doc-card doc-card-minimal';
                card.dataset.url = doc.url;
                card.dataset.type = type;
                card.onclick = () => { window.setActiveCard(card); window.loadDocument(doc.url); window.closeMobileSidebar(); };
                card.innerHTML = `<div class="doc-name">${window.getFileIcon(doc.name)} ${doc.name}</div>`;
                resultsArea.appendChild(card);
            }
        });
        
        if (docs.length === 0) {
            resultsArea.innerHTML = '<h1 class="status-msg">&#10548;</h1><h1 class="status-msg">Drop a folder to begin scanning</h1>';
        }
    }
};

window.setActiveCard = function(card) {
    document.querySelectorAll('.doc-card').forEach(c => c.classList.remove('active'));
    card.classList.add('active');
};

window.setActiveCardFromUrl = function(url) {
    document.querySelectorAll('.doc-card').forEach(c => c.classList.remove('active'));
    const card = document.querySelector(`.doc-card[data-url="${url}"]`);
    if (card) card.classList.add('active');
    
    document.querySelectorAll('.tree-item').forEach(item => {
        const header = item.querySelector('.tree-header');
        if (header) header.classList.remove('active');
    });
    const treeItem = [...document.querySelectorAll('.tree-item')].find(item => {
        return item.querySelector('.tree-name').textContent === window.docDataCache[url]?.name;
    });
    if (treeItem) {
        treeItem.querySelector('.tree-header').classList.add('active');
    }

    if (window.currentLayout === 'tree') {
        window.expandedTreeItems.clear();
        window.expandedTreeItems.add(url);
    }
};

// ========== NAVIGATION / ZOOM ==========

window.zoomIn = function() { window.setZoom(window.currentScale + 0.15); };
window.zoomOut = function() { window.setZoom(window.currentScale - 0.15); };

window.zoomFit = function() {
    if (!window.pdfDoc || window.totalPages === 0) return;
    window.pdfDoc.getPage(1).then(page => {
        const viewport = page.getViewport({ scale: 1.0 });
        const containerWidth = viewerScroll.clientWidth - 32;
        const fitScale = Math.max(0.5, Math.min(4.0, containerWidth / viewport.width));
        window.setZoom(fitScale);
    });
};

window.zoomActual = function() {
    window.setZoom(1.0, true);
};

window.scheduleHighResRender = function() {
    if (window.zoomRenderTask) {
        window.zoomRenderTask.cancelled = true;
    }

    const task = { cancelled: false };
    window.zoomRenderTask = task;

    const visiblePages = window.getVisiblePages();
    
    async function renderHighRes() {
        if (task.cancelled) return;
        
        for (const pageNum of visiblePages) {
            if (task.cancelled) return;
            
            const currentScale = window.renderedScales[pageNum] || 1.0;
            if (currentScale < 2.0) {
                await window.renderPageNow(pageNum, 2.0);
            }
            
            await new Promise(r => requestAnimationFrame(r));
        }
    }

    requestAnimationFrame(renderHighRes);
};

window.getVisiblePages = function() {
    const scrollTop = viewerScroll.scrollTop;
    const containerHeight = viewerScroll.clientHeight;
    const viewStart = scrollTop - 200;
    const viewEnd = scrollTop + containerHeight + 200;

    const visible = [];
    let offsetY = 0;

    for (let i = 1; i <= window.totalPages; i++) {
        const h = (window.pageHeights[i] || 800) * window.currentScale;
        const pageTop = offsetY;
        const pageBottom = offsetY + h;
        offsetY += h + 32;

        if (pageBottom > viewStart && pageTop < viewEnd) {
            visible.push(i);
        }
    }

    return visible;
};

window.clearHighResRenders = function() {
    for (const pageNum of Object.keys(window.renderedScales)) {
        window.renderedScales[pageNum] = 0;
    }
    
    document.querySelectorAll('.pdf-page').forEach(el => {
        el.innerHTML = '';
        const pageNum = parseInt(el.dataset.pageNum);
        const h = window.pageHeights[pageNum] || 800;
        const cached = window.textPageCache[pageNum];
        const w = cached ? cached.viewport.width : 600;
        const placeholder = document.createElement('div');
        placeholder.className = 'page-placeholder';
        placeholder.id = 'page-' + pageNum;
        placeholder.dataset.pageNum = pageNum;
        placeholder.style.width = w + 'px';
        placeholder.style.height = h + 'px';
        placeholder.textContent = `Page ${pageNum}`;
        el.appendChild(placeholder);
    });
    
    if (window.pageObserver) {
        window.pageObserver.disconnect();
        window.setupPageObserver();
    }
};

window.updateZoomDisplay = function() {
    zoomLevelEl.textContent = Math.round(window.currentScale * 100) + '%';
};

window.prevPage = function() {
    if (window.currentPage > 1) {
        window.currentPage--;
        window.scrollToPage(window.currentPage);
    }
};

window.nextPage = function() {
    if (window.currentPage < window.totalPages) {
        window.currentPage++;
        window.scrollToPage(window.currentPage);
    }
};

window.scrollToPage = function(pageNum) {
    const pageEl = document.getElementById('page-' + pageNum);
    let targetOffset = 0;
    if (pageEl) {
        targetOffset = pageEl.offsetTop;
    } else {
        for (let i = 1; i < pageNum; i++) {
            targetOffset += (window.pageHeights[i] * window.currentScale || 800) + 32;
        }
    }
    const behavior = window.smoothScrollEnabled && !window.isNavigating ? 'smooth' : 'auto';
    window.isNavigating = true;
    viewerScroll.scrollTo({ top: targetOffset, behavior: behavior });
    window.currentPage = pageNum;
    window.updatePageInfo();
    setTimeout(() => { window.isNavigating = false; }, 100);
};

window.updatePageInfo = function() {
    pageInput.value = window.currentPage;
    pageInput.placeholder = window.totalPages > 0 ? window.currentPage : '0';
};

window.goToMatch = function(index) {
    if (window.searchResults.length === 0) return;

    window.currentMatchIndex = ((index % window.searchResults.length) + window.searchResults.length) % window.searchResults.length;
    matchInput.value = window.currentMatchIndex + 1;
    window.updateSidebarBadge();
    window.updateHeatmap();

    const result = window.searchResults[window.currentMatchIndex];

    window.renderPageNow(result.page).then(() => {
        const pageEl = document.getElementById('page-' + result.page);
        if (pageEl) {
            const targetTop = pageEl.offsetTop + result.y * window.currentScale - (viewerScroll.clientHeight / 2);
            const behavior = window.smoothScrollEnabled ? 'smooth' : 'auto';
            viewerScroll.scrollTo({ top: Math.max(0, targetTop), behavior: behavior });
        }

        window.clearHighlights();
        window.renderAllHighlights();
        window.updateHeatmap();
    });

    window.startPrerender();
};

window.findNext = function() {
    if (window.currentDocType === 'pdf' && window.searchResults.length > 0) {
        window.goToMatch(window.currentMatchIndex + 1);
    } else if (window.docSearchResults.length > 0) {
        window.goToDocMatch(window.docCurrentMatchIndex + 1);
    }
};

window.findPrev = function() {
    if (window.currentDocType === 'pdf' && window.searchResults.length > 0) {
        window.goToMatch(window.currentMatchIndex - 1);
    } else if (window.docSearchResults.length > 0) {
        window.goToDocMatch(window.docCurrentMatchIndex - 1);
    }
};

// ========== TOUCH ZOOM ==========

window.getTouchDist = function(e) {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
};

// ========== UPDATE FUNCTIONS ==========

window.updateStats = function() {
    if (window.totalMatchesFound > 0) {
        statusBar.textContent = `${window.totalMatchesFound} matches across ${window.totalDocsFound} document${window.totalDocsFound !== 1 ? 's' : ''}`;
    } else if (window.totalDocsFound > 0) {
        statusBar.textContent = `${window.totalDocsFound} document${window.totalDocsFound !== 1 ? 's' : ''} scanned`;
    }
};

window.updateSidebarBadge = function() {
    const badges = document.querySelectorAll('.badge');
    badges.forEach(badge => {
        const k = badge.dataset.keyword;
        const total = parseInt(badge.dataset.count) || 0;
        const cardUrl = badge.closest('.doc-card').dataset.url || '';
        
        const isCurrentFile = cardUrl === window.currentDocUrl;
        const isActiveKeyword = k === window.activeKeyword;
        
        if (isCurrentFile && isActiveKeyword && window.currentMatchIndex >= 0) {
            const current = window.currentMatchIndex + 1;
            const minWidth = Math.max(2, total.toString().length);
            const currentStr = current.toString().padStart(minWidth, ' ');
            const totalStr = total.toString().padStart(minWidth, ' ');
            badge.textContent = `${k}: ${currentStr}/${totalStr}`;
        } else {
            const minWidth = Math.max(2, total.toString().length);
            const totalStr = total.toString().padStart(minWidth, ' ');
            badge.textContent = `${k}: ${totalStr}`;
        }
    });
};

window.updateProgressMainThread = function() {
    window.processed++;
    progressBar.style.width = `${Math.round((window.processed / window.totalFiles) * 100)}%`;
    
    if (window.processed === window.totalFiles) {
        window.renderResultsArea();
        if (window.totalMatchesFound === 0) {
            statusBar.textContent = "No matches found";
        } else {
            statusBar.textContent = `${window.totalMatchesFound} matches across ${window.totalDocsFound} document${window.totalDocsFound !== 1 ? 's' : ''}`;
        }
    }
};

// ========== EVENT LISTENERS ==========

window.setupEventListeners = function() {
    window.addEventListener('resize', window.checkMobileLayout);
    document.addEventListener('DOMContentLoaded', window.checkMobileLayout);

    viewerScroll.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
            window.touchStartDist = window.getTouchDist(e);
            window.touchStartScale = window.currentScale;
        }
    }, { passive: true });

    viewerScroll.addEventListener('touchmove', (e) => {
        if (e.touches.length === 2) {
            e.preventDefault();
            const dist = window.getTouchDist(e);
            const ratio = dist / window.touchStartDist;
            const newScale = Math.max(0.5, Math.min(4.0, window.touchStartScale * ratio));
            if (Math.abs(newScale - window.currentScale) > 0.01) {
                window.setZoom(newScale);
            }
        }
    }, { passive: false });

    const savedSmooth = localStorage.getItem('pdf_smooth_scroll');
    if (savedSmooth !== null) {
        window.smoothScrollEnabled = savedSmooth === 'true';
    }

    viewerScroll.addEventListener('wheel', (e) => {
        if (e.ctrlKey) {
            e.preventDefault();
            const delta = e.deltaY > 0 ? -0.1 : 0.1;
            window.setZoom(window.currentScale + delta);
        }
    }, { passive: false });

    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && (e.key === '+' || e.key === '=')) {
            e.preventDefault();
            window.zoomIn();
        }
        if (e.ctrlKey && e.key === '-') {
            e.preventDefault();
            window.zoomOut();
        }
        if (e.ctrlKey && e.key === 'f') {
            e.preventDefault();
            window.showSearchOverlay();
        }
        if (e.key === 'F3' && !e.shiftKey) {
            e.preventDefault();
            window.showSearchOverlay();
        }
        if (e.key === 'F3' && e.shiftKey) {
            e.preventDefault();
            if (searchOverlay && searchOverlay.classList.contains('visible')) {
                window.customFindPrev();
            }
        }
        if (e.key === 'g' && !e.ctrlKey && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
            e.preventDefault();
            pageInput.focus();
            pageInput.select();
        }
        if (e.key === 'Escape') {
            pageInput.blur();
            matchInput.blur();
            window.closeMobileSidebar();
            window.closeSearchOverlay();
        }
    });

    pageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const num = parseInt(pageInput.value);
            if (num >= 1 && num <= window.totalPages) {
                window.scrollToPage(num);
                pageInput.blur();
            }
        }
    });

    pageInput.addEventListener('blur', () => {
        pageInput.value = window.currentPage;
    });

    matchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const num = parseInt(matchInput.value);
            if (num >= 1 && num <= window.searchResults.length) {
                window.goToMatch(num - 1);
                matchInput.blur();
            }
        }
    });

    matchInput.addEventListener('blur', () => {
        matchInput.value = window.currentMatchIndex + 1;
    });

    keywordSelect.addEventListener('change', () => {
        if (keywordSelect.value) {
            if (window.currentDocType === 'pdf') {
                window.performSearch(keywordSelect.value);
            } else {
                window.performDocSearch(keywordSelect.value);
            }
        }
    });

    viewerScroll.addEventListener('scroll', () => {
        if (!viewer.children.length) return;
        if (window.isNavigating) return;

        const scrollTop = viewerScroll.scrollTop;
        const containerHeight = viewerScroll.clientHeight;
        const scrollHeight = viewerScroll.scrollHeight;

        const midPoint = scrollTop + containerHeight / 2;

        let detectedPage = null;
        for (let i = 1; i <= window.totalPages; i++) {
            const pageEl = document.getElementById('page-' + i);
            if (!pageEl) continue;

            const pageTop = pageEl.offsetTop;
            const pageBottom = pageTop + pageEl.offsetHeight;

            if (midPoint < pageBottom) {
                detectedPage = i;
                break;
            }
        }

        if (!detectedPage && scrollTop + containerHeight >= scrollHeight - 50) {
            detectedPage = window.totalPages;
        }

        if (detectedPage && detectedPage !== window.currentPage) {
            window.currentPage = detectedPage;
            window.updatePageInfo();
        }

        if (window.searchResults.length > 0) {
            window.updateHeatmap();
        }
    });

    (function() {
        const resizer = document.getElementById("resizer");
        const sidebarEl = document.getElementById("sidebar");
        resizer.addEventListener("mousedown", (e) => {
            e.preventDefault();
            document.body.classList.add("dragging");
            const startX = e.clientX;
            const startWidth = sidebarEl.offsetWidth;
            const onMove = (e) => {
                const width = startWidth + (e.clientX - startX);
                if (width > 150 && width < 900) {
                    sidebarEl.style.width = width + "px";
                    sidebarEl.style.flexBasis = width + "px";
                }
            };
            const onUp = () => {
                document.body.classList.remove("dragging");
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
            };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
        });
    })();

    const viewerContainer = document.querySelector('.viewer-container');
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(name => {
        viewerContainer.addEventListener(name, (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (name === 'dragover') viewerContainer.style.background = "var(--grey-700)";
            if (name === 'dragleave' || name === 'drop') viewerContainer.style.background = "";
        }, false);
    });
    
    viewerContainer.addEventListener('drop', (e) => {
        console.log('viewerContainer drop event');
        window.handleDrop(e);
    });

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(name => {
        sidebar.addEventListener(name, (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (name === 'dragenter') {
                sidebar.classList.add('drag-over');
            }
            if ((name === 'dragleave' && !sidebar.contains(e.relatedTarget)) || name === 'drop') {
                sidebar.classList.remove('drag-over');
            }
        }, false);
    });
};

// ========== INIT ==========

(function initTheme() {
    const savedTheme = localStorage.getItem('pdf_theme');
    if (savedTheme === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
    }
})();

window.touchStartDist = 0;
window.touchStartScale = 1.0;
window.pageObserver = null;
window.renderPageDebounce = null;
window.bgRenderRunning = false;
window.bgRenderQueue = [];
window.zoomRenderTask = null;