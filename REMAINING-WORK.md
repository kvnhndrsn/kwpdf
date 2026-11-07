# kwpdf — remaining work + browser verification handoff

State when this was written: **Phase 1 (security/correctness) complete**, **most of Phase 2 (performance) complete**. `npm run typecheck` exits 0, `npm test` = 17 files / 220 tests, `npm run build` exits 0.

Use this document as the work order in a browser-capable environment. Every "Verify" step is written so it can be executed manually; none of the completed renderer, OCR, service-worker or DOCX changes have been exercised in a real browser yet.

Line numbers drift — grep the named symbol instead of trusting a number.

---

## 0. Verify what already shipped (no code changes; do these first)

These changes are unit-tested/compiled but not browser-tested. Confirm them before building on top.

**Status:** rows 0.1–0.12, 0.15–0.21 and 0.23 are now automated in `e2e/part0-verify.spec.js` (test names carry the row number) and pass. 0.13, 0.14, 0.22 and 0.24 still need a manual pass; see `VERIFICATION-NOTES.md`.

| # | Area | Check |
|---|---|---|
| 0.1 | Folder name escaping (`rendering.ts` `renderTree`) | Drop a folder literally named `<b>x</b>`. Tree shows the characters; no bold, no console error. |
| 0.2 | Keyword grid DOM (`rendering.ts` `updateKeywordGrid`) | Add keywords `a" onmouseover="alert(1)`, `<img src=x onerror=alert(1)>`, `R&D`. Grid renders them literally; clicking each filters correctly. |
| 0.3 | Blank keyword hang (`keyword-regex.ts` `normalizeKeywordList`) | Save a list containing a blank line. Import/scan completes; no frozen tab. Counts unchanged vs the same list without the blank line. |
| 0.4 | Duplicate keywords | `geotextile` + `Geotextile` in one list → one grid cell/keyword, counts not doubled. |
| 0.5 | Zero-result cached search (`pdf-search.ts` `showSearchResults`/`cycleSearch`) | Search term A with hits → search term B with none (then A again, then B). Old yellow marks disappear on B; they do not survive the switch. |
| 0.6 | DOCX zero-result search (`docx-engine.ts`) | Same as 0.5 inside a DOCX: switching to a no-hit term removes `<mark class="doc-highlight">` everywhere. |
| 0.7 | DOCX repeated term (`renderDocHighlights` per-term queue) | DOCX with "tender" three times on one page. Next/Prev highlights 1 → 2 → 3, scrolling each into view; counter agrees. |
| 0.8 | DOCX page offsets (`buildPageOffsets`/`findPageForIndex`) | 10+ page DOCX with one keyword near the end of each page. Every match navigates to the page that actually contains it. |
| 0.9 | Keyword edit rescan (`keywords.ts` `refreshScansAfterKeywordChange`) | Load 3 docs → add a keyword → Save. Tree counts/status update without reloading docs. Remove it → counts drop. Check console for errors from `rescanAllDocuments`. |
| 0.10 | Keyword delete/import | Delete the active custom list: app switches to the fallback list and rescans. Import a list: rescans and shows its counts. |
| 0.11 | Service worker network-first (`service_worker.js`) | Serve `dist/`, DevTools → Application → SW. Reload `/index.html`: Network shows a network response, not `(ServiceWorker)`. Deploy a changed `bundle.js` and confirm a normal reload picks it up. |
| 0.12 | Manifest icon (`src/manifest.json`) | Application → Manifest: icon loads, no 404 for `icons/favicon.ico`. |
| 0.13 | OCR reset (`ocr.ts` `resetOcrState`) | Start OCR on two PDFs, hit "Clear all". No console errors, no stray highlights, OCR workers gone (Sources → Workers), CPU settles. |
| 0.14 | pdf.js cleanup (`file-handler.ts` `extractPdfText`) | Batch-drop 20 PDFs; after completion, heap snapshot shows no growing pdf.js worker/document count. |
| 0.15 | Single-file drop | Drop one PDF: status says "N matches across 1 document". Open measurement tool: key is the bare file name, not `file.pdf/file.pdf`. |
| 0.16 | Failed batch entry cleanup | Drop a folder containing one deliberately corrupt PDF. Tree has no dead entry; cache total does not include it. |
| 0.17 | Scroll page indicator (Phase 2) | 500+ page PDF: scroll fast; page number tracks, no long tasks in Performance attributable to the scroll handler. |
| 0.18 | Chunked page setup (Phase 2) | 500–1,000 page PDF: first page appears without waiting for every page; jump to page N still lands correctly. |
| 0.19 | Prerender window (Phase 2) | Search a keyword hitting 200 pages. Only ~11 canvases render (radius 5). Next/Prev to a far match renders its neighbourhood and the highlight is visible. |
| 0.20 | Canvas eviction (Phase 2) | Scroll through 200 pages: canvas count plateaus near ±30 pages instead of growing. Scroll back: pages re-render, no layout jump, highlights and measurements still correct, text selection works. |
| 0.21 | Rescan concurrency (Phase 2) | 200-document folder → change keyword list → rescan. Tree renders once at the end, progress advances, results correct. Hit Clear all mid-rescan: scan stops without errors. |
| 0.22 | DOCX text from HTML (Phase 2) | 50-page DOCX: import time noticeably lower than before (record both). Match counts identical to a known-good copy; page attribution still correct. |
| 0.23 | Keyword menu reuse (Phase 2) | Next/Prev through matches: the keyword dropdown does not flicker/rebuild; selection follows. |
| 0.24 | OCR pulse (Phase 2) | Start OCR: OCR badge pulses; after completion it stops. No 50 ms timers in Performance. |

