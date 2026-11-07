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
