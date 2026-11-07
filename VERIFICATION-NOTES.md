# Verification notes — open checks and touch-ups

Things that still need a human look, or that I changed and could not fully prove.
Companion to `REMAINING-WORK.md` (the work order); this file is the "did we
actually check it?" list. Delete a line when it has been confirmed, not when it
has been coded.

## Bugs found while verifying (not in the work order)

- **Per-file OCR button does nothing, silently.** `#kwGridOcrBtn` shows for a
  loaded PDF, but clicking it leaves the status bar unchanged and creates no
  worker — `startOcrForFile` (`src/ocr.ts`) returns at one of its three silent
  guards (no `docTextCache` entry, `totalPages` 0, not a `.pdf`), each of which
  only sets `ocrFileState` to `error`. The OCR runtime itself is fine (see C6
  below). Needs a status-bar reason and a fix.
- **Corrupt single-file drop reports success.** Dropping `bad.pdf` alone ends
  with "1 document scanned" and leaves no tree row — a misleading success
  message. `0.16` covers the batch/folder path only.
- **Document loading stalls in a hidden tab.** pdf.js renders through
  `requestAnimationFrame`, which is paused while the tab is hidden, so a
  document opened in the background finishes loading only when you return to the
  tab. C4 fixed this for search only.

## Browser checks still outstanding (Part 0 rows)

Verified: 0.1, 0.2, 0.4, 0.5, 0.6, 0.7, 0.8, 0.15.

Never exercised in a browser:

| Row | What |
|---|---|
| 0.3 | Blank line in a saved keyword list — no hang, counts unchanged |
| 0.9 | Keyword edit → rescan updates tree counts without reloading docs |
| 0.10 | Keyword list delete (falls back) and import (rescans) |
| 0.11 | Service worker network-first for `index.html`/`bundle.js` |
| 0.12 | Manifest icon loads, no 404 for `icons/favicon.ico` |
| 0.13 | OCR on two PDFs + "Clear all" leaves no workers, highlights or CPU burn |
| 0.14 | 20-PDF batch drop leaves no growing pdf.js workers/documents |
| 0.16 | Folder with one corrupt PDF: no dead tree row, cache total excludes it |
| 0.17 | 500-page PDF: page indicator tracks fast scrolling without long tasks |
| 0.18 | 500–1,000 page PDF: first page paints before all pages are set up |
| 0.19 | Prerender window: ~11 canvases around the current match, far jumps work |
| 0.20 | Canvas eviction near ±30 pages; highlights, measurements, selection survive |
| 0.21 | 200-doc rescan renders the tree once; "Clear all" mid-rescan stops cleanly |
| 0.22 | 50-page DOCX import time vs. before; counts and page attribution identical |
| 0.23 | Keyword dropdown not rebuilt on Next/Prev; selection follows |
| 0.24 | OCR badge pulses while running and stops afterwards; no 50 ms timers |

## Changes worth a second look

- **C6 — OCR self-hosting.** Ships ~11 MB into `dist/tesseract/`. Only the LSTM
  cores are included (oem 1 everywhere), and only their `.js` halves, because
  those builds inline the wasm as base64; a future `tesseract.js-core` bump could
  switch back to a sibling `.wasm` file, which would break OCR with a
  "Failed to load TesseractCore" error. Re-check `dist/tesseract/` after any
  dependency bump. `workerBlobURL: false` is deliberate — the blob-worker default
  cannot resolve same-origin paths from the core glue. Core + language data are
  cached on first *use*, not at install, so a fresh profile's first OCR run pulls
  11 MB from the app origin; confirm that is the intended trade.
- **B3 — measurement keys.** Keys are now folder-relative (`A/drawing.pdf`).
  Confirmed via `localStorage.kwpdf_measurements` that two `drawing.pdf` files
  keep separate sets, but the measurement *overlay* did not render in my
  headless run even for the file I measured, so on-screen isolation on
  switching documents is unconfirmed.
- **B7 — rotated text runs.** Both extractors (main thread and
  `doc_processor_worker.js`) now measure gaps along the run's own axis, and unit
  tests cover 90°/270°/adjacent/gapped/sideways cases. Not yet exercised on a
  real PDF whose content stream draws rotated text: `rotated.pdf` uses `/Rotate
  90`, which rotates the page but leaves the text runs horizontal, so it does not
  reach this code. A fixture with `0 1 -1 0 x y Tm` text is worth adding.
- **C2 — wrapped highlights.** Confirmed on `wrap.pdf` (two marks, 40 px and
  60 px). Not checked: a match that wraps across a page or column boundary.