---

## Part A — Phase 2 items not done

### A1. Make DOCX highlighting incremental (plan 2.5)
**Why:** `renderDocHighlights` restores the HTML of every page that carries marks and re-walks/re-parses all its text nodes on every match step. It is also called twice per navigation: `performDocSearch`, `cycleDocSearch` and `cycleAllDocKeywords` call it and then `goToDocMatch()`, which calls it again.
**Files:** `src/docx-engine.ts`.
**Change:**
1. Remove the duplicate call: make `goToDocMatch` the owner of highlighting (or give it `{ highlight = true }`), and drop the explicit `renderDocHighlights()` from the three callers.
2. Keep `Map<pageNum, HTMLElement[]>` (or term → mark queue) of created marks. On navigation, remove `.current` from the previous mark and add it to the new one; rebuild a page only when its result set changes.
3. Reuse the per-term FIFO from A1's sibling fix (`pending` map) so mark ↔ result association is stable.
**Verify:** DOCX with 500 matches: Next/Prev is instant; Performance profile shows no `innerHTML` parse per step; current mark scrolls into view; switching query rebuilds only affected pages.
**Commit:** `perf(docx): update highlight state incrementally instead of re-rendering pages`

### A2. Precompute per-keyword match counts for badge/grid (plan 2.8)
**Why:** `updateSidebarBadge` and `updateKeywordGrid` (`src/rendering.ts`) run `filter`/linear scans over `searchResults`/`docSearchResults` on every navigation, per keyword. With thousands of matches this is repeated O(n) work per Next/Prev.
**Files:** `src/rendering.ts`, `src/types.ts` (only if adding a typed cache).
**Change:** when `searchResults`/`docSearchResults` changes, build `{ keyword: { count, indices[] } }` once (keyed by the results array identity + length, invalidated on document/search change). Badge/grid read counts from it; "which occurrence am I on" binary-searches `indices`.
**Verify:** 5,000-match PDF and DOCX: Next/Prev stays smooth; badge and grid numbers stay correct across keyword switch, all-keyword mode, OCR-added matches.
**Commit:** `perf(ui): precompute per-keyword match counts`

### A3. Stream ZIP extraction into processing (plan 2.13)
**Why:** `extractAllFromZip` (`src/file-handler.ts`) builds every `File` **and** `_cachedBuffer` before `processFiles` starts, so a large archive is fully materialised in memory. Extracted `File` objects also keep `_cachedBuffer` alive until the array is dropped.
**Files:** `src/file-handler.ts`.
**Change:** process entries in chunks (8–10) as they are extracted and release each `File`/`_cachedBuffer` once its text has been cached. Either make `processFiles` accept an async iterable or add a `processQueue` shared by the drop path and the ZIP path. Keep per-file size limits, ZIP entry error reporting, `beginResultsBatch`/`endResultsBatch`, and the `MAX_TOTAL_FILES` behaviour.
**Verify:** drop a 400 MB ZIP of PDFs; peak memory (Performance monitor) stays bounded instead of equal to the whole archive; counts identical; cancelling/clearing mid-scan stops cleanly.
**Commit:** `perf(zip): process archive entries incrementally`

---

## Part B — Phase 3 robustness & UX

