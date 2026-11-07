import { state, dropCachedDocument } from './state';
import * as dom from './dom';
import { getKeywordRegex, normalizeKeywordMatch } from './keyword-regex';
import { processTextContentAsync } from './pdf-search';
import { estimatePagesSize, estimateTextEntrySize } from './cache-size';
import { fn, pdfjsLib, JSZip, mammoth, KEYWORDS, basePath } from './cross';
import { htmlToText } from './html-text';
import { cacheKey, readStoredText, storePdfText, storeDocxText } from './text-store';

/** Word 97-2003 `.doc` files are OLE2 compound files; OOXML `.docx` is a ZIP. */
const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0];

export const LEGACY_DOC_MESSAGE = "Legacy .doc isn't supported \u2014 save it as .docx";

/**
 * Batch extraction has nobody to ask for a password, so an encrypted PDF is
 * reported as skipped instead of as a broken file. The single-file path loads
 * through pdf-loader, which prompts.
 */
export const PASSWORD_PROTECTED_MESSAGE = 'Skipped (password-protected)';

export function isPasswordException(err) {
    return err?.name === 'PasswordException';
}

/** Encrypted files skipped in the batch scan currently running. */
let passwordSkipped = 0;

/**
 * Scans in flight. A counter rather than a flag: processing an archive calls
 * processFiles() again for a single-entry archive, so the inner run finishes
 * before the outer one does.
 */
let runningScans = 0;

/** True while a multi-file scan or a rescan is running (used to warn on unload). */
export function isScanRunning(): boolean {
    return runningScans > 0;
}

/**
 * Mammoth only reads OOXML. Sniffing the header catches the legacy format even
 * when it arrives as `report.doc` from a folder drop, before Mammoth is asked
 * to parse it and returns something generic.
 */
export function isLegacyDocFile(arrayBuffer) {
    if (!arrayBuffer || arrayBuffer.byteLength < OLE_SIGNATURE.length) return false;
    const bytes = new Uint8Array(arrayBuffer, 0, OLE_SIGNATURE.length);
    return OLE_SIGNATURE.every((b, i) => bytes[i] === b);
}

export function getFileType(filename) {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.pdf')) return 'pdf';
    if (lower.endsWith('.docx')) return 'docx';
    if (lower.endsWith('.doc')) return 'doc';
    if (lower.endsWith('.zip')) return 'zip';
    return null;
}

/**
 * Identity of a dropped file.
 *
 * The name alone is not enough (A/drawing.pdf and B/drawing.pdf are different
 * drawings) and a drop creates a fresh object URL every time, so the same file
 * dropped twice looked like a new document. Path plus size plus modification
 * time identifies it. The keys live on `docDataCache`, so clearing the library
 * resets this with it.
 */
export function fileDedupeKey(file): string {
    const path = file?.relativePath || file?.name || '';
    return path + '|' + (file?.size ?? '') + '|' + (file?.lastModified ?? '');
}

/** URL of the already-loaded document `file` duplicates, if there is one. */
export function findDuplicateUrl(file): string | null {
    const key = fileDedupeKey(file);
    for (const [url, doc] of Object.entries(state.docDataCache)) {
        if ((doc as any)?._dedupeKey === key) return url;
    }
    return null;
}

/**
 * Canonical document-type resolution for a document URL.
 *
 * pdf-loader.ts and docx-engine.ts each carried a copy of this with slightly
 * different rules. The cached entry knows its own type, then its file name
 * (blob URLs carry no extension), then the URL itself.
 */
