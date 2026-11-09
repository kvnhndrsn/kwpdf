// Bends the same tail four ways across the directions that looked wrong, so the
// lean and the level-exit lift can be chosen from pictures instead of guesses.
import { build } from 'esbuild';
import { chromium } from 'playwright';
import fs from 'fs';

const src = fs.readFileSync('src/callout.ts', 'utf8');

const metrics = {
    fontSize: 15,
    lineHeight: 1.25,
    paddingX: 8,
    paddingY: 4,
    radius: 6,
    tailHalfBase: 8,
    strokeWidth: 1.5,
    measureText: (text, size) => text.length * size * 0.58,
};

async function loadVariant(lean, lift) {
    const patched = src
        .replace(/const TAIL_LEAN = -?\d+;/, `const TAIL_LEAN = ${lean};`)
        .replace(/const TAIL_LIFT = [\d.]+;/, `const TAIL_LIFT = ${lift};`);
    const out = await build({
        stdin: { contents: patched, resolveDir: 'src', loader: 'ts' },
        bundle: true,
        format: 'esm',
        write: false,
        logLevel: 'warning',
    });
    return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
}

const anchor = { x: 400, y: 400 };
const spots = [
    { id: 'up-left', tip: { x: 250, y: 300 } },
    { id: 'up-right', tip: { x: 560, y: 310 } },
    { id: 'down-right', tip: { x: 570, y: 500 } },
    { id: 'level left', tip: { x: 180, y: 400 } },
    { id: 'straight up', tip: { x: 410, y: 250 } },
];

const variants = [
    { name: 'lean +1, lift on', lean: 1, lift: 0.5 },
    { name: 'lean -1, lift on', lean: -1, lift: 0.5 },
    { name: 'lean -1, no lift', lean: -1, lift: 0.001 },
    { name: 'lean +1, no lift', lean: 1, lift: 0.001 },
];

const rows = [];

for (const variant of variants) {
    const { calloutShape } = await loadVariant(variant.lean, variant.lift);
    const cells = spots.map(({ id, tip }) => {
        const shape = calloutShape(anchor, tip, ['SHS COL 150'], metrics);
        const b = shape.bounds;
        const scale = Math.min(200 / b.width, 300 / b.height);
        const mid = (shape.tail.baseA.x + shape.tail.baseB.x) / 2;
        const share = (mid - shape.box.left) / shape.box.width;

        return `<figure>
          <svg viewBox="${b.left} ${b.top} ${b.width} ${b.height}" width="${Math.round(b.width * scale)}" height="${Math.round(
              b.height * scale,
          )}">
            <g transform="translate(${shape.box.left} ${shape.box.top})">
              <path d="${shape.path}" fill="#fff" fill-opacity="0.92" stroke="rgb(255,60,60)" stroke-width="1.5" />
            </g>
            <circle cx="${tip.x}" cy="${tip.y}" r="2" fill="#2b6cff" />
          </svg>
          <figcaption>${id} · ${shape.tail.edge} · ${(share * 100).toFixed(0)}%</figcaption>
        </figure>`;
    });
    rows.push(`<div class="row"><div class="name">${variant.name}</div>${cells.join('')}</div>`);
}

const html = `<!doctype html><meta charset="utf-8">
<style>
  body { margin: 0; background: #eef0f3; font: 11px system-ui, sans-serif; color: #333; }
  .sheet { padding: 12px; }
  .row { display: flex; gap: 10px; align-items: flex-start; margin-bottom: 8px; }
  .name { width: 120px; padding-top: 6px; font-weight: 600; }
  figure { margin: 0; background: #fff; border-radius: 5px; padding: 6px; }
  figcaption { padding-top: 4px; color: #555; }
</style>
<div class="sheet">${rows.join('')}</div>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 1300 }, deviceScaleFactor: 1.6 });
await page.setContent(html);
await page.locator('.sheet').screenshot({ path: '.verify/bend-sheet.png' });
await browser.close();
fs.writeFileSync('.verify/bend-sheet.html', html);
console.log('wrote .verify/bend-sheet.png');
