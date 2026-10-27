// Markdown's rendered view: a file's blocks laid out as rows of styled text
// to read rather than edit (markup dropped, paragraphs wrapped, code
// highlighted, tables drawn), and where the view is scrolled to.

import * as path from 'node:path';

import type { Buffer } from './editor/buffer';
import * as highlight from './highlight';
import type { TextStyle } from './protocol';
import { theme, themeName, tokenColor, tokenStyle } from './theme';

export type StyledRun = [text: string, color: string, style?: TextStyle];

/** One row of the rendered view. */
export interface MdRow {
    runs: StyledRun[];
    /** The source line the row comes from, to keep the view and the text
     * at the same place when switching between them. */
    source: number;
    /** How many block quotes the row is in, each drawn as a bar. */
    quote: number;
    /** Columns before the text, inside the quotes. */
    indent: number;
    /** A code block's rows get a background; a rule is a line across. */
    kind?: 'code' | 'rule';
}

/** Whether a file is Markdown, which has a rendered view. */
export function isMarkdown(file: string | undefined): boolean {
    return file !== undefined && ['.md', '.markdown', '.mdx'].includes(path.extname(file).toLowerCase());
}

/** A character of a paragraph, with how it's drawn and the line it's from;
 * `\n` is a hard line break. */
type Cell = [c: string, color: string, style: TextStyle | undefined, source: number];

const charLen = (s: string): number => Array.from(s).length;

const BULLETS = ['•', '◦', '▪'];
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+|$)/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+|$)(.*?)(?:\s+#+)?\s*$/;
const RULE = /^ {0,3}([-*_])( *\1){2,} *$/;
const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`{}]*)/;

/** Cells for a line's inline Markdown in `chars[from..to)`, markup dropped. */
function inlineCells(chars: readonly string[], from: number, to: number, source: number, base?: highlight.Token): Cell[] {
    const cells: Cell[] = [];
    for (const s of highlight.markdownInline(chars, from, to, base)) {
        const token = s.token ?? 'Normal';
        const color = s.token === undefined ? theme.FG : tokenColor(token === 'Markup' ? 'Link' : token);
        const style = s.token === undefined ? undefined : tokenStyle(token);
        const text = s.shown ?? chars.slice(s.start, s.end).join('');
        for (const c of text) cells.push([c, color, style, source]);
    }
    return cells;
}

function toRuns(cells: readonly Cell[]): StyledRun[] {
    const runs: StyledRun[] = [];
    for (const [c, color, style] of cells) {
        const last = runs[runs.length - 1];
        if (last && last[1] === color && last[2] === style) last[0] += c;
        else runs.push(style ? [c, color, style] : [c, color]);
    }
    return runs;
}

/** Break cells into rows at most `cols` wide, at spaces where possible. */
function wrapCells(cells: readonly Cell[], cols: number): Cell[][] {
    const out: Cell[][] = [];
    let start = 0;
    const skipSpaces = (): void => {
        while (start < cells.length && cells[start][0] === ' ') start++;
    };
    while (start < cells.length) {
        const brk = cells.findIndex((c, i) => i >= start && c[0] === '\n');
        const limit = brk === -1 ? cells.length : brk;
        if (limit - start <= cols) {
            out.push(cells.slice(start, limit));
            start = limit + 1;
            skipSpaces();
            continue;
        }
        let end = start + cols;
        for (let i = end; i > start + cols / 2; i--) {
            if (cells[i][0] === ' ') {
                end = i;
                break;
            }
        }
        out.push(cells.slice(start, end));
        start = end;
        skipSpaces();
    }
    return out;
}

/** A table row's cells: split at `|`s that aren't escaped or in code. */
function tableCells(line: string): [from: number, to: number][] {
    const chars = Array.from(line);
    const out: [number, number][] = [];
    let start = 0;
    let code = false;
    for (let i = 0; i <= chars.length; i++) {
        const c = chars[i];
        if (c === '\\') i++;
        else if (c === '`') code = !code;
        else if (i === chars.length || (c === '|' && !code)) {
            out.push([start, i]);
            start = i + 1;
        }
    }
    // Leading and trailing pipes don't start or end cells.
    if (/^\s*\|/.test(line)) out.shift();
    if (/\|\s*$/.test(line) && out.length > 0) out.pop();
    return out;
}