### B1. Cap the polling loops (plan 3.1)
**Why:** `renderTree`'s `tryActivateAndRender` (`src/rendering.ts`) and `_gsJumpToDoc`'s `tryActivate` (`src/ui.ts`) re-`setTimeout(200)` forever if a document never becomes ready. A failed load leaves timers alive indefinitely.
**Files:** `src/rendering.ts`, `src/ui.ts`.
**Change:** attempt counter + deadline (e.g. 20 attempts / 5 s per stage, 30 s total). On exhaustion write a status-bar error and stop.
**Verify:** load a corrupt PDF, click its tree row/count: polling stops after the deadline; console/status shows one error; no timers in Performance.
**Commit:** `fix(ui): cap document activation polling`

### B2. Null-prototype search cache + explicit dedup flag (plan 3.4)
**Why:** `state.searchCache` is a plain `{}` keyed by user text and also stores a `_deduplicated` sentinel. A keyword named `__proto__`, `constructor` or `_deduplicated` collides with the object prototype or the sentinel.
**Files:** `src/state.ts`, `src/pdf-search.ts`, tests (`src/__tests__/pdf-search.test.js` asserts `_deduplicated`).
**Change:** initialise `state.searchCache = Object.create(null)` in `state.ts` and `resetDocumentState`; move the sentinel to `state._searchDeduplicated: boolean`; update the ~8 references and tests. Also account for the DOCX `_docCounts`/`_docResults` keys currently stuffed into the same object — either type them properly or move them to `state`.
**Verify:** keyword named `__proto__` and `constructor` scan and count correctly; typecheck/tests pass.
**Commit:** `fix(search): use null-prototype cache and explicit dedup flag`

### B3. Measurement key collisions (plan 3.5)
**Why:** `measure.ts` `getDocKey()` returns `entry?.fullPath || url`, but `fullPath` is written from the bare file name in `renderCard`/`renderPlaceholderCard` (`file-handler.ts` passes `file.name`). Two `drawing.pdf` files in different folders share measurements.
**Files:** `src/measure.ts`, `src/file-handler.ts` (`renderCard`, `renderPlaceholderCard`, `extractPdfText`/`extractDocText` callers), `src/rendering.ts`.
**Change:** make `fullPath` always the relative path with folder prefix (`file.relativePath` when present, else `folder + '/' + name`), and use it unconditionally for non-blob keys.
**Verify:** folder with `A/drawing.pdf` and `B/drawing.pdf`: measure one, open the other — measurements are not shared; both persist across reload.
**Commit:** `fix(measure): key measurements by folder-relative path`

### B4. Respect a user-chosen measurement scale (plan 3.6)
**Why:** `pdf-loader.ts` calls `setScale(detected)` whenever text/metadata reveals a scale, overwriting a global scale the user already set.
**Files:** `src/pdf-loader.ts`, `src/measure.ts`.
**Change:** only auto-set when the user has not explicitly set a global scale this session (or when the current scale is still the default); persist the user's choice (`localStorage`) and respect it.
**Verify:** set 1:50, open a drawing containing "1:100": input stays 1:50 and measurements use it. With no user choice, auto-detect still applies.
**Commit:** `fix(measure): prefer user-set scale over auto-detection`

### B5. Legacy `.doc` handling (plan 3.7)
**Why:** `.doc` is accepted by `getFileType` and the file pickers, but Mammoth cannot parse legacy binary Word; users get a generic failure.
**Files:** `src/file-handler.ts`, `src/pdf-loader.ts`/`src/docx-engine.ts` (`getDocTypeFromUrl`), `src/__tests__/file-handler.test.js`, `index.html` accept lists.
**Change:** either reject `.doc` with "Legacy .doc isn't supported — save as .docx" at drop time, or detect the OLE header (`D0 CF 11 E0`) before calling Mammoth and show the same message. Update icons, tests and accept lists.
**Verify:** drop a real `.doc`: clear message, no Mammoth stack trace, tree has no dead entry.
**Commit:** `fix(docx): reject legacy .doc with a clear message`

### B6. Make "clear measurements" semantics explicit (plan 3.8)
**Why:** `measure.ts` `clearAllMeasurements()` only deletes the current document's measurements, but the UI button is titled "Clear all measurements".
**Files:** `src/measure.ts`, `index.html` (button `#clearMeasureBtn`).
**Change:** pick one: rename to `clearMeasurementsForCurrentDoc` + update label/tooltip, or clear every `measurementsByDoc` key behind a confirmation. Choose based on intended UX.
**Verify:** measure two documents; the chosen behaviour matches the label exactly.
**Commit:** `fix(measure): make clear-all semantics explicit`

