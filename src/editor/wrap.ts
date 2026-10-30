// Soft line wrapping: a long line shown over several screen rows, cut at the
// window's width.

/** How many screen rows a line takes when wrapped to `cols` columns, with tabs
 * `tabstop` wide. `cursorCol` is the cursor's column when it is on this line:
 * after the last character (in Insert mode) it needs a cell, which takes
 * another row when the line fills its last one exactly. */
export function lineRows(chars: readonly string[], tabstop: number, cols: number, cursorCol?: number): number {
    const ts = Math.max(tabstop, 1);
    const width = Math.max(cols, 1);
    let d = 0;
    let at = cursorCol === undefined || cursorCol <= 0 ? 0 : undefined;
    for (let i = 0; i < chars.length; i++) {
        if (i === cursorCol) at = d;
        d = chars[i] === '\t' ? (Math.floor(d / ts) + 1) * ts : d + 1;
    }
    if (cursorCol !== undefined && at === undefined) at = d + (cursorCol - chars.length);
    const rows = Math.max(Math.ceil(d / width), 1);
    return at === undefined ? rows : Math.max(rows, Math.floor(at / width) + 1);
}