/** Strip the cell's surrounding spaces. */
function trimRange(chars: readonly string[], [from, to]: [number, number]): [number, number] {
    while (from < to && /\s/.test(chars[from])) from++;
    while (to > from && /\s/.test(chars[to - 1])) to--;
    return [from, to];
}

/** Lay out Markdown source `lines` as rows `cols` wide. */
export function renderMarkdown(lines: readonly string[], cols: number): MdRow[] {
    const rows: MdRow[] = [];
    cols = Math.max(cols, 10);
    /** Open list items: where their marker and text start in the source,
     * and where their text starts on screen. */
    let lists: { marker: number; content: number; indent: number }[] = [];
    let para: { cells: Cell[]; first: Cell[]; indent: number; quote: number; source: number } | undefined;
    let quote = 0;

    const blank = (source: number, q = quote): void => {
        const last = rows[rows.length - 1];
        if (last && (last.runs.length > 0 || last.kind)) rows.push({ runs: [], source, quote: q, indent: 0 });
    };
    const flush = (): void => {
        if (!para) return;
        const p = para;
        para = undefined;
        const firstWidth = charLen(p.first.map((c) => c[0]).join(''));
        const wrapped = p.cells.length > 0 ? wrapCells(p.cells, Math.max(cols - p.indent - 2 * p.quote, 1)) : [[]];
        wrapped.forEach((cells, i) => {
            const prefix = i === 0 ? p.first : [];
            const source = cells[0]?.[3] ?? p.source;
            rows.push({ runs: toRuns([...prefix, ...cells]), source, quote: p.quote, indent: p.indent - (i === 0 ? firstWidth : 0) });
        });
    };
    /** The indent on screen for a block whose source starts at column
     * `at`: inside the list items it's indented under, which stay open. */
    const indentFor = (at: number): number => {
        while (lists.length > 0 && at < lists[lists.length - 1].content) lists.pop();
        return lists.length > 0 ? lists[lists.length - 1].indent : 0;
    };

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].replace(/\t/g, '    ');
        // Block quotes.
        let depth = 0;
        let m: RegExpExecArray | null;
        while ((m = /^ {0,3}> ?/.exec(line))) {
            depth++;
            line = line.slice(m[0].length);
        }
        if (depth !== quote) {
            flush();
            if (depth < quote && line.trim() !== '') blank(i, depth);
            lists = [];
            quote = depth;
        }
        const chars = Array.from(line);
        const lead = charLen(/^\s*/.exec(line)![0]);

        if (line.trim() === '') {
            flush();
            blank(i);
            continue;
        }
        // HTML comments, to their end.
        if (/^\s*<!--/.test(line)) {
            flush();
            while (i < lines.length && !lines[i].includes('-->')) i++;
            continue;
        }
        const fence = FENCE.exec(line);
        if (fence && !(fence[2][0] === '`' && line.slice(fence[0].length).includes('`'))) {
            flush();
            const indent = indentFor(lead);
            const lang = highlight.fenceLanguage(fence[3]);
            let state = highlight.NORMAL;
            const close = new RegExp(`^\\s*${fence[2][0]}{${fence[2].length},}\\s*$`);
            for (i++; i < lines.length; i++) {
                let code = lines[i];
                for (let q = 0; q < quote; q++) code = code.replace(/^ {0,3}> ?/, '');
                if (close.test(code)) break;
                // Take off the fence's own indent.
                code = code.replace(new RegExp(`^ {0,${charLen(fence[1])}}`), '').replace(/\t/g, '    ');
                const cs = Array.from(code);
                let runs: StyledRun[] = [[code, lang ? theme.FG : tokenColor('Raw')]];
                if (lang) {
                    const [spans, next] = highlight.highlightLine(lang, cs, state);
                    state = next;
                    runs = [];
                    let at = 0;
                    for (const [s, e, t] of spans) {
                        if (s > at) runs.push([cs.slice(at, s).join(''), theme.FG]);
                        const style = tokenStyle(t);
                        runs.push(style ? [cs.slice(s, e).join(''), tokenColor(t), style] : [cs.slice(s, e).join(''), tokenColor(t)]);
                        at = e;
                    }
                    if (at < cs.length) runs.push([cs.slice(at).join(''), theme.FG]);
                }
                rows.push({ runs: runs.filter(([s]) => s !== ''), source: i, quote, indent, kind: 'code' });
            }
            continue;
        }
        // A setext heading's underline, under a paragraph.
        const setext = /^ {0,3}(=+|-+) *$/.exec(line);
        if (setext && para && para.first.length === 0) {
            const p = para;
            para = undefined;
            const level = setext[1][0] === '=' ? 1 : 2;
            heading(p.cells.map((c): Cell => [c[0] === '\n' ? ' ' : c[0], tokenColor('Heading'), 'bold', c[3]]), level, p.source, p.indent);
            continue;
        }
        if (RULE.test(line)) {
            flush();
            rows.push({ runs: [], source: i, quote, indent: indentFor(lead), kind: 'rule' });
            continue;
        }
        const h = HEADING.exec(line);
        if (h) {
            flush();
            const at = charLen(/^ {0,3}#{1,6}\s*/.exec(line)![0]);
            const text = inlineCells(chars, at, at + charLen(h[2]), i, 'Heading');
            heading(text, h[1].length, i, indentFor(lead));
            continue;
        }
        // A table: a header row, then a delimiter row.
        if (line.includes('|') && i + 1 < lines.length && highlight.TABLE_DELIMITER.test(lines[i + 1])) {
            flush();
            i = table(lines, i, quote, indentFor(lead)) - 1;
            continue;
        }
        // Link reference definitions don't show.
        if (/^ {0,3}\[[^\]]+\]:\s*\S/.test(line) && !para) continue;
        const item = LIST_ITEM.exec(line);
        if (item && !(para && para.first.length === 0 && !/^\s*(\d+[.)]|[-*+])\s+\S/.test(line))) {
            flush();
            const marker = charLen(item[1]);
            const indent = indentFor(marker);
            while (lists.length > 0 && lists[lists.length - 1].marker >= marker) lists.pop();
            const level = lists.length;
            let at = charLen(item[0]);
            let bullet = /\d/.test(item[2]) ? item[2] : BULLETS[Math.min(level, BULLETS.length - 1)];
            const task = /^\[([ xX])\](?=\s|$)\s*/.exec(line.slice(item[0].length));
            if (task) {
                bullet = task[1] === ' ' ? '☐' : '☑';
                at += charLen(task[0]);
            }
            const first: Cell[] = Array.from(`${bullet} `).map((c): Cell => [c, tokenColor('ListMarker'), undefined, i]);
            const contentIndent = indent + first.length;
            lists.push({ marker, content: at, indent: contentIndent });
            para = { cells: inlineCells(chars, at, chars.length, i), first, indent: contentIndent, quote, source: i };
            continue;
        }
        // Indented code, outside lists and paragraphs.
        if (lead >= 4 && !para && lists.length === 0) {
            rows.push({ runs: [[line.slice(4), tokenColor('Raw')]], source: i, quote, indent: 0, kind: 'code' });
            continue;
        }
        // Paragraph text, joined across lines. Two spaces or a backslash at
        // the end of a line break it there.
        const hard = / {2,}$|\\$/.test(line);
        const end = chars.length - (hard ? charLen(/( {2,}|\\)$/.exec(line)![0]) : 0);
        const cells = inlineCells(chars, lead, end, i);
        if (para) {
            const last = para.cells[para.cells.length - 1];
            if (last && last[0] !== '\n') para.cells.push([' ', theme.FG, undefined, i]);
            para.cells.push(...cells);
        } else {
            para = { cells, first: [], indent: indentFor(lead), quote, source: i };
        }
        if (hard) para.cells.push(['\n', theme.FG, undefined, i]);
    }
    flush();
    while (rows.length > 0 && rows[rows.length - 1].runs.length === 0 && !rows[rows.length - 1].kind) rows.pop();
    return rows;

    function heading(cells: Cell[], level: number, source: number, indent: number): void {
        if (rows.length > 0) blank(source);
        const width = Math.max(cols - indent - 2 * quote, 1);
        for (const row of wrapCells(cells, width)) rows.push({ runs: toRuns(row), source, quote, indent });
        if (level <= 2) rows.push({ runs: [], source, quote, indent, kind: 'rule' });
    }

    /** Lay out the table starting at `start`; returns the line after it. */
    function table(lines: readonly string[], start: number, quote: number, indent: number): number {
        const aligns = tableCells(lines[start + 1]).map(([s, e]) => {
            const c = lines[start + 1].slice(s, e).trim();
            return c.endsWith(':') ? (c.startsWith(':') ? 'center' : 'right') : 'left';
        });
        const body: { cells: Cell[][]; source: number }[] = [];
        let end = start;
        for (; end < lines.length; end++) {
            const line = lines[end];
            if (end === start + 1) continue;
            if (line.trim() === '' || !line.includes('|')) break;
            const chars = Array.from(line);
            const cells = tableCells(line).map((r) => {
                const [s, e] = trimRange(chars, r);
                return inlineCells(chars, s, e, end, end === start ? 'Strong' : undefined);
            });
            body.push({ cells, source: end });
        }
        const n = Math.max(aligns.length, ...body.map((r) => r.cells.length));
        const widths = Array.from({ length: n }, (_, c) => Math.max(1, ...body.map((r) => r.cells[c]?.length ?? 0)));
        // Narrow the widest columns until the table fits; their cells wrap.
        const room = cols - indent - 2 * quote - (3 * n + 1);
        let total = widths.reduce((a, b) => a + b, 0);
        while (total > room) {
            const widest = widths.indexOf(Math.max(...widths));
            if (widths[widest] <= 8) break;
            widths[widest]--;
            total--;
        }
        const border = tokenColor('Markup');
        const line = (l: string, mid: string, r: string, source: number): void => {
            const text = l + widths.map((w) => '─'.repeat(w + 2)).join(mid) + r;
            rows.push({ runs: [[text, border]], source, quote, indent });
        };
        line('┌', '┬', '┐', start);
        body.forEach((r, k) => {
            const wrapped = widths.map((w, c) => wrapCells(r.cells[c] ?? [], w));
            const height = Math.max(1, ...wrapped.map((w) => w.length));
            for (let y = 0; y < height; y++) {
                const runs: StyledRun[] = [['│', border]];
                widths.forEach((w, c) => {
                    const cells = wrapped[c][y] ?? [];
                    const space = w - cells.length;
                    const align = aligns[c] ?? 'left';
                    const before = align === 'right' ? space : align === 'center' ? Math.floor(space / 2) : 0;
                    runs.push([' '.repeat(before + 1), theme.FG], ...toRuns(cells), [' '.repeat(space - before + 1), theme.FG], ['│', border]);
                });
                rows.push({ runs: runs.filter(([s]) => s !== ''), source: r.source, quote, indent });
            }
            if (k === 0) line('├', '┼', '┤', start + 1);
        });
        line('└', '┴', '┘', end - 1);
        return end;
    }
}

