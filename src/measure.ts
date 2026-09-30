import { state } from './state';
import * as dom from './dom';

// ── state ──

/** @type {'distance'|'polyline'|'area'|null} */
let activeTool = null;
/** @type {number} the ratio in "1:{scaleRatio}" */
let scaleRatio = 100;
/** @type {Object<string, Array<{id:string, type:string, points:Array, label:string, areaMm2?:number}>>} */
let measurementsByDoc = {};
/** @type {Array<{page:number, x:number, y:number}>} */
let pendingPoints = [];
/** @type {{x1:number, y1:number, x2:number, y2:number}|null} */
let previewLine = null;
/** @type {number|null} */
let activePageNum = null;
/** @type {boolean} */
let isMouseListening = false;

/** @type {boolean} scale calibration mode */
let isCalibrating = false;
/** @type {number} known distance in meters entered by user */
let calibrationMeters = 0;
/** @type {{page:number, x:number, y:number}|null} first clicked point during calibration */
let calibrationPoint = null;

const STORAGE_KEY = 'kwpdf_measurements';
const SCALE_STORAGE_KEY = 'kwpdf_measure_scale';
const MAX_SCALE = 10000000;

// ── stable doc key (filenames persist across reloads, blob URLs don't) ──

function getDocKey() {
    const url = state.currentDocUrl;
    if (!url) return null;
    const entry = state.docDataCache[url];
    return entry?.fullPath || url;
}

// ── persistence ──

function loadMeasurements() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) measurementsByDoc = JSON.parse(raw);
    } catch (e) { /* ignore */ }
}

function saveMeasurements() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(measurementsByDoc));
    } catch (e) { /* quota exceeded, ignore */ }
}

function loadScale() {
    try {
        const raw = localStorage.getItem(SCALE_STORAGE_KEY);
        if (raw) {
            const parsed = parseFloat(raw);
            if (!isNaN(parsed) && parsed >= 0.001 && parsed <= MAX_SCALE) scaleRatio = parsed;
        }
    } catch (e) { /* ignore */ }
}

function saveScale() {
    try {
        localStorage.setItem(SCALE_STORAGE_KEY, String(scaleRatio));
    } catch (e) { /* ignore */ }
}

loadMeasurements();
loadScale();

// ── helpers (PDF 1x space ↔ real-world) ──

const POINTS_PER_MM = 72 / 25.4;

/** @param {number} pdfPts */
export function pdfToMm(pdfPts) {
    return pdfPts / POINTS_PER_MM;
}

/** @param {number} pdfPts */
export function realWorldMm(pdfPts) {
    return pdfToMm(pdfPts) * scaleRatio;
}

export function addCommas(n) {
    const parts = n.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
}

/** @param {number} totalMm */
export function formatLength(totalMm) {
    if (totalMm < 0) totalMm = 0;
    if (totalMm < 10) return Math.round(totalMm) + ' mm';
    if (totalMm < 1000) return (totalMm / 10).toFixed(1) + ' cm';
    return addCommas((totalMm / 1000).toFixed(2)) + ' m';
}

/** @param {number} mm2 */
export function formatArea(mm2) {
    if (mm2 < 0) mm2 = 0;
    if (mm2 < 100) return Math.round(mm2) + ' mm\xB2';
    if (mm2 < 10000) return (mm2 / 100).toFixed(1) + ' cm\xB2';
    return addCommas((mm2 / 1000000).toFixed(2)) + ' m\xB2';
}

/** @param {Array<{x:number, y:number}>} points */
export function simplePolygonArea(points) {
    let sum = 0;
    for (let i = 0; i < points.length; i++) {
        const j = (i + 1) % points.length;
        sum += points[i].x * points[j].y;
        sum -= points[j].x * points[i].y;
    }
    return Math.abs(sum) / 2;
}

/** @param {{x:number, y:number, page?:number}} p1 @param {{x:number, y:number, page?:number}} p2 @param {{x:number, y:number, page?:number}} p3 @param {{x:number, y:number, page?:number}} p4 */
export function getIntersection(p1, p2, p3, p4) {
    const denom = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);
    if (Math.abs(denom) < Number.EPSILON) return null;

    const t = ((p1.x - p3.x) * (p3.y - p4.y) - (p1.y - p3.y) * (p3.x - p4.x)) / denom;
    const u = -((p1.x - p2.x) * (p1.y - p3.y) - (p1.y - p2.y) * (p1.x - p3.x)) / denom;

    if (t > 0.00001 && t < 0.99999 && u > 0.00001 && u < 0.99999) {
        return {
            page: p1.page,
            x: p1.x + t * (p2.x - p1.x),
            y: p1.y + t * (p2.y - p1.y)
        };
    }
    return null;
}

/** @param {Array<{page?:number, x:number, y:number}>} points */
export function decomposePolygon(points) {
    if (points.length < 3) return [];

    for (let i = 0; i < points.length; i++) {
        const next_i = (i + 1) % points.length;
        const p1 = points[i], p2 = points[next_i];

        for (let j = i + 2; j < points.length; j++) {
            if (i === 0 && j === points.length - 1) continue;

            const next_j = (j + 1) % points.length;
            const p3 = points[j], p4 = points[next_j];

            const intersection = getIntersection(p1, p2, p3, p4);

            if (intersection) {
                const polyA = [intersection];
                for (let k = next_i; k !== next_j; k = (k + 1) % points.length) {
                    polyA.push(points[k]);
                }

                const polyB = [intersection];
                for (let k = next_j; k !== next_i; k = (k + 1) % points.length) {
                    polyB.push(points[k]);
                }

                return [...decomposePolygon(polyA), ...decomposePolygon(polyB)];
            }
        }
    }

    return [points];
}

