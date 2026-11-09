/**
 * Measurement styling shared by the on-screen overlay (measure.ts) and the
 * burned-in PDF output (measure-burn.ts).
 *
 * The screen draws in CSS pixels at 100% zoom, where one CSS pixel is one PDF
 * point, so the same numbers are meaningful in both places. Keeping them here
 * means an exported drawing cannot drift away from what the app showed.
 *
 * The two sizes that are deliberately *not* shared are the label sizes: the
 * on-screen label is a fixed 15px piece of UI, while the printed label is 9pt,
 * because a fixed 15px label would come out as ~5mm text on paper.
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

    /** Label geometry, matching `.measure-label` (font-size + padding + offset). */
    labelFontPx: 15,
    printLabelFontSize: 9,
    labelOffsetX: 6,
    labelOffsetY: 10,

    /**
     * Detail callout bubble. The screen size scales with zoom (the bubble is
     * part of the drawing), while the printed size is fixed like the labels.
     */
    calloutFontPx: 15,
    printCalloutFontSize: 9,
    calloutLineHeight: 1.25,
    calloutPaddingX: 8,
    calloutPaddingY: 4,
    calloutRadius: 5,
    calloutBorderWidth: 1,
    leaderWidth: 1,
} as const;
