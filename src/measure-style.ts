/**
 * Measurement styling shared by the on-screen overlay (measure.ts) and the
 * burned-in PDF output (measure-burn.ts).
 *
 * The screen draws in CSS pixels at 100% zoom, where one CSS pixel is one PDF
 * point, so the same numbers are meaningful in both places. Keeping them here
 * means an exported drawing cannot drift away from what the app showed.
 *
 * Labels are part of the drawing, not UI chrome: the on-screen label uses the
 * same size in CSS pixels at 100% zoom as the printed label uses in points,
 * and the screen size scales with zoom. 12 is the compromise between the old
 * 15px screen label and 9pt print label, so neither side jumps on export.
 */
export const MEASURE_STYLE = {
    red: 1,
    green: 60 / 255,
    blue: 60 / 255,
    opacity: 0.9,

    /** Line weight of a committed measurement, in points. */
    lineWidth: 1.5,

    /** End tick drawn across a distance/polyline. */
    tickLength: 10,
    tickWidth: 2,

    /** Filled arrowhead at an open end: 10 long, 14 wide. */
    arrowLength: 10,
    arrowWidth: 14,

    /** Label geometry, shared by `.measure-label` and the PDF text. */
    labelFontPx: 12,
    labelLineHeight: 1.2,
    labelPaddingX: 5,
    labelPaddingY: 2,
    labelBorderWidth: 0.75,
    labelBackgroundOpacity: 0.75,
    labelOffsetX: 6,
    labelOffsetY: 10,

    /**
     * Detail callout bubble. The screen size scales with zoom (the bubble is
     * part of the drawing) and the printed one matches it: a 15px note at 100%
     * zoom is 15pt on paper, so a saved note looks like the one that was typed.
     */
    calloutFontPx: 15,
    calloutLineHeight: 1.25,
    calloutPaddingX: 8,
    calloutPaddingY: 4,
    calloutRadius: 6,
    calloutBorderWidth: 1.5,
    /** How wide the bubble's tail is where it leaves the plate. */
    calloutTailHalfBase: 8,
} as const;