/** @param {{x:number, y:number}} p1 @param {{x:number, y:number}} p2 */
export function distanceBetween(p1, p2) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    return Math.sqrt(dx * dx + dy * dy);
}

/** @param {{x:number, y:number}} p1 @param {{x:number, y:number}} p2 @param {boolean} snap */
export function snapAngle45(p1, p2, snap) {
    if (!snap) return p2;
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 0.5) return p2;
    const angle = Math.atan2(dy, dx);
    const snapped = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
    return { x: p1.x + dist * Math.cos(snapped), y: p1.y + dist * Math.sin(snapped) };
}

/** @param {Array<{x:number, y:number}>} points @param {boolean} [closed] */
export function polylineLength(points, closed) {
    let total = 0;
    const n = closed ? points.length : points.length - 1;
    for (let i = 0; i < n; i++) {
        total += distanceBetween(points[i], points[(i + 1) % points.length]);
    }
    return total;
}

// ── page → PDF coordinate conversion ──

/** @param {MouseEvent} e @returns {{page:number, x:number, y:number}|null} */
function pageEventToPdfCoords(e) {
    let el = e.target;
    while (el && !el.id?.startsWith('page-')) el = el.parentElement;
    if (!el) return null;
    const pageNum = parseInt(el.id.replace('page-', ''));
    if (isNaN(pageNum)) return null;
    const rect = el.getBoundingClientRect();
    const xPx = e.clientX - rect.left;
    const yPx = e.clientY - rect.top;
    const scale = state.currentScale || 1;
    return { page: pageNum, x: xPx / scale, y: yPx / scale };
}

// ── public API ──

/** @param {number|string} value */
export function setScale(value) {
    const parsed = parseFloat(value);
    if (isNaN(parsed) || parsed < 0.001 || parsed > MAX_SCALE) return;
    scaleRatio = parsed;
    saveScale();
}

export function getScale() {
    return scaleRatio;
}

export function getActiveTool() {
    return activeTool;
}

/** @param {'distance'|'polyline'|'area'} tool */
export function activateTool(tool) {
    if (isCalibrating) cancelCalibration();
    if (activeTool === tool) {
        deactivateTool();
        return;
    }
    deactivateTool();
    activeTool = tool;
    pendingPoints = [];
    previewLine = null;
    activePageNum = null;
    if (!isMouseListening) {
        dom.viewerScroll.addEventListener('mousemove', onMouseMove);
        isMouseListening = true;
    }
    dom.viewerScroll.classList.add('is-measuring');
}

export function deactivateTool() {
    activeTool = null;
    pendingPoints = [];
    previewLine = null;
    activePageNum = null;
    if (isMouseListening) {
        dom.viewerScroll.removeEventListener('mousemove', onMouseMove);
        isMouseListening = false;
    }
    dom.viewerScroll.classList.remove('is-measuring');
    ['measureDistBtn', 'measurePerimBtn', 'measureAreaBtn'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.classList.remove('active-tool');
    });
    renderAllMeasurements();
}

export function cancelMeasurement() {
    pendingPoints = [];
    previewLine = null;
    activePageNum = null;
    renderAllMeasurements();
}

export function clearAllMeasurements() {
    const url = getDocKey();
    if (!url) return;
    delete measurementsByDoc[url];
    saveMeasurements();
    markCommittedDirty();
    renderAllMeasurements();
}

export function getIsCalibrating() {
    return isCalibrating;
}

export function startCalibration() {
    if (activeTool) deactivateTool();
    cancelCalibration();
    isCalibrating = true;
    calibrationPoint = null;
    calibrationMeters = 0;
    if (!isMouseListening) {
        dom.viewerScroll.addEventListener('mousemove', onMouseMove);
        isMouseListening = true;
    }
    dom.viewerScroll.classList.add('is-measuring');
    const scaleInput = document.getElementById('scaleInput') as HTMLInputElement;
    if (scaleInput) {
        scaleInput.value = '';
        scaleInput.placeholder = 'm';
        scaleInput.title = 'Enter known distance in meters, then click two points on the PDF';
        scaleInput.focus();
    }
    renderAllMeasurements();
}

export function cancelCalibration() {
    isCalibrating = false;
    calibrationMeters = 0;
    calibrationPoint = null;
    previewLine = null;
    activePageNum = null;
    if (isMouseListening && !activeTool) {
        dom.viewerScroll.removeEventListener('mousemove', onMouseMove);
        isMouseListening = false;
    }
    dom.viewerScroll.classList.remove('is-measuring');
    const scaleInput = document.getElementById('scaleInput') as HTMLInputElement;
    if (scaleInput) {
        scaleInput.placeholder = '1:XXX';
        scaleInput.title = 'Scale 1:X';
        scaleInput.value = '1:' + scaleRatio;
    }
    const btn = document.getElementById('calibrateScaleBtn');
    if (btn) btn.classList.remove('active-tool');
    renderAllMeasurements();
}

/** @param {string} id */
export function deleteMeasurement(id) {
    const url = getDocKey();
    if (!url || !measurementsByDoc[url]) return;
    measurementsByDoc[url] = measurementsByDoc[url].filter(m => m.id !== id);
    saveMeasurements();
    markCommittedDirty();
    renderAllMeasurements();
}

