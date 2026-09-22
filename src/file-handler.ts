import { state } from './state';
import * as dom from './dom';
import { getKeywordRegex, normalizeKeywordMatch } from './keyword-regex';
import { processTextContentAsync } from './pdf-search';
import { fn, pdfjsLib, JSZip, mammoth, KEYWORDS } from './cross';

export function getFileType(filename) {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.pdf')) return 'pdf';
    if (lower.endsWith('.docx')) return 'docx';
    if (lower.endsWith('.doc')) return 'doc';
    if (lower.endsWith('.zip')) return 'zip';
    return null;
}

export function getFileIcon(filename) {
    const type = getFileType(filename);
    if (type === 'pdf') return '<img src="icons/pdf.svg" width="18" height="18" alt="pdf">';
    if (type === 'docx' || type === 'doc') return '<img src="icons/docx.svg" width="18" height="18" alt="docx">';
    if (type === 'zip') return '<img src="icons/zip.svg" width="18" height="18" alt="zip">';
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="#757575"><path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20Z"/></svg>';
}

import { WorkerPool } from './worker-pool';

export function initWorkerPool() {
    if (!state.workerPool) {
        state.workerPool = new WorkerPool();
        state.workerPool.init();
    }
}

function truncateFileName(name, maxLen) {
    if (name.length <= maxLen) return name;
    return name.slice(0, maxLen - 2) + '..';
}

function startVerboseStatus(fileName) {
    const nameWithoutExt = fileName.replace(/\.(pdf|docx?)$/i, '');
    const shortName = truncateFileName(nameWithoutExt, 20);
    dom.statusBar.textContent = 'Scanning ' + shortName + '..';
}

function stopVerboseStatus() {}


function updateProgressMainThread() {
    state.processed++;
    const pct = state.totalFiles > 0 ? Math.round((state.processed / state.totalFiles) * 100) : 0;
    dom.progressBar.style.width = pct + '%';
}

function showFileError(fileName, message) {
    dom.statusBar.textContent = 'Error: ' + message;
    console.warn('[File]', fileName, '-', message);
}

export function evictCaches() {
    const allEntries = [];

    Object.entries(state.docTextCache).forEach(([key, entry]) => {
        if (key !== state.currentDocUrl) allEntries.push({ key, entry, cacheType: 'pdf' });
    });
    Object.entries(state.docContentCache).forEach(([key, entry]) => {
        if (key !== state.currentDocUrl) allEntries.push({ key, entry, cacheType: 'docx' });
    });

    allEntries.sort((a, b) => a.entry._lastAccess - b.entry._lastAccess);

    for (const { key, entry, cacheType } of allEntries) {
        const pdfCount = Object.keys(state.docTextCache).length;
        const docxCount = Object.keys(state.docContentCache).length;
        const countOk = pdfCount <= state.MAX_CACHE_COUNT_PER_TYPE && docxCount <= state.MAX_CACHE_COUNT_PER_TYPE;
        const sizeOk = state.totalCacheSize <= state.MAX_CACHE_SIZE_TOTAL;
        if (countOk && sizeOk) break;

        if (cacheType === 'pdf') delete state.docTextCache[key];
        if (cacheType === 'docx') delete state.docContentCache[key];
        state.totalCacheSize -= (entry._size || 0);
    }
}

export async function extractPdfText(arrayBuffer, fileName, id, file) {
    try {
        const fakeDoc = {
            createElement: name => name === 'canvas' ? new OffscreenCanvas(1, 1) : null,
            fonts: {}
        };

        const pdfData = new Uint8Array(arrayBuffer);
        const pdf = await pdfjsLib.getDocument({ data: pdfData, ownerDocument: fakeDoc }).promise;
        const numPages = pdf.numPages;
        const pageTextData = [];

        for (let p = 1; p <= numPages; p++) {
            const page = await pdf.getPage(p);
            const content = await page.getTextContent();
            const vp = page.getViewport({ scale: 1.0 });
            const { text, items } = await processTextContentAsync(content);
            pageTextData.push({
                text,
                viewport: {
                    width: vp.width,
                    height: vp.height,
                    offsetX: vp.offsetX,
                    offsetY: vp.offsetY,
                    transform: vp.transform,
                    rotation: vp.rotation
                },
                items
            });
            if (numPages > 1) dom.statusBar.textContent = 'Extracting pages: ' + p + '/' + numPages;
        }

        const keywords = KEYWORDS || [];
        const combinedRegex = getKeywordRegex(keywords);
        const counts = {};
        let totalMatches = 0;

        if (combinedRegex) {
            for (const pageData of pageTextData) {
                const text = pageData.text || '';
                let match;
                const regex = new RegExp(combinedRegex.source, 'gi');
                while ((match = regex.exec(text)) !== null) {
                    const key = normalizeKeywordMatch(match, keywords);
                    if (!key) continue;
                    counts[key] = (counts[key] || 0) + 1;
                    totalMatches++;
                }
            }
        }

        const pdfCacheEntry = {
            totalPages: numPages,
            pages: pageTextData,
            fileName,
            _lastAccess: Date.now(),
            _size: JSON.stringify(pageTextData).length + fileName.length
        };
        state.docTextCache[id] = pdfCacheEntry;
        state.totalCacheSize += pdfCacheEntry._size;
        evictCaches();
        state.totalDocsFound++;

        fn.renderCard(fileName, counts, id, file);
        state.totalMatchesFound += totalMatches;
        state.emit('stats-changed');

        return pdfCacheEntry;
    } catch (err) {
        showFileError(fileName, 'Failed to extract PDF text: ' + (err.message || err));
    }
}

