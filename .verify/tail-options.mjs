// Renders the callout tail at several root widths and tip caps, at a close and
// a far detail, so the taper range can be compared in one picture.
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

/** Bundle the real module with the two shape constants swapped, then import it. */
async function loadVariant(base, cap) {
    const patched = src
        .replace(/const TAIL_CAP = [\d.]+;/, `const TAIL_CAP = ${cap};`)
        .replace(/const TAIL_BASE_SHARE = [\d.]+;/, `const TAIL_BASE_SHARE = ${base};`);
    const out = await build({
        stdin: { contents: patched, resolveDir: 'src', loader: 'ts' },
        bundle: true,
        format: 'esm',
        write: false,
        logLevel: 'warning',
    });
    const url = 'data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64');
    return import(url);
}

const spots = [
    { id: 'close', label: 'PILE CAP', anchor: { x: 260, y: 320 }, tip: { x: 205, y: 212 } },
    { id: 'long', label: 'SHS COL 150', anchor: { x: 320, y: 620 }, tip: { x: 120, y: 240 } },
];

const variants = [
    { name: 'A current', base: 0.08, cap: 0.26 },
    { name: 'B wider root', base: 0.12, cap: 0.18 },
    { name: 'C much wider, fine point', base: 0.16, cap: 0.1 },
    { name: 'D widest, needle', base: 0.21, cap: 0.06 },
];

const cells = [];

for (const variant of variants) {
    const { calloutShape } = await loadVariant(variant.base, variant.cap);
    for (const spot of spots) {
        const shape = calloutShape(spot.anchor, spot.tip, [spot.label], metrics);
        const b = shape.bounds;
        const scale = Math.min(230 / b.width, 360 / b.height);
        const baseW = Math.hypot(shape.tail.baseA.x - shape.tail.baseB.x, shape.tail.baseA.y - shape.tail.baseB.y);
        const midX = (shape.tail.baseA.x + shape.tail.baseB.x) / 2;
        const midY = (shape.tail.baseA.y + shape.tail.baseB.y) / 2;
        const body = Math.hypot(spot.tip.x - midX, spot.tip.y - midY) || 1;
        const perp =
            Math.abs(
                ((shape.tail.baseA.x - midX) * (spot.tip.y - midY)) / body -
                    ((shape.tail.baseA.y - midY) * (spot.tip.x - midX)) / body,
            ) || baseW / 2;
        const tipW = 2 * Math.max(1.5, perp * variant.cap);

        cells.push(`<figure class="cell">
      <svg viewBox="${b.left} ${b.top} ${b.width} ${b.height}" width="${Math.round(b.width * scale)}" height="${Math.round(
            b.height * scale,
        )}">
        <g transform="translate(${shape.box.left} ${shape.box.top})">
          <path d="${shape.path}" fill="#fff" fill-opacity="0.92" stroke="rgb(255,60,60)" stroke-width="1.5" />
        </g>
        <circle cx="${spot.tip.x}" cy="${spot.tip.y}" r="2" fill="#2b6cff" />
      </svg>
      <figcaption>${spot.id} · base ${baseW.toFixed(0)} · tip ${tipW.toFixed(1)}</figcaption>
    </figure>`);
    }
}

const html = `<!doctype html><meta charset="utf-8">
<style>
  body { margin: 0; background: #eef0f3; font: 12px system-ui, sans-serif; color: #333; }
  .sheet { padding: 14px; }
  .row { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 10px; }
  .name { width: 150px; padding-top: 8px; font-weight: 600; }
  figure { margin: 0; background: #fff; border-radius: 6px; padding: 8px; }
  figcaption { padding-top: 5px; color: #555; }
</style>
<div class="sheet">
${variants
    .map(
        (v, i) =>
            `<div class="row"><div class="name">${v.name}<br><span style="font-weight:400;color:#777">root ${
                v.base * 100
            }%, cap ${Math.round(v.cap * 100)}%</span></div>${cells.slice(i * 2, i * 2 + 2).join('')}</div>`,
    )
    .join('')}
</div>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 800, height: 1000 }, deviceScaleFactor: 2 });
await page.setContent(html);
await page.locator('.sheet').screenshot({ path: '.verify/tail-more.png' });
await browser.close();
fs.writeFileSync('.verify/tail-more.html', html);
console.log('wrote .verify/tail-more.png');
