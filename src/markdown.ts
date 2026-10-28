// Markdown's rendered view: a file's blocks laid out as rows of styled text
// to read rather than edit (markup dropped, paragraphs wrapped, code
// highlighted, tables drawn, images and Mermaid diagrams shown), with where
// its links go, and where the view is scrolled to.

import { createHash } from 'node:crypto';
import * as path from 'node:path';

import type { Buffer } from './editor/buffer';
import * as highlight from './highlight';
import type { TextStyle } from './protocol';
import { theme, themeName, tokenColor, tokenStyle } from './theme';

export type StyledRun = [text: string, color: string, style?: TextStyle];

/** A link in a row: its columns `[from, to)`, counted from where the row's
 * text starts, and where it goes (an `href` as `links.parseHref` takes it). */
export interface RowLink {
    from: number;
    to: number;
    href: string;
}

/** A picture in the view, with the size it's shown at in pixels: an image
 * file, or a Mermaid diagram, which the window draws (0 by 0 until it has
 * said how big it is). */
export type Media =
    | { t: 'Image'; file: string; src: string; width: number; height: number }
    | { t: 'Diagram'; id: string; source: string; width: number; height: number };

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
    /** A code block's rows get a background; a rule is a line across; a
     * picture takes as many `media` rows as it is high, and is set on the
     * first. */
    kind?: 'code' | 'rule' | 'media';
    links?: RowLink[];
    media?: Media;
}

/** What the view needs to know to show pictures; without one, images are
 * shown as their names and diagrams as code. */
export interface MediaHost {
    /** Changes whenever the answers below may have. */
    key: string;
    charW: number;
    lineH: number;
    /** The most a picture's height may be, in pixels. */
    maxHeight: number;
    /** The image file an embed's target names (an `href`), with its size in
     * pixels, if it is one that can be shown. */
    image(href: string): { file: string; src: string; width: number; height: number } | undefined;
    /** How big the window drew a diagram, or why it couldn't; nothing until
     * it has tried. */
    diagram(id: string): { width: number; height: number } | { error: string } | undefined;
}

/** Whether a file is Markdown, which has a rendered view. */
export function isMarkdown(file: string | undefined): boolean {
    return file !== undefined && ['.md', '.markdown', '.mdx'].includes(path.extname(file).toLowerCase());
}

/** A character of a paragraph, with how it's drawn, the line it's from and
 * the link it's in; `\n` is a hard line break. */
type Cell = [c: string, color: string, style: TextStyle | undefined, source: number, href?: string];

const charLen = (s: string): number => Array.from(s).length;