export async function extractDocText(arrayBuffer, fileName, id, file) {
    try {
        const type = getFileType(fileName);
        let htmlContent = '';
        let plainText = '';

        if (type === 'docx' || type === 'doc') {
            const htmlResult = await mammoth.convertToHtml({ arrayBuffer });
            htmlContent = htmlResult.value;
            const textResult = await mammoth.extractRawText({ arrayBuffer });
            plainText = textResult.value.replace(/\s+/g, ' ').trim();
        }

        if (!plainText && !htmlContent) {
            showFileError(fileName, 'No extractable text found');
            updateProgressMainThread();
            return;
        }

        const keywords = KEYWORDS || [];
        const combinedRegex = getKeywordRegex(keywords);
        const counts = {};
        let totalMatches = 0;
        let match;

        if (combinedRegex) {
            const regex = new RegExp(combinedRegex.source, 'gi');
            while ((match = regex.exec(plainText)) !== null) {
                const key = normalizeKeywordMatch(match, keywords);
                if (!key) continue;
                counts[key] = (counts[key] || 0) + 1;
                totalMatches++;
            }
        }

        const docxCacheEntry = {
            html: htmlContent,
            text: plainText,
            fileName,
            type,
            _lastAccess: Date.now(),
            _size: JSON.stringify({ html: htmlContent, text: plainText }).length + fileName.length
        };
        state.docContentCache[id] = docxCacheEntry;
        state.totalCacheSize += docxCacheEntry._size;
        evictCaches();
        state.totalDocsFound++;

        fn.renderCard(fileName, counts, id, file);
        state.totalMatchesFound += totalMatches;
        state.emit('stats-changed');

        return docxCacheEntry;
    } catch (err) {
        showFileError(fileName, 'Failed to extract document text: ' + (err.message || err));
    }
}

