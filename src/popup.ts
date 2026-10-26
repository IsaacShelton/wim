// Popups drawn over the editor: floating text (hover, diagnostics), the
// completion menu and a Telescope-style picker.

import { Pos } from './editor/buffer';
import { KeyInput, charOf, isCharKey } from './editor/keys';
import { fuzzyScore } from './fuzzy';
import { DrawCmd } from './protocol';
import { theme } from './theme';

/** A piece of text in one color. */
export type Run = [text: string, color: string];

export interface Box {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

/** Vertical padding inside a popup's border, in pixels. */
const PAD = 4;

function width(s: string): number {
    return Array.from(s).length;
}

function runsWidth(runs: readonly Run[]): number {
    return runs.reduce((n, [s]) => n + width(s), 0);
}

/** Break a line of runs into lines at most `cols` wide, at spaces where
 * possible. */
export function wrapRuns(line: readonly Run[], cols: number): Run[][] {
    const chars: [string, string][] = [];
    for (const [s, color] of line) for (const c of s) chars.push([c, color]);
    const out: Run[][] = [];
    let start = 0;
    while (chars.length - start > cols) {
        let end = start + cols;
        for (let i = end; i > start + cols / 2; i--) {
            if (chars[i][0] === ' ') {
                end = i;
                break;
            }
        }
        out.push(toRuns(chars.slice(start, end)));
        start = end;
        while (start < chars.length && chars[start][0] === ' ') start++;
    }
    out.push(toRuns(chars.slice(start)));
    return out;
}

function toRuns(chars: [string, string][]): Run[] {
    const runs: Run[] = [];
    for (const [c, color] of chars) {
        const last = runs[runs.length - 1];
        if (last && last[1] === color) last[0] += c;
        else runs.push([c, color]);
    }
    return runs;
}

/** Draws popups as drawing commands on the character grid. */
export class Overlay {
    constructor(
        private readonly cmds: DrawCmd[],
        private readonly cw: number,
        private readonly lh: number,
    ) {}

    private rect(b: Box, color: string): void {
        if (b.right > b.left && b.bottom > b.top) this.cmds.push(['rect', b.left, b.top, b.right - b.left, b.bottom - b.top, color, 0]);
    }

    private text(x: number, y: number, s: string, color: string): void {
        if (s !== '') this.cmds.push(['text', x, y, s, color]);
    }

    private runs(x: number, y: number, runs: readonly Run[], maxCols: number): void {
        let col = 0;
        for (const [s, color] of runs) {
            const chars = Array.from(s);
            const room = maxCols - col;
            if (room <= 0) break;
            this.text(x + col * this.cw, y, chars.slice(0, room).join(''), color);
            col += chars.length;
        }
    }

    /** A bordered box with a title in its top border. */
    private frame(b: Box, title?: string): void {
        this.rect(b, theme.POPUP_BG);
        this.cmds.push(['stroke', b.left, b.top, b.right - b.left, b.bottom - b.top, theme.POPUP_BORDER]);
        if (title) {
            const t = ` ${title} `;
            const x = b.left + this.cw;
            this.rect({ left: x, top: b.top - 1, right: x + width(t) * this.cw, bottom: b.top + 2 }, theme.POPUP_BG);
            this.cmds.push(['text', x, b.top - this.lh / 2, t, theme.FG]);
        }
    }

    /** Place a `w` by `h` box next to the cell at (`x`, `y`): below it if it
     * fits, otherwise wherever there is more room. */
    private place(area: Box, x: number, y: number, w: number, h: number): Box {
        const below = area.bottom - (y + this.lh);
        const above = y - area.top;
        const left = Math.max(Math.min(x, area.right - w), area.left);
        if (h <= below || below >= above) return { left, top: y + this.lh, right: left + w, bottom: y + this.lh + Math.min(h, below) };
        return { left, top: y - Math.min(h, above), right: left + w, bottom: y };
    }

    float(f: Float, area: Box, anchorX: number, anchorY: number): void {
        const maxCols = Math.max(Math.floor((area.right - area.left) / this.cw) - 4, 10);
        const lines = f.layout(Math.min(maxCols, 80));
        const cols = Math.max(...lines.map(runsWidth), 1);
        // Up to half the height; all of it once focused.
        const fullRows = Math.max(Math.floor((area.bottom - area.top - 2 * PAD) / this.lh) - 1, 1);
        const rows = Math.min(lines.length, f.focused ? fullRows : Math.max(Math.floor(fullRows / 2), 3));
        f.visibleRows = rows;
        f.scroll = Math.max(Math.min(f.scroll, lines.length - rows), 0);
        const b = this.place(area, anchorX, anchorY, (cols + 2) * this.cw, rows * this.lh + 2 * PAD);
        this.frame(b);
        if (f.focused) this.cmds.push(['stroke', b.left, b.top, b.right - b.left, b.bottom - b.top, theme.CURSOR]);
        this.cmds.push(['clip', b.left, b.top, b.right - b.left, b.bottom - b.top]);
        const shown = Math.floor((b.bottom - b.top - 2 * PAD) / this.lh);
        for (let i = 0; i < shown && f.scroll + i < lines.length; i++) {
            this.runs(b.left + this.cw, b.top + PAD + i * this.lh, lines[f.scroll + i], cols);
        }
        this.cmds.push(['unclip']);
    }