/** @param {string} url */
export function getDocMeasurements(url) {
    return measurementsByDoc[url] || [];
}

// ── click handling ──

/** @param {MouseEvent} e */
export function onPageClick(e) {
    if (isCalibrating) {
        handleCalibrationClick(e);
        return;
    }
    if (!activeTool) return;
    const coords = pageEventToPdfCoords(e);
    if (!coords) return;

    let pt = coords;
    if (e.shiftKey && pendingPoints.length > 0) {
        const snapped = snapAngle45(pendingPoints[pendingPoints.length - 1], coords, true);
        pt = { ...coords, x: snapped.x, y: snapped.y };
    }

    if (activeTool === 'distance') {
        handleDistanceClick(pt);
    } else if (activeTool === 'perimeter') {
        handlePerimeterClick(pt);
    } else if (activeTool === 'area') {
        handlePerimeterClick(pt);
    }
}

/** @param {{page:number, x:number, y:number}} coords */
function handleDistanceClick(coords) {
    if (pendingPoints.length === 0) {
        pendingPoints.push(coords);
        activePageNum = coords.page;
        renderAllMeasurements();
        return;
    }

    if (pendingPoints.length === 1) {
        if (pendingPoints[0].page !== coords.page) {
            pendingPoints = [coords];
            activePageNum = coords.page;
            renderAllMeasurements();
            return;
        }
        pendingPoints.push(coords);
        finalizeDistance();
    }
}

function generateId() {
    return Date.now() + '_' + Math.random().toString(36).slice(2, 6);
}

// ── calibration ──

/** @param {MouseEvent} e */
function handleCalibrationClick(e) {
    if (!isCalibrating) return;

    const scaleInput = document.getElementById('scaleInput') as HTMLInputElement;
    const meters = parseFloat(scaleInput?.value);
    if (isNaN(meters) || meters <= 0) {
        if (scaleInput) { scaleInput.focus(); scaleInput.select(); }
        return;
    }

    const coords = pageEventToPdfCoords(e);
    if (!coords) return;

    if (!calibrationPoint) {
        calibrationMeters = meters;
        calibrationPoint = coords;
        activePageNum = coords.page;
        renderAllMeasurements();
        return;
    }

    if (calibrationPoint.page !== coords.page) {
        calibrationPoint = coords;
        activePageNum = coords.page;
        renderAllMeasurements();
        return;
    }

    // Re-read meters in case user changed the value after first click
    const currentMeters = parseFloat(scaleInput?.value);
    if (isNaN(currentMeters) || currentMeters <= 0) return;
    calibrationMeters = currentMeters;

    const pdfDist = distanceBetween(calibrationPoint, coords);
    if (pdfDist < 0.5) {
        calibrationPoint = coords;
        renderAllMeasurements();
        return;
    }

    const computedScale = calibrationMeters * 1000 * POINTS_PER_MM / pdfDist;
    const clamped = Math.max(0.001, Math.min(MAX_SCALE, computedScale));
    const rounded = Math.round(clamped);

    setScale(rounded);
    saveScale();

    if (scaleInput) {
        scaleInput.value = '1:' + rounded;
        scaleInput.placeholder = '1:XXX';
        scaleInput.title = 'Scale 1:X';
    }

    renderAllMeasurements();
    cancelCalibration();
}

function finalizeDistance() {
    const url = getDocKey();
    if (!url || pendingPoints.length < 2) return;
    if (!measurementsByDoc[url]) measurementsByDoc[url] = [];

    const p1 = pendingPoints[0];
    const p2 = pendingPoints[1];
    const pdfDist = distanceBetween(p1, p2);
    const realMm = realWorldMm(pdfDist);
    const label = formatLength(realMm) + ' @ 1:' + scaleRatio;

    measurementsByDoc[url].push({
        id: generateId(),
        type: 'distance',
        points: [p1, p2],
        label
    });

    pendingPoints = [];
    previewLine = null;
    activePageNum = null;
    saveMeasurements();
    markCommittedDirty();
    renderAllMeasurements();
    deactivateTool();
}

// ── perimeter ──

/** @param {{page:number, x:number, y:number}} coords */
function handlePerimeterClick(coords) {
    if (pendingPoints.length === 0) {
        pendingPoints.push(coords);
        activePageNum = coords.page;
        renderAllMeasurements();
        return;
    }
    if (coords.page !== activePageNum) return;
    pendingPoints.push(coords);
    renderAllMeasurements();
}

function finalizePerimeter() {
    const url = getDocKey();
    if (!url || pendingPoints.length < 2) return;
    if (!measurementsByDoc[url]) measurementsByDoc[url] = [];

    let totalPdf = 0;
    for (let i = 0; i < pendingPoints.length - 1; i++) {
        totalPdf += distanceBetween(pendingPoints[i], pendingPoints[i + 1]);
    }
    const realMm = realWorldMm(totalPdf);
    const label = formatLength(realMm) + ' @ 1:' + scaleRatio;

    measurementsByDoc[url].push({
        id: generateId(),
        type: 'polyline',
        points: pendingPoints.slice(),
        label
    });

    pendingPoints = [];
    previewLine = null;
    activePageNum = null;
    saveMeasurements();
    markCommittedDirty();
    renderAllMeasurements();
}

export function finishPerimeter() {
    if (activeTool !== 'perimeter' || pendingPoints.length < 2) return;
    finalizePerimeter();
    deactivateTool();
}