async function processFiles(files) {
    if (files.length === 0) return;

    const viewerMsg = document.getElementById('viewerDropMsg');
    if (viewerMsg) viewerMsg.style.display = 'none';

    const statusMsgs = dom.resultsArea.querySelectorAll('.status-msg');
    statusMsgs.forEach(el => el.remove());

    if (files.length === 1) {
        // ── Single file: render immediately, search async inside loadDocument ──
        const file = files[0];
        const sizeLimit = getFileType(file.name) === 'pdf' ? state.MAX_FILE_SIZE : state.MAX_DOC_FILE_SIZE;
        if (file.size > sizeLimit) {
            showFileError(file.name, 'Skipped (' + (file.size / 1024 / 1024).toFixed(1) + ' MB exceeds limit)');
            return;
        }

        dom.progressBar.style.width = '0%';
        state.processed = 0;
        state.totalFiles = 1;

        const url = URL.createObjectURL(file);
        state.objectUrls.push(url);

        fn.renderPlaceholderCard(file.name, url, file);

        // Load & render immediately — text extraction + keyword search happen inside loadPDF/loadDocxDoc
        fn.loadDocument(url);

        state.processed = 1;
        state.emit('stats-changed');
        return;
    }

    // ── Multiple files: existing batch behavior ──
    dom.progressBar.style.width = '0%';

    state.processed = 0;
    state.totalFiles = Math.min(files.length, state.MAX_TOTAL_FILES);
    let failedCount = 0;

    for (let i = 0; i < state.totalFiles; i++) {
        const file = files[i];
        const sizeLimit = getFileType(file.name) === 'pdf' ? state.MAX_FILE_SIZE : state.MAX_DOC_FILE_SIZE;
        if (file.size > sizeLimit) {
            showFileError(file.name, 'Skipped (' + (file.size / 1024 / 1024).toFixed(1) + ' MB exceeds limit)');
            updateProgressMainThread();
            state.emit('stats-changed');
            continue;
        }

        const url = URL.createObjectURL(file);
        state.objectUrls.push(url);

        startVerboseStatus(file.name);

        fn.renderPlaceholderCard(file.name, url, file);

        let success = false;
        try {
            const arrayBuffer = file._cachedBuffer || await file.arrayBuffer();
            const type = getFileType(file.name);

            if (type === 'pdf') {
                await extractPdfText(arrayBuffer, file.name, url, file);
                success = !!state.docTextCache[url];
            } else if (type === 'docx' || type === 'doc') {
                await extractDocText(arrayBuffer, file.name, url, file);
                success = !!state.docContentCache[url];
            }
        } catch (err) {
            showFileError(file.name, err.message || err);
        } finally {
            if (!success) {
                const idx = state.objectUrls.indexOf(url);
                if (idx !== -1) state.objectUrls.splice(idx, 1);
                URL.revokeObjectURL(url);
                failedCount++;
            }
            stopVerboseStatus();
            updateProgressMainThread();
            state.emit('stats-changed');
        }
    }

    if (failedCount > 0) {
        dom.statusBar.textContent = failedCount + ' file(s) failed to process';
    }
}

export async function handleDrop(e) {
    try {
        const entries = [];
        if (e.dataTransfer.items) {
            for (let i = 0; i < e.dataTransfer.items.length; i++) {
                const entry = e.dataTransfer.items[i].webkitGetAsEntry();
                if (entry) entries.push(entry);
            }
        }
        state.basePath = '';
        let filesToProcess = [];

        const viewerMsg = document.getElementById('viewerDropMsg');
        if (viewerMsg) viewerMsg.style.display = 'none';
        const statusMsgs = dom.resultsArea.querySelectorAll('.status-msg');
        statusMsgs.forEach(el => el.remove());

        for (const entry of entries) {
            if (entry.isFile && entry.name.toLowerCase().endsWith('.zip')) {
                dom.statusBar.textContent = 'Unzipping ' + entry.name + '...';
                dom.progressBar.style.width = '0%';
                try {
                    const zipFile = await new Promise((resolve, reject) => {
                        entry.file(resolve, reject);
                    });
                    state.basePath = (zipFile as any).name.replace(/\.zip$/i, '');
                    filesToProcess = filesToProcess.concat(await extractAllFromZip(zipFile));
                } catch (err) {
                    showFileError(entry.name, 'Failed to read zip file: ' + (err.message || err));
                }
            } else {
                dom.statusBar.textContent = 'Reading folder "' + entry.name + '"...';
                dom.progressBar.style.width = '0%';
                try {
                    await traverseFileTree(entry, filesToProcess, '');
                    state.basePath = entry.name;
                } catch (err) {
                    showFileError(entry.name, 'Failed to read folder: ' + (err.message || err));
                }
            }
        }

        if (filesToProcess.length === 0) {
            dom.statusBar.textContent = 'No supported files found';
            dom.progressBar.style.width = '0%';
        } else {
            processFiles(filesToProcess);
        }
    } catch (err) {
        showFileError('(drop)', 'Failed to process dropped files: ' + (err.message || err));
    }
}

async function traverseFileTree(item, fileList, baseDir = '') {
    const currentPath = baseDir ? baseDir + '/' + item.name : item.name;
    const type = getFileType(item.name);
    if (item.isFile && type) {
        try {
            const file = await new Promise((resolve, reject) => {
                item.file(resolve, reject);
            });
			(file as any).relativePath = currentPath;
			fileList.push(file);
		} catch (err) {
			showFileError(currentPath, 'Failed to read file: ' + (err.message || err));
			return;
		}
        if (fileList.length % 10 === 0) {
            dom.statusBar.textContent = 'Reading folder: found ' + fileList.length + ' files...';
        }
    } else if (item.isDirectory) {
        let entries = [];
        try {
            const dirReader = item.createDirectoryReader ? item.createDirectoryReader() : item.createReader();
            while (true) {
                const batch: any[] = await new Promise((resolve) => dirReader.readEntries(resolve));
                if (batch.length === 0) break;
                entries.push(...batch);
            }
        } catch (err) {
            showFileError(currentPath, 'Failed to read directory: ' + (err.message || err));
            return;
        }
        for (const entry of entries) await traverseFileTree(entry, fileList, currentPath);
    }
}

