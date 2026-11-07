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
} catch (e) { /* not a git checkout (tarball / CI export) — the date is optional */ }

const HASH_PLACEHOLDER = 'KWPBF_HASH_PLACEHOLDER_8c3a';

await esbuild.build({
    entryPoints: [path.join(__dirname, 'src/index.js')],
    bundle: true,
    outfile: path.join(dist, 'bundle.js'),
    format: 'iife',
    minify: true,
    define: {
        'process.env.NODE_ENV': '"production"',
        'WORKER_BASE': '"utils/"',
        '__BUNDLE_HASH__': '"' + HASH_PLACEHOLDER + '"',
        '__COMMIT_DATE__': '"' + commitDate + '"',
    },
});

const bundleContent = fs.readFileSync(path.join(dist, 'bundle.js'), 'utf8');
const bundleHash = crypto.createHash('md5')
    .update(bundleContent)
    .digest('hex')
    .slice(0, 8);

const replacedBundle = bundleContent.replaceAll(HASH_PLACEHOLDER, bundleHash);

if (replacedBundle.includes(HASH_PLACEHOLDER)) {
    throw new Error('Build failed: unresolved hash placeholder remains in bundle.js');
}

fs.writeFileSync(path.join(dist, 'bundle.js'), replacedBundle);

function copy(src, dest) { fs.cpSync(path.join(__dirname, src), path.join(dist, dest), { recursive: true }); }

copy('src/style.css', 'style.css');
copy('src/manifest.json', 'manifest.json');
copy('keywords.json', 'keywords.json');
copy('icons', 'icons');
copy('fonts', 'fonts');

let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
// Rewrite asset URLs only. A blanket `dist/` removal also mangles unrelated
// occurrences, such as a link or label that happens to contain that path.
html = html.replace(/(\s(?:src|href)=")dist\//g, '$1');
fs.writeFileSync(path.join(dist, 'index.html'), html);

let sw = fs.readFileSync(path.join(__dirname, 'service_worker.js'), 'utf8');
sw = sw.replaceAll('__CACHE_VERSION__', bundleHash);
if (sw.includes('__CACHE_VERSION__')) {
    throw new Error('Build failed: unresolved cache version placeholder remains in service_worker.js');
}
fs.writeFileSync(path.join(dist, 'service_worker.js'), sw);

copy('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'pdf.worker.min.mjs');
// pdf.js needs these next to the app: CMaps for CJK/encoded fonts and
// standard_fonts for the base-14 fonts that PDFs usually leave unembedded.
copy('node_modules/pdfjs-dist/cmaps', 'cmaps');
copy('node_modules/pdfjs-dist/standard_fonts', 'standard_fonts');
copy('src/doc_processor_worker.js', 'utils/doc_processor_worker.js');
copy('src/ocr_worker.js', 'utils/ocr_worker.js');

console.log('Build complete: dist/bundle.js + dist/pdf.worker.min.mjs [cache:' + bundleHash + ']');