export function getDocTypeFromUrl(url) {
    if (!url) return null;
    const dataCached = state.docDataCache[url];
    if (dataCached?.type) return dataCached.type;
    const name = dataCached?.name;
    if (name) {
        const type = getFileType(name);
        if (type && type !== 'zip') return type;
    }
    if (state.docContentCache[url]?.type) return state.docContentCache[url].type;
    const fromUrl = getFileType(String(url).split(/[?#]/)[0]);
    return fromUrl === 'zip' ? null : fromUrl;
}

export function getFileIcon(filename) {
    const type = getFileType(filename);
    if (type === 'pdf') return '<img src="icons/pdf.svg" width="18" height="18" alt="pdf">';
    if (type === 'docx' || type === 'doc') return '<img src="icons/docx.svg" width="18" height="18" alt="docx">';
    if (type === 'zip') return '<img src="icons/zip.svg" width="18" height="18" alt="zip">';
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="#757575"><path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20Z"/></svg>';
}

import { WorkerPool, CancelledTaskError } from './worker-pool';

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

    // Counts and the running total are tracked as we evict. Recomputing them
    // inside the loop made eviction O(n^2) in cache size, and evictCaches runs
    // after every insert.
    let pdfCount = Object.keys(state.docTextCache).length;
    let docxCount = Object.keys(state.docContentCache).length;
    let totalSize = state.totalCacheSize;

    for (const { key, entry, cacheType } of allEntries) {
        const countOk = pdfCount <= state.MAX_CACHE_COUNT_PER_TYPE && docxCount <= state.MAX_CACHE_COUNT_PER_TYPE;
        const sizeOk = totalSize <= state.MAX_CACHE_SIZE_TOTAL;
        if (countOk && sizeOk) break;

        // Same accounting as dropCachedDocument(), but against a local running
        // total so eviction stays O(n) instead of re-reading state each step.
        if (cacheType === 'pdf' && key in state.docTextCache) {
            delete state.docTextCache[key];
            pdfCount--;
        }
        if (cacheType === 'docx' && key in state.docContentCache) {
            delete state.docContentCache[key];
            docxCount--;
        }
        const size = entry._size || 0;
        state.totalCacheSize -= size;
        totalSize -= size;
    }
}

/**
 * Count keyword hits across page (or document) texts.
 *
 * Shared by the extractors and by the IndexedDB hydration path: a hydrated
 * document must produce exactly the counts a freshly extracted one would, or
 * the text cache would quietly change scan results.
 */
export function countKeywordMatches(texts: string[], keywords = KEYWORDS || []) {
    const combinedRegex = getKeywordRegex(keywords);
    const counts = {};
    let total = 0;

    if (!combinedRegex) return { counts, total };

    for (const text of texts) {
        if (!text) continue;
        const regex = new RegExp(combinedRegex.source, 'gi');
        let match;
        while ((match = regex.exec(text)) !== null) {
            const key = normalizeKeywordMatch(match, keywords);
            if (!key) continue;
            counts[key] = (counts[key] || 0) + 1;
            total++;
        }
    }

    return { counts, total };
}

/** Store a PDF's page text under `id` and publish its counts. */
function cachePdfEntry(id, fileName, pageTextData, file) {
    const { counts, total: totalMatches } = countKeywordMatches(pageTextData.map((p) => p.text || ''));

    const pdfCacheEntry = {
        totalPages: pageTextData.length,
        pages: pageTextData,
        fileName,
        _lastAccess: Date.now(),
        _size: estimatePagesSize(pageTextData) + fileName.length,
    };
    // A rescan of the same URL replaces the entry; drop the old one first
    // or its size stays counted forever.
    dropCachedDocument(id);
    state.docTextCache[id] = pdfCacheEntry;
    state.totalCacheSize += pdfCacheEntry._size;
    evictCaches();
    state.totalDocsFound++;

    fn.renderCard(fileName, counts, id, file);
    state.totalMatchesFound += totalMatches;
    state.emit('stats-changed');

    return pdfCacheEntry;
}

/** Store a DOCX's HTML/text under `id` and publish its counts. */
function cacheDocxEntry(id, fileName, type, htmlContent, plainText, file) {
    const { counts, total: totalMatches } = countKeywordMatches([plainText]);

    const docxCacheEntry = {
        html: htmlContent,
        text: plainText,
        fileName,
        type,
        _lastAccess: Date.now(),
        _size: estimateTextEntrySize(htmlContent, plainText) + fileName.length,
    };
    dropCachedDocument(id);
    state.docContentCache[id] = docxCacheEntry;
    state.totalCacheSize += docxCacheEntry._size;
    evictCaches();
    state.totalDocsFound++;

    fn.renderCard(fileName, counts, id, file);
    state.totalMatchesFound += totalMatches;
    state.emit('stats-changed');

    return docxCacheEntry;
}

export async function extractPdfText(arrayBuffer, fileName, id, file) {
    let pdf = null;
    try {
        const fakeDoc = {
            createElement: (name) => (name === 'canvas' ? new OffscreenCanvas(1, 1) : null),
            fonts: {},
        };

        // The same bytes extracted in an earlier session do not need pdf.js at
        // all: hydrate the page text and recompute the counts against the
        // current keyword list.
        const storedKey = await cacheKey(arrayBuffer, fileName);
        if (storedKey) {
            const stored = await readStoredText(storedKey);
            if (stored && stored.type === 'pdf') {
                return cachePdfEntry(
                    id,
                    fileName,
                    stored.pages.map((p) => ({ text: p.text, viewport: p.viewport || {}, items: p.items ?? null })),
                    file,
                );
            }
        }

        const pdfData = new Uint8Array(arrayBuffer);
        pdf = await pdfjsLib.getDocument({
            data: pdfData,
            ownerDocument: fakeDoc,
            cMapUrl: basePath + 'cmaps/',
            cMapPacked: true,
            standardFontDataUrl: basePath + 'standard_fonts/',
            isEvalSupported: false,
        }).promise;
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
                    rotation: vp.rotation,
                },
                items,
            });
            if (numPages > 1) dom.statusBar.textContent = 'Extracting pages: ' + p + '/' + numPages;
        }

        // Fire and forget: a storage failure must not fail the scan.
        void storePdfText(storedKey, fileName, pageTextData);
        return cachePdfEntry(id, fileName, pageTextData, file);
    } catch (err) {
        if (isPasswordException(err)) {
            passwordSkipped++;
            showFileError(fileName, PASSWORD_PROTECTED_MESSAGE);
            return;
        }
        showFileError(fileName, 'Failed to extract PDF text: ' + (err.message || err));
    } finally {
        // Batch extraction never hands the document to state.pdfDoc, so nothing
        // else would release this loading task's worker and page caches; left
        // alone, every scanned PDF leaks one for the life of the tab.
        if (pdf) {
            try {
                await pdf.destroy();
            } catch (e) {
                /* already torn down */
            }
        }
    }
}

