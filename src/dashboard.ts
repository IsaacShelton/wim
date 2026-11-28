// The dashboard shown when Wim starts without a project folder: the projects
// opened recently, filtered as you type and chosen with Enter or a click.

import * as os from 'node:os';
import * as path from 'node:path';

import { KeyInput, isCharKey } from './editor/keys';
import { fuzzyScore } from './fuzzy';
import { baseName } from './paths';
import { textWidth } from './textwidth';

/** Something the dashboard can open. */
export interface DashboardItem {
    /** The folder to open; empty when the system's folder chooser is asked. */
    dir: string;
    /** The name drawn in the list. */
    label: string;
    /** The folder's path, shortened with `~`, drawn dimmed. */
    detail: string;
    /** Ask the system for a folder instead of opening `dir`. */
    pickFolder?: boolean;
}

/** A project row as it is drawn, for mouse clicks. */
export interface DashboardRow {
    item: DashboardItem;
    /** The row's place in the filtered list. */
    index: number;
    left: number;
    right: number;
    top: number;
    bottom: number;
}

/** Where the dashboard's parts go for one frame. */
export interface DashboardLayout {
    left: number;
    right: number;
    titleTop: number;
    prompt: { left: number; top: number; right: number; bottom: number };
    /** Where the prompt's text is, and the caret after the query. */
    promptTextTop: number;
    caretX: number;
    listTop: number;
    footerTop: number;
    rows: DashboardRow[];
}

/** Vertical padding inside the search box, in pixels. */
const PAD = 4;
/** How many project rows are shown at most. */
const MAX_ROWS = 12;

/** The project names a dashboard offers: the recent projects, then a way to
 * choose another folder. */
export function projectItems(dirs: readonly string[]): DashboardItem[] {
    const items: DashboardItem[] = dirs.map((dir) => ({
        dir,
        label: baseName(dir) || dir,
        detail: shortPath(dir),
    }));
    items.push({ dir: '', label: 'Open Project Folder…', detail: 'Choose a folder', pickFolder: true });
    return items;
}

/** `dir` with the home directory written as `~`. */
export function shortPath(dir: string): string {
    const home = os.homedir();
    if (dir === home) return '~';
    if (dir.startsWith(home + path.sep)) return '~' + dir.slice(home.length);
    return dir;
}

/** The startup screen: a fuzzy-filtered list of projects. */
export class Dashboard {
    query = '';
    /** The items matching the query, in the order they are shown. */
    filtered: DashboardItem[];
    selected = 0;
    scroll = 0;
    /** Rows shown in the last frame. */
    visibleRows = MAX_ROWS;
    /** A problem with the last choice, shown in the footer. */
    message: string | undefined;
    private readonly items: DashboardItem[];
    private wheelLines = 0;

    constructor(items: readonly DashboardItem[]) {
        this.items = [...items];
        this.filtered = [...items];
    }

    /** A note under the list (a project that could not be opened, say). */
    setMessage(message: string | undefined): void {
        this.message = message;
    }

    /** Type text into the search box (Cmd+V). */
    paste(text: string): void {
        this.setQuery(this.query + text.split('\n')[0]);
    }

    /** Handle a key. Returns the chosen item, `'cancel'` for Esc, or
     * undefined while the dashboard stays open. */
    key(key: KeyInput): DashboardItem | 'cancel' | undefined {
        if (key.key === 'Esc' || (key.ctrl && key.key === 'c')) return 'cancel';
        if (key.key === 'Enter') return this.filtered[this.selected];
        const ctrl = key.ctrl ? key.key : undefined;
        if (key.key === 'Down' || key.key === 'Tab' || ctrl === 'n' || ctrl === 'j') this.move(1);
        else if (key.key === 'Up' || key.key === 'BackTab' || ctrl === 'p' || ctrl === 'k') this.move(-1);
        else if (key.key === 'PageDown' || ctrl === 'd') this.move(Math.max(Math.floor(this.visibleRows / 2), 1));
        else if (key.key === 'PageUp') this.move(-Math.max(Math.floor(this.visibleRows / 2), 1));
        else if (ctrl === 'u') this.setQuery('');
        else if (key.key === 'Backspace' && key.alt) this.setQuery(deleteWord(this.query));
        else if (key.key === 'Backspace' || ctrl === 'h') this.setQuery(Array.from(this.query).slice(0, -1).join(''));
        else if (ctrl === 'w') this.setQuery(deleteWord(this.query));
        else if (!key.ctrl && !key.alt && isCharKey(key)) this.setQuery(this.query + key.key);
        return undefined;
    }

