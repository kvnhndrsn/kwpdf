# kwpdf

A document viewer for PDF and DOCX files that automatically scans documents against a keyword list and lets you quickly jump between matches.

<img src="https://kvnhndrsn.github.io/projects/kwpdf.gif" height="480">

## Features

- **Keyword scanning** — documents are searched against a pre-defined keyword list on open
- **Global search & cross-file navigation** — search and jump between matches across all loaded files
- **Measurement tools** — calibrated distance, perimeter, and area measurements on PDF pages
- **ZIP file support** — drag and drop zip file right from file explorer, email or browser downloads 
- **OCR support** (beta) — extract text from scanned PDFs via Tesseract.js

## Getting Started

```bash
git clone https://github.com/kvnhndrsn/kwpdf
cd kwpdf/
npm install
npm run build
python3 -m http.server 8895 --directory dist
```

Open http://localhost:8895/index.html in your browser.

Serve **`dist/`**, not the repository root. The root `index.html` is a source file
that registers `service_worker.js` with an unresolved cache version, so serving it
installs a service worker that caches broken responses.

### Scripts

| Command | What it does |
|---|---|
| `npm run build` | Bundles into `dist/` (bundle, service worker, pdf.js worker, CMaps, standard fonts) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest, single run |
| `npm run bench` | Vitest benchmarks (`src/__tests__/perf.bench.js`) |

`npm run build` deletes `dist/` first, so anything you put there by hand is gone
after a rebuild.

## Caveats

- **Keyword vs. ad-hoc search.** Keyword scans match whole words (`\bterm\b`), so
  the keyword `cat` does not count `category`. The inline/global search box is a
  plain substring search, so it does. The two totals can therefore differ for the
  same text; this is intentional (see `src/__tests__/search-controller.test.js`).
- **Keyword list failures are visible.** If `keywords.json` cannot be fetched the
  app shows a banner with a Retry action instead of silently reporting no matches.
- **Legacy `.doc` is not supported.** Mammoth only reads `.docx`; save binary
  Word files as `.docx` first.
- **OCR is self-hosted.** The Tesseract runtime, its wasm core and the eng
  language data ship in `dist/tesseract/` (copied from the pinned
  `tesseract.js`, `tesseract.js-core` and `@tesseract.js-data/eng` packages), so
  OCR needs no CDN. The two small scripts are precached; the wasm cores and
  language data (~11 MB, wasm inlined in the core scripts) are cached on first
  OCR use, so the first run after a fresh install reads them from the app's own
  origin and later runs work offline.
- **Background tabs.** pdf.js renders through `requestAnimationFrame`, which is
  paused in a hidden tab; a document opened while the tab is in the background
  finishes loading when you return to it.

### Customizing Keywords

Edit `keywords.json` to define your own keyword lists before serving the page.

## Built With

- [PDF.js](https://mozilla.github.io/pdf.js/) — PDF rendering
- [jszip](https://stuk.github.io/jszip/) — ZIP file support
- [Mammoth.js](https://github.com/mwilliamson/mammoth.js/) — DOCX conversion
- [Tesseract.js](https://tesseract.projectnaptha.com/) — OCR engine
- [esbuild](https://esbuild.github.io/) — bundling

## License

MIT — see [LICENSE.md](LICENSE.md).
