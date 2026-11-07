# Manual pass — the four Part 0 rows the test browser cannot see

Rows 0.13, 0.14, 0.22 and 0.24 need a person, a real DevTools panel and real
timings. Everything else is automated in `e2e/part0-verify.spec.js`.

Nothing is needed from your own files: the fixtures are generated.

## Setup (once)

```bash
python3 -m http.server 8895 --directory dist
```

Open <http://localhost:8895/index.html> in Chrome or Edge, then `F12`.

Two panels to keep handy:

- **Performance monitor** — DevTools ⋮ → More tools → Performance monitor. Tick
  *JS heap size*, *DOM Nodes*, *JS event listeners*.
- **Workers** — open <chrome://inspect/#workers> in a second tab. Dedicated
  workers (pdf.js, Tesseract) appear under *Workers* while they are alive.

Drop folders by dragging them from the file manager onto the window, or with the
folder button in the sidebar.

If something looks stale, use DevTools → Application → Service Workers →
*Update on reload*; the app is served by a service worker.

## 0.13 — OCR reset

Goal: starting OCR on two PDFs and hitting "Clear all" must stop everything.

1. Drop the folder `dist/manual/ocr` (two PDFs, 3 pages and 1 page).
2. Wait for the status bar to say "matches across 2 documents".
3. Click `a.pdf` in the tree — the keyword grid on the right shows the file and
   an **OCR** button at its top right.
4. Click **OCR**, then click `b.pdf` in the tree and click **OCR** again.
5. Both rows now show a pulsing OCR badge; the status bar counts pages.
6. Click **Clear all** (the ✕ in the sidebar header) while both are running.
7. Record: does the status bar stop immediately? Any red lines in the Console?
   After ~5 s, does <chrome://inspect/#workers> show zero workers? Does CPU in
   the Performance monitor fall back to idle within ~10 s?

Then the normal finish, to confirm a completed run is clean: drop the folder
again, OCR `a.pdf` only, let it finish (badge becomes **OCR✓**, under a minute),
and check that the console is clean and the tree has no leftover highlights.

## 0.14 — pdf.js cleanup after a 20-file batch

1. Performance monitor: note *JS heap size* and *DOM Nodes* before anything is
   dropped. Click the bin icon in DevTools → Memory first, so garbage is
   collected and the numbers mean something.
2. Drop the folder `dist/manual/heap-batch` (20 PDFs, four of them 120 pages).
3. Wait for "matches across 20 documents", then wait ~10 s and collect garbage
   again. Note heap and DOM nodes. Does <chrome://inspect/#workers> show any
   workers left?
4. Click **Clear all**, wait ~5 s, collect garbage. Note heap and DOM nodes.

Record: baseline → after batch → after clear, for both heap and DOM nodes, plus
the worker count after the batch and after the clear. Growth of a few MB is
normal; a heap that does not fall back after the clear, or workers that stay
listed, is the failure this row is looking for.

## 0.22 — 50-page DOCX import time

1. First remove the text cache, or the second run is served from IndexedDB and
   looks unrealistically fast: Settings → **Clear Cache**, then
   reload.
2. Start a Performance recording, drop `dist/manual/docx/waiting.docx`, and stop
   when the status bar settles. The time to the final "7 matches across 1
   document" is the import time.
3. Repeat twice more, clearing the text cache each time. Record all three.

Then check the result is still correct: the tree count is **7**, and clicking it
opens the results panel with pages **7, 14, 21, 28, 35, 42, 49**.

Note: there is no pre-change build left to compare against — the DOCX-from-HTML
change landed before this work order started — so these numbers become the
baseline. Say so in the report rather than claiming a speedup.

## 0.24 — OCR pulse

1. Enable OCR if the badge does not appear: Settings → OCR toggle (on by
   default).
2. Select a PDF, click **OCR**, and watch the badge.
3. While it runs, in the Console check `document.querySelectorAll('.ocr-pulsing').length`
   — it should be 1 or more, and the badge should visibly pulse.
4. When the run finishes, the same expression must be `0`, the badge shows
   **OCR✓**, and the pulse animation must be gone (Elements → the button has no
   `ocr-pulsing` class; `document.querySelector('.kw-ocr-btn').getAnimations()` is empty).
5. In the Performance monitor, no 50 ms timer should tick while idle. During a
   run, a single status tick every 2 s is expected.

## What to send back

Paste something like this (numbers can be rough):

```
Browser: Chrome 1xx / Edge 1xx on <OS>

0.13 clear-all mid-OCR: status stopped = yes/no, console errors = ..., workers after 5s = ..., CPU idle = yes/no
0.13 completed run: badge = OCR✓, console = clean/dirty, leftover highlights = yes/no
0.14 heap: baseline ... MB -> batch ... MB -> clear ... MB; DOM nodes ... -> ... -> ...; workers after batch = ...
0.22 waiting.docx: 1st ... s, 2nd ... s, 3rd ... s; count = 7; pages = ...
0.24 pulse: during = 1, after = 0; 50 ms timers = yes/no; animation gone = yes/no
```

Anything that looks wrong is more useful than a clean report — that is what
these rows are for.