// ── area ──

function finalizeArea() {
    const url = getDocKey();
    if (!url || pendingPoints.length < 3) return;
    if (!measurementsByDoc[url]) measurementsByDoc[url] = [];

    const subPolygons = decomposePolygon(pendingPoints);

    for (const poly of subPolygons) {
        if (poly.length < 3) continue;

        const pdfArea = simplePolygonArea(poly);
        const realMm2 = pdfArea / (POINTS_PER_MM * POINTS_PER_MM) * scaleRatio * scaleRatio;

        const pdfPerim = polylineLength(poly, true);
        const realPerimMm = realWorldMm(pdfPerim);

        const label = 'Area: ' + formatArea(realMm2) + '\nPerim: ' + formatLength(realPerimMm) + ' @ 1:' + scaleRatio;

        measurementsByDoc[url].push({
            id: generateId(),
            type: 'area',
            points: poly,
            label,
            areaMm2: realMm2
        });
    }

    pendingPoints = [];
    previewLine = null;
    activePageNum = null;
    saveMeasurements();
    markCommittedDirty();
    renderAllMeasurements();
}

export function finishArea() {
    if (activeTool !== 'area' || pendingPoints.length < 3) return;
    finalizeArea();
    deactivateTool();
}

// ── mouse move preview ──

/** @param {MouseEvent} e */
function onMouseMove(e) {
    if (isCalibrating) {
        if (!calibrationPoint) return;
        const coords = pageEventToPdfCoords(e);
        if (!coords) return;
        if (coords.page !== activePageNum) {
            if (previewLine) {
                previewLine = null;
                clearPreview();
            }
            return;
        }
        const snapped = e.shiftKey ? snapAngle45(calibrationPoint, coords, true) : coords;
        previewLine = {
            x1: calibrationPoint.x,
            y1: calibrationPoint.y,
            x2: snapped.x,
            y2: snapped.y
        };
        schedulePreview();
        return;
    }
    if (!activeTool || pendingPoints.length === 0) return;
    const coords = pageEventToPdfCoords(e);
    if (!coords) return;
    if (coords.page !== activePageNum) {
        if (previewLine) {
            previewLine = null;
            clearPreview();
        }
        return;
    }
    const last = pendingPoints[pendingPoints.length - 1];
    const snapped = e.shiftKey ? snapAngle45(last, coords, true) : coords;
    previewLine = {
        x1: last.x,
        y1: last.y,
        x2: snapped.x,
        y2: snapped.y
    };
    schedulePreview();
}

function schedulePreview() {
    if (_previewRAF) return;
    _previewRAF = requestAnimationFrame(() => {
        _previewRAF = null;
        clearPreview();
        renderPreview();
    });
}

// ── rendering ──

let _committedDirty = true;
let _measureRenderRAF = null;

function markCommittedDirty() {
    _committedDirty = true;
}

function clearMeasurementOverlays() {
    document.querySelectorAll('.measure-layer').forEach(el => el.remove());
}

function clearPreview() {
    document.querySelectorAll('.measure-line-ghost, .measure-label-ghost, .measure-fill-ghost').forEach(el => el.remove());
}

function renderBase() {
    if (_committedDirty) {
        clearMeasurementOverlays();

        const url = getDocKey();
        const docs = measurementsByDoc[url] || [];

        for (const m of docs) {
            renderMeasurement(m);
        }
        _committedDirty = false;
    }

    if (isCalibrating && calibrationPoint && activePageNum) {
        renderCalibrationPendingPoint();
    }

    if (pendingPoints.length > 0 && activePageNum) {
        if (activeTool === 'distance') {
            renderPendingPoint();
        } else if ((activeTool === 'perimeter' || activeTool === 'area') && pendingPoints.length >= 2) {
            renderPendingPerimeter();
        }
    }
}

let _previewRAF = null;

function renderPreview() {
    if (previewLine && activePageNum) {
        if (isCalibrating) {
            renderCalibrationPreview();
        } else {
            renderPreviewLine();
        }
    }
}

export function renderAllMeasurements() {
    if (_measureRenderRAF) return;
    _measureRenderRAF = requestAnimationFrame(() => {
        _measureRenderRAF = null;
        clearPreview();
        renderBase();
        renderPreview();
    });
}

/** @param {number} pageNum */
function getPageEl(pageNum) {
    return document.getElementById('page-' + pageNum);
}

/** @param {{id:string, type:string, points:Array, label:string, areaMm2?:number}} m */
function renderMeasurement(m) {
    if (m.type === 'distance') {
        renderDistance(m.points[0], m.points[1], m.label, false, m.id);
    } else if (m.type === 'polyline') {
        renderPerimeter(m.points, m.label, false, m.id);
    } else if (m.type === 'area') {
        renderArea(m.points, m.label, false, m.id);
    }
}

// ── label helper ──

/** @param {number} x @param {number} y @param {string} color @param {string} text @param {string} [measId] */
function createLabel(x, y, color, text, measId) {
    const lbl = document.createElement('div');
    lbl.className = 'measure-label';
    lbl.style.left = (x + 6) + 'px';
    lbl.style.top = (y - 10) + 'px';
    lbl.style.color = '#000';
    lbl.style.borderColor = color;
        if (measId) {
            const shortText = text.split(' @ ')[0];
            lbl.innerHTML = shortText.replace(/\n/g, '<br>') + '  \u00D7';
            lbl.title = text + '\nClick to delete';
            lbl.style.cursor = 'pointer';
            lbl.addEventListener('click', (e) => {
                e.stopPropagation();
                deleteMeasurement(measId);
            });
            const escapedMeasId = CSS.escape(measId);
            lbl.addEventListener('mouseenter', () => {
                document.querySelectorAll('[data-meas-id="' + escapedMeasId + '"]').forEach(el => el.classList.add('measure-highlight'));
            });
            lbl.addEventListener('mouseleave', () => {
                document.querySelectorAll('[data-meas-id="' + escapedMeasId + '"]').forEach(el => el.classList.remove('measure-highlight'));
            });
        } else {
            lbl.textContent = text;
        }
    return lbl;
}

