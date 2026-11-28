// The lines the cursor is inside: a class, a function, an `if` ... worked out
// from the indentation, so they are found in any file and without a language
// server. The view shows them at its top once they have scrolled above it.

import { Buffer } from './buffer';

/** How many context lines a view shows at most. */
export const MAX_CONTEXT = 5;

/** How far above the cursor to look, so a large file cannot hold up a frame
 * where nothing is found. */
const SCAN_LINES = 10000;

/** Whether a line says something about the structure around the cursor: not
 * blank, not only a comment, and not only the braces closing a block. */
function structural(line: readonly string[]): boolean {
    let i = 0;
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
    if (i >= line.length) return false;
    const c = line[i];
    const n = line[i + 1];
    // Comments and other lines that never open a block.
    if (c === '#' || c === ';' || c === '%' || c === '*') return false;
    if (c === '/' && (n === '/' || n === '*')) return false;
    if (c === '-' && n === '-') return false;
    if (c === '<' && n === '!' && line[i + 2] === '-') return false;
    if (c === '"' && n === '"' && line[i + 2] === '"') return false;
    if (c === "'" && n === "'" && line[i + 2] === "'") return false;
    // A line of only closing brackets, and the words that close a block.
    if (c === '}' || c === ')' || c === ']') {
        return line.slice(i).some((ch) => ch !== '}' && ch !== ')' && ch !== ']' && ch !== ';');
    }
    let j = i;
    while (j < line.length && /[A-Za-z]/.test(line[j])) j++;
    const word = line.slice(i, j).join('').toLowerCase();
    // `end`, `fi`, ... only when the whole line is the word (or it ends there
    // and a comment follows), rather than a name starting with it.
    if (['end', 'fi', 'done', 'esac'].includes(word) && (j === line.length || !/\w/.test(line[j]))) return false;
    return true;
}

/** How far in a line is, in columns, with tabs `tabstop` wide. */
function indentWidth(buf: Buffer, line: number, tabstop: number): number {
    let d = 0;
    for (const c of buf.indentOf(line)) d = c === '\t' ? (Math.floor(d / tabstop) + 1) * tabstop : d + 1;
    return d;
}

/** Whether the line opens the block that the lines after it belong to (its
 * text ends with the way a block is usually opened). */
function opensBlock(text: string): boolean {
    const t = text.trim();
    if (/[{([:,=]$/.test(t)) return true;
    if (/(=>|->|\\)$/.test(t)) return true;
    return /\b(do|then|else|begin|try)\s*(#.*)?$/.test(t);
}

/** The lines the code at `cursorLine` is inside, outermost first, found by
 * working up from the cursor to each line that is less indented than the one
 * before it. At most `MAX_CONTEXT` of them. */
export function contextLines(buf: Buffer, cursorLine: number, tabstop: number): number[] {
    const found: number[] = [];
    const ts = Math.max(tabstop, 1);
    const at = Math.min(Math.max(cursorLine, 0), buf.lastLine());
    if (at === 0) return found;
    let limit: number;
    let scan: number;
    if (buf.isBlankLine(at)) {
        // An empty line has no indentation of its own. The nearest line with
        // text says how far in it is, and opens its block when it does.
        let k = at - 1;
        while (k >= 0 && !structural(buf.line(k))) k--;
        if (k < 0) return found;
        limit = indentWidth(buf, k, ts);
        if (opensBlock(buf.lineString(k))) found.push(k);
        scan = k - 1;
    } else {
        limit = indentWidth(buf, at, ts);
        scan = at - 1;
    }
    for (let l = scan, seen = 0; l >= 0 && found.length < MAX_CONTEXT && seen < SCAN_LINES; l--, seen++) {
        if (!structural(buf.line(l))) continue;
        const indent = indentWidth(buf, l, ts);
        if (indent >= limit) continue;
        found.push(l);
        limit = indent;
        if (limit === 0) break;
    }
    return found.reverse();
}

/** The context lines a view shows at the top: those above the line showing
 * under the rows, and any the rows would hide, so a line is never drawn twice.
 * At most `maxRows` rows (and at most one fewer than the view has), and never
 * over the cursor's line when `cursorLine` is in the view. The lines left out
 * are the outermost ones, which are the least to the point. `rowsAt` says how
 * many screen rows a line takes there. */
export function shownContext(
    context: readonly number[],
    first: number,
    rowsAt: (line: number) => number,
    viewRows: number,
    cursorLine?: number,
    maxRows: number = MAX_CONTEXT,
): number[] {
    if (context.length === 0) return [];
    // The first line still showing under `rows` of them: a line part under
    // them is still in frame.
    const below = (rows: number): number => {
        let l = first;
        let r = 0;
        while (r + rowsAt(l) <= rows) {
            r += rowsAt(l);
            l++;
        }
        return l;
    };
    let cap = Math.min(maxRows, Math.max(viewRows - 1, 0));
    if (cursorLine !== undefined && cursorLine >= first) {
        let rows = 0;
        for (let l = first; l < cursorLine && rows <= cap; l++) rows += rowsAt(l);
        cap = Math.min(cap, rows);
    }
    let rows = 0;
    for (; ;) {
        const next = Math.min(context.filter((l) => l < below(rows)).length, cap);
        if (next === rows) break;
        rows = next;
    }
    if (rows === 0) return [];
    const shown = context.filter((l) => l < below(rows));
    return shown.slice(Math.max(shown.length - rows, 0));
}