async function extractAllFromZip(zipFile) {
    if (zipFile.size > state.MAX_ZIP_FILE_SIZE) {
        showFileError(zipFile.name, 'ZIP too large (' + (zipFile.size / 1024 / 1024).toFixed(1) + ' MB)');
        return [];
    }

    const sizeMB = (zipFile.size / (1024 * 1024)).toFixed(1);
    dom.statusBar.textContent = sizeMB + ' MB - Unzipping ' + zipFile.name + '...';

    let zip;
    try {
        zip = await JSZip.loadAsync(zipFile);
    } catch (err) {
        showFileError(zipFile.name, 'Failed to open ZIP: ' + (err.message || err));
        return [];
    }

    const entries = [];
    zip.forEach((path, entry) => {
        if (!entry.dir && getFileType(path)) entries.push({ path, entry });
    });

    entries.sort((a, b) => (a.entry._data && a.entry._data.uncompressedSize || 0) - (b.entry._data && b.entry._data.uncompressedSize || 0));

    const total = Math.min(entries.length, state.MAX_TOTAL_FILES);
    const concurrency = Math.min(navigator.hardwareConcurrency || 4, 8);
    const extracted = [];
    let done = 0;
    let zipErrors = 0;

    function updateProgress() {
        done++;
        const pct = Math.round((done / total) * 100);
        dom.statusBar.textContent = pct + '% - Unzipping ' + zipFile.name + ': ' + done + '/' + total + ' files';
        dom.progressBar.style.width = pct + '%';
    }

    for (let i = 0; i < total; i += concurrency) {
        const batch = entries.slice(i, i + concurrency);
        const results = await Promise.allSettled(batch.map(async ({ path, entry }) => {
            const blob = await entry.async('blob');
            return { blob, path, type: getFileType(path) };
        }));
        for (const result of results) {
            if (result.status === 'rejected') {
                zipErrors++;
                continue;
            }
            const { blob, path, type } = result.value;
            const sizeLimit = type === 'pdf' ? state.MAX_FILE_SIZE : state.MAX_DOC_FILE_SIZE;
            if (blob.size > sizeLimit) {
                updateProgress();
                continue;
            }
            let mimeType = 'application/pdf';
            if (type === 'docx') mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
            else if (type === 'doc') mimeType = 'application/msword';
            const file = new File([blob], path, { type: mimeType });
            (file as any).relativePath = path;
            try {
                (file as any)._cachedBuffer = await blob.arrayBuffer();
            } catch (err) {
                showFileError(path, 'Failed to read entry from ZIP: ' + (err.message || err));
                updateProgress();
                continue;
            }
            extracted.push(file);
            updateProgress();
        }
    }

    if (zipErrors > 0) {
        showFileError(zipFile.name, zipErrors + ' entry(s) failed to extract from ZIP');
    }

    return extracted;
}

export function initFileHandler() {
    dom.sidebar.addEventListener('drop', (e) => {
        e.preventDefault();
        handleDrop(e);
    });

    dom.folderInput.addEventListener('change', async (e) => {
        const viewerMsg = document.getElementById('viewerDropMsg');
        if (viewerMsg) viewerMsg.style.display = 'none';
        const statusMsgs = dom.resultsArea.querySelectorAll('.status-msg');
        statusMsgs.forEach(el => el.remove());

        let filesToProcess = [];
        const items = Array.from((e.target as HTMLInputElement).files || []);
        const hasZip = items.some(f => f.name.toLowerCase().endsWith('.zip'));
        const folderName = items.length > 0 ? ((items[0] as any).webkitRelativePath || '').split('/')[0] : '';

        if (hasZip) {
            dom.statusBar.textContent = 'Processing ZIP file...';
            dom.progressBar.style.width = '0%';
        } else if (folderName) {
            dom.statusBar.textContent = 'Reading folder "' + folderName + '"...';
            dom.progressBar.style.width = '0%';
        }

        for (const file of items) {
            const type = getFileType((file as any).name);
            if ((file as any).name.toLowerCase().endsWith('.zip')) {
                try {
                    filesToProcess = filesToProcess.concat(await extractAllFromZip(file));
                } catch (err) {
                    showFileError((file as any).name, 'Failed to process ZIP: ' + (err.message || err));
                }
            } else if (type) {
                (file as any).relativePath = (file as any).webkitRelativePath || (file as any).name;
                filesToProcess.push(file);
            }
        }

        if (filesToProcess.length === 0) {
            dom.statusBar.textContent = 'No supported files found';
            dom.progressBar.style.width = '0%';
        } else {
            processFiles(filesToProcess);
        }
    });
}