const FINAL_COLOR = 'rgba(255, 60, 60, 0.9)';
const FINAL_LINEW = 1.5;

/** @param {number} x @param {number} y @param {number} tickLen @param {number} tickW @param {number} deg @param {string} color @param {string} className @param {string} [measId] */
function createTick(x, y, tickLen, tickW, deg, color, className, measId) {
    const tick = document.createElement('div');
    tick.className = className;
    tick.style.left = (x - tickLen / 2) + 'px';
    tick.style.top = (y - tickW / 2) + 'px';
    tick.style.width = tickLen + 'px';
    tick.style.height = tickW + 'px';
    tick.style.background = color;
    tick.style.transform = 'rotate(' + deg + 'deg)';
    if (measId) tick.dataset.measId = measId;
    return tick;
}

function renderDistance(p1, p2, label, isPreview, measId) {
    const pageEl = getPageEl(p1.page);
    if (!pageEl) return;
    const s = state.currentScale || 1;
    const color = isPreview ? 'rgba(80, 255, 150, 0.75)' : FINAL_COLOR;

    const layer = getOrCreateLayer(pageEl);

    const dx = (p2.x - p1.x) * s;
    const dy = (p2.y - p1.y) * s;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.5) return;
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;

    const line = document.createElement('div');
    line.className = 'measure-line m-line';
    line.style.left = (p1.x * s) + 'px';
    line.style.top = (p1.y * s - 1) + 'px';
    line.style.width = len + 'px';
    line.style.height = FINAL_LINEW + 'px';
    line.style.background = color;
    line.style.transform = 'rotate(' + angle + 'deg)';
    line.dataset.color = color;
    if (measId) line.dataset.measId = measId;
    layer.appendChild(line);

    const tickLen = isPreview ? 8 : 10;
    const tickW = 2;
    const tickAngle = angle + 90;
    for (const p of [p1, p2]) {
        const tx = p.x * s;
        const ty = p.y * s;
        const tick = createTick(tx, ty, tickLen, tickW, tickAngle, color, 'measure-tick', measId);
        layer.appendChild(tick);
    }

    // Arrows positioned inside the line, pointing outward toward the end ticks
    const ARR = 0;
    const aRad = angle * Math.PI / 180;
    addArrow(layer, p1.x * s + ARR * Math.cos(aRad), p1.y * s + ARR * Math.sin(aRad), angle + 180, color, measId);
    addArrow(layer, p2.x * s - ARR * Math.cos(aRad), p2.y * s - ARR * Math.sin(aRad), angle, color, measId);

    if (label) {
        const midX = ((p1.x + p2.x) / 2) * s;
        const midY = ((p1.y + p2.y) / 2) * s;
        const lbl = createLabel(midX, midY, color, label, measId);
        layer.appendChild(lbl);
    }
}

function renderPendingPoint() {
    const p = pendingPoints[0];
    const pageEl = getPageEl(p.page);
    if (!pageEl) return;
    const s = state.currentScale || 1;
    const layer = getOrCreateLayer(pageEl);
    const tx = p.x * s;
    const ty = p.y * s;
    const tick = createTick(tx, ty, 10, 2, 0, 'rgba(80, 255, 150, 0.75)', 'measure-tick-pending', null);
    tick.style.boxShadow = '0 0 0 1px rgba(255,255,255,0.6)';
    layer.appendChild(tick);
}

function renderPerimeter(points, label, isPreview, measId) {
    if (points.length < 2) return;
    const pageEl = getPageEl(points[0].page);
    if (!pageEl) return;
    const s = state.currentScale || 1;
    const color = isPreview ? 'rgba(80, 255, 150, 0.75)' : FINAL_COLOR;
    const layer = getOrCreateLayer(pageEl);

    for (let i = 0; i < points.length - 1; i++) {
        const p1 = points[i], p2 = points[i + 1];
        drawLineSegment(layer, p1, p2, s, color, measId);
    }

    // Ticks only at first and last point
    const tickLen = isPreview ? 8 : 10;
    const tickW = 2;
    for (const idx of [0, points.length - 1]) {
        if (idx < 0) continue;
        const p = points[idx];
        let deg = 0;
        if (idx === 0 && points.length > 1) {
            const dx = (points[1].x - p.x) * s;
            const dy = (points[1].y - p.y) * s;
            deg = Math.atan2(dy, dx) * 180 / Math.PI + 90;
        } else if (idx === points.length - 1 && points.length > 1) {
            const dx = (p.x - points[idx - 1].x) * s;
            const dy = (p.y - points[idx - 1].y) * s;
            deg = Math.atan2(dy, dx) * 180 / Math.PI + 90;
        }
        const tx = p.x * s;
        const ty = p.y * s;
        const tick = createTick(tx, ty, tickLen, tickW, deg, color, 'measure-tick', measId);
        layer.appendChild(tick);
    }

    // Arrows positioned inside the line, pointing outward toward the end ticks
    if (points.length >= 2) {
        const ARR = 0;
        const a0Rad = Math.atan2(points[1].y - points[0].y, points[1].x - points[0].x);
        addArrow(layer, points[0].x * s + ARR * Math.cos(a0Rad), points[0].y * s + ARR * Math.sin(a0Rad), a0Rad * 180 / Math.PI + 180, color, measId);
        const n = points.length - 1;
        const aNRad = Math.atan2(points[n].y - points[n - 1].y, points[n].x - points[n - 1].x);
        addArrow(layer, points[n].x * s - ARR * Math.cos(aNRad), points[n].y * s - ARR * Math.sin(aNRad), aNRad * 180 / Math.PI, color, measId);
    }

    if (label) {
        const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
        const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length;
        const lbl = createLabel(cx * s, cy * s, color, label, measId);
        layer.appendChild(lbl);
    }
}

