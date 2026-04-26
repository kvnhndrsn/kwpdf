// ========== FILE TYPE HELPERS ==========

window.getFileType = function(filename) {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.pdf')) return 'pdf';
    if (lower.endsWith('.docx')) return 'docx';
    if (lower.endsWith('.doc')) return 'doc';
    return null;
};

window.getFileIcon = function(filename) {
    const type = window.getFileType(filename);
    if (type === 'pdf') {
        return '<img src="icons/pdf.svg" width="18" height="18" alt="pdf">';
    }
    if (type === 'docx' || type === 'doc') {
        return '<img src="icons/docx.svg" width="18" height="18" alt="docx">';
    }
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="#757575"><path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20Z"/></svg>';
};

// ========== STATE ==========

window.objectUrls = [];
window.docTextCache = {};
window.docContentCache = {};
window.docDataCache = {};
window.basePath = '';
window.totalMatchesFound = 0;
window.totalDocsFound = 0;
window.processed = 0;
window.totalFiles = 0;

// ========== PROCESS FILES ==========

window.processFiles = async function(files) {
    if (files.length === 0) return;

    const viewerMsg = document.getElementById('viewerDropMsg');
    if (viewerMsg) viewerMsg.style.display = 'none';

    const statusMsgs = window.resultsArea.querySelectorAll('.status-msg');
    statusMsgs.forEach(el => el.remove());

    window.statusBar.textContent = `Scanning ${files.length} documents...`;
    window.progressBar.style.width = '0%';

    window.processed = 0;
    window.totalFiles = files.length;

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const url = URL.createObjectURL(file);
        window.objectUrls.push(url);

        const arrayBuffer = await file.arrayBuffer();
        const type = window.getFileType(file.name);

        if (type === 'pdf') {
            await window.extractPdfText(arrayBuffer, file.name, url, file);
        } else if (type === 'docx' || type === 'doc') {
            await window.extractDocText(arrayBuffer, file.name, url, file);
        }

        window.updateProgressMainThread();
    }
};

// ========== EXTRACT PDF TEXT ==========

window.extractPdfText = async function(arrayBuffer, fileName, id, file) {
    try {
        const fakeDoc = {
            createElement: name => name === 'canvas' ? new OffscreenCanvas(1, 1) : null,
            fonts: {}
        };
        
        const pdfData = new Uint8Array(arrayBuffer);
        
        console.log('[PDF] Using native text extraction for:', fileName);
        const pdf = await pdfjsLib.getDocument({ data: pdfData, ownerDocument: fakeDoc }).promise;
        const numPages = pdf.numPages;
        const pageTextData = [];
        
        for (let p = 1; p <= numPages; p++) {
            const page = await pdf.getPage(p);
            const content = await page.getTextContent();
            const vp = page.getViewport({ scale: 1.0 });
            
            let pageText = '';
            for (const item of content.items) {
                pageText += item.str;
            }
            const textItems = [];
            for (const item of content.items) {
                textItems.push({
                    text: item.str,
                    transform: item.transform,
                    width: item.width,
                    height: item.height
                });
            }
            pageTextData.push({ text: pageText, viewport: { width: vp.width, height: vp.height }, items: textItems });
        }
        
        const keywords = window.KEYWORDS || [];
        const combinedRegex = window.getKeywordRegex(keywords);
        const counts = {};
        let totalMatches = 0;

        if (combinedRegex) {
            for (const pageData of pageTextData) {
                const text = pageData.text || '';
                let match;
                const regex = new RegExp(combinedRegex.source, 'gi');
                while ((match = regex.exec(text)) !== null) {
                    if (match[0].length < 3) continue;
                    if (!/[a-zA-Z]/.test(match[0])) continue;
                    const lower = match[0].toLowerCase();
                    const key = keywords.find(k => k.toLowerCase() === lower) || lower;
                    counts[key] = (counts[key] || 0) + 1;
                    totalMatches++;
                }
            }
        }

        console.log('[PDF] Processed', fileName, '- Found', totalMatches, 'matches');

        window.docTextCache[id] = { totalPages: numPages, pages: pageTextData, fileName };
        window.totalDocsFound++;

        window.renderCard(fileName, counts, id, file);
        window.totalMatchesFound += totalMatches;
        window.updateStats();
    } catch (err) {
        console.error('[PDF] Error processing PDF:', err);
        window.updateProgressMainThread();
    }
};

// ========== EXTRACT DOC TEXT ==========