### B7. Join rotated text runs along the correct axis (plan 3.9)
**Why:** `processTextContent` (in `src/pdf-search.ts`; duplicate in `src/doc_processor_worker.js`) uses `transform[4]` and compares x/y gaps assuming horizontal text. Rotated runs can be misjoined, changing extracted text and therefore matches, even though highlight projection handles rotation.
**Files:** `src/pdf-search.ts`, `src/doc_processor_worker.js`.
**Change:** derive direction from the run transform (e.g. `abs(transform[1]) > abs(transform[0])` ⇒ vertical/rotated) and join along the advance axis; keep both copies in sync (or consolidate them, see D1). Add a fixture test if a rotated PDF is available.
**Verify:** a `/Rotate 90` page with multi-line text: extracted text reads in the right order; keyword counts match the unrotated equivalent; highlights still cover the glyphs.
**Commit:** `fix(pdf): join rotated text runs along the correct axis`

### B8. Audit remaining cache deletions for `_size` accounting (plan 3.3, partially done)
**Why:** the known invalid-entry path in `pdf-loader.ts` now subtracts `_size`, but other `delete state.docTextCache[...]` / `delete state.docContentCache[...]` / `resetLibraryState` sites may still leak budget accounting.
**Files:** `src/file-handler.ts`, `src/pdf-loader.ts`, `src/state.ts`, `src/ocr.ts`.
**Change:** grep every `docTextCache`/`docContentCache` delete and ensure `totalCacheSize` is decremented exactly once; prefer a small helper (`dropPdfCacheEntry(url)`) so the pattern cannot drift.
**Verify:** load/evict/replace documents repeatedly; `state.totalCacheSize` roughly equals the sum of `_size` of live entries.
**Commit:** `fix(cache): centralise cache-entry deletion accounting`

---

## Part C — Findings from review that are not in the original phases

### C1. Two-letter and numeric keywords silently never match — **high**
**Why:** `keyword-regex.ts` `normalizeKeywordMatch` rejects any match shorter than 3 characters or without an ASCII letter. A user adding `AI`, `QC`, `IP`, `GC`, `RFI` or `4500` gets zero matches with no warning (worker has the same rule). `keywords.json` currently has no such entries, so it is latent.
**Files:** `src/keyword-regex.ts`, `src/doc_processor_worker.js`, `src/keywords.ts` (save warning), `src/__tests__/keyword-regex.test.js`.
**Change:** decide the product rule. Recommended: allow 1+ characters, keep the "must contain a letter" rule only if numeric-only keywords should stay unsupported — and if so, warn on save ("N keywords ignored: too short / no letters"). Whatever is chosen, apply it identically in main thread, worker, and OCR.
**Verify:** keywords `AI`, `QC`, `4500` produce expected counts in PDF and DOCX; legacy counts for existing lists unchanged; test expectations updated.
**Commit:** `fix(keywords): stop silently dropping short and numeric keywords`

### C2. Matches that wrap across lines highlight only the first line — **high**
**Why:** `computeMatchCoords` (`src/pdf-search.ts`) and `getTextCoords` (`src/search-controller.ts`) union boxes only when `boxesOverlap` (x **and** y overlap); otherwise the second fragment's box is discarded. A phrase like "heat bonded" split across a line break highlights only "heat". Affects both keyword highlights and inline/global search.
**Files:** `src/pdf-search.ts`, `src/search-controller.ts`, `src/types.ts`, `src/pdf-highlights.ts`, `src/__tests__/pdf-coords.test.js`.
**Change:** return a list of boxes per result (one per line fragment) and render one mark per box, or union unconditionally and accept a taller highlight. Prefer the list — a union across a line gap paints over unrelated text.
**Verify:** a PDF/strong wrap fixture where the keyword spans two lines: both fragments highlighted; current-match styling and scrolling point at the first fragment; tests for both coordinate paths.
**Commit:** `fix(highlights): cover matches that wrap onto a second line`

