import { test, expect } from '@playwright/test';
import { openPdf } from './helpers.js';

// The pdf.js 6 upgrade moved image decoding (JPEG 2000, JBIG2, CMYK→RGB, ICC)
// out of the bundle and into WebAssembly the app has to serve itself. When that
// plumbing is wrong a drawing does not fail loudly: it renders blank, grey or
// miscoloured. These tests decode real image fixtures and read the pixels.
//
// JBIG2 has no offline encoder in this environment, so there is no JBIG2 image
// fixture; see the asset test at the end of this file for what is covered.

/** RGBA at a point in PDF user-space points (from the page's top-left). */
async function pixelAt(page, x, y) {
    return page.evaluate(
        ({ x, y }) => {
            const canvas = document.querySelector('#page-1 canvas');
            // No canvas yet: the page exists before its first paint does.
            if (!canvas) return [0, 0, 0, 0];
            const ctx = canvas.getContext('2d');
            const px = Math.round((x / 612) * canvas.width);
            const py = Math.round((y / 792) * canvas.height);
            const d = ctx.getImageData(px, py, 1, 1).data;
            return [d[0], d[1], d[2], d[3]];
        },
        { x, y },
    );
}

/** Wait until the point has opaque ink: a blank page has alpha 0 everywhere. */
async function waitForInk(page, x, y) {
    await expect.poll(async () => (await pixelAt(page, x, y))[3], { timeout: 20_000 }).toBe(255);
}

/**
 * Geometry of page 1's canvas and text layer, plus a real DOM selection over
 * the first run — the same path Ctrl+A and drag-selection take.
 */
async function textLayerInfo(page) {
    return page.evaluate(() => {
        const el = document.getElementById('page-1');
        const canvas = el.querySelector('canvas');
        const layer = el.querySelector('.textLayer');
        if (!canvas || !layer) return null;

        const spans = [...layer.querySelectorAll('span')].filter((s) => s.textContent.trim());
        const first = spans[0];
        const spanStyle = first ? getComputedStyle(first) : null;
        const layerStyle = getComputedStyle(layer);
        const rect = (node) => {
            const r = node.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
        };

        let selected = '';
        if (first) {
            const range = document.createRange();
            range.selectNodeContents(first);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            selected = selection.toString();
        }

        return {
            spanCount: spans.length,
            firstSpanText: first ? first.textContent : '',
            selected,
            fontSize: spanStyle ? parseFloat(spanStyle.fontSize) : 0,
            fontHeight: first ? parseFloat(first.style.getPropertyValue('--font-height')) || 0 : 0,
            scaleFactor: parseFloat(layerStyle.getPropertyValue('--scale-factor')) || 0,
            userUnit: parseFloat(layerStyle.getPropertyValue('--user-unit')) || 0,
            layerTransform: layerStyle.transform,
            layer: rect(layer),
            canvas: rect(canvas),
            span: first ? rect(first) : null,
        };
    });
}

/**
 * The text layer has to sit on the glyphs. pdf.js 6 sizes runs from
 * --font-height and lays them out with --total-scale-factor, so a layer that
 * never gets those rules collapses to the browser default and drifts.
 */
function expectTextLayerAligned(info) {
    expect(info).not.toBeNull();
    expect(info.spanCount).toBeGreaterThan(0);

    const totalScaleFactor = info.scaleFactor * info.userUnit;
    expect(info.fontHeight).toBeGreaterThan(0);
    expect(info.fontSize).toBeGreaterThan(3);
    // font-size: --font-height x --total-scale-factor (see .textLayer in style.css).
    expect(Math.abs(info.fontSize - info.fontHeight * totalScaleFactor)).toBeLessThanOrEqual(
        Math.max(1.5, info.fontSize * 0.2),
    );
    // The smaller box dimension is the font height whether or not the run is
    // rotated, so this catches a span still laid out at the default size.
    expect(Math.min(info.span.w, info.span.h)).toBeGreaterThan(3);
    expect(Math.abs(Math.min(info.span.w, info.span.h) - info.fontSize)).toBeLessThanOrEqual(
        Math.max(2, info.fontSize * 0.35),
    );

    // The layer covers the canvas, and the run sits inside the layer.
    expect(Math.abs(info.layer.w - info.canvas.w)).toBeLessThanOrEqual(2);
    expect(Math.abs(info.layer.h - info.canvas.h)).toBeLessThanOrEqual(2);
    expect(info.span.x).toBeGreaterThanOrEqual(info.layer.x - 2);
    expect(info.span.y).toBeGreaterThanOrEqual(info.layer.y - 2);
    expect(info.span.x + info.span.w).toBeLessThanOrEqual(info.layer.x + info.layer.w + 2);
    expect(info.span.y + info.span.h).toBeLessThanOrEqual(info.layer.y + info.layer.h + 2);

    expect(info.selected.trim()).toBe(info.firstSpanText.trim());
}

