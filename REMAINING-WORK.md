# kwpdf — performance work order (Phases 0–3)

Status: **Phases 0, 1, 2 and 3 implemented.** The automated gates pass; the
browser-only gates listed under "Still manual" have not been run yet.

Goal: the two remaining costs on very large drawing PDFs (hundreds of pages,
millions of vector elements):

1. **Time to first usable page** — the loader used to stay up until the whole
   document was indexed.
2. **Scroll/zoom responsiveness** — pdf.js executed drawing operators on the
   main thread, so panning/zooming a dense drawing janked.

Constraints confirmed with the user: both symptoms matter; the browser target is
mixed (so the rendering path must degrade on its own where it cannot use a
worker); files are a mix of repeat and one-off; **static/local only**, so no
server-side pre-rendering or tile service.

---

## Invariant that must not regress: open jumps to the first match

Opening a document still lands on a match, not page 1, and still lands on the
*same* one:

- `pdf-loader.ts` picks the first keyword with entries in `state.searchCache`
  (insertion order = first keyword encountered in page order), or uses the
  keyword passed to `loadPDF(url, keyword)`.
- `performSearch()` → `showSearchResults()` → `goToMatch(0)` → `ui.ts` renders
  that page, scrolls it to the viewport centre, sets the `.current` mark, updates
  the counter and the keyword grid.

The prefix indexer preserves this by construction: it stops on the first page
that produces a match, so the first keyword inserted into the cache — and
therefore the landing keyword — is the same one a full scan would have chosen.
`precomputePrefix` also resolves an explicitly requested keyword to the list's
spelling before deciding what to stop on.

---

## Phase 0 — Instrument and measure — **done**

- `src/perf.ts`: `mark` / `measure` / `dumpPerf` / `dumpLongTasks`, gated on
  `?perf=1` or `localStorage.kwpdf_perf`, no-op when off. `__kwpdfPerf()` and
  `__kwpdfPerfLongTasks()` are exposed only when enabled.
- Marks: `getDocument`, `setupVirtualPages`, first render, extraction, the
  prefix index, scale detection, and inside `renderPageNow`
  (`render:getPage`, `render:paint`, `render:text`).
- `src/__tests__/perf.test.js` covers the disabled path, the enabled path and
  the missing-mark case.
- New fixture `vector-heavy.pdf` in `.verify/make-fixtures.mjs`: 60 pages,
  2,500 path operators per page plus a few curves and fills. `large.pdf` is 120
  pages of Helvetica text and cannot show anything about rasterisation.
- `e2e/perf-baseline.spec.js` prints the table (`KWPDF_BASELINE=1 npx
  playwright test e2e/perf-baseline.spec.js`).

### Baseline — `vector-heavy.pdf`, Chromium, headless, first open after a drop

| Phase 0 baseline | ms |
|---|---|
| getDocument | 257 |
| setupVirtualPages | 85 |
| first page render (incl. 140 ms paint) | 155 |
| text extraction (cache miss) | 321 |
| prefix index (stops at first match) | **3.7** |
| median / worst `render:paint` while scrolling | **94.6 / 159.2** |
| longest main-thread task | **266** (2 long tasks, 325 ms total) |

**Verdict for the Phase 3 gate:** rasterisation dominates by more than an order
of magnitude (95 ms median per painted page vs 4 ms to index the document), so
moving the drawing operators off the main thread is worth doing, and the raster
cache is worth doing too.

---

## Phase 1 — Open before the index finishes — **done**