### C3. Keyword search vs inline/global search use different semantics — **medium**
**Why:** keyword scanning wraps alternatives in `\b…\b`; `searchTextPages` and `countMatchesInAllDocs` (`src/search-controller.ts`) use a bare substring regex. Searching "cat" highlights "category" inline but keyword counts do not include it — the same word shows two totals.
**Files:** `src/search-controller.ts`, `src/keyword-regex.ts`, docs/README.
**Change:** pick and document one rule (recommended: word-bounded for keyword lists, substring for ad-hoc search, since users expect both). If NOT changed, document it in README and make labels clarify ("substring search"). Add a test that pins the intended behaviour.
**Verify:** "cat" in a document containing "category": keyword count and inline count behave as documented, not by accident.
**Commit:** `docs(search): document and pin keyword vs ad-hoc search semantics`

### C4. Global search stalls in a hidden tab — **medium**
**Why:** `countMatchesInAllDocs` chunks with `requestAnimationFrame`; rAF is paused/throttled when the tab is hidden, so a long global search never finishes until refocus.
**Files:** `src/search-controller.ts`.
**Change:** use `setTimeout(0)`/`scheduler.postTask` with a rAF fast path, or fall back to `setTimeout` when `document.hidden`.
**Verify:** start a global search over 400 docs and switch tabs; on return (or in a background tab) the search has completed and the status bar is correct. Add a unit test that runs the chunk loop with rAF stubbed.
**Commit:** `fix(search): keep global search running in a background tab`

### C5. Worker pool starts only on the first rescan — **medium**
**Why:** `initWorkerPool()` is only called from `rescanAllDocuments`/`rescanWithNewKeywords` (`src/file-handler.ts`). On a fresh load `state.workerPool` is null, so `processTextContentAsync` (`src/pdf-search.ts`) silently does text processing synchronously on the main thread for the first imports.
**Files:** `src/file-handler.ts` or `src/pdf-search.ts`.
**Change:** initialise once at startup (after DOM ready) or at the top of `processFiles`/`loadPDF`.
**Verify:** fresh reload → drop a 100-page PDF: main thread does not block in `processTextContent`; worker exists before the first scan (DevTools → Sources → Workers).
**Commit:** `perf(workers): initialise the worker pool before the first import`

### C6. Tesseract is an unpinned CDN import and is never cached — **medium/high for offline**
**Why:** `src/ocr_worker.js` line 1 `importScripts('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js')`. Floating major, no SRI, not in `package.json`/lockfile, not in the service worker cache — OCR needs network on first use and can change under you. It is also re-downloaded when a timeout recreates a worker.
**Files:** `package.json`, `build.js`, `src/ocr_worker.js`, `service_worker.js`, `src/ocr.ts` (worker URL/hash).
**Change:** pin an exact version, self-host `tesseract.min.js` + core + `eng.traineddata` under `dist/`, add them to `LOCAL_ASSETS`, and make the OCR worker URL include the asset hash. Include those files in the build hash (D3).
**Verify:** with DevTools set to offline after one load, OCR still starts and recognises a page; no requests to `cdn.jsdelivr.net`; timed-out worker recreation does not re-download.
**Commit:** `fix(ocr): self-host and pin the Tesseract runtime`

### C7. `keywords.json` load failure is silent — **high**
**Why:** `keywords.ts` `loadKeywords()` catches the fetch error, logs to console, and continues with `KEYWORDS = []`. The app then opens documents and reports "no matches" — the worst failure for a scanner.
**Files:** `src/keywords.ts`, `index.html`/`src/style.css` (warning UI), possibly `src/ui.ts`.
**Change:** set an error flag, show a persistent status-bar/banner warning ("Keyword list failed to load — scanning disabled") with a Retry action, and disable/annotate keyword-dependent UI.
**Verify:** serve `dist/` with `keywords.json` renamed/missing: visible warning + retry works after restoring the file; no silent "0 matches".
**Commit:** `fix(keywords): surface keyword list load failures`

### C8. Silent truncation at 1,000 files — **medium**
**Why:** `file-handler.ts` uses `Math.min(files.length, state.MAX_TOTAL_FILES)` in `processFiles` and `extractAllFromZip` with no notice; a 1,500-file folder silently loses 500.
**Files:** `src/file-handler.ts`.
**Change:** report "N files skipped (limit 1,000)" in the status bar/tree and include it in the final summary.
**Verify:** drop a synthetic folder/ZIP over the cap: skipped count is visible and matches the difference.
**Commit:** `fix(batch): report files skipped by the total-file limit`

