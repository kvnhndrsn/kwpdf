import JSZip from 'jszip';
import * as mammoth from 'mammoth';
import * as pdfjsLib from 'pdfjs-dist';

const scriptUrl = document.currentScript && document.currentScript.src;
const basePath = scriptUrl ? scriptUrl.substring(0, scriptUrl.lastIndexOf('/') + 1) : './';
pdfjsLib.GlobalWorkerOptions.workerSrc = basePath + 'pdf.worker.min.mjs';

setPdfjsLib(pdfjsLib);
setJSZip(JSZip);
setMammoth(mammoth);

import { state } from './state';
import * as dom from './dom';
import { register, fn, setPdfjsLib, setJSZip, setMammoth } from './cross';

import * as pdfRenderer from './pdf-renderer';
import * as pdfSearch from './pdf-search';
import * as docxEngine from './docx-engine';
import * as pdfLoader from './pdf-loader';
import * as fileHandler from './file-handler';
import * as rendering from './rendering';
import * as ui from './ui';
import * as keywords from './keywords';
import * as ocr from './ocr';
import * as measure from './measure';
import { CustomDropdown } from './dropdown';


register('setupVirtualPages', pdfRenderer.setupVirtualPages);
register('teardownPdf', pdfRenderer.teardownPdf);
register('isPageRendered', pdfRenderer.isPageRendered);
register('renderPageNow', pdfRenderer.renderPageNow);
register('setZoom', pdfRenderer.setZoom);
register('startPrerender', pdfRenderer.startPrerender);
register('rebuildTextLayers', pdfRenderer.rebuildTextLayers);
register('setRenderQuality', pdfRenderer.setRenderQuality);

register('precomputeAllSearches', pdfSearch.precomputeAllSearches);
register('performSearch', pdfSearch.performSearch);
register('cycleSearch', pdfSearch.cycleSearch);
register('cycleAllKeywords', pdfSearch.cycleAllKeywords);
register('clearHighlights', pdfSearch.clearHighlights);
register('renderAllHighlights', pdfSearch.renderAllHighlights);
register('renderHighlightsForPage', pdfSearch.renderHighlightsForPage);
register('updateCurrentMatch', pdfSearch.updateCurrentMatch);
register('repositionHighlights', pdfSearch.repositionHighlights);
register('renderPageHeatmaps', pdfSearch.renderPageHeatmaps);

register('loadDocxDoc', docxEngine.loadDocxDoc);
register('performDocSearch', docxEngine.performDocSearch);
register('cycleDocSearch', docxEngine.cycleDocSearch);
register('cycleAllDocKeywords', docxEngine.cycleAllDocKeywords);
register('renderDocHighlights', docxEngine.renderDocHighlights);
register('goToDocMatch', docxEngine.goToDocMatch);

register('loadDocument', pdfLoader.loadDocument);

register('handleDrop', fileHandler.handleDrop);
register('extractPdfText', fileHandler.extractPdfText);
register('extractDocText', fileHandler.extractDocText);

register('renderPlaceholderCard', rendering.renderPlaceholderCard);
register('renderCard', rendering.renderCard);
register('renderNoMatchCard', rendering.renderNoMatchCard);
register('renderResultsArea', rendering.renderResultsArea);
register('updateStats', rendering.updateStats);
register('updateSidebarBadge', rendering.updateSidebarBadge);
register('updateKeywordGrid', rendering.updateKeywordGrid);
register('updateProgressMainThread', rendering.updateProgressMainThread);

register('clearSearch', ui.clearSearch);
register('showSearchOverlay', ui.showSearchOverlay);
register('closeSearchOverlay', ui.closeSearchOverlay);
register('closeMobileSidebar', ui.closeMobileSidebar);
register('toggleTheme', ui.toggleTheme);
register('zoomIn', ui.zoomIn);
register('zoomOut', ui.zoomOut);
register('updateZoomDisplay', ui.updateZoomDisplay);
register('updatePageInfo', ui.updatePageInfo);
register('findNext', ui.findNext);
register('findPrev', ui.findPrev);
register('goToMatch', ui.goToMatch);
register('toggleSettings', ui.toggleSettings);
register('clearAllResults', ui.clearAllResults);
register('performGlobalSearch', ui.performGlobalSearch);
register('activateGlobalSearch', ui.activateGlobalSearch);
register('cycleGlobalSearch', ui.cycleGlobalSearch);
register('cycleGlobalSearchPrev', ui.cycleGlobalSearchPrev);

register('populateKeywordSelect', keywords.populateKeywordSelect);

register('toggleOcrGlobal', ocr.toggleOcrGlobal);
register('toggleOcrForFile', ocr.toggleOcrForFile);
register('isOcrEnabled', ocr.isOcrEnabled);
register('getOcrState', ocr.getOcrState);
register('getOcrMatchesForKeyword', ocr.getOcrMatchesForKeyword);

register('setScale', measure.setScale);
register('getActiveTool', measure.getActiveTool);
register('activateTool', measure.activateTool);
register('deactivateTool', measure.deactivateTool);
register('clearMeasurements', measure.clearAllMeasurements);
register('refreshAllMeasurements', measure.refreshAllMeasurements);
register('renderAllMeasurements', measure.renderAllMeasurements);
register('cancelCalibration', measure.cancelCalibration);
register('startCalibration', measure.startCalibration);
register('getIsCalibrating', measure.getIsCalibrating);

register('_performSearch', () => {
    if (state.activeKeyword) {
        if (state.currentDocType === 'pdf') fn.performSearch(state.activeKeyword);
        else fn.performDocSearch(state.activeKeyword);
    }
});

rendering.setCallbacks({
    loadDocument: pdfLoader.loadDocument,
    cycleSearch: pdfSearch.cycleSearch,
    cycleDocSearch: docxEngine.cycleDocSearch,
    cycleAllKeywords: pdfSearch.cycleAllKeywords,
    cycleAllDocKeywords: docxEngine.cycleAllDocKeywords,
    closeMobileSidebar: ui.closeMobileSidebar,
});

state.on('results-changed', fn.renderResultsArea);
state.on('stats-changed', fn.updateStats);
state.on('badge-changed', fn.updateSidebarBadge);
state.on('heatmaps-changed', fn.renderPageHeatmaps);
state.on('keywords-changed', fn.populateKeywordSelect);


ocr.initOcr();

keywords.initKeywordBridge();

document.addEventListener('DOMContentLoaded', async () => {
    dom.init();

    new CustomDropdown(dom.keywordListSelect);
    new CustomDropdown(dom.keywordSelect);
    new CustomDropdown(dom.kwListSelector);

    keywords.setupKeywordManager();
    fileHandler.initFileHandler();
    dom.keywordListSelect.addEventListener('change', () => {
        const listName = dom.keywordListSelect.value;
        if (keywords.switchKeywordList(listName)) {
            state.searchCache = {};
            ui.clearSearch();
            if (state.objectUrls.length > 0) fileHandler.rescanAllDocuments();
        }
    });
    await keywords.loadKeywords();
    keywords.populateListSelector();
    keywords.syncKeywordsToWindow();
    ui.setupEventListeners();
});
