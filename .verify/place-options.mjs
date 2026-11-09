// Six details around one bubble, so the exit edge and its position along that
// edge can be checked at a glance.
import { build } from 'esbuild';
import { chromium } from 'playwright';
import fs from 'fs';

const out = await build({
    entryPoints: ['src/callout.ts'],
    bundle: true,
    format: 'esm',
    write: false,
    logLevel: 'warning',
});
const { calloutShape } = await import(
    'data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64')
);

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

const anchor = { x: 400, y: 400 };
const spots = [
    { id: 'up-left', tip: { x: 250, y: 300 } },
    { id: 'up-right', tip: { x: 560, y: 310 } },
    { id: 'straight up', tip: { x: 410, y: 250 } },
    { id: 'down-left', tip: { x: 240, y: 520 } },
    { id: 'down-right', tip: { x: 570, y: 500 } },
    { id: 'level left', tip: { x: 180, y: 400 } },
];

const cells = spots.map(({ id, tip }) => {
    const shape = calloutShape(anchor, tip, ['SHS COL 150'], metrics);
    const b = shape.bounds;
    const scale = Math.min(260 / b.width, 380 / b.height);
    const mid = (shape.tail.baseA.x + shape.tail.baseB.x) / 2;
    const share = (mid - shape.box.left) / shape.box.width;
    const width = Math.hypot(shape.tail.baseA.x - shape.tail.baseB.x, shape.tail.baseA.y - shape.tail.baseB.y);

    return `<figure>
      <svg viewBox="${b.left} ${b.top} ${b.width} ${b.height}" width="${Math.round(b.width * scale)}" height="${Math.round(
          b.height * scale,
      )}">
        <g transform="translate(${shape.box.left} ${shape.box.top})">
          <path d="${shape.path}" fill="#fff" fill-opacity="0.92" stroke="rgb(255,60,60)" stroke-width="1.5" />
        </g>
        <circle cx="${tip.x}" cy="${tip.y}" r="2" fill="#2b6cff" />
      </svg>
      <figcaption>${id} · ${shape.tail.edge} · exit ${(share * 100).toFixed(0)}% from left · root ${width.toFixed(0)}</figcaption>
    </figure>`;
});

const html = `<!doctype html><meta charset="utf-8">
<style>
  body { margin: 0; background: #eef0f3; font: 12px system-ui, sans-serif; color: #333; }
  .sheet { padding: 14px; display: grid; grid-template-columns: repeat(3, max-content); gap: 12px; }
  figure { margin: 0; background: #fff; border-radius: 6px; padding: 8px; }
  figcaption { padding-top: 5px; color: #555; }
</style>
<div class="sheet">${cells.join('')}</div>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 2 });
await page.setContent(html);
await page.locator('.sheet').screenshot({ path: '.verify/place-sheet.png' });
await browser.close();
fs.writeFileSync('.verify/place-sheet.html', html);
console.log('wrote .verify/place-sheet.png');
