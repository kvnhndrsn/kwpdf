// Plain, searchable text derived from the HTML mammoth produces.
//
// `textContent` alone concatenates block text with no separator
// ("<p>heat</p><p>bonded</p>" → "heatbonded"), which merges words across
// paragraphs and breaks both matching and page offsets. Insert a space at every
// block boundary, then collapse whitespace the way the scanners expect.

const BLOCK_TAGS = new Set([
    'ADDRESS',
    'ARTICLE',
    'ASIDE',
    'BLOCKQUOTE',
    'BR',
    'CAPTION',
    'DD',
    'DIV',
    'DL',
    'DT',
    'FIGCAPTION',
    'FIGURE',
    'FOOTER',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'HEADER',
    'HR',
    'LI',
    'MAIN',
    'NAV',
    'OL',
    'P',
    'PRE',
    'SECTION',
    'TABLE',
    'TBODY',
    'TD',
    'TFOOT',
    'TH',
    'THEAD',
    'TR',
    'UL',
]);

export function htmlToText(html: string): string {
    if (!html) return '';

    const container = document.createElement('div');
    container.innerHTML = html;

    let out = '';
    const walk = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            out += (node as Text).nodeValue || '';
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;

        const el = node as HTMLElement;
        const block = BLOCK_TAGS.has(el.tagName);
        if (block) out += ' ';
        for (const child of Array.from(el.childNodes)) walk(child);
        if (block) out += ' ';
    };

    for (const child of Array.from(container.childNodes)) walk(child);
    return out.replace(/\s+/g, ' ').trim();
}