/** A buffer's rendered view: where it's scrolled to, and its rows for the
 * buffer's text as last laid out. */
export class MarkdownView {
    /** The first row shown. */
    top = 0;
    private cache: { key: string; rows: MdRow[] } | undefined;

    rows(buffer: Buffer, cols: number): MdRow[] {
        const key = `${buffer.version()}:${cols}:${themeName()}`;
        if (this.cache?.key !== key) {
            const lines = Array.from({ length: buffer.lineCount() }, (_, i) => buffer.lineString(i));
            this.cache = { key, rows: renderMarkdown(lines, cols) };
        }
        return this.cache.rows;
    }

    /** Scroll by `delta` rows, keeping a screen of `height` rows full where
     * there are enough. */
    scrollBy(rows: readonly MdRow[], height: number, delta: number): void {
        this.top = clampTop(rows, height, this.top + delta);
    }

    /** Show the rows for source `line` at the top. */
    showSource(rows: readonly MdRow[], height: number, line: number): void {
        const at = rows.findIndex((r) => r.source >= line);
        this.top = clampTop(rows, height, at === -1 ? rows.length : at);
    }

    /** The source line at the top of the view. */
    sourceAtTop(rows: readonly MdRow[]): number {
        return rows[Math.min(this.top, rows.length - 1)]?.source ?? 0;
    }
}

export function clampTop(rows: readonly MdRow[], height: number, top: number): number {
    return Math.max(Math.min(top, rows.length - height), 0);
}