    completion(menu: CompletionMenu, area: Box, anchorX: number, anchorY: number, icons: boolean): void {
        const items = menu.items;
        const rows = Math.min(items.length, MENU_ROWS);
        menu.scroll = Math.max(Math.min(menu.scroll, items.length - rows), 0);
        const shown = items.slice(menu.scroll, menu.scroll + rows);
        const labelCols = Math.min(Math.max(...shown.map((e) => width(e.label))), 50);
        const menuCols = Math.max(...shown.map((e) => width(e.kind) + 5));
        const cols = 3 + 1 + labelCols + menuCols;
        // The label lines up with the word being completed.
        const b = this.place(area, anchorX - 4 * this.cw, anchorY, cols * this.cw, rows * this.lh);
        this.rect(b, theme.POPUP_BG);
        this.cmds.push(['clip', b.left, b.top, b.right - b.left, b.bottom - b.top]);
        shown.forEach((e, i) => {
            const y = b.top + i * this.lh;
            if (menu.scroll + i === menu.selected) this.rect({ left: b.left, top: y, right: b.right, bottom: y + this.lh }, theme.POPUP_SELECTION);
            this.rect({ left: b.left, top: y, right: b.left + 3 * this.cw, bottom: y + this.lh }, kindColor(e.kind));
            this.text(b.left + this.cw, y, icons ? (KIND_ICONS[e.kind] ?? '') : e.kind.charAt(0), theme.BG);
            this.runs(b.left + 4 * this.cw, y, [[e.label, theme.FG]], labelCols);
            this.text(b.left + (4 + labelCols) * this.cw, y, `   (${e.kind})`, theme.COMMENT);
        });
        this.cmds.push(['unclip']);
    }

    picker<T>(p: Picker<T>, area: Box): void {
        const areaCols = Math.floor((area.right - area.left) / this.cw);
        const areaRows = Math.floor((area.bottom - area.top) / this.lh);
        const cols = Math.max(Math.min(Math.round(areaCols * 0.8), 120, areaCols - 4), 10);
        const rows = p.inputOnly ? 1 : Math.max(Math.min(Math.round(areaRows * 0.6), areaRows - 4), 3);
        const w = (cols + 2) * this.cw;
        const h = (rows + (p.inputOnly ? 0 : 1)) * this.lh + 2 * PAD;
        const left = area.left + Math.floor((area.right - area.left - w) / 2);
        const top = p.inputOnly ? area.top + Math.floor((area.bottom - area.top) / 3) : area.top + Math.floor((area.bottom - area.top - h) / 2);
        const b = { left, top, right: left + w, bottom: top + h };
        this.frame(b, p.title);
        const x = b.left + this.cw;
        let y = b.top + PAD;
        // The prompt.
        const prompt = p.inputOnly ? p.query : `> ${p.query}`;
        this.runs(x, y, [[prompt, theme.FG]], cols);
        const end = x + Math.min(width(prompt), cols) * this.cw;
        this.rect({ left: end, top: y, right: end + 2, bottom: y + this.lh }, theme.CURSOR);
        if (p.inputOnly) return;
        const count = `${p.filtered.length} / ${p.total}`;
        this.text(b.right - (width(count) + 1) * this.cw, y, count, theme.COMMENT);
        y += this.lh;
        this.rect({ left: b.left, top: y, right: b.right, bottom: y + 1 }, theme.POPUP_BORDER);
        const listRows = rows - 1;
        p.visibleRows = listRows;
        p.keepSelectionVisible();
        this.cmds.push(['clip', b.left, y, w, b.bottom - y]);
        for (let i = 0; i < listRows && p.scroll + i < p.filtered.length; i++) {
            const item = p.filtered[p.scroll + i];
            const ry = y + PAD + i * this.lh;
            if (p.scroll + i === p.selected) this.rect({ left: b.left + 1, top: ry, right: b.right - 1, bottom: ry + this.lh }, theme.POPUP_SELECTION);
            const detail = item.detail ?? '';
            const detailCols = Math.min(width(detail), Math.floor(cols / 2));
            const labelCols = cols - (detailCols > 0 ? detailCols + 2 : 0);
            this.runs(x, ry, [[item.label, item.color ?? theme.FG]], labelCols);
            if (detailCols > 0) this.runs(x + (cols - detailCols) * this.cw, ry, [[detail, theme.COMMENT]], detailCols);
        }
        if (p.filtered.length === 0 && p.message) this.text(x, y + PAD, p.message, theme.COMMENT);
        this.cmds.push(['unclip']);
    }
}

// ----- Floating text ------------------------------------------------------------------------

/** Text shown next to a position, such as hover documentation. Any key closes
 * it, unless it was focused (by asking for it again) to scroll it. */
export class Float {
    focused = false;
    scroll = 0;
    /** Rows shown in the last frame. */
    visibleRows = 1;
    private wrapped: { cols: number; lines: Run[][] } | undefined;