function renderPendingPerimeter() {
    const points = pendingPoints;
    if (points.length < 2 || !activePageNum) return;
    const pageEl = getPageEl(activePageNum);
    if (!pageEl) return;
    const s = state.currentScale || 1;
    const layer = getOrCreateLayer(pageEl);
    const color = 'rgba(80, 255, 150, 0.75)';

    for (let i = 0; i < points.length - 1; i++) {
        drawLineSegment(layer, points[i], points[i + 1], s, color, null);
    }

    // Ticks only at first and last point
    const tickLen = 8, tickW = 2;
    for (const idx of [0, points.length - 1]) {
        if (idx < 0) continue;
        const p = points[idx];
        let deg = 0;
        if (idx === 0 && points.length > 1) {
            const dx = (points[1].x - p.x) * s;
            const dy = (points[1].y - p.y) * s;
            deg = Math.atan2(dy, dx) * 180 / Math.PI + 90;
        } else if (idx === points.length - 1 && points.length > 1) {
            const dx = (p.x - points[idx - 1].x) * s;
            const dy = (p.y - points[idx - 1].y) * s;
            deg = Math.atan2(dy, dx) * 180 / Math.PI + 90;
        }
        const tx = p.x * s;
        const ty = p.y * s;
        const tick = createTick(tx, ty, tickLen, tickW, deg, color, 'measure-tick-pending', null);
        layer.appendChild(tick);
    }

    // Arrows positioned inside the line, pointing outward toward the end ticks
    if (points.length >= 2) {
        const ARR = 0;
        const a0Rad = Math.atan2(points[1].y - points[0].y, points[1].x - points[0].x);
        addArrow(layer, points[0].x * s + ARR * Math.cos(a0Rad), points[0].y * s + ARR * Math.sin(a0Rad), a0Rad * 180 / Math.PI + 180, color, null);
        const n = points.length - 1;
        const aNRad = Math.atan2(points[n].y - points[n - 1].y, points[n].x - points[n - 1].x);
        addArrow(layer, points[n].x * s - ARR * Math.cos(aNRad), points[n].y * s - ARR * Math.sin(aNRad), aNRad * 180 / Math.PI, color, null);
    }

    // running length label for perimeter/area
    const totalPdf = polylineLength(points, false);
    if (activeTool === 'perimeter') {
        const realMm = realWorldMm(totalPdf);
        const lblText = formatLength(realMm);
        const last = points[points.length - 1];
        const lbl = createLabel(last.x * s + 10, last.y * s - 10, color, lblText, null);
        layer.appendChild(lbl);
    }
}

/** @param {HTMLElement} layer @param {{x:number, y:number}} p1 @param {{x:number, y:number}} p2 @param {number} s @param {string} color @param {string} [measId] */
function drawLineSegment(layer, p1, p2, s, color, measId) {
    const dx = (p2.x - p1.x) * s;
    const dy = (p2.y - p1.y) * s;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.5) return;
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;

    const line = document.createElement('div');
    line.className = 'measure-line m-line';
    line.style.left = (p1.x * s) + 'px';
    line.style.top = (p1.y * s - 1) + 'px';
    line.style.width = len + 'px';
    line.style.height = FINAL_LINEW + 'px';
    line.style.background = color;
    line.style.transform = 'rotate(' + angle + 'deg)';
    line.dataset.color = color;
    if (measId) line.dataset.measId = measId;
    layer.appendChild(line);
}

function renderArea(points, label, isPreview, measId) {
    if (points.length < 3) return;
    const pageEl = getPageEl(points[0].page);
    if (!pageEl) return;
    const s = state.currentScale || 1;
    const color = isPreview ? 'rgba(80, 255, 150, 0.75)' : FINAL_COLOR;
    const layer = getOrCreateLayer(pageEl);

    for (let i = 0; i < points.length; i++) {
        const p1 = points[i], p2 = points[(i + 1) % points.length];
        drawLineSegment(layer, p1, p2, s, color, measId);
    }

    // fill
    const fill = document.createElement('div');
    fill.className = 'measure-fill';
    const clip = points.map(p => (p.x * s) + 'px ' + (p.y * s) + 'px').join(', ');
    fill.style.clipPath = 'polygon(' + clip + ')';
    fill.style.background = color + '25';
    if (measId) fill.dataset.measId = measId;
    layer.appendChild(fill);

    if (label) {
        const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
        const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length;
        const lbl = createLabel(cx * s, cy * s, color, label, measId);
        layer.appendChild(lbl);
    }
}