window.extractDocText = async function(arrayBuffer, fileName, id, file) {
    try {
        const type = window.getFileType(fileName);
        let htmlContent = '';
        let plainText = '';

        if (type === 'docx' || type === 'doc') {
            const htmlResult = await mammoth.convertToHtml({ arrayBuffer: arrayBuffer });
            htmlContent = htmlResult.value;
            const textResult = await mammoth.extractRawText({ arrayBuffer: arrayBuffer });
            plainText = textResult.value.replace(/\s+/g, ' ').trim();
        }

        if (!plainText && !htmlContent) {
            console.warn('[DOC] No text extracted from:', fileName);
            window.updateProgressMainThread();
            return;
        }

        const keywords = window.KEYWORDS || [];
        const combinedRegex = window.getKeywordRegex(keywords);
        const counts = {};
        let totalMatches = 0;
        let match;

        if (combinedRegex) {
            const regex = new RegExp(combinedRegex.source, 'gi');
            while ((match = regex.exec(plainText)) !== null) {
                if (match[0].length < 3) continue;
                if (!/[a-zA-Z]/.test(match[0])) continue;
                const lower = match[0].toLowerCase();
                const key = keywords.find(k => k.toLowerCase() === lower) || lower;
                counts[key] = (counts[key] || 0) + 1;
                totalMatches++;
            }
        }

        console.log('[DOC] Processed', fileName, '- Found', totalMatches, 'matches');

        window.docContentCache[id] = { html: htmlContent, text: plainText, fileName, type };
        window.totalDocsFound++;

        window.renderCard(fileName, counts, id, file);
        window.totalMatchesFound += totalMatches;
        window.updateStats();
    } catch (err) {
        console.error('[DOC] Error processing document:', err);
        window.updateProgressMainThread();
    }
};

// ========== DROP HANDLING ==========

window.handleDrop = async function(e) {
    const entries = [];
    if (e.dataTransfer.items) {
        for (let i = 0; i < e.dataTransfer.items.length; i++) {
            const entry = e.dataTransfer.items[i].webkitGetAsEntry();
            if (entry) entries.push(entry);
        }
    }
    window.basePath = '';
    let filesToProcess = [];
    for (const entry of entries) {
        if (entry.isFile && entry.name.toLowerCase().endsWith('.zip')) {
            const zipFile = await new Promise((resolve) => entry.file(resolve));
            window.basePath = zipFile.name.replace(/\.zip$/i, '');
            filesToProcess = filesToProcess.concat(await window.extractAllFromZip(zipFile));
        } else {
            await window.traverseFileTree(entry, filesToProcess, '');
            window.basePath = entry.name;
        }
    }

    if (filesToProcess.length === 0) {
        const viewerMsg = document.getElementById('viewerDropMsg');
        if (viewerMsg) viewerMsg.style.display = 'none';
        const statusMsgs = window.resultsArea.querySelectorAll('.status-msg');
        statusMsgs.forEach(el => el.remove());
        window.statusBar.textContent = 'No supported files found in folder';
        window.progressBar.style.width = '0%';
    } else {
        window.processFiles(filesToProcess);
    }
};

window.sidebar.addEventListener('drop', window.handleDrop);

// ========== TRAVERSE FILE TREE ==========

window.traverseFileTree = async function(item, fileList, baseDir = '') {
    const currentPath = baseDir ? baseDir + '/' + item.name : item.name;
    const type = window.getFileType(item.name);
    if (item.isFile && type) {
        const file = await new Promise((resolve) => item.file(resolve));
        file.relativePath = currentPath;
        fileList.push(file);
    } else if (item.isDirectory) {
        const dirReader = item.createReader();
        const entries = await new Promise((resolve) => dirReader.readEntries(resolve));
        for (const entry of entries) await window.traverseFileTree(entry, fileList, currentPath);
    }
};

// ========== FOLDER INPUT ==========

document.getElementById('folderInput').addEventListener('change', async (e) => {
    let filesToProcess = [];
    for (const file of e.target.files) {
        const type = window.getFileType(file.name);
        if (file.name.toLowerCase().endsWith('.zip')) {
            filesToProcess = filesToProcess.concat(await window.extractAllFromZip(file));
        } else if (type) {
            file.relativePath = file.webkitRelativePath || file.name;
            filesToProcess.push(file);
        }
    }
    window.processFiles(filesToProcess);
});

// ========== ZIP EXTRACTION ==========