export async function extractDocText(arrayBuffer, fileName, id, file) {
    try {
        const type = getFileType(fileName) as 'docx' | 'doc';
        let htmlContent = '';
        let plainText = '';

        if (type === 'doc' || isLegacyDocFile(arrayBuffer)) {
            showFileError(fileName, LEGACY_DOC_MESSAGE);
            updateProgressMainThread();
            return;
        }

        // Same short-circuit as the PDF path: Mammoth is skipped entirely when
        // an earlier session already saved this document's HTML and text.
        const storedKey = await cacheKey(arrayBuffer, fileName);
        if (storedKey) {
            const stored = await readStoredText(storedKey);
            if (stored && (stored.type === 'docx' || stored.type === 'doc')) {
                return cacheDocxEntry(id, fileName, type, stored.html, stored.text, file);
            }
        }

        if (type === 'docx') {
            const htmlResult = await mammoth.convertToHtml({ arrayBuffer });
            htmlContent = htmlResult.value;
            // Derive the searchable text from the HTML we already have instead
            // of unzipping and parsing the same document a second time. Page
            // text and the searched string now share one normalizer, so the page
            // offset table lines up exactly.
            plainText = htmlToText(htmlContent);
        }

        if (!plainText && !htmlContent) {
            showFileError(fileName, 'No extractable text found');
            updateProgressMainThread();
            return;
        }

        void storeDocxText(storedKey, fileName, type, htmlContent, plainText);
        return cacheDocxEntry(id, fileName, type, htmlContent, plainText, file);
    } catch (err) {
        showFileError(fileName, 'Failed to extract document text: ' + (err.message || err));
    }
}