function renderCalibrationPendingPoint() {
    if (!calibrationPoint) return;
    const p = calibrationPoint;
    const pageEl = getPageEl(p.page);
    if (!pageEl) return;
    const s = state.currentScale || 1;
    const layer = getOrCreateLayer(pageEl);
    const tx = p.x * s;
    const ty = p.y * s;
    const tick = createTick(tx, ty, 10, 2, 0, 'rgba(80, 255, 150, 0.75)', 'measure-tick-pending', null);
    tick.style.boxShadow = '0 0 0 1px rgba(255,255,255,0.6)';
    layer.appendChild(tick);
}

function renderCalibrationPreview() {
    if (!previewLine || !activePageNum || !calibrationMeters) return;
    const s = state.currentScale || 1;
    const pageEl = getPageEl(activePageNum);
    if (!pageEl) return;
    const layer = getOrCreateLayer(pageEl);

    const last = { x: previewLine.x1, y: previewLine.y1 };
    const mouse = { x: previewLine.x2, y: previewLine.y2 };

    drawGhostSegment(layer, last, mouse, s);

    const pdfDist = distanceBetween(last, mouse);
    if (pdfDist < 0.5) return;

    const computedScale = calibrationMeters * 1000 * POINTS_PER_MM / pdfDist;
    const clamped = Math.max(0.001, Math.min(MAX_SCALE, computedScale));
    const rounded = Math.round(clamped);
    const labelText = calibrationMeters + 'm \u2192 1:' + rounded;
    addGhostLabel(layer, (last.x + mouse.x) / 2 * s, (last.y + mouse.y) / 2 * s, labelText);
}

function renderPreviewLine() {
    if (!previewLine || !activePageNum) return;
    const s = state.currentScale || 1;
    const pageEl = getPageEl(activePageNum);
    if (!pageEl) return;
    const layer = getOrCreateLayer(pageEl);

    const last = { x: previewLine.x1, y: previewLine.y1 };
    const mouse = { x: previewLine.x2, y: previewLine.y2 };

    drawGhostSegment(layer, last, mouse, s);

    if (activeTool === 'distance') {
        const real = realWorldMm(distanceBetween(last, mouse));
        addGhostLabel(layer, (last.x + mouse.x) / 2 * s, (last.y + mouse.y) / 2 * s, formatLength(real));
    } else if (activeTool === 'perimeter') {
        const allPoints = [...pendingPoints, mouse];
        const total = polylineLength(allPoints, false);
        addGhostLabel(layer, (last.x + mouse.x) / 2 * s + 10, (last.y + mouse.y) / 2 * s - 10, formatLength(realWorldMm(total)));
    } else if (activeTool === 'area') {
        if (pendingPoints.length >= 2) {
            const first = pendingPoints[0];
            drawGhostSegment(layer, mouse, first, s);

            const allPoints = [...pendingPoints, mouse];
            if (allPoints.length >= 3) {
                const subPolys = decomposePolygon(allPoints);
                let totalAreaMm2 = 0;
                for (const poly of subPolys) {
                    if (poly.length < 3) continue;
                    const fill = document.createElement('div');
                    fill.className = 'measure-fill-ghost';
                    fill.style.clipPath = 'polygon(' + poly.map(p => (p.x * s) + 'px ' + (p.y * s) + 'px').join(', ') + ')';
                    layer.appendChild(fill);

                    const pdfArea = simplePolygonArea(poly);
                    const realMm2 = pdfArea / (POINTS_PER_MM * POINTS_PER_MM) * scaleRatio * scaleRatio;
                    totalAreaMm2 += realMm2;
                    const pdfPerim = polylineLength(poly, true);
                    const realPerimMm = realWorldMm(pdfPerim);
                    const cx = poly.reduce((sum, p) => sum + p.x, 0) / poly.length;
                    const cy = poly.reduce((sum, p) => sum + p.y, 0) / poly.length;
                    addGhostLabel(layer, (cx + 6) * s, (cy - 10) * s, 'Area: ' + formatArea(realMm2) + '\nPerim: ' + formatLength(realPerimMm));
                }
                if (subPolys.length > 1) {
                    const cx = allPoints.reduce((sum, p) => sum + p.x, 0) / allPoints.length;
                    const cy = allPoints.reduce((sum, p) => sum + p.y, 0) / allPoints.length;
                    addGhostLabel(layer, (cx + 6) * s, (cy + 20) * s, 'Total area: ' + formatArea(totalAreaMm2));
                }
            }
        } else {
            const real = realWorldMm(distanceBetween(last, mouse));
            addGhostLabel(layer, (last.x + mouse.x) / 2 * s, (last.y + mouse.y) / 2 * s, formatLength(real));
        }
    }
}

function drawGhostSegment(layer, p1, p2, s) {
    const dx = (p2.x - p1.x) * s;
    const dy = (p2.y - p1.y) * s;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.5) return;
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;
    const line = document.createElement('div');
    line.className = 'measure-line-ghost';
    line.style.left = (p1.x * s) + 'px';
    line.style.top = (p1.y * s) + 'px';
    line.style.width = len + 'px';
    line.style.transform = 'rotate(' + angle + 'deg)';
    layer.appendChild(line);
}

function addGhostLabel(layer, x, y, text) {
    const lbl = document.createElement('div');
    lbl.className = 'measure-label-ghost';
    lbl.style.left = (x + 6) + 'px';
    lbl.style.top = (y - 10) + 'px';
    lbl.innerHTML = text.replace(/\n/g, '<br>');
    layer.appendChild(lbl);
}