    constructor(
        readonly lines: Run[][],
        /** Where it is shown, in the buffer it belongs to. */
        readonly anchor: Pos,
        readonly bufferId: number,
    ) {}

    layout(cols: number): Run[][] {
        if (this.wrapped?.cols !== cols) this.wrapped = { cols, lines: this.lines.flatMap((l) => wrapRuns(l, cols)) };
        return this.wrapped.lines;
    }

    /** A key while focused; returns false when the float should close. */
    key(key: KeyInput): boolean {
        const half = Math.max(Math.floor(this.visibleRows / 2), 1);
        const c = key.ctrl ? undefined : charOf(key);
        if (key.key === 'Esc' || c === 'q') return false;
        if (c === 'j' || key.key === 'Down' || (key.ctrl && key.key === 'e')) this.scroll += 1;
        else if (c === 'k' || key.key === 'Up' || (key.ctrl && key.key === 'y')) this.scroll -= 1;
        else if ((key.ctrl && key.key === 'd') || key.key === 'PageDown' || (key.ctrl && key.key === 'f')) this.scroll += half;
        else if ((key.ctrl && key.key === 'u') || key.key === 'PageUp' || (key.ctrl && key.key === 'b')) this.scroll -= half;
        else if (c === 'G' || key.key === 'End') this.scroll = Infinity;
        else if (c === 'g' || key.key === 'Home') this.scroll = 0;
        this.scroll = Math.max(this.scroll, 0);
        return true;
    }
}

// ----- Completion menu --------------------------------------------------------------------

const MENU_ROWS = 10;

export interface MenuEntry {
    label: string;
    /** The kind's name, such as `Function`. */
    kind: string;
}

export interface CompletionMenu {
    items: readonly MenuEntry[];
    /** -1 when nothing is selected. */
    selected: number;
    scroll: number;
}

/** Keep the selected entry of a menu in view. */
export function scrollMenu(menu: CompletionMenu): void {
    if (menu.selected < 0) return;
    if (menu.selected < menu.scroll) menu.scroll = menu.selected;
    if (menu.selected >= menu.scroll + MENU_ROWS) menu.scroll = menu.selected - MENU_ROWS + 1;
}

/** Icons from the Neovim config's `lspkind_icons.lua`. */
const KIND_ICONS: Record<string, string> = {
    Text: '\u{f027f}',
    Method: '\u{f01a7}',
    Function: '\u{f01a7}',
    Constructor: '\u{f423}',
    Field: '\u{f0722}',
    Variable: '\u{f002b}',
    Class: '\u{f0831}',
    Interface: '\u{f0e8}',
    Module: '\u{f487}',
    Property: '\u{f0722}',
    Unit: '\u{f046d}',
    Value: '\u{f03a0}',
    Enum: '\u{f15d}',
    Keyword: '\u{f030b}',
    Snippet: '\u{f44f}',
    Color: '\u{f03d8}',
    File: '\u{f021a}',
    Reference: '\u{f0207}',
    Folder: '\u{f024b}',
    EnumMember: '\u{f15d}',
    Constant: '\u{f03ff}',
    Struct: '\u{f0645}',
    Event: '\u{f0e7}',
    Operator: '\u{f0195}',
    TypeParameter: '\u{f0284}',
};

/** The kind column's color, as in the Neovim config's nvim-cmp highlights. */
function kindColor(kind: string): string {
    switch (kind) {
        case 'Function':
        case 'Method':
            return theme.KEYWORD;
        case 'Variable':
        case 'Interface':
        case 'Class':
            return theme.FUNCTION;
        case 'Snippet':
            return theme.STRING;
        case 'Text':
            return theme.FG;
        default:
            return theme.MACRO;
    }
}

// ----- Picker -----------------------------------------------------------------------------------

export interface PickerItem<T> {
    label: string;
    /** Shown dimmed on the right, and matched too. */
    detail?: string;
    color?: string;
    value: T;
}

export interface PickerOptions<T> {
    /** Called with the query as it changes, for pickers whose items come from
     * a search (workspace symbols). Without it the items are filtered. */
    onQuery?: (query: string) => void;
    /** Shown when there are no items. */
    message?: string;
    initialQuery?: string;
    /** For a text prompt with no list: accepting passes the query. */
    onInput?: (text: string) => void;
    items?: PickerItem<T>[];
}

/** A Telescope-style list to choose from, filtered by typing. */
export class Picker<T> {
    query: string;
    filtered: PickerItem<T>[] = [];
    selected = 0;
    scroll = 0;
    /** Rows shown in the last frame. */
    visibleRows = 10;
    message: string | undefined;
    private items: PickerItem<T>[];

