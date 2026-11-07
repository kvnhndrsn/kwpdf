import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, 'dist');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

let commitDate = '';
try {
    // execFile rather than exec: no shell is spawned, so a checkout path with
    // spaces or shell metacharacters cannot break the build.
    commitDate = execFileSync('git', ['log', '-1', '--format=%cd', '--date=short'], {
        encoding: 'utf8',
        cwd: __dirname,
    }).trim();
} catch (e) {
    /* not a git checkout (tarball / CI export) — the date is optional */
}

const HASH_PLACEHOLDER = 'KWPBF_HASH_PLACEHOLDER_8c3a';

await esbuild.build({
    entryPoints: [path.join(__dirname, 'src/index.js')],
    bundle: true,
    outfile: path.join(dist, 'bundle.js'),
    format: 'iife',
    minify: true,
    define: {
        'process.env.NODE_ENV': '"production"',
        WORKER_BASE: '"utils/"',
        __BUNDLE_HASH__: '"' + HASH_PLACEHOLDER + '"',
        __COMMIT_DATE__: '"' + commitDate + '"',
    },
});

const bundleContent = fs.readFileSync(path.join(dist, 'bundle.js'), 'utf8');

function copy(src, dest) {
    fs.cpSync(path.join(__dirname, src), path.join(dist, dest), { recursive: true });
}

copy('src/style.css', 'style.css');
copy('src/manifest.json', 'manifest.json');
copy('keywords.json', 'keywords.json');
copy('icons', 'icons');
copy('fonts', 'fonts');

let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
// Rewrite asset URLs only. A blanket `dist/` removal also mangles unrelated
// occurrences, such as a link or label that happens to contain that path.
html = html.replace(/(\s(?:src|href)=")dist\//g, '$1');

// index.html is also served from the repository root during development, where
// registering service_worker.js installs a cache whose version is still a
// placeholder and whose ./bundle.js does not exist. The built page is the only
// one that registers it.
const BUILD_TARGET_MARKER = '/* BUILD_TARGET */ false';
if (!html.includes(BUILD_TARGET_MARKER)) {
    throw new Error('Build failed: index.html lost its service worker marker');
}
html = html.replace(BUILD_TARGET_MARKER, '/* BUILD_TARGET */ true');

fs.writeFileSync(path.join(dist, 'index.html'), html);

copy('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'pdf.worker.min.mjs');
// pdf.js needs these next to the app: CMaps for CJK/encoded fonts and
// standard_fonts for the base-14 fonts that PDFs usually leave unembedded.
copy('node_modules/pdfjs-dist/cmaps', 'cmaps');
copy('node_modules/pdfjs-dist/standard_fonts', 'standard_fonts');
copy('src/doc_processor_worker.js', 'utils/doc_processor_worker.js');
copy('src/ocr_worker.js', 'utils/ocr_worker.js');

// OCR runtime, self-hosted (was a floating tesseract.js@5 import from jsDelivr
// inside ocr_worker.js). Pinned in package.json; these copies are what the OCR
// worker loads, so first use needs no network and a version bump cannot change
// behaviour silently.
copy('node_modules/tesseract.js/dist/tesseract.min.js', 'tesseract/tesseract.min.js');
copy('node_modules/tesseract.js/dist/worker.min.js', 'tesseract/worker.min.js');
// tesseract.js picks SIMD or plain at runtime, so both LSTM cores are shipped.
// Only the .js halves: these builds embed the wasm as base64 (a ~3.8 MB inline
// blob, no reference to the sibling .wasm file), so the 2.8 MB .wasm copies
// would never be requested.
for (const core of ['tesseract-core-simd-lstm.wasm.js', 'tesseract-core-lstm.wasm.js']) {
    copy('node_modules/tesseract.js-core/' + core, 'tesseract/' + core);
}
// Integer LSTM (oem 1) language data, 2.9 MB gzipped instead of the 11 MB
// legacy set; tesseract.js decompresses it itself.
copy('node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'tesseract/eng.traineddata.gz');

/**
 * Hash every shipped file, not just the bundle. CACHE_NAME used to come from
 * bundle.js alone, so editing style.css, keywords.json, an icon or a worker
 * left the cache name unchanged and cache-first copies of those files stayed
 * stale until some unrelated bundle change came along.
 */
function hashShippedAssets() {
    const hash = crypto.createHash('md5');
    const files = [];
    const walk = (dir, prefix = '') => {
        for (const name of fs.readdirSync(dir).sort()) {
            const full = path.join(dir, name);
            const rel = prefix ? prefix + '/' + name : name;
            if (fs.statSync(full).isDirectory()) walk(full, rel);
            else files.push([rel, full]);
        }
    };
    walk(dist);
    // Written from source below; its own asset list must bust the cache too.
    files.push(['../service_worker.js', path.join(__dirname, 'service_worker.js')]);
    files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const [rel, full] of files) {
        hash.update(rel);
        hash.update(fs.readFileSync(full));
    }
    return hash.digest('hex').slice(0, 8);
}

const buildHash = hashShippedAssets();
const replacedBundle = bundleContent.replaceAll(HASH_PLACEHOLDER, buildHash);

if (replacedBundle.includes(HASH_PLACEHOLDER)) {
    throw new Error('Build failed: unresolved hash placeholder remains in bundle.js');
}

fs.writeFileSync(path.join(dist, 'bundle.js'), replacedBundle);

let sw = fs.readFileSync(path.join(__dirname, 'service_worker.js'), 'utf8');
sw = sw.replaceAll('__CACHE_VERSION__', buildHash);
if (sw.includes('__CACHE_VERSION__')) {
    throw new Error('Build failed: unresolved cache version placeholder remains in service_worker.js');
}
fs.writeFileSync(path.join(dist, 'service_worker.js'), sw);

console.log('Build complete: dist/bundle.js + dist/pdf.worker.min.mjs + dist/tesseract/ [cache:' + buildHash + ']');