function addArrow(layer, x, y, angleDeg, color, measId) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '12');
    svg.setAttribute('height', '14');
    svg.style.position = 'absolute';
    svg.style.left = (x - 10) + 'px';
    svg.style.top = (y - 7) + 'px';
    svg.style.transform = 'rotate(' + angleDeg + 'deg)';
    svg.style.transformOrigin = '10px 7px';
    svg.style.overflow = 'visible';
    svg.style.pointerEvents = 'none';
    svg.style.zIndex = '6';
    if (measId) svg.dataset.measId = measId;

    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    poly.setAttribute('points', '10,7 0,0 0,14');
    poly.setAttribute('fill', color);
    if (measId) poly.dataset.measId = measId;
    svg.appendChild(poly);
    layer.appendChild(svg);
}

/** @param {HTMLElement} pageEl @returns {HTMLElement} */
function getOrCreateLayer(pageEl) {
    let layer = pageEl.querySelector('.measure-layer');
    if (!layer) {
        layer = document.createElement('div');
        layer.className = 'measure-layer';
        pageEl.appendChild(layer);
    }
    return layer;
}

export function refreshAllMeasurements() {
    markCommittedDirty();
    renderAllMeasurements();
}

export function handleZoomChange() {
    markCommittedDirty();
    renderAllMeasurements();
}

// ── auto scale detection ──

export function parseScaleString(str) {
    // "1 mm = 50 mm" → 50
    let m = str.match(/(\d+(?:\.\d+)?)\s*(?:mm|cm|m|in|ft|"|')\s*=\s*(\d+(?:\.\d+)?)\s*(?:mm|cm|m|in|ft|"|')/i);
    if (m) {
        const ratio = parseFloat(m[2]) / parseFloat(m[1]);
        if (!isNaN(ratio) && ratio >= 0.001 && ratio <= MAX_SCALE) return Math.round(ratio);
    }
    // "1/8\" = 1'-0\"" → 96
    m = str.match(/(\d+)\/(\d+)\s*"\s*=\s*(\d+)'\s*-\s*(\d+)"/);
    if (m) {
        const paper = parseFloat(m[1]) / parseFloat(m[2]);
        const world = parseFloat(m[3]) * 12 + parseFloat(m[4]);
        const ratio = world / paper;
        if (!isNaN(ratio) && ratio >= 0.001 && ratio <= MAX_SCALE) return Math.round(ratio);
    }
    return null;
}

/**
 * How much of the PDF we are willing to pull into memory just to look for a
 * /Measure dict. Scale metadata lives in the early (catalog/page-tree) objects
 * of a PDF, so a prefix is normally enough; `autoDetectScale` falls back to
 * `detectScaleFromText` when nothing is found, and the scale stays
 * user-overridable either way.
 */
const RAW_SCAN_LIMIT = 4 * 1024 * 1024;

async function detectScaleFromRawPdf(fileUrl) {
    try {
        const resp = await fetch(fileUrl);
        if (!resp.ok) return null;

        // Stream a bounded prefix instead of fetch() -> arrayBuffer() ->
        // latin1 decode of the entire file. For a 35 MB tender that was ~35 MB
        // of bytes plus a ~35M-char JS string (70 MB+) allocated on every open,
        // for a regex match that almost never hits.
        let raw = '';
        if (resp.body && typeof resp.body.getReader === 'function') {
            const reader = resp.body.getReader();
            const decoder = new TextDecoder('latin1');
            let bytesRead = 0;
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    raw += decoder.decode(value, { stream: true });
                    bytesRead += value.byteLength;
                    if (bytesRead >= RAW_SCAN_LIMIT) {
                        await reader.cancel();
                        break;
                    }
                }
                raw += decoder.decode();
            } catch (e) {
                await reader.cancel().catch(() => {});
            }
        } else {
            // No streaming body (older engines): fall back to a bounded read.
            const buf = await resp.arrayBuffer();
            raw = new TextDecoder('latin1').decode(buf.slice(0, RAW_SCAN_LIMIT));
        }

        if (!raw.includes('/Measure')) return null;

        const sf = raw.match(/\/ScaleFactor\s+(\d+(?:\.\d+)?)/);
        if (sf) {
            const v = parseFloat(sf[1]);
            if (!isNaN(v) && v >= 0.001 && v <= MAX_SCALE) return Math.round(v);
        }

        const ss = raw.match(/\/ScaleString\s*\(([^)]*)\)/);
        if (ss) {
            const parsed = parseScaleString(ss[1]);
            if (parsed) return parsed;
        }
    } catch (e) { /* fetch may fail for some URLs */ }
    return null;
}

function detectScaleFromText() {
    for (let p = 1; p <= state.totalPages; p++) {
        const pageData = state.textPageCache[p];
        if (!pageData) continue;
        const text = pageData.text;

        const m = text.match(/(?:scale|metric)\s*[:=-]?\s*(\d+)\s*:\s*(\d+)/i);
        if (m) {
            const scaleNum = parseInt(m[2], 10);
            if (!isNaN(scaleNum) && scaleNum >= 1 && scaleNum <= MAX_SCALE) return scaleNum;
        }
    }
    return null;
}

export async function autoDetectScale(fileUrl) {
    let scale = await detectScaleFromRawPdf(fileUrl);
    if (scale) return scale;

    scale = detectScaleFromText();
    if (scale) return scale;

    return null;
}