/** One chunk of files handed to processFiles(), plus what was dropped from it. */
interface FileChunk {
    files: File[];
    /** Archive entries that produced no file (oversized or unreadable). */
    skipped: number;
}

/** A batch source: a plain array of dropped files, or a streaming archive. */
interface FileSource {
    /** Files that will be processed: the progress denominator. */
    total: number;
    /** Files dropped by MAX_TOTAL_FILES before processing started. */
    skippedByLimit: number;
    chunks: AsyncIterable<FileChunk> | FileChunk[];
    /** Release the underlying archive once the last chunk has been handed out. */
    close?(): void;
}

function arraySource(files: File[]): FileSource {
    const total = Math.min(files.length, state.MAX_TOTAL_FILES);
    return {
        total,
        skippedByLimit: Math.max(0, files.length - total),
        chunks: [{ files, skipped: 0 }],
    };
}

async function* chunksOf(chunks: FileChunk[] | AsyncIterable<FileChunk>): AsyncGenerator<FileChunk> {
    for await (const chunk of chunks as AsyncIterable<FileChunk>) yield chunk;
}

/**
 * Process one file of a batch: cache its text, render its card, and undo every
 * trace of it if extraction failed.
 */
async function processBatchFile(file): Promise<boolean> {
    const sizeLimit = getFileType(file.name) === 'pdf' ? state.MAX_FILE_SIZE : state.MAX_DOC_FILE_SIZE;
    if (file.size > sizeLimit) {
        showFileError(file.name, 'Skipped (' + (file.size / 1024 / 1024).toFixed(1) + ' MB exceeds limit)');
        updateProgressMainThread();
        state.emit('stats-changed');
        return true;
    }

    const url = URL.createObjectURL(file);
    state.objectUrls.push(url);

    startVerboseStatus(file.name);

    fn.renderPlaceholderCard(file.name, url, file);

    let success = false;
    try {
        const arrayBuffer = file._cachedBuffer || (await file.arrayBuffer());
        const type = getFileType(file.name);

        // Key documents by their folder-relative path, not the bare name:
        // A/drawing.pdf and B/drawing.pdf are different drawings and must not
        // share measurement state.
        const docPath = (file as any).relativePath || file.name;

        if (type === 'pdf') {
            await extractPdfText(arrayBuffer, docPath, url, file);
            success = !!state.docTextCache[url];
        } else if (type === 'docx' || type === 'doc') {
            await extractDocText(arrayBuffer, docPath, url, file);
            success = !!state.docContentCache[url];
        }
    } catch (err) {
        showFileError(file.name, err.message || err);
    } finally {
        // Release the extracted buffer as soon as its text is cached: holding
        // one per archive entry is what made a big ZIP expensive to scan.
        delete file._cachedBuffer;
        if (!success) {
            const idx = state.objectUrls.indexOf(url);
            if (idx !== -1) state.objectUrls.splice(idx, 1);
            URL.revokeObjectURL(url);
            // Drop the failed entry from every cache too: a placeholder card or
            // a dead-URL text entry would otherwise stay in the tree and in the
            // running cache total for good.
            dropCachedDocument(url);
            delete state.docDataCache[url];
        }
        updateProgressMainThread();
        state.emit('stats-changed');
    }

    return success;
}

/** Process files read from a picked directory handle, like a folder drop. */
export function openFolderFiles(files: File[]) {
    return processFiles(files);
}