test.beforeEach(async ({ page }) => {
    await page.goto('/index.html');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
});

test('decodes a DeviceCMYK image through the wasm colour path', async ({ page }) => {
    await openPdf(page, 'cmyk.pdf');
    // Three 120pt bands: black, paper, 100% cyan. Sample their centres.
    await waitForInk(page, 186, 352);

    const black = await pixelAt(page, 186, 352);
    const paper = await pixelAt(page, 306, 352);
    const cyan = await pixelAt(page, 426, 352);

    expect(Math.max(black[0], black[1], black[2])).toBeLessThan(70);
    expect(Math.min(paper[0], paper[1], paper[2])).toBeGreaterThan(200);
    // 100% cyan keeps green and blue and gives up red. Without the conversion
    // this band would come out black (the raw ink value) or flat grey.
    expect(cyan[1]).toBeGreaterThan(140);
    expect(cyan[2]).toBeGreaterThan(140);
    expect(cyan[0]).toBeLessThan(140);
});

test('decodes a JPEG 2000 image with the openjpeg decoder', async ({ page }) => {
    await openPdf(page, 'jpx.pdf');
    // The fixture's left half is red, its right half green.
    await waitForInk(page, 226, 332);

    const left = await pixelAt(page, 226, 332);
    const right = await pixelAt(page, 386, 332);

    expect(left[0]).toBeGreaterThan(150);
    expect(left[1]).toBeLessThan(120);
    expect(right[1]).toBeGreaterThan(110);
    expect(right[0]).toBeLessThan(120);
});

test('lays the text layer on the glyphs of a /Rotate 90 page', async ({ page }) => {
    await openPdf(page, 'rotated.pdf');
    await expect(page.locator('#page-1 .textLayer')).toBeAttached({ timeout: 20_000 });

    const info = await textLayerInfo(page);
    expectTextLayerAligned(info);
    // The rotated box only lines up if the data-main-rotation rule applies.
    expect(info.layerTransform).not.toBe('none');
});

test('honours /UserUnit when sizing the page and its text layer', async ({ page }) => {
    await openPdf(page, 'userunit.pdf');
    await expect(page.locator('#page-1 .textLayer')).toBeAttached({ timeout: 20_000 });

    // At 1:1 a 612x792 page with /UserUnit 2 is 1224x1584 CSS px. A viewer that
    // drops the unit shows the same proportions at half the size, so only the
    // absolute measurement tells the two apart.
    await page.locator('#zoomActualBtn').click();
    await expect
        .poll(async () => (await textLayerInfo(page))?.canvas.w ?? 0, { timeout: 20_000 })
        .toBeGreaterThan(1200);

    const info = await textLayerInfo(page);
    expect(info.canvas.w).toBeGreaterThan(1218);
    expect(info.canvas.w).toBeLessThan(1230);
    expect(info.userUnit).toBe(2);
    expectTextLayerAligned(info);
});

// JBIG2 needs a bitmap encoder that no offline tool here provides (ImageMagick
// and Ghostscript both decode it, neither encodes it), so the image itself is
// still a manual check. What is covered automatically is the half the upgrade
// actually changed: the decoder assets moving to files the build has to ship.
test('serves every decoder asset the upgraded build has to ship', async ({ page }) => {
    await page.goto('/index.html');

    const assets = await page.evaluate(async () => {
        const names = ['jbig2.wasm', 'jbig2_nowasm_fallback.js', 'openjpeg.wasm', 'qcms_bg.wasm'];
        const out = {};
        for (const name of names) {
            const res = await fetch('wasm/' + name);
            out[name] = { status: res.status, size: (await res.arrayBuffer()).byteLength };
        }
        return out;
    });

    for (const [name, { status, size }] of Object.entries(assets)) {
        expect(status, name).toBe(200);
        expect(size, name).toBeGreaterThan(1024);
    }
});