### C9. pdf.js is missing CMaps and standard font data — **medium**
**Why:** `pdf-loader.ts` calls `pdfjsLib.getDocument(fileUrl)` with no `cMapUrl`, `standardFontDataUrl` or `isEvalSupported`; `build.js` does not copy `pdfjs-dist/cmaps` or `standard_fonts`. CJK and non-embedded standard-font PDFs render with missing glyphs (the test suite already warns "Ensure that the `standardFontDataUrl` API parameter is provided").
**Files:** `src/pdf-loader.ts`, `src/file-handler.ts` (`extractPdfText`), `build.js`, `service_worker.js` (cache paths).
**Change:** copy `cmaps/` and `standard_fonts/` into `dist/`, pass `cMapUrl`/`cMapPacked`/`standardFontDataUrl`, and set `isEvalSupported: false`.
**Verify:** a PDF with CJK text renders glyphs and highlights correctly; no standard-font warnings; offline load still works after the assets are cached.
**Commit:** `fix(pdf): ship CMaps and standard font data`

### C10. No password-protected PDF support — **medium**
**Why:** no `onPassword` handler anywhere; encrypted PDFs show a generic "Error loading PDF".
**Files:** `src/pdf-loader.ts`, `src/file-handler.ts` (batch extraction), UI for the prompt.
**Change:** pass an `onPassword` callback that prompts and retries; in batch mode report "password-protected, skipped" rather than a generic failure.
**Verify:** an encrypted PDF prompts, accepts the password, renders and scans; wrong password reports clearly; batch drop skips it with a specific message.
**Commit:** `feat(pdf): prompt for password-protected documents`

### C11. `tsconfig` weakens `strict` — **medium**
**Why:** `strict: true` is set but `strictNullChecks: false` and `noImplicitAny: false` override the two checks that catch the most bugs, so typechecking flatters the codebase.
**Files:** `tsconfig.json`, gradually `src/**`.
**Change:** tighten file-by-file starting with pure modules (`keyword-regex`, `highlight-plan`, `canvas-budget`, `cache-size`, `pdf-coords`, `html-text`), then loaders. Do not flip both globally in one commit.
**Verify:** `npm run typecheck` stays green per step; no blanket `any`/`@ts-ignore` added.
**Commit:** `chore(types): enable strict null checks for pure modules` (one per batch)

---

## Part D — Build, CI, docs, dead code

### D1. Delete dead code (plan 4.1)
- `rescanWithNewKeywords` — `src/file-handler.ts` (no live callers; superseded by `rescanAllDocuments`).
- `handleZoomChange` — `src/measure.ts` (no callers).
- `_findCustomResultAfterScroll`, `_findCustomResultBeforeScroll` — `src/ui.ts` (no callers).
- `deleteRawTextContent`, `rawTextContentSize` — `src/raw-text-store.ts` (only tests use them; keep if the tests are the intended API, otherwise move coverage to the cap behaviour).
- `fix-errors.sh` — stale one-off with a hard-coded `/home/kevin/...` path.
- Duplicate type resolution: `getFileType` (`file-handler.ts`), `getDocTypeFromUrl` (`pdf-loader.ts`), `getDocTypeFromUrl` + `getFileTypeSimple` (`docx-engine.ts`) — keep one.
- Duplicate `processTextContent` implementations (`pdf-search.ts`, `doc_processor_worker.js`, plus `processTextContentOnItems`) — consolidate or add a "canonical implementation" comment at each copy.
**Verify:** `rg` for each symbol returns nothing outside tests; typecheck/tests/build green; manual smoke of open/scan/rescan.
**Commit:** `chore: remove dead code and duplicated helpers`

### D2. CI should run typecheck and tests (plan 4.2)
**Why:** `.github/workflows/deploy.yml` only runs `npm install` + `npm run build` on `main`. Type errors and failing tests still deploy.
**Files:** `.github/workflows/deploy.yml` (or a separate `ci.yml`).
**Change:** use `npm ci`; run `npm run typecheck` and `npm test` before `npm run build`; fail the job on either. Consider a PR workflow so breakage is caught before merge.
**Verify:** open a PR with a deliberate type error/failing test: CI fails and deploy does not publish. Revert: green.
**Commit:** `ci: typecheck and test before deploying`