- `pdf-search.ts`:
  - `scanPage()` scans one page and returns the matches it produced. It
    re-acquires the keyword regex for **every page**: `getKeywordRegex()` returns
    one shared global regex and resets `lastIndex` on every call, so a concurrent
    `countKeywordMatches()` (a drop-scan) would otherwise rewind a page and
    duplicate its matches. A page is always scanned to its end, which is also
    what keeps each keyword's array in page/text order without a re-sort.
  - `precomputePrefix({ preferredKeyword, budgetMs })` walks pages until the
    first match (or the preferred keyword's first match) and stops *after* that
    page. If the budget expires with nothing found it falls back to the full
    `precomputeAllSearches()` — nothing was pushed, so the fallback cannot
    duplicate anything.
  - `precomputeRemaining()` resumes from the cursor in ≤8 ms slices, yields with
    `setTimeout` (not `requestAnimationFrame`: a hidden tab pauses rAF and would
    leave the document half-indexed), appends to the active search, and finishes
    by publishing counts.
  - `finishIndexing()` sets `searchDeduplicated` + `_gsPageCacheReady`, nulls the
    all-keyword memo, recomputes `docDataCache[url].counts` (preserving OCR
    additions), and emits `keywords-changed` / `stats-changed` / `badge-changed` /
    `results-changed` once.
- Tail results are **appended** to `state.searchResults` — tail matches are
  always on later pages, so existing indices and the object `currentMatchIndex`
  points at keep their positions and the current highlight never jumps.
- `state._pdfInteractive` is set when the loader hides; `rendering.ts`'s
  `isDocReady()` uses it, so a document is clickable immediately.
  `_gsPageCacheReady` still means "fully indexed" and still gates global search
  and cycle-all-keyword. Clicking a count while indexing now says "Indexing …"
  and runs the cycle when the index lands, instead of silently doing nothing.
- `autoDetectScale()` moved behind the index (it re-reads the file and
  re-renders measurement overlays). `autoSetScale` does not change zoom, so
  there is no visual jump.
- Counter behaviour: it reads "1 / 3" on open and grows as the tail lands.
  `#matchTotal` never carries an "indexing…" suffix (callers parse it as a
  number); the state is on `body[data-indexing]` plus `aria-busy`/`title`.
- Tests: `precomputePrefix` (stops at the first match; no-match fallback;
  preferred keyword wins), `precomputeRemaining` (no duplicates; immune to a
  regex reset mid-run; append keeps the current match; generation change
  abandons the tail; counts published).

---

## Phase 3 — pdf.js 6 + its renderer worker — **done** (manual gates pending)

`pdfjs-dist` 4.10.38 → 6.5.438. The hand-rolled render worker, its message
protocol, its capability detection and its Chromium-only fallback were **not**
built: pdf.js 6 ships `RendererWorker` (PR #21860), created by the API on the
main thread as a *sibling* of the parser worker — so no nested worker, no second
document parse, no doubled memory, and an automatic main-thread fallback
(#22163).

- **Teardown migration first.** `PDFDocumentProxy.prototype.destroy()` was
  removed in 6.0.227 (PR #21245) and all five call sites were inside try/catch,
  so every one of them failed silently — one leaked pdf.js worker per document
  switch and per scanned file. All five now go through
  `proxy.loadingTask.destroy()`. `State.pdfDoc` is `any`, so `tsc` cannot catch a
  regression; `src/__tests__/destroy-migration.test.js` is the gate.
- **Assets** (`build.js`): `pdf.renderer.min.mjs` (same package version — pdf.js
  refuses a mismatched renderer), `wasm/` (JPX, JBIG2, ICC, QuickJS) and `iccs/`.
  Since pdf.js 5.0 those decoders load from `wasmUrl`/`iccUrl`.
- **Config** (`pdf-loader.ts`): `wasmUrl` + `iccUrl` beside the existing
  `cMapUrl`/`standardFontDataUrl`; no `ownerDocument` and no `styleElement` on
  the viewer path (either one forces main-thread rendering).
- `index.js` sets `GlobalWorkerOptions.rendererSrc`; the file is precached in
  `LOCAL_ASSETS` the same way `pdf.worker.min.mjs` is.
- `isEvalSupported: false` removed from both `getDocument` calls and both
  comments rewritten: pdf.js 6 has no host `eval`, and document JavaScript only
  runs in its sandboxed QuickJS interpreter (`wasm/quickjs-eval.wasm`) when
  `enableScripting` is on — which this app never enables.
- **Text layer CSS ported** (`style.css`): `--total-scale-factor` /
  `--text-scale-factor` / `--min-font-size` / per-span `--font-height`,
  `--scale-x`, `--rotate`. `buildTextLayer` and `updateTextLayersAtScale` set
  `--user-unit` from the viewport and `data-main-rotation`, so `/UserUnit` and
  rotated sheets lay out correctly.

**Decision recorded:** the standard build is used, not `legacy/build/`. That
raises the minimum browser (pdf.js 6 needs `Promise.withResolvers`). If an older
browser must be supported, switching to `legacy/build/` is the escape hatch and
is a build-config change only.

---

## Phase 2 — Persistent raster cache — **done**

- `src/raster-store.ts`: separate DB (`kwpdf-raster-cache`), LRU by `savedAt`,
  60 entries / 64 MB, fail-soft in every direction (no IndexedDB, blocked
  upgrade, quota, private window).
- Key = the document's content hash (stashed on the doc entry at scan time; it
  used to be computed and thrown away) + page + zoom bucket (0.1) + DPR +
  render quality. A changed file can never hit an old bitmap.
- **The bitmap is the render result**, not a placeholder: at a matching bucket
  `renderPageNow` paints the cached bitmap and marks the page rendered, so the
  drawing operators do not run at all. Text still comes from
  `page.getTextContent()` — `TextLayer` needs the raw `TextContent` with its
  `styles` font map, which `textPageCache` does not hold — so this removes the
  raster pass only, which is why the Phase 0 gate mattered.
- Writes are deliberately narrow: current page only, on idle, never while the
  tab is hidden, capped at 8 MP, behind a `navigator.storage.estimate()`
  headroom check. Encoding a big canvas is itself a main-thread cost.
- "Clear Cache" clears both stores.
- Tests: `src/__tests__/raster-store.test.js` (key stability, bucket reuse, LRU
  by count and bytes, payload validation, graceful degradation without IDB).

---

## Still manual (browser-only, not yet run)

1. **Drawing inputs with unusual images.** A page with a CMYK JPEG, one with a
   JPX image and one with JBIG2 must render identically to 4.10.38. No fixture
   produces these yet — this is the one gate that can still invalidate the
   upgrade. *A cheap version: `python3 -m http.server` over `dist/`, open a real
   drawing set that contains scanned/colour sheets.*
2. **Rotated and `/UserUnit` pages.** Select and copy text on a `/Rotate 90`
   sheet and on a sheet whose `/UserUnit` is not 1; the selection must sit on the
   glyphs.
3. **Firefox / Safari.** The app must still open a drawing and land on the same
   first match. `RendererWorker` falls back on its own; what needs checking is
   that the fallback is taken and nothing else breaks.
4. **Renderer worker actually engaged** in Chromium (`chrome://inspect/#workers`
   → a second pdf.js worker, `pdf.renderer.min.mjs`).
5. **Bounded memory over a long scroll**: 50+ pages of a dense drawing, canvas
   and bitmap counts must stay bounded (eviction still releases canvases).
6. ~~**Raster cache across sessions**~~ — automated in
   `e2e/raster-cache.spec.js` (first open stores, second session hits). What is
   still manual is the budget side: the cache must stay under 60 entries / 64 MB
   after scrolling 200 pages.
