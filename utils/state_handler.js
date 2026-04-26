// ========== DOCUMENT STORE ==========

(function() {
    class DocumentStore {
        constructor() {
            this.currentDocUrl = "";
            this.currentDocType = 'pdf';
            this.pdfDoc = null;
            this.totalPages = 0;
            this.currentPage = 1;

            this.currentScale = 1.0;
            this.renderedPages = new Set();
            this.renderedScales = {};
            this.pageHeights = {};
            this.textPageCache = {};
            this.zoomRenderTask = null;
            this.isNavigating = false;

            this.activeKeyword = "";
            this.searchResults = [];
            this.currentMatchIndex = -1;
            this.searchCache = {};

            this.docSearchResults = [];
            this.docCurrentMatchIndex = -1;
            this.docOriginalHtml = null;
        }

        reset() {
            if (this.pdfDoc) {
                try {
                    this.pdfDoc.destroy();
                } catch (e) {
                    console.warn("Error destroying previous PDF:", e);
                }
            }

            this.pdfDoc = null;
            this.currentDocUrl = "";
            this.totalPages = 0;
            this.currentPage = 1;
            this.currentScale = 1.0;

            this.renderedPages.clear();
            this.renderedScales = {};
            this.pageHeights = {};
            this.textPageCache = {};

            this.activeKeyword = "";
            this.searchResults = [];
            this.currentMatchIndex = -1;
            this.searchCache = {};

            this.docSearchResults = [];
            this.docCurrentMatchIndex = -1;
            this.docOriginalHtml = null;
        }
    }

    window.docStore = new DocumentStore();

    // ========== STATE INITIALIZATION ==========
    // Initialize window.* for backward compatibility

    window.activeKeyword = "";
    window.currentDocType = 'pdf';
    window.pdfDoc = null;
    window.currentDocUrl = "";
    window.currentScale = 1.0;
    window.currentPage = 1;
    window.totalPages = 0;
    window.isNavigating = false;

    // ========== STATE FUNCTIONS ==========

    window.clearSearch = function() {
        window.activeKeyword = '';
        window.searchResults = [];
        window.currentMatchIndex = -1;
        window.navGroup.classList.remove('active');
        window.navSep.style.display = 'none';
        window.clearHighlights();
        window.keywordSelect.value = '';
        window.matchInput.value = '';
        window.matchTotal.textContent = '0';
        window.updateSidebarBadge();
        window.updateHeatmap();
    };

    window.clearAllResults = function() {
        window.resultsArea.innerHTML = `<h1 class="status-msg">
        <img src="icons/folder.svg" width="32" height="32" alt="folder">
        <img src="icons/pdf.svg" width="32" height="32" alt="pdf">
        <img src="icons/docx.svg" width="32" height="32" alt="docx">
        <img src="icons/zip.svg" width="32" height="32" alt="zip">
        </h1>
<h2 class="status-msg">Drop here to begin scanning</h2>`;
        
        // Reset viewer
        const viewerDropMsg = document.getElementById('viewerDropMsg');
        if (viewerDropMsg) viewerDropMsg.style.display = 'block';
        window.statusBar.textContent = '';

        if (window.objectUrls) {
            window.objectUrls.forEach(url => URL.revokeObjectURL(url));
        }
        window.objectUrls = [];
        window.totalMatchesFound = 0;
        window.totalDocsFound = 0;
        window.docDataCache = {};
        window.docContentCache = {};
        window.docTextCache = {};
        if (window.expandedTreeItems) {
            window.expandedTreeItems.clear();
        }
        window.updateStats();

        window.pdfDoc = null;
        window.currentDocUrl = "";
        window.currentDocType = 'pdf';
        window.currentScale = 1.0;
        window.currentPage = 1;
        window.totalPages = 0;
        window.viewer.innerHTML = '';
        window.renderedPages.clear();
        window.renderedScales = {};
        window.pageHeights = {};
        window.searchCache = {};
        window.clearSearch();
        window.currentScale = 1.0;
        window.currentPage = 1;
        window.textPageCache = {};
        window.docSearchResults = [];
        window.docCurrentMatchIndex = -1;
    };
})();