    constructor(
        readonly title: string,
        private readonly onAccept: (value: T) => void,
        private readonly opts: PickerOptions<T> = {},
    ) {
        this.items = opts.items ?? [];
        this.query = opts.initialQuery ?? '';
        this.message = opts.message;
        this.filter();
    }

    get inputOnly(): boolean {
        return this.opts.onInput !== undefined;
    }

    get total(): number {
        return this.items.length;
    }

    setItems(items: PickerItem<T>[], message?: string): void {
        this.items = items;
        this.message = message;
        this.filter();
    }

    private filter(): void {
        if (this.opts.onQuery) {
            this.filtered = this.items;
        } else {
            const scored: [PickerItem<T>, number][] = [];
            for (const item of this.items) {
                const s = fuzzyScore(this.query, item.label) ?? fuzzyScore(this.query, `${item.label} ${item.detail ?? ''}`);
                if (s !== undefined) scored.push([item, s]);
            }
            // A stable sort keeps the items' own order among equal scores.
            if (this.query !== '') scored.sort((a, b) => b[1] - a[1]);
            this.filtered = scored.map(([item]) => item);
        }
        this.selected = 0;
        this.scroll = 0;
    }

    keepSelectionVisible(): void {
        if (this.selected < this.scroll) this.scroll = this.selected;
        if (this.selected >= this.scroll + this.visibleRows) this.scroll = this.selected - this.visibleRows + 1;
    }

    private move(delta: number): void {
        const n = this.filtered.length;
        if (n === 0) return;
        this.selected = (((this.selected + delta) % n) + n) % n;
        this.keepSelectionVisible();
    }

    private setQuery(query: string): void {
        if (query === this.query) return;
        this.query = query;
        if (this.opts.onQuery) this.opts.onQuery(query);
        else this.filter();
    }

    /** Type text into the prompt (Cmd+V). */
    paste(text: string): void {
        this.setQuery(this.query + text.split('\n')[0]);
    }

    /** Handle a key; returns false when the picker is done. */
    key(key: KeyInput): boolean {
        if (key.key === 'Esc' || (key.ctrl && key.key === 'c')) return false;
        if (key.key === 'Enter') {
            if (this.opts.onInput) {
                this.opts.onInput(this.query);
            } else {
                const item = this.filtered[this.selected];
                if (!item) return true;
                this.onAccept(item.value);
            }
            return false;
        }
        const ctrl = key.ctrl ? key.key : undefined;
        if (key.key === 'Down' || key.key === 'Tab' || ctrl === 'n' || ctrl === 'j') this.move(1);
        else if (key.key === 'Up' || key.key === 'BackTab' || ctrl === 'p' || ctrl === 'k') this.move(-1);
        else if (key.key === 'PageDown' || ctrl === 'd') this.move(Math.max(Math.floor(this.visibleRows / 2), 1));
        else if (ctrl === 'u' && this.inputOnly) this.setQuery('');
        else if (key.key === 'PageUp' || ctrl === 'u') this.move(-Math.max(Math.floor(this.visibleRows / 2), 1));
        else if (key.key === 'Backspace' && key.alt) this.setQuery(deleteWord(this.query));
        else if (key.key === 'Backspace' || ctrl === 'h') this.setQuery(Array.from(this.query).slice(0, -1).join(''));
        else if (ctrl === 'w') this.setQuery(deleteWord(this.query));
        else if (!key.ctrl && !key.alt && isCharKey(key)) this.setQuery(this.query + key.key);
        return true;
    }
}

function deleteWord(s: string): string {
    const trimmed = s.replace(/\s+$/, '');
    const kept = trimmed.replace(/[\p{L}\p{N}_]+$/u, '');
    return kept.length === trimmed.length ? Array.from(trimmed).slice(0, -1).join('') : kept;
}