### D3. Build hash must cover every shipped asset (plan 4.3)
**Why:** `build.js` computes `bundleHash` from `dist/bundle.js` only, and uses it for `CACHE_NAME` and `?h=` worker URLs. Changing `style.css`, `keywords.json`, icons, `manifest.json`, the service worker or either worker script leaves the cache name unchanged, so cache-first assets (icons, manifest, `keywords.json`, workers) can stay stale.
**Files:** `build.js`, `service_worker.js`, `src/ocr.ts` (worker URL hash).
**Change:** hash all build inputs (bundle + copied CSS/JSON/icons/manifest/worker scripts + Tesseract assets from C6) and use that hash for `CACHE_NAME` and worker query strings. Add every runtime worker and OCR asset to `LOCAL_ASSETS`.
**Verify:** change only `keywords.json` and rebuild: `CACHE_NAME` changes, reload picks up new keywords. Change only `style.css`: same. Confirm `dist/service_worker.js` has no placeholder.
**Commit:** `build: hash all shipped assets for cache busting`

### D4. Root dev entry registers the source service worker (plan 4.4)
**Why:** root `index.html` registers `'service_worker.js'` (the source file with a literal `__CACHE_VERSION__` and paths like `./bundle.js` that do not exist at the repo root). `README.md` tells you to serve the **repo root** after `npm run build`, so local dev installs a broken SW that can cache the wrong responses. The deployed `dist/index.html` is fine.
**Files:** `README.md`, root `index.html` (or a dev-server script).
**Change:** either serve `dist/` (`python3 -m http.server 8895 --directory dist`) and say so in README, or register `dist/service_worker.js` and make the source SW tolerate placeholders for dev. Prefer serving `dist/`.
**Verify:** follow README exactly on a clean checkout: SW registers without console errors, caches resolve, no `__CACHE_VERSION__` anywhere in Application → Cache Storage.
**Commit:** `docs: serve dist for local development`

### D5. README accuracy
Add scripts (`typecheck`, `test`, `bench`), the build output behaviour, the keyword-list warning (C7), the search semantics decision (C3), OCR offline story (C6), and the supported-file caveat for legacy `.doc` (B5).
**Commit:** `docs: document build, test and runtime caveats`

---

## Part E — Maintenance, robustness, accessibility

### E1. Add lint/format tooling
No ESLint/Prettier config exists while `allowJs: true` worker files sit alongside TypeScript. Add `eslint` + `typescript-eslint` + `prettier`, a `lint` script, and run it in CI (D2). Land formatting as one no-op commit before behaviour changes.
**Commit:** `chore: add eslint and prettier`

### E2. Add an end-to-end smoke test
All 220 tests are unit/jsdom. Add Playwright: load a fixture PDF → assert counts, highlights, next/prev; load a DOCX → assert page attribution and repeated-term navigation; drop a folder with an HTML-ish name → assert literal text. This directly guards the regressions fixed in Phase 1/2.
**Commit:** `test(e2e): add Playwright smoke coverage`

### E3. Tame the module bus / split `ui.ts`
`src/cross.ts` is a mutable `fn` registry plus mutable `KEYWORDS`/`pdfjsLib`, with untyped `fn` and `typeof fn.x === 'function'` guards; `ui.ts` is ~1,390 lines. Plan a later refactor: type the registry with an interface per module and split `ui.ts` into navigation / toolbar / settings / drag-drop. Not urgent; do after the correctness work.
**Commit:** `refactor: type the module registry` (incremental)

### E4. Deduplicate dropped files
Dropping the same file twice creates two object URLs, two tree rows and two cache entries. Key by `name + size + lastModified` (and relative path) and skip/merge duplicates with a status message.
**Verify:** drop the same PDF twice: one entry, no double counts.
**Commit:** `fix(drop): skip duplicate files`

### E5. Terminate the worker pool on clear-all
`ui.clearAllResults()` calls `cancelStale()` but never `terminate()`, so idle workers survive a "Clear all". Call `state.workerPool?.terminate?.()` and null it, then let the next import recreate it (after C5).
**Verify:** Clear all → Sources → Workers shows no doc-processor workers; next drop recreates them.
**Commit:** `fix(workers): tear down the pool on clear all`

### E6. Warn before unloading during OCR/batch
`beforeunload` (`ui.ts`) only revokes object URLs, which is a no-op at that point. Add a `preventDefault`/returnValue guard while OCR or a batch scan is running.
**Verify:** start a scan, close the tab: browser asks for confirmation; after completion it does not.
**Commit:** `fix(ui): warn before closing during scans`

