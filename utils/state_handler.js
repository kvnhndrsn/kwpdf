export class DocumentStore {
    constructor() {
        // --- Document Identity ---
        this.currentDocUrl = "";
        this.currentDocType = 'pdf';
        this.pdfDoc = null;
        this.totalPages = 0;
        this.currentPage = 1;

        // --- Viewport & Rendering State ---
        this.currentScale = 1.0;
        this.renderedPages = new Set();
        this.renderedScales = {};
        this.pageHeights = {};
        this.textPageCache = {};
        this.zoomRenderTask = null;
        this.isNavigating = false;

        // --- Search & Keyword State ---
        this.activeKeyword = "";
        this.searchResults = [];
        this.currentMatchIndex = -1;
        this.searchCache = {};

        // --- DOCX Specific State ---
        // (We will extract DOCX logic later, but for now, we capture its state here)
        this.docSearchResults = [];
        this.docCurrentMatchIndex = -1;
        this.docOriginalHtml = null;
    }

    /**
     * Wipes the current state clean. Call this immediately before loading a new document.
     */
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