- **D3 — build hash.** `CACHE_NAME` now changes for any shipped file. Note that
  the 11 MB of OCR assets are part of that hash, so any dependency bump also
  invalidates the whole asset cache for every client.

## Re-running the harness

```
npm run build                      # wipes dist/, so regenerate fixtures after
node .verify/make-fixtures.mjs
python3 -m http.server 8895 --bind 127.0.0.1 --directory dist
```

Fixtures live in `dist/fixtures/` (`one-kw`, `mixed`, `wrap`, `rotated`, `large`,
`bad`, `repeated-3.docx`, `waiting.docx`, `two-folders/A|B/drawing.pdf`,
`html-folder/<b>x</b>/plain.pdf`). The service worker is cache-first for assets:
after a rebuild, reload the page and fetch fixtures with a fresh `?v=N`, or you
will get stale bytes.

Useful checks that caught false failures before:

```js
// OCR runtime, without going through the app UI
const w = new Worker('/utils/ocr_worker.js?h=probe');
// draw text on a canvas, toBlob, postMessage {task:'ocr-page', data:{...}}
```

The dev server log (`stderr`) is the reliable record of what was fetched — worker
subrequests do not appear in DevTools-style network logs.

## Part A (performance) — quick browser pass

Dev server `python3 -m http.server 8895 --directory dist`, build `kwpdf-27077841`.

- **A1 incremental DOCX highlights** — `repeated-3.docx` (11 pages, 13 matches): clicking the tree count advances the current mark 0 → 1 → 2 → 3, exactly one `.current` at any time, total marks stay at 13, and a JS expando set on a mark element survives the step (`sameElements: true`), so pages are no longer re-parsed on navigation. Not profiled on a 500-match document, and the query-switch rebuild path was only exercised implicitly.
- **A2 per-keyword counts** — the keyword grid cell read `13` and stayed correct through all-keyword cycling. Not exercised with a 5,000-match document, and the `x/y` occurrence text in all-keyword mode was not confirmed with a multi-keyword document.
- **A3 streamed ZIP** — the work order asks for a 400 MB archive; only a 4-entry archive (`stream-test.zip`, 2.8 KB) was tested. Entries were processed in chunks: three documents landed in the tree under `zipsrc/` with counts 6 / 9 / 13, the deliberately corrupt entry was reported and its row removed (`1 file(s) failed to process`), and the scan reached its summary. Peak memory was not measured, the progress bar read `''` after the scan (full width unconfirmed), and an archive containing exactly one document (which is routed back to the single-file open path) was not exercised.
- `finishResultsIfComplete()` now owns the end-of-scan summary because a streamed archive can shrink its own file count after the last file was processed; that path is only covered by the runs above, not by a unit test.

## B6 — clear-measurements scope

`clearAllMeasurements()` deleted only the open document's entry while its button read "Clear all measurements". The behaviour was kept (the toolbar acts on the open document and the other documents are not reachable from there) and made explicit: the export is now `clearMeasurementsForCurrentDoc()` and the button reads "Clear measurements for this document".

- Unit: `src/__tests__/measure-clear.test.js` seeds storage for two documents and checks that clearing removes one key, persists that removal, leaves the other document's measurements intact, and no-ops with no document open.
- Browser: with `one-kw.pdf` (2) and `mixed.pdf` (1) stored, clicking clear on the open `one-kw.pdf` removed only its key; `mixed.pdf` kept its measurement.
- Caveat: the preview tab does not paint, so `requestAnimationFrame` never fires and measurement overlays never render there, which leaves the button disabled. For this check it was enabled through its normal `updateMeasureUI` path with a placeholder `.measure-line` node, so the overlays appearing/disappearing were not visually confirmed — only the handler's scope and persistence.

## C10 — password-protected PDFs

Encrypted PDFs used to reject the load with no way to supply a password (`getDocument` had no `onPassword`), and in a batch they were reported as a generic extraction failure.