### E7. Accessibility gaps that remain
Most icon buttons already have `aria-label` and status/loader have live regions. Remaining:
- `src/dropdown.ts`: menu items are `div role="option"` with no `tabindex`, yet the code calls `.focus()` on them — keyboard navigation does not work. Give items `tabindex="-1"` (and the trigger proper `aria-expanded`/`aria-controls`), or use a roving tabindex.
- Results tree (`src/rendering.ts`): folder rows and file rows are clickable `<span>`s with no role/tabindex/keyboard activation; add `role="treeitem"`, `tabindex`, Enter/Space handling and arrow-key navigation (or at minimum make folders/files focusable buttons).
**Verify:** keyboard-only: open the keyword dropdown, arrow through options, select with Enter; tab to the tree, expand folders and activate files with Enter/Space; screen reader announces expanded state.
**Commit:** `fix(a11y): keyboard support for dropdown and results tree`

---

## Part F — Feature gaps (highest leverage for tender/bid review)

These are not bugs; do them after Parts A–D unless the product goal changed.

### F1. Export results to CSV/XLSX — **removed at the user's request**
Shipped, then removed (the results panel keeps the shared row builder). Original text:
File, folder, page, keyword, count, snippet. Everything is in `state.docDataCache` + search results already. Include OCR matches flagged as OCR. Add a toolbar action and a unit test on the CSV serializer (escaping quotes/newlines/commas).

### F2. Persist extracted text in IndexedDB
Re-extracting on every reload is the most expensive repeated work. Key by a file hash (e.g. SHA-256 of bytes + name) and hydrate `docTextCache`/`docContentCache` on drop. Include a schema version and a clear-cache action.

### F3. Clickable tree count → filtered results panel
Clicking a count/folder currently cycles matches only. A side panel listing file, page, keyword and snippet, with click-to-jump, would make the tool usable for review rather than sequential clicking.

### F4. Reopen last folder
File System Access API (with `browser-fs-access` fallback) to re-open the last directory and rescan without re-dropping.

---

## Suggested order

1. **Part 0** verification (find regressions from completed work first).
2. **C1, C2, C7** — highest user-visible correctness/trust issues.
3. **C4, C5, C6** + **D2, D3** — reliability and deploy safety.
4. **B1–B8** — robustness.
5. **A1–A3** — remaining perf.
6. **C9, C10, C3, C8, C11**.
7. **D1, D4, D5, E1, E2** — cleanup and regression guardrails.
8. **E4–E7**, then **F1–F4**.

Dependencies/notes:
- C1 and C3 both change match semantics and count expectations; land them together or with tests that pin both rules.
- B2 touches many call sites and tests; do it before A2 if A2 stores keyword indices on state.
- A1 depends on C2's box-list decision only if DOCX and PDF highlighting are unified; otherwise independent.
- D3 must be done before shipping C6 (self-hosted OCR assets need cache busting).
- C11 should follow D2 (CI typecheck) so tightening cannot regress silently.

---

## Invariants to preserve in every change

- Generation tokens and `isCurrentGeneration` guards around async loads/searches.
- `CancelledTaskError` handling and `workerPool.cancelStale`; cancellation is not a failure.
- LRU eviction via `evictCaches()`, `_lastAccess` touches, and `totalCacheSize` accounting.
- Bounded extraction concurrency (`EXTRACT_CONCURRENCY`) and render concurrency (`MAX_CONCURRENT_RENDERS`).
- Page-coordinate projection via `viewport.transform` (`pdf-coords.ts`) for highlights and measurements.
- `beginResultsBatch()` / `endResultsBatch()` around bulk renders.
- New: cached page geometry (`pageHeights`) must survive canvas eviction; eviction must never drop the current-match page or a visible page.
- New: keyword normalization must stay identical in `keyword-regex.ts`, `doc_processor_worker.js`, and OCR.

---

## Browser fixtures worth creating once

1. `repeated-3.docx` — "tender" three times on one page, plus one occurrence near the end of each of 10 pages.
2. `waiting.docx` — 50-page DOCX for import-time comparison (record before/after).
3. `wrap.pdf` — a keyword split across a line break, and one split across a page/column boundary.
4. `rotated.pdf` — `/Rotate 90` with multi-line text.
5. `large-500.pdf` — 500 pages, keyword on 200 of them.
6. `two-folders/` — `A/drawing.pdf`, `B/drawing.pdf`, plus a folder named `<b>x</b>`.
7. `protected.pdf` — encrypted.
8. `many-files/` — 1,500 tiny files (limit notice).
9. `cjk.pdf` — CJK/non-embedded standard fonts (CMaps).
10. `bad.pdf` — truncated PDF (failure paths, polling caps, cache cleanup).
