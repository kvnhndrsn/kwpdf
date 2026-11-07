import { state } from './state';
import * as dom from './dom';
import { getCurrentDocMeasurements } from './measure';
import { burnMeasurementsIntoPdf, measuredFileName } from './measure-burn';

/** True while a save is in flight, so the toolbar can disable its button. */
let saving = false;

export function isSavingPdf(): boolean {
    return saving;
}

function setStatus(text: string): void {
    if (dom.statusBar) dom.statusBar.textContent = text;
}

/**
 * Page mappers for the open pdf.js document.
 *
 * `getViewport({ scale: 1 })` is the space measurement coordinates are stored
 * in (page elements are sized as viewport × zoom), and `convertToPdfPoint()`
 * is pdf.js's own inverse transform, so rotated pages and non-zero crop boxes
 * land correctly without any hand-written geometry here.
 */
function pageMapperFor(pdfDoc: any) {
    const cache = new Map<number, { toUserSpace(x: number, y: number): { x: number; y: number } } | null>();

    return async (pageNum: number) => {
        if (!cache.has(pageNum)) {
            let mapper = null;
            try {
                const page = await pdfDoc.getPage(pageNum);
                const viewport = page.getViewport({ scale: 1 });
                mapper = {
                    toUserSpace(x: number, y: number) {
                        const point = viewport.convertToPdfPoint(x, y);
                        return { x: point[0], y: point[1] };
                    },
                };
            } catch (e) {
                mapper = null;
            }
            cache.set(pageNum, mapper);
        }
        return cache.get(pageNum);
    };
}

/** The untouched bytes of the open document (object URLs stay valid all session). */
async function readSourceBytes(url: string): Promise<Uint8Array> {
    const response = await fetch(url);
    if (!response.ok) throw new Error('could not read the PDF (' + response.status + ')');
    return new Uint8Array(await response.arrayBuffer());
}

type WriteOutcome = 'saved' | 'downloaded' | 'cancelled';

/**
 * Write the burned bytes to disk. The save picker is used where it exists and
 * remembers its own last folder, so repeat saves are one confirm; everywhere
 * else this falls back to a normal download.
 */
async function writeFile(bytes: Uint8Array, suggestedName: string): Promise<WriteOutcome> {
    const picker = (window as any).showSaveFilePicker;

    if (typeof picker === 'function') {
        let handle: any;
        try {
            handle = await picker.call(window, {
                suggestedName,
                types: [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }],
            });
        } catch (err: any) {
            if (err?.name === 'AbortError') return 'cancelled';
            throw err;
        }
        const writable = await handle.createWritable();
        await writable.write(bytes);
        await writable.close();
        return 'saved';
    }

    const blobUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = suggestedName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(blobUrl);
    return 'downloaded';
}

function describeError(err: any): string {
    const message = String(err?.message || err || 'unknown error');
    if (err?.name === 'EncryptedPDFError' || /encrypted/i.test(message)) {
        return 'This PDF is encrypted, so measurements cannot be written into it';
    }
    return 'Could not save the measured PDF: ' + message;
}

/**
 * Burn the open PDF's measurements into a copy of the file.
 *
 * The source file is never touched: this always writes a new `-measured.pdf`.
 * Returns silently when there is nothing to do (no PDF open, or no
 * measurements), so the caller only has to refresh the toolbar afterwards.
 */
export async function savePdfWithMeasurements(): Promise<void> {
    if (saving) return;

    const url = state.currentDocUrl;
    const pdfDoc = state.pdfDoc;
    if (!url || !pdfDoc || state.currentDocType !== 'pdf') return;

    const measurements = getCurrentDocMeasurements().slice();
    if (measurements.length === 0) {
        setStatus('No measurements to save');
        return;
    }

    const name = measuredFileName(state.docDataCache[url]?.name || 'document.pdf');

    saving = true;
    setStatus('Writing measurements into ' + name + '...');
    try {
        const bytes = await readSourceBytes(url);
        const result = await burnMeasurementsIntoPdf({
            bytes,
            measurements,
            getPage: pageMapperFor(pdfDoc),
        });

        // The document may have been swapped mid-write; never write bytes for
        // one drawing under the name of another.
        if (state.currentDocUrl !== url) {
            setStatus('Measurements not saved \u2014 a different document is open now');
            return;
        }

        const outcome = await writeFile(result.bytes, name);
        if (outcome === 'cancelled') {
            setStatus('Save cancelled');
            return;
        }

        const count = result.drawn + (result.drawn === 1 ? ' measurement' : ' measurements');
        let message = (outcome === 'saved' ? 'Saved ' : 'Downloaded ') + name + ' (' + count + ')';
        if (result.skippedPages.length > 0) {
            message += ' \u2014 skipped page ' + result.skippedPages.join(', ') + ' (not in the PDF)';
        }
        setStatus(message);
    } catch (err) {
        setStatus(describeError(err));
        console.warn('[Measure] Could not write measurements into the PDF:', err);
    } finally {
        saving = false;
    }
}