async function processFiles(source) {
    const files = Array.isArray(source) ? source : null;
    if (files && files.length === 0) return;

    const viewerMsg = document.getElementById('viewerDropMsg');
    if (viewerMsg) viewerMsg.style.display = 'none';

    const statusMsgs = dom.resultsArea.querySelectorAll('.status-msg');
    statusMsgs.forEach((el) => el.remove());

    if (files && files.length === 1) {
        // ── Single file: render immediately, search async inside loadDocument ──
        const file = files[0];
        const sizeLimit = getFileType(file.name) === 'pdf' ? state.MAX_FILE_SIZE : state.MAX_DOC_FILE_SIZE;
        if (file.size > sizeLimit) {
            showFileError(file.name, 'Skipped (' + (file.size / 1024 / 1024).toFixed(1) + ' MB exceeds limit)');
            return;
        }

        if (findDuplicateUrl(file)) {
            state.processed = 1;
            state.totalFiles = 1;
            dom.progressBar.style.width = '0%';
            state.emit('stats-changed');
            // After the emit: the stats handler rewrites this line.
            dom.statusBar.textContent = 'Already loaded: ' + file.name;
            return;
        }

        // A legacy .doc would otherwise get a placeholder row and then fail
        // inside Mammoth, leaving a dead entry and a success message. Reject it
        // before anything is added to the tree. The header check also catches a
        // binary file renamed to .docx.
        if (getFileType(file.name) === 'doc' || isLegacyDocFile(await file.slice(0, 4).arrayBuffer())) {
            state.processed = 1;
            state.totalFiles = 1;
            showFileError(file.name, LEGACY_DOC_MESSAGE);
            state.emit('stats-changed');
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

    // ── Multiple files / archive: process chunk by chunk ──
    const batch: FileSource = files ? arraySource(files) : source;

    // An archive holding exactly one file opens it, exactly as dropping that
    // file on its own does; only the extraction is streamed.
    if (!files && batch.total === 1) {
        try {
            for await (const chunk of chunksOf(batch.chunks)) {
                if (chunk.files.length === 1) {
                    await processFiles([chunk.files[0]]);
                    return;
                }
            }
        } finally {
            batch.close?.();
        }
        return;
    }

    dom.progressBar.style.width = '0%';

    state.processed = 0;
    state.totalFiles = batch.total;
    // The cap silently dropped the tail of a large drop; report it instead.
    const skippedByLimit = batch.skippedByLimit;
    let failedCount = 0;
    let handled = 0;
    let duplicatesSkipped = 0;
    passwordSkipped = 0;

    // Throttle sidebar tree rebuilds for the duration of the scan: one full
    // rebuild per file is quadratic, and each file already renders its own
    // card. endResultsBatch() flushes the final state.
    fn.beginResultsBatch();
    runningScans++;
    try {
        for await (const chunk of chunksOf(batch.chunks)) {
            // Entries the extractor could not produce never reach the loop, so
            // they must not stay in the progress denominator.
            if (chunk.skipped) state.totalFiles -= chunk.skipped;
            for (const file of chunk.files) {
                if (handled >= batch.total) break;
                handled++;
                // Checked per file rather than by pre-filtering: a drop can
                // contain two copies of the same file, and the first one only
                // registers its key once its card is rendered.
                if (findDuplicateUrl(file)) {
                    duplicatesSkipped++;
                    updateProgressMainThread();
                    continue;
                }
                if (!(await processBatchFile(file))) failedCount++;
            }
        }
    } finally {
        runningScans--;
        fn.endResultsBatch();
        batch.close?.();
    }

    // A final chunk that held only skipped entries never reaches
    // updateProgressMainThread(), so close the scan out here.
    fn.finishResultsIfComplete();

    if (failedCount > 0) {
        dom.statusBar.textContent = failedCount + ' file(s) failed to process';
    }

    if (duplicatesSkipped > 0) {
        const note = document.createElement('div');
        note.className = 'status-msg';
        note.textContent = duplicatesSkipped + ' file(s) skipped — already loaded';
        dom.resultsArea.prepend(note);
        dom.statusBar.textContent =
            duplicatesSkipped +
            ' duplicate(s) skipped' +
            (dom.statusBar.textContent ? ' · ' + dom.statusBar.textContent : '');
    }

    // An encrypted entry isn't a broken one, and the generic failure count hides
    // that there is a password to supply: say so, and how to supply it.
    if (passwordSkipped > 0) {
        const note = document.createElement('div');
        note.className = 'status-msg';
        note.textContent =
            passwordSkipped + ' file(s) skipped — password-protected ' + '(open one on its own to enter its password)';
        dom.resultsArea.prepend(note);
        const otherFailures = failedCount - passwordSkipped;
        dom.statusBar.textContent =
            passwordSkipped +
            ' file(s) skipped (password-protected)' +
            (otherFailures > 0 ? ' · ' + otherFailures + ' failed' : '');
    }

    if (skippedByLimit > 0) {
        const note = document.createElement('div');
        note.className = 'status-msg';
        note.textContent =
            skippedByLimit +
            ' file(s) skipped — only the first ' +
            state.MAX_TOTAL_FILES +
            ' files of a drop are scanned';
        dom.resultsArea.prepend(note);
        dom.statusBar.textContent +=
            (dom.statusBar.textContent ? ' · ' : '') +
            skippedByLimit +
            ' skipped (limit ' +
            state.MAX_TOTAL_FILES +
            ')';
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
        const filesToProcess = [];
        let processedArchive = false;

        const viewerMsg = document.getElementById('viewerDropMsg');
        if (viewerMsg) viewerMsg.style.display = 'none';
        const statusMsgs = dom.resultsArea.querySelectorAll('.status-msg');
        statusMsgs.forEach((el) => el.remove());

        for (const entry of entries) {
            if (entry.isFile && entry.name.toLowerCase().endsWith('.zip')) {
                dom.statusBar.textContent = 'Unzipping ' + entry.name + '...';
                dom.progressBar.style.width = '0%';
                try {
                    const zipFile = await new Promise((resolve, reject) => {
                        entry.file(resolve, reject);
                    });
                    state.basePath = (zipFile as any).name.replace(/\.zip$/i, '');
                    // Entries are processed as they are extracted instead of the
                    // whole archive being materialised first.
                    const zipSource = await openZipSource(zipFile);
                    if (zipSource) {
                        processedArchive = true;
                        await processFiles(zipSource);
                    }
                } catch (err) {
                    showFileError(entry.name, 'Failed to read zip file: ' + (err.message || err));
                }
            } else if (entry.isDirectory) {
                dom.statusBar.textContent = 'Reading folder "' + entry.name + '"...';
                dom.progressBar.style.width = '0%';
                try {
                    await traverseFileTree(entry, filesToProcess, '');
                    state.basePath = entry.name;
                } catch (err) {
                    showFileError(entry.name, 'Failed to read folder: ' + (err.message || err));
                }
            } else {
                // A lone file establishes no folder. Treating it as one named the
                // phantom root after the file, which corrupted every fullPath
                // (and therefore every measurement key) derived from it.
                try {
                    await traverseFileTree(entry, filesToProcess, '');
                } catch (err) {
                    showFileError(entry.name, 'Failed to read file: ' + (err.message || err));
                }
            }
        }

        if (filesToProcess.length > 0) {
            processFiles(filesToProcess);
        } else if (!processedArchive) {
            dom.statusBar.textContent = 'No supported files found';
            dom.progressBar.style.width = '0%';
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
        const entries = [];
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

/**
 * Open an archive and hand its files out a few at a time.
 *
 * The whole archive used to be extracted before processing began, so a large
 * ZIP was fully materialised in memory and every extracted File kept its buffer
 * alive until the array was dropped. Each chunk is now processed (and released)
 * before the next one is extracted.
 */
async function openZipSource(zipFile) {
    if (zipFile.size > state.MAX_ZIP_FILE_SIZE) {
        showFileError(zipFile.name, 'ZIP too large (' + (zipFile.size / 1024 / 1024).toFixed(1) + ' MB)');
        return null;
    }

    const sizeMB = (zipFile.size / (1024 * 1024)).toFixed(1);
    dom.statusBar.textContent = sizeMB + ' MB - Unzipping ' + zipFile.name + '...';

    let zip;
    try {
        zip = await JSZip.loadAsync(zipFile);
    } catch (err) {
        showFileError(zipFile.name, 'Failed to open ZIP: ' + (err.message || err));
        return null;
    }

    const entries = [];
    zip.forEach((path, entry) => {
        if (!entry.dir && getFileType(path)) entries.push({ path, entry });
    });

    entries.sort(
        (a, b) =>
            ((a.entry._data && a.entry._data.uncompressedSize) || 0) -
            ((b.entry._data && b.entry._data.uncompressedSize) || 0),
    );

    const total = Math.min(entries.length, state.MAX_TOTAL_FILES);
    if (entries.length > total) {
        showFileError(
            zipFile.name,
            entries.length - total + ' file(s) in the archive skipped (limit ' + state.MAX_TOTAL_FILES + ')',
        );
    }
    if (total === 0) {
        dom.statusBar.textContent = 'No supported files found in ' + zipFile.name;
        return null;
    }

    const concurrency = Math.min(navigator.hardwareConcurrency || 4, 8);
    let done = 0;

    function updateProgress() {
        done++;
        const pct = Math.round((done / total) * 100);
        dom.statusBar.textContent = pct + '% - Unzipping ' + zipFile.name + ': ' + done + '/' + total + ' files';
        dom.progressBar.style.width = pct + '%';
    }

    async function* chunks(): AsyncGenerator<FileChunk> {
        let zipErrors = 0;

        for (let i = 0; i < total; i += concurrency) {
            const group = entries.slice(i, i + concurrency);
            const results = await Promise.allSettled(
                group.map(async ({ path, entry }) => {
                    const blob = await entry.async('blob');
                    return { blob, path, type: getFileType(path) };
                }),
            );

            const files = [];
            let skipped = 0;
            for (const result of results) {
                if (result.status === 'rejected') {
                    zipErrors++;
                    skipped++;
                    updateProgress();
                    continue;
                }
                const { blob, path, type } = result.value;
                const sizeLimit = type === 'pdf' ? state.MAX_FILE_SIZE : state.MAX_DOC_FILE_SIZE;
                if (blob.size > sizeLimit) {
                    skipped++;
                    updateProgress();
                    continue;
                }
                let mimeType = 'application/pdf';
                if (type === 'docx')
                    mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
                else if (type === 'doc') mimeType = 'application/msword';
                const file = new File([blob], path, { type: mimeType });
                (file as any).relativePath = path;
                try {
                    (file as any)._cachedBuffer = await blob.arrayBuffer();
                } catch (err) {
                    showFileError(path, 'Failed to read entry from ZIP: ' + (err.message || err));
                    skipped++;
                    updateProgress();
                    continue;
                }
                files.push(file);
                updateProgress();
            }

            // Yield even when the chunk produced nothing but skips: the caller
            // needs the count to keep its progress denominator honest.
            if (files.length > 0 || skipped > 0) yield { files, skipped };
        }

        if (zipErrors > 0) {
            showFileError(zipFile.name, zipErrors + ' entry(s) failed to extract from ZIP');
        }
    }

    return {
        total,
        skippedByLimit: 0,
        chunks: chunks(),
        close() {
            zip = null;
        },
    };
}

export function initFileHandler() {
    // Create the text-processing pool once, at startup. It used to be created
    // lazily by the first rescan, so a freshly loaded app processed its first
    // imports synchronously on the main thread.
    initWorkerPool();

    dom.sidebar.addEventListener('drop', (e) => {
        e.preventDefault();
        handleDrop(e);
    });

    dom.folderInput.addEventListener('change', async (e) => {
        const viewerMsg = document.getElementById('viewerDropMsg');
        if (viewerMsg) viewerMsg.style.display = 'none';
        const statusMsgs = dom.resultsArea.querySelectorAll('.status-msg');
        statusMsgs.forEach((el) => el.remove());

        const filesToProcess = [];
        let processedArchive = false;
        const items = Array.from((e.target as HTMLInputElement).files || []);
        const hasZip = items.some((f) => f.name.toLowerCase().endsWith('.zip'));
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
                    const zipSource = await openZipSource(file);
                    if (zipSource) {
                        processedArchive = true;
                        await processFiles(zipSource);
                    }
                } catch (err) {
                    showFileError((file as any).name, 'Failed to process ZIP: ' + (err.message || err));
                }
            } else if (type) {
                (file as any).relativePath = (file as any).webkitRelativePath || (file as any).name;
                filesToProcess.push(file);
            }
        }

        if (filesToProcess.length > 0) {
            processFiles(filesToProcess);
        } else if (!processedArchive) {
            dom.statusBar.textContent = 'No supported files found';
            dom.progressBar.style.width = '0%';
        }
    });
}

const RESCAN_CONCURRENCY = 4;

async function mapConcurrent<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
        while (next < items.length) {
            await run(items[next++]);
        }
    });
    await Promise.all(lanes);
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
    // Supersede anything queued by an earlier scan: those results describe a
    // library the user has already replaced.
    state.workerPool.cancelStale(state.docGeneration);
    const keywords = KEYWORDS || [];
    let failedCount = 0;
    let cancelled = false;

    const scanOne = async ({ url, i }: { url: string; i: number }) => {
        if (cancelled) return;
        const pdfCached = state.docTextCache[url];

        if (pdfCached) {
            try {
                const result = await state.workerPool.runRegexOnPDFCache(
                    pdfCached.pages,
                    pdfCached.fileName || url.split('/').pop(),
                    keywords,
                    url,
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
                // A cancelled scan is not a failed document: stop without
                // reporting an error for work the user abandoned.
                if (err instanceof CancelledTaskError) {
                    cancelled = true;
                    return;
                }
                const name = pdfCached.fileName || url.split('/').pop();
                showFileError(name, 'Rescan PDF worker error: ' + (err.message || err));
                failedCount++;
            }
        } else {
            const docCached = state.docContentCache[url];
            if (docCached) {
                try {
                    const result = await state.workerPool.runRegexOnText(
                        docCached.text,
                        docCached.fileName || url.split('/').pop(),
                        keywords,
                        'docx',
                        url,
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
                    if (err instanceof CancelledTaskError) {
                        cancelled = true;
                        return;
                    }
                    const name = docCached.fileName || url.split('/').pop();
                    showFileError(name, 'Rescan DOCX worker error: ' + (err.message || err));
                    failedCount++;
                }
            }
        }

        if (cancelled) return;
        state.processed++;
        dom.progressBar.style.width = Math.round((state.processed / state.objectUrls.length) * 100) + '%';
    };

    // Documents used to be awaited one at a time and the tree rebuilt per
    // document. The pool runs several scans at once; the batch keeps the tree at
    // one rebuild while that happens.
    fn.beginResultsBatch();
    try {
        await mapConcurrent(
            state.objectUrls.map((url, i) => ({ url, i })),
            RESCAN_CONCURRENCY,
            scanOne,
        );
    } finally {
        fn.endResultsBatch();
    }

    if (cancelled) return;

    state.emit('stats-changed');

    if (failedCount > 0) {
        dom.statusBar.textContent = failedCount + ' document(s) failed during rescan';
    } else if (state.totalMatchesFound === 0) {
        dom.statusBar.textContent = 'No matches found';
    } else {
        dom.statusBar.textContent =
            state.totalMatchesFound +
            ' matches across ' +
            state.totalDocsFound +
            ' document' +
            (state.totalDocsFound !== 1 ? 's' : '');
    }
}