    /** Scroll by a wheel's lines. */
    wheel(lines: number): void {
        this.wheelLines += lines;
        const whole = Math.trunc(this.wheelLines);
        if (whole === 0) return;
        this.wheelLines -= whole;
        this.move(whole);
    }

    /** The item at a point, selecting it (for a hover or a click); nothing
     * when the point is outside the list. */
    itemAt(x: number, y: number, width: number, height: number, charW: number, lineH: number): DashboardItem | undefined {
        const layout = this.layout(width, height, charW, lineH);
        const row = layout.rows.find((r) => x >= r.left && x < r.right && y >= r.top && y < r.bottom);
        if (!row) return undefined;
        this.selected = row.index;
        this.keepSelectionVisible();
        return row.item;
    }

    /** Where everything goes in a window of this size, with the visible rows
     * for mouse clicks. */
    layout(width: number, height: number, charW: number, lineH: number): DashboardLayout {
        const cols = Math.max(Math.min(Math.floor(width / charW) - 8, 96), 20);
        const left = Math.round((width - cols * charW) / 2);
        const right = left + cols * charW;
        this.visibleRows = Math.max(Math.min(Math.floor(height / lineH) - 8, MAX_ROWS), 1);
        this.keepSelectionVisible();
        const shown = Math.min(this.filtered.length, this.visibleRows);
        const promptHeight = lineH + 2 * PAD;
        // The title, a gap, the search box, a gap, the rows (one row says
        // there are none), a gap and the footer.
        const total = promptHeight + (5 + Math.max(shown, 1)) * lineH;
        const titleTop = Math.max(Math.floor((height - total) / 2 / lineH) * lineH, 0);
        const promptTop = titleTop + 2 * lineH;
        const listTop = promptTop + promptHeight + lineH;
        const footerTop = listTop + Math.max(shown, 1) * lineH + lineH;
        const rows: DashboardRow[] = [];
        for (let i = 0; i < shown; i++) {
            const top = listTop + i * lineH;
            rows.push({ item: this.filtered[this.scroll + i], index: this.scroll + i, left, right, top, bottom: top + lineH });
        }
        return {
            left,
            right,
            titleTop,
            prompt: { left, top: promptTop, right, bottom: promptTop + promptHeight },
            promptTextTop: promptTop + PAD,
            caretX: left + charW * (3 + textWidth(this.query)),
            listTop,
            footerTop,
            rows,
        };
    }

    private setQuery(query: string): void {
        if (query === this.query) return;
        this.query = query;
        this.filtered = this.filter();
        this.selected = 0;
        this.scroll = 0;
        this.message = undefined;
    }

    private filter(): DashboardItem[] {
        if (this.query === '') return [...this.items];
        const scored: [DashboardItem, number][] = [];
        for (const item of this.items) {
            const score = fuzzyScore(this.query, item.label) ?? fuzzyScore(this.query, `${item.label} ${item.detail}`);
            if (score !== undefined) scored.push([item, score]);
        }
        scored.sort((a, b) => b[1] - a[1]);
        return scored.map(([item]) => item);
    }

    private move(delta: number): void {
        const n = this.filtered.length;
        if (n === 0) return;
        this.selected = (((this.selected + delta) % n) + n) % n;
        this.keepSelectionVisible();
    }

    private keepSelectionVisible(): void {
        const n = this.filtered.length;
        if (n === 0) {
            this.selected = 0;
            this.scroll = 0;
            return;
        }
        this.selected = Math.min(this.selected, n - 1);
        if (this.selected < this.scroll) this.scroll = this.selected;
        if (this.selected >= this.scroll + this.visibleRows) this.scroll = this.selected - this.visibleRows + 1;
        this.scroll = Math.max(Math.min(this.scroll, n - this.visibleRows), 0);
    }
}

/** Delete the last word of a query, for Ctrl+W and Alt+Backspace. */
function deleteWord(s: string): string {
    const trimmed = s.replace(/\s+$/, '');
    const kept = trimmed.replace(/[\p{L}\p{N}_]+$/u, '');
    return kept.length === trimmed.length ? Array.from(trimmed).slice(0, -1).join('') : kept;
}