- Single-file: `loadPDF` now sets `loadingTask.onPassword`, which opens a modal (`#passwordDialog`, `src/password-prompt.ts`) and re-asks with "Incorrect password, try again." when pdf.js reports reason 2. Cancelling destroys the loading task and leaves "Password required / drop it again to enter the password" in the loader instead of a bogus PDF error.
- Batch: `extractPdfText` recognises `PasswordException` and reports `Skipped (password-protected)`; the scan adds a note and a status line ("N file(s) skipped (password-protected)") instead of counting encrypted files as failures.
- Test fixture: `dist/fixtures/locked.pdf` is generated ad hoc with Ghostscript (`-sUserPassword=letmein -sOwnerPassword=owner -dEncryptionR=3 -dKeyLength=128`); it is not part of `.verify/make-fixtures.mjs`, so regenerate it by hand before re-running these checks.
- Verified: unit tests in `src/__tests__/password-prompt.test.js` (open/resolve, Enter + empty rejected, cancel, wrong-password text, a second request abandoning the first); browser — dropping `locked.pdf` opened the dialog with the filename and focused input, a wrong password produced the retry text and kept the dialog open, and the correct password decrypted the document (3 pages set up).
- NOT verified: the unlocked document finishing its render and keyword search, because the preview tab never fires `requestAnimationFrame` and the loader parks at "Rendering first page..." (same limitation as the B6 measurement overlays). The batch case was checked separately (batch extraction does not need rAF): `locked.pdf` + `one-kw.pdf` dropped together skipped only the encrypted file with the specific note and scanned the other.
- `ocr.ts` still loads PDFs without an `onPassword` handler, so OCR on an encrypted file fails with its generic error.

## C11 — strict typechecking (first batch: pure modules)

`tsconfig.json` still sets `strictNullChecks: false` and `noImplicitAny: false`, which quietly disables most of `strict`. Rather than flipping them for the whole `src/**` tree at once (411 errors once the loaders are included), `tsconfig.strict.json` extends the base config, turns `strictNullChecks`, `noImplicitAny` and `useUnknownInCatchVariables` on, and lists the files covered so far. `npm run typecheck` now runs both projects, so the covered set can only grow.

- Covered: `keyword-regex`, `highlight-plan`, `canvas-budget`, `cache-size`, `pdf-coords`, `html-text` (all dependency-free, zero errors under the stricter settings).
- Proof the config is not inert: a temporary `const x: string = null` in `html-text.ts` fails the strict project (`TS2322`), and the file was restored.
- Still on the loose settings: everything else. Adding `pdf-loader.ts`, `file-handler.ts` and `ocr.ts` to the strict project currently yields 411 errors (measure 175, file-handler 82, pdf-search 59, ocr 52, pdf-loader 35, pdf-highlights 6, state 2), so each of those needs its own batch.

## D1 — dead code and duplicated helpers

- Removed `rescanWithNewKeywords` (`file-handler.ts`, no callers, superseded by `rescanAllDocuments`), `handleZoomChange` (`measure.ts`, no callers), `_findCustomResultAfterScroll` / `_findCustomResultBeforeScroll` (`ui.ts`, no callers) and `fix-errors.sh` (stale one-off with a hard-coded `/home/kevin/11blog/...` path).
- Kept `deleteRawTextContent` / `rawTextContentSize` in `raw-text-store.ts`: the LRU-cap tests use them as their API, so they now carry a "test-facing" comment instead of being deleted.
- Type resolution: `getFileType` (`file-handler.ts`) stays the only extension parser, and the copies of `getDocTypeFromUrl` in `pdf-loader.ts` and `docx-engine.ts` (plus `getFileTypeSimple`) are replaced by one exported `getDocTypeFromUrl` in `file-handler.ts`. It differs from the old copies in two ways: it strips `?query`/`#hash` before matching an extension, and it returns `null` for `.zip` (the old URL-suffix checks did not know about `.zip` at all).
- `processTextContent` (`pdf-search.ts`) is documented as the canonical implementation; `processTextContentOnItems` in `doc_processor_worker.js` cannot import it and now says so, so a change to one is visible from the other.
- Verified: grep for every removed symbol returns nothing, `npm run typecheck` 0, `npx vitest run` 256 passed / 20 files, `npm run build` 0.
- Browser smoke after the change: dropping `one-kw.pdf` + `mixed.pdf` scanned both (tree rows with 6 and 9 matches, "15 matches across 2 documents"); the rescan path (switching keyword list + Save & Apply) reran both documents and the counts moved to 6 / 7 with "13 matches across 2 documents". Opening a PDF in the viewer still stalls in the preview tab at "Rendering first page..." for the usual `requestAnimationFrame` reason, so the open path itself was only checked through the scan results.

## D2 — CI runs typecheck and tests