export async function rescanAllDocuments() {
    const viewerMsg = document.getElementById('viewerDropMsg');
    if (viewerMsg) viewerMsg.style.display = 'none';

    dom.statusBar.textContent = 'Scanning ' + state.objectUrls.length + ' documents...';
    dom.progressBar.style.width = '0%';

    dom.resultsArea.innerHTML = '';

    state.totalMatchesFound = 0;
    state.totalDocsFound = 0;
    state.processed = 0;
    state.totalFiles = state.objectUrls.length;

    initWorkerPool();
    const keywords = KEYWORDS || [];
    let failedCount = 0;

    for (let i = 0; i < state.objectUrls.length; i++) {
        const url = state.objectUrls[i];
        const pdfCached = state.docTextCache[url];

        if (pdfCached) {
            try {
                const result = await state.workerPool.runRegexOnPDFCache(
                    pdfCached.pages, pdfCached.fileName || url.split('/').pop(), keywords, url
                );

                const displayName = pdfCached.fileName || 'Document ' + (i + 1);
                state.totalDocsFound++;

                if (result.totalMatches > 0) {
                    fn.renderCard(displayName, result.counts, url);
                    state.totalMatchesFound += result.totalMatches;
                } else {
                    fn.renderNoMatchCard(displayName, url);
                }
            } catch (err) {
                const name = pdfCached.fileName || url.split('/').pop();
                showFileError(name, 'Rescan PDF worker error: ' + (err.message || err));
                failedCount++;
            }
        } else {
            const docCached = state.docContentCache[url];
            if (docCached) {
                try {
                    const result = await state.workerPool.runRegexOnText(
                        docCached.text, docCached.fileName || url.split('/').pop(), keywords, 'docx', url
                    );

                    const displayName = docCached.fileName || 'Document ' + (i + 1);
                    state.totalDocsFound++;

                    if (result.totalMatches > 0) {
                        fn.renderCard(displayName, result.counts, url);
                        state.totalMatchesFound += result.totalMatches;
                    } else {
                        fn.renderNoMatchCard(displayName, url);
                    }
                } catch (err) {
                    const name = docCached.fileName || url.split('/').pop();
                    showFileError(name, 'Rescan DOCX worker error: ' + (err.message || err));
                    failedCount++;
                }
            }
        }

        state.processed++;
        const pct = Math.round(((i + 1) / state.objectUrls.length) * 100);
        dom.progressBar.style.width = pct + '%';
    }

    state.emit('stats-changed');

    if (failedCount > 0) {
        dom.statusBar.textContent = failedCount + ' document(s) failed during rescan';
    } else if (state.totalMatchesFound === 0) {
        dom.statusBar.textContent = 'No matches found';
    } else {
        dom.statusBar.textContent = state.totalMatchesFound + ' matches across ' + state.totalDocsFound + ' document' + (state.totalDocsFound !== 1 ? 's' : '');
    }
}

export async function rescanWithNewKeywords() {
    if (!state.pdfDoc || !state.currentDocUrl) return;

    initWorkerPool();
    const keywords = KEYWORDS || [];

    let fullText = '';
    for (let p = 1; p <= state.totalPages; p++) {
        if (state.textPageCache[p] && state.textPageCache[p].text) {
            fullText += state.textPageCache[p].text;
        }
    }

    try {
        const result = await state.workerPool.runRegexOnText(fullText, 'current-document', keywords, 'pdf', state.currentDocUrl);

        const docCounts = result.counts || {};
        const totalMatches = result.totalMatches || 0;

        if (state.currentDocUrl && state.docDataCache[state.currentDocUrl]) {
            state.docDataCache[state.currentDocUrl].counts = docCounts;
        }

        state.totalMatchesFound = totalMatches;
        state.emit('stats-changed');
        fn.precomputeAllSearches();
        if (state.currentDocUrl) fn.updateKeywordGrid(state.currentDocUrl);
    } catch (err) {
        console.error('[Worker] Rescan with new keywords error:', err);
    }
}