const BULLETS = ['•', '◦', '▪'];
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+|$)/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+|$)(.*?)(?:\s+#+)?\s*$/;
const RULE = /^ {0,3}([-*_])( *\1){2,} *$/;
const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`{}]*)/;
/** An embedded image: `![[file.png|300]]`, or `![alt|300](file.png "title")`. */
const EMBED = /!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\\?\|([^\]]*))?\]\]|!\[([^\]]*)\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+"[^"]*")?\s*\)/g;

/** Cells for a line's inline Markdown in `chars[from..to)`, markup dropped. */
function inlineCells(chars: readonly string[], from: number, to: number, source: number, base?: highlight.Token): Cell[] {
    const cells: Cell[] = [];
    for (const s of highlight.markdownInline(chars, from, to, base)) {
        const token = s.token ?? 'Normal';
        const color = s.token === undefined ? theme.FG : tokenColor(token === 'Markup' ? 'Link' : token);
        const style = s.token === undefined ? undefined : tokenStyle(token);
        const text = s.shown ?? chars.slice(s.start, s.end).join('');
        for (const c of text) cells.push(s.href === undefined ? [c, color, style, source] : [c, color, style, source, s.href]);
    }
    return cells;
}

/** The runs and links of a row of cells, its links starting `at` columns in. */
function styled(cells: readonly Cell[], at = 0): { runs: StyledRun[]; links?: RowLink[] } {
    const links: RowLink[] = [];
    cells.forEach(([, , , , href], i) => {
        if (href === undefined) return;
        const last = links[links.length - 1];
        if (last && last.href === href && last.to === at + i) last.to++;
        else links.push({ from: at + i, to: at + i + 1, href });
    });
    return links.length > 0 ? { runs: toRuns(cells), links } : { runs: toRuns(cells) };
}

/** The size to show a picture `width` by `height` at, in pixels: shrunk to
 * fit `cols` columns and the host's height. */
function fitMedia(host: MediaHost, width: number, height: number, cols: number): [number, number] {
    const scale = Math.min(1, (cols * host.charW) / width, host.maxHeight / height);
    return [Math.max(Math.round(width * scale), 1), Math.max(Math.round(height * scale), 1)];
}

/** A Mermaid diagram's id, for the window to say how big it drew it. */
export function diagramId(source: string): string {
    return createHash('sha1').update(source).digest('hex').slice(0, 16);
}

/** The Mermaid theme that matches Wim's colors. */
export function diagramTheme(): Record<string, string> {
    return {
        darkMode: 'true',
        background: theme.BG,
        fontFamily: 'Menlo, Consolas, "DejaVu Sans Mono", monospace',
        fontSize: '14px',
        primaryColor: theme.SELECTION,
        primaryTextColor: theme.FG,
        primaryBorderColor: theme.LINK,
        secondaryColor: theme.CURSOR_LINE,
        secondaryTextColor: theme.FG,
        secondaryBorderColor: theme.GUTTER,
        tertiaryColor: theme.POPUP_BG,
        tertiaryTextColor: theme.FG,
        tertiaryBorderColor: theme.GUTTER,
        lineColor: theme.COMMENT,
        textColor: theme.FG,
        mainBkg: theme.SELECTION,
        nodeBorder: theme.LINK,
        clusterBkg: theme.CURSOR_LINE,
        clusterBorder: theme.GUTTER,
        titleColor: theme.FG,
        edgeLabelBackground: theme.BG,
        noteBkgColor: theme.POPUP_BG,
        noteTextColor: theme.FG,
        noteBorderColor: theme.GUTTER,
        actorBkg: theme.SELECTION,
        actorBorder: theme.LINK,
        actorTextColor: theme.FG,
        signalColor: theme.FG,
        signalTextColor: theme.FG,
        labelBoxBkgColor: theme.SELECTION,
        labelTextColor: theme.FG,
        errorBkgColor: theme.ERROR,
        errorTextColor: theme.BG,
    };
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

/** Lay out Markdown source `lines` as rows `cols` wide, with pictures if
 * there is a `host` to size them. */
export function renderMarkdown(lines: readonly string[], cols: number, host?: MediaHost): MdRow[] {
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
            rows.push({ ...styled([...prefix, ...cells]), source, quote: p.quote, indent: p.indent - (i === 0 ? firstWidth : 0) });
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
            const close = new RegExp(`^\\s*${fence[2][0]}{${fence[2].length},}\\s*$`);
            const body: [code: string, source: number][] = [];
            for (i++; i < lines.length; i++) {
                let code = lines[i];
                for (let q = 0; q < quote; q++) code = code.replace(/^ {0,3}> ?/, '');
                if (close.test(code)) break;
                // Take off the fence's own indent.
                body.push([code.replace(new RegExp(`^ {0,${charLen(fence[1])}}`), '').replace(/\t/g, '    '), i]);
            }
            if (host && fence[3].toLowerCase() === 'mermaid') {
                const source = body.map(([code]) => code).join('\n');
                const id = diagramId(source);
                const size = host.diagram(id);
                const start = body[0]?.[1] ?? i;
                if (size === undefined) {
                    // Until the window has drawn it, and said how big it is.
                    const media: Media = { t: 'Diagram', id, source, width: 0, height: 0 };
                    rows.push({ runs: [['Drawing the diagram…', theme.COMMENT]], source: start, quote, indent, kind: 'media', media });
                    continue;
                }
                if (!('error' in size)) {
                    const [width, height] = fitMedia(host, size.width, size.height, cols - indent - 2 * quote);
                    pushMedia({ t: 'Diagram', id, source, width, height }, start, indent);
                    continue;
                }
                const message = Array.from(`Mermaid: ${size.error}`).map((c): Cell => [c, theme.ERROR, undefined, start]);
                for (const row of wrapCells(message, Math.max(cols - indent - 2 * quote, 1))) {
                    rows.push({ runs: toRuns(row), source: start, quote, indent });
                }
            }
            let state = highlight.NORMAL;
            for (const [code, source] of body) {
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
                rows.push({ runs: runs.filter(([s]) => s !== ''), source, quote, indent, kind: 'code' });
            }
            continue;
        }
        // A setext heading's underline, under a paragraph.
        const setext = /^ {0,3}(=+|-+) *$/.exec(line);
        if (setext && para && para.first.length === 0) {
            const p = para;
            para = undefined;
            const level = setext[1][0] === '=' ? 1 : 2;
            heading(p.cells.map((c): Cell => [c[0] === '\n' ? ' ' : c[0], tokenColor('Heading'), 'bold', c[3], c[4]]), level, p.source, p.indent);
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
        // A line of only images shows them.
        const embeds = host && line.includes('![') ? embedsIn(line.slice(lead)) : undefined;
        if (embeds) {
            flush();
            const indent = indentFor(lead);
            for (const { href, width, height } of embeds) {
                const image = host!.image(href)!;
                const w = width ?? (height !== undefined ? (image.width * height) / image.height : image.width);
                const h = height ?? (image.height * w) / image.width;
                const [fw, fh] = fitMedia(host!, w, h, cols - indent - 2 * quote);
                pushMedia({ t: 'Image', file: image.file, src: image.src, width: fw, height: fh }, i, indent);
            }
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

    /** The images a line embeds, if it has nothing else and they can all be
     * shown. */
    function embedsIn(text: string): { href: string; width?: number; height?: number }[] | undefined {
        if (text.replace(EMBED, '').trim() !== '') return undefined;
        const out: { href: string; width?: number; height?: number }[] = [];
        for (const m of text.matchAll(EMBED)) {
            const href = m[1] !== undefined ? `[[${m[1].trim()}]]` : m[4].replace(/^<(.*)>$/, '$1');
            if (!host!.image(href)) return undefined;
            // A size after a bar: `300` wide, or `300x200`.
            const size = /^\s*(\d+)(?:x(\d+))?\s*$/.exec(m[2] ?? m[3]?.split('|').slice(1).join('|') ?? '');
            out.push(size ? { href, width: Number(size[1]), height: size[2] === undefined ? undefined : Number(size[2]) } : { href });
        }
        return out;
    }

    /** A picture's rows: as many as it is high. */
    function pushMedia(media: Media, source: number, indent: number): void {
        const n = Math.max(Math.ceil(media.height / host!.lineH), 1);
        rows.push({ runs: [], source, quote, indent, kind: 'media', media });
        for (let k = 1; k < n; k++) rows.push({ runs: [], source, quote, indent, kind: 'media' });
    }

    function heading(cells: Cell[], level: number, source: number, indent: number): void {
        if (rows.length > 0) blank(source);
        const width = Math.max(cols - indent - 2 * quote, 1);
        for (const row of wrapCells(cells, width)) rows.push({ ...styled(row), source, quote, indent });
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
                const links: RowLink[] = [];
                let at = 1;
                widths.forEach((w, c) => {
                    const cells = wrapped[c][y] ?? [];
                    const space = w - cells.length;
                    const align = aligns[c] ?? 'left';
                    const before = align === 'right' ? space : align === 'center' ? Math.floor(space / 2) : 0;
                    const cell = styled(cells, at + before + 1);
                    links.push(...(cell.links ?? []));
                    runs.push([' '.repeat(before + 1), theme.FG], ...cell.runs, [' '.repeat(space - before + 1), theme.FG], ['│', border]);
                    at += w + 3;
                });
                const row: MdRow = { runs: runs.filter(([s]) => s !== ''), source: r.source, quote, indent };
                rows.push(links.length > 0 ? { ...row, links } : row);
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

    rows(buffer: Buffer, cols: number, host?: MediaHost): MdRow[] {
        const key = `${buffer.version()}:${cols}:${themeName()}:${host?.key}`;
        if (this.cache?.key !== key) {
            const lines = Array.from({ length: buffer.lineCount() }, (_, i) => buffer.lineString(i));
            this.cache = { key, rows: renderMarkdown(lines, cols, host) };
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