- `deploy.yml` already ran `npm run typecheck` and `npm test` before `npm run build`, so the real gaps were that it installed with `npm install` (which silently papered over a `package.json`/lockfile mismatch) and that it only ran on `main`, leaving pull requests with no checks. It now installs with `npm ci`, uses the npm cache, and a new `ci.yml` runs the same four steps (`npm ci`, typecheck, test, build) on every pull request and on pushes to branches other than `main`.
- Verified locally: `npm ci --dry-run` resolves the lockfile (lockfileVersion 3) without touching `node_modules`, and the workflow's steps run green by hand — typecheck 0, 256 tests in 20 files, build 0. Both workflow files parse as YAML.
- NOT verified: an actual GitHub Actions run, including the "deliberate failure blocks the deploy" check, because that needs a pushed PR and pushing is on hold. CI syntax and step order can only be confirmed by a real run.

## D3 — build hash covers every shipped asset

`build.js` already hashed every file it writes to `dist` (plus `service_worker.js`), so `CACHE_NAME` was not bundle-only any more. Three gaps remained:

- The `doc_processor_worker.js` URL in `worker-pool.js` had no hash query (only `ocr.ts` did), so a rebuilt worker script could be served by the cache while the page was the new one. Both workers now use `?h=<build hash>`.
- `LOCAL_ASSETS` did not precache either runtime worker, so the first scan of a session paid for them. They are now precached with the same `?h=` query the app requests (a cache hit needs an exact URL), with a comment saying so.
- `worker-pool.js` reads `__BUNDLE_HASH__` behind a `typeof` guard: esbuild defines it in the shipped bundle, and vitest does not, where an unguarded read would throw in every test that calls `init()`. A test covers both cases.
- Verified by rebuilding in one sequence: the baseline hash was `2ffda515`; appending a newline to `keywords.json` alone gave `8eb66320`; appending a CSS comment to `src/style.css` alone gave `3a2cb9a4`; both files were then restored and the hash returned to `2ffda515`, so only shipped content moves it. (The hash after this commit's own source changes is different again, which is the point.) `dist/service_worker.js` contains no `__CACHE_VERSION__`, and both worker URLs carry the hash in the SW and in `dist/bundle.js`.
- Still lazy (not precached): `cmaps/`, `standard_fonts/`, the Tesseract wasm cores and `eng.traineddata.gz` — several MB that most sessions never touch. They are cached on first use and the cache name changes with them, so they cannot go stale either.
- Browser: after a rebuild the service worker cache was `kwpdf-ae529044` and held `/utils/doc_processor_worker.js?h=ae529044` and `/utils/ocr_worker.js?h=ae529044`, i.e. the precache URL matches the one the app requests, and a keyword-list switch re-scanned both loaded documents through the pool (13 matches across 2) with no worker errors in the console.

## D4 — root dev entry no longer registers a broken service worker

`README.md` already told you to serve `dist/` and explained why the repository root is wrong (that was fixed in an earlier pass). What remained was the failure mode itself: the root `index.html` still registered `service_worker.js` unconditionally, so anyone who served the root anyway installed a cache whose version is the literal `__CACHE_VERSION__` and whose `./bundle.js` does not exist there.

- `index.html` now guards the registration with `/* BUILD_TARGET */ false`; `build.js` rewrites that marker to `true` while writing `dist/index.html` and throws if the marker is missing. The source page can no longer install a service worker, and the built page is unchanged.
- Verified: `index.html` contains the marker as `false`, `dist/index.html` as `true`; `dist/index.html` points at `bundle.js` (no `dist/` prefix); typecheck 0, 257 tests, build 0. With the repo root served (`python3 -m http.server 8896 --directory .`), `index.html` returns 200 while `style.css` is 404 and `service_worker.js` still carries `__CACHE_VERSION__` — the exact broken setup the README warns about, now harmless.
- Browser: opening `http://127.0.0.1:8896/index.html` (repo root served) loads the app but registers nothing — `navigator.serviceWorker.getRegistrations()` is empty, the page is not controlled by a worker, and `caches.keys()` is empty; the console stays silent instead of logging a registration. The dist-served page still registers (`kwpdf-6d66a00f`).

## D5 — README accuracy

Most of what D5 asks for was already in `README.md` from earlier items: the scripts table (including `bench`), the "`npm run build` deletes `dist/` first" note, the keyword-vs-ad-hoc search semantics, the keyword-list failure banner, the self-hosted OCR story and the legacy `.doc` rejection. Three gaps were real and are now fixed:

- The `npm run typecheck` row said `tsc --noEmit`, which stopped being the whole story in C11 (it now also runs the stricter `tsconfig.strict.json` project).
- There was no statement of which formats are accepted, only scattered mentions in the feature list; a "Supported files" section now says PDF, DOCX and ZIP (including folders inside an archive).
- The password behaviour added in C10 was undocumented: a new caveat covers the single-file prompt (including a wrong password and cancelling) and the batch/ZIP skip, and notes that OCR does not prompt.

Docs-only change: no build or test run was needed, and none of the claims are new behaviour — each describes something verified in its own item.

## E1 — lint and format tooling

- `eslint.config.js` (flat config) runs `@eslint/js` recommended plus `typescript-eslint` recommended over `src/**` and the root scripts, ignoring `dist/`, `dist-types/` and `node_modules/`. The esbuild defines (`WORKER_BASE`, `__BUNDLE_HASH__`, `__COMMIT_DATE__`, `KEYWORDS`) and `Tesseract` are declared as globals, so `no-undef` stays meaningful; `.mjs` files (`.verify/`) get Node globals.
- Rule baseline matches the code as it is, not as it should be: `@typescript-eslint/no-explicit-any` off (69 hits, all in modules the strict migration has not reached — re-enable per batch as `tsconfig.strict.json` grows), unused catch bindings ignored, `no-empty` allows empty `catch`. Genuinely unused imports/variables and dead branches stay as errors.
- `npm run lint`, `npm run format`, `npm run format:check`; CI runs lint and format:check between typecheck and tests. Prettier config is 4 spaces, single quotes, 120 columns to match the existing style; the reformat is a separate commit with no behaviour change.
- 12 real findings fixed: unused imports (`getKeywordRegex` in keywords.ts, `fn` in ocr.ts, `ocr` namespace and `RawSearchResult` type in ui.ts, `processTextContent` in pdf-loader.ts, `SearchResult` in pdf-highlights.ts), unused variables (`ocrTotalPages` with both its writes, `hasDocx`, `pageText`, `displayText`, an unused `pageBreak` fixture helper, an unused `saveKeywords`), two `let` → `const`, a parenthesised assignment in a `while`, and an empty `if` branch in the calibrate handler.
- Observation, not changed: the `displayText` removed from `rendering.ts` was computing "3/13"-style match position for the tree count but was never assigned to the span, which always shows the total. If that progress display was intended, it is a bug rather than dead code.
- Verified: eslint 0, `format:check` 0, typecheck 0 (both projects), 257 tests / 20 files, build 0.

## E2 — end-to-end smoke tests

- `playwright.config.js` runs against a real build: the `webServer` command rebuilds (`node build.js`), regenerates fixtures, and serves `dist/` on 127.0.0.1:8897, so `npm run e2e` is self-contained. Chromium only, no retries locally, one retry in CI, trace kept on failure.
- `e2e/smoke.spec.js` drops fixtures through the same path the app uses (`#folderInput` plus a `change` event with a `DataTransfer`), because there is no upload endpoint to drive.
- PDF: `one-kw.pdf` scans to a non-zero tree count; opening it paints `div.highlight-mark` overlays (not `<mark>`, which is the DOCX path) with exactly one `.current`, and next/prev move the counter 1 → 2 → 1.
- DOCX: `waiting.docx` (geotextile on pages 7, 14 … 49) scans to 7, and the current mark sits in the page whose text contains "Section 7", then "Section 14" after one step — the page-attribution regression, asserted on the mark's own page rather than the counter.
- HTML-ish folder: dropping a file under a folder literally named `<b>x</b>` creates no `<b>` element in the sidebar and keeps the characters as text.
- Two findings while writing it: `repeated-3.docx` scans to zero because its text uses "tender", which is not in the shipped keyword list (the fixture only makes sense for ad-hoc search), so the DOCX case uses `waiting.docx`; and a folder name containing slashes (`<b>x</b>`) is split into extra tree levels by the app's path parsing — pre-existing behaviour, so the test asserts escaping rather than nesting.
- CI installs Chromium (`npx playwright install --with-deps chromium`) and runs `npm run e2e` after the build. `test-results/`, `playwright-report/` are gitignored and excluded from ESLint.
- Verified: e2e 3/3 passing, eslint 0, format:check 0, typecheck 0, 257 unit tests.

## E4 — duplicate drops

- Dropping the same file twice used to create a second object URL, a second tree row and a second cache entry, so every count doubled. Files are now identified by `relativePath || name` + `size` + `lastModified` (`fileDedupeKey`), and `processFiles` skips a file whose key is already on an entry in `docDataCache`. Because the keys live on the cache entries, clearing the library (which empties `docDataCache`) resets the check — no separate index to keep in sync.
- The path is part of the key on purpose: `two-folders/A/drawing.pdf` and `two-folders/B/drawing.pdf` are different drawings and both still load.
- Single drop: the status line says "Already loaded: <name>" and nothing is added. Batch/ZIP: skipped files are counted, a "N file(s) skipped — already loaded" note is prepended to the results, and the status line leads with the duplicate count.
- The check runs per file as the batch advances rather than as a pre-filter, because a single drop can contain two copies of the same file and the first one only registers its key when its card is rendered.
- Ordering detail: the status line is set *after* `emit('stats-changed')` in the single-file path, because the stats handler rewrites it (the first e2e attempt read "8 matches across 1 document" instead).
- Verified by a new Playwright case: drop `one-kw.pdf` twice with the same `lastModified` → still one tree row, count unchanged, "Already loaded" in the status bar. Plus eslint 0, format:check 0, typecheck 0, 257 unit tests, 4 e2e tests.

## E6 — warn before closing during a scan

- `beforeunload` only revoked object URLs, which is a no-op while the page is being torn down, so closing the tab mid-scan lost the work silently. It now calls `preventDefault()` and sets `returnValue` while either a multi-file scan/rescan (`isScanRunning()`) or an OCR run (`isOcrRunning()`) is in flight.
- `isScanRunning()` is a counter rather than a boolean because a single-entry archive calls `processFiles()` again from inside the outer batch, so the inner run finishes first. It is incremented around the batch loop and around `rescanAllDocuments`, so rescanning a big library is protected too.
- `isOcrRunning()` is derived from `ocrFileState` (any entry still `processing`) instead of a separate flag, so a run that errors out or is reset cannot leave the guard stuck on.
- The browser shows its own generic message; `returnValue` is only there for engines that still require it.
- Verified by a Playwright case: a dispatched `beforeunload` is not prevented when idle, is prevented while `large.pdf` + `one-kw.pdf` are being scanned (two files, so the batch path runs), and is not prevented again once the scan finishes. Plus eslint 0, format:check 0, typecheck 0, 257 unit tests, 5 e2e tests.
- Not verified: the real browser prompt on an actual tab close (it needs a human or a headed run; a synthetic event only exercises the handler's decision), and the OCR half of the guard end-to-end, since driving Tesseract in the test browser is slow and flaky.

## E7 — keyboard access for the dropdown and results tree

- Dropdown (`src/dropdown.ts`): options were `div role="option"` with no tabindex, so the existing `.focus()` calls (open, arrows, Home/End) silently did nothing. Options are now `tabindex="-1"` — focusable programmatically, still out of the tab order — and every option carries `aria-selected` (it was only set on the selected one before). The trigger carries `aria-expanded` (kept in sync by open/close, `false` instead of removed) and `aria-controls` pointing at the generated menu id, and ArrowDown/ArrowUp on the focused trigger opens the list with the first/last option focused.
- Results tree (`src/rendering.ts`): folder and file rows are spans, so they were mouse-only. Both now get `tabindex="0"`, `role="button"` and an Enter/Space handler that runs the existing click handler (`makeActivatable`), so there is one code path for mouse and keyboard. Folders expose `aria-expanded` and keep it in step with the `open`/`expanded` classes. The match-count and search-count badges stay mouse-only on purpose: they sit inside the row button, and activating the row already cycles the matches.
- `src/style.css`: added a `:focus-visible` outline for `.folder`/`.file`. Note the stylesheet is not in the prettier `format`/`format:check` globs and must not be reformatted — prettier rewrites the attribute selector quotes, which breaks the `textLayer[data-main-rotation="90"]` lookup that `text-layer-rotation.test.js` reads out of the real CSS. (Caught and reverted during this change.)
- Verified by `src/__tests__/dropdown.test.js` (8 cases: ARIA wiring, tabindex, arrow navigation and wrapping, Enter/Space selection, Escape returning focus) and `src/__tests__/rendering-tree.test.js` (6 cases: row role/tabindex, Enter/Space activation reaching `loadDocument`, folder `aria-expanded` plus keyboard collapse/expand, count spans out of the tab order). Plus a Playwright case: focus a tree row, press Enter, the document opens and becomes active. eslint 0, format:check 0, typecheck 0, 271 unit tests, 6 e2e tests.
- Not verified: a screen reader announcing expanded state, and full arrow-key traversal of the tree (file/folder rows are independent tab stops; arrow navigation between rows was not added).