window.extractAllFromZip = async function(zipFile) {
    const zip = await JSZip.loadAsync(zipFile);
    const extracted = [];
    const promises = [];
    zip.forEach((path, entry) => {
        if (!entry.dir) {
            const type = window.getFileType(path);
            if (type) {
                let mimeType = 'application/pdf';
                if (type === 'docx') mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
                else if (type === 'doc') mimeType = 'application/msword';
                promises.push(entry.async("blob").then(blob => {
                    const file = new File([blob], path, { type: mimeType });
                    file.relativePath = path;
                    extracted.push(file);
                }));
            }
        }
    });
    await Promise.all(promises);
    return extracted;
};

// ========== RESCAN ==========

window.rescanAllDocuments = async function() {
    console.log('[PDF] rescanAllDocuments called');
    
    const viewerMsg = document.getElementById('viewerDropMsg');
    if (viewerMsg) viewerMsg.style.display = 'none';
    
    window.statusBar.textContent = `Scanning ${window.objectUrls.length} documents...`;
    window.progressBar.style.width = '0%';
    
    window.resultsArea.innerHTML = '';
    
    window.totalMatchesFound = 0;
    window.totalDocsFound = 0;
    
    const combinedRegex = window.getKeywordRegex(window.KEYWORDS);
    
    for (let i = 0; i < window.objectUrls.length; i++) {
        const url = window.objectUrls[i];
        const cached = window.docTextCache[url];
        
        if (!cached) continue;
        
        const counts = {};
        let fileTotalMatches = 0;
        
        for (let p = 0; p < cached.pages.length; p++) {
            const text = cached.pages[p].text;
            let match;
            const regex = new RegExp(combinedRegex.source, 'gi');
            while ((match = regex.exec(text)) !== null) {
                if (match[0].length < 3) continue;
                if (!/[a-zA-Z]/.test(match[0])) continue;
                const lowerMatch = match[0].toLowerCase();
                const originalKey = window.KEYWORDS.find(k => k.toLowerCase() === lowerMatch) || lowerMatch;
                counts[originalKey] = (counts[originalKey] || 0) + 1;
                fileTotalMatches++;
            }
        }
        
        const fileName = cached.fileName || `Document ${i + 1}`;
        window.totalDocsFound++;
        
        if (fileTotalMatches > 0) {
            window.renderCard(fileName, counts, url);
            window.totalMatchesFound += fileTotalMatches;
        } else {
            window.renderNoMatchCard(fileName, url);
        }
        
        const pct = Math.round(((i + 1) / window.objectUrls.length) * 100);
        window.progressBar.style.width = pct + '%';
    }
    
    window.updateStats();
    
    if (window.totalMatchesFound === 0) {
        window.statusBar.textContent = "No matches found";
    } else {
        window.statusBar.textContent = `${window.totalMatchesFound} matches across ${window.totalDocsFound} document${window.totalDocsFound !== 1 ? 's' : ''}`;
    }
};

window.rescanWithNewKeywords = async function() {
    if (!window.pdfDoc || !window.currentDocUrl) return;

    const combinedRegex = window.getKeywordRegex(window.KEYWORDS);
    let totalMatches = 0;
    const docCounts = {};

    for (let pageNum = 1; pageNum <= window.totalPages; pageNum++) {
        const cached = window.textPageCache[pageNum];
        if (!cached) continue;
        const text = cached.text;
        let match;
        const regex = new RegExp(combinedRegex.source, 'gi');
        while ((match = regex.exec(text)) !== null) {
            if (match[0].length < 3) continue;
            if (!/[a-zA-Z]/.test(match[0])) continue;
            totalMatches++;
            const key = window.KEYWORDS.find(k => k.toLowerCase() === match[0].toLowerCase()) || match[0].toLowerCase();
            docCounts[key] = (docCounts[key] || 0) + 1;
        }
    }

    const activeCard = window.viewer.querySelector('.doc-card.active, .tree-header.active')?.closest('.doc-card') || window.viewer.querySelector('.doc-card.active');
    if (activeCard) {
        const cardName = activeCard.querySelector('.doc-name').textContent;
        const badgeGrid = activeCard.querySelector('.badge-grid');
        if (badgeGrid) {
            badgeGrid.innerHTML = '';
            window.KEYWORDS.forEach(k => {
                const count = docCounts[k] || 0;
                if (count > 0) {
                    const b = document.createElement('div');
                    b.className = 'badge';
                    b.textContent = `${k}: ${count}`;
                    b.onclick = (e) => {
                        e.stopPropagation();
                        window.cycleSearch(k);
                    };
                    badgeGrid.appendChild(b);
                }
            });
        }
    }

    window.totalMatchesFound = totalMatches;
    window.updateStats();
    window.precomputeAllSearches();
};
