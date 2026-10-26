// The window's logic: translates window input into editor keys and paints the
// editor state (file tree, buffer tabs, text, gutter, selection, cursor,
// status and command lines) as a list of drawing commands for the window.

import * as path from 'node:path';

import { Clipboard, SystemClipboard } from './clipboard';
import { Pos, isWhitespace, pos } from './editor/buffer';
import { Editor } from './editor/editor';
import { KeyInput, ch, charOf, ctrl, isNamedKey, keyEq, keyNew, keyToString, parseKeys, plain } from './editor/keys';
import { isCmdLine } from './editor/mode';
import { Range } from './editor/range';
import { lineMatches } from './editor/search';
import { FileTree } from './filetree';
import * as highlight from './highlight';
import { Token } from './highlight';
import * as icons from './icons';
import { Command, Keymap, MapMode, Rhs, TIMEOUT } from './keymap';
import { baseName, currentDir } from './paths';
import { ClientMessage, DrawCmd } from './protocol';

const theme = {
    BG: '#282c34',
    FG: '#abb2bf',
    CURSOR_LINE: '#2c313c',
    GUTTER: '#4b5263',
    GUTTER_CURRENT: '#e5c07b',
    TILDE: '#3b4048',
    SELECTION: '#3e4451',
    SEARCH: '#5c4f2e',
    CURSOR: '#528bff',
    STATUS_BG: '#21252b',
    ERROR: '#e06c75',
    /** Yank flash, as `[r, g, b]`; the alpha fades over time. */
    FLASH: [0xe5, 0xc0, 0x7b],

    KEYWORD: '#c678dd',
    TYPE: '#e5c07b',
    CONSTANT: '#d19a66',
    STRING: '#98c379',
    COMMENT: '#7f848e',
    FUNCTION: '#61afef',
    MACRO: '#56b6c2',

    MODE_NORMAL: '#61afef',
    MODE_INSERT: '#98c379',
    MODE_VISUAL: '#c678dd',
    MODE_REPLACE: '#e06c75',
    MODE_COMMAND: '#e5c07b',
    MODE_TREE: '#56b6c2',
} as const;

const TEXT_PADDING = 6;
/** Width of the file tree, in characters. */
const SIDEBAR_COLS = 30;
const FLASH_DURATION = 300;
/** How far the mouse must move before a press becomes a drag, in pixels. */
const DRAG_THRESHOLD = 4;

interface Rect {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

function rect(left: number, top: number, right: number, bottom: number): Rect {
    return { left, top, right, bottom };
}

function contains(r: Rect, x: number, y: number): boolean {
    return x >= r.left && x < r.right && y >= r.top && y < r.bottom;
}

export interface Metrics {
    width: number;
    height: number;
    charW: number;
    lineH: number;
}

/** Screen geometry for one frame. */
interface Layout {
    sidebar?: Rect;
    tabline?: Rect;
    textArea: Rect;
    textLeft: number;
    status: Rect;
    cmdline: Rect;
    charW: number;
    lineH: number;
    rows: number;
    cols: number;
    treeRows: number;
}

type Focus = 'Editor' | 'Tree';

interface Flash {
    range: Range;
    bufferId: number;
    start: number;
}

export interface AppOptions {
    /** The file to open, if any. */
    path?: string;
    /** Whether a Nerd Font is available, so file icons can be drawn. */
    icons: boolean;
    clipboard?: Clipboard;
    /** Called whenever the window should be repainted. */
    onFrame: (title: string, dirty: boolean, cmds: DrawCmd[]) => void;
    /** Called once when Wim should exit. */
    onQuit: () => void;
}

export class WimApp {
    readonly editor: Editor;
    private readonly clipboard: Clipboard;
    private readonly keymap = Keymap.fromNeovimConfig();
    /** Keys typed so far that may be the start of a mapping. */
    private mapPending: KeyInput[] = [];
    /** The mode `mapPending` is being matched in (undefined: no mappings apply). */
    private mapMode: MapMode | undefined;
    /** Waits for the rest of an ambiguous or partial mapping (`timeoutlen`). */
    private mapTimer: NodeJS.Timeout | undefined;
    /** A mapping that needs one more typed character (`ç`, `∂`). */
    private awaitingChar: Command | undefined;
    private readonly icons: boolean;
    private readonly tree: FileTree;
    private treeVisible = false;
    private focus: Focus = 'Editor';
    /** `<C-w>` was pressed; the next key picks a window. */
    private windowCmdPending = false;
    /** The file last revealed in the tree, to follow buffer switches. */
    private revealed: string | undefined;
    private treeCwd: string | undefined;
    private flash: Flash | undefined;
    private flashTimer: NodeJS.Timeout | undefined;
    /** Buffer tabs from the last frame, for mouse clicks. */
    private tabHits: [Rect, number][] = [];
    private readonly highlightCache = new highlight.Cache();
    private scrollRemainder = 0;
    private closeWarned = false;
    private metrics: Metrics = { width: 1000, height: 720, charW: 9, lineH: 23 };
    /** The press that may become a drag in the text area. */
    private press: { x: number; y: number; dragging: boolean } | undefined;
    private quitting = false;

    constructor(private readonly opts: AppOptions) {
        this.icons = opts.icons;
        this.clipboard = opts.clipboard ?? new SystemClipboard();
        // Launched from a file manager the working directory may be the root;
        // use the file's directory instead so the tree and relative paths are
        // useful.
        const cwd = process.cwd();
        if (path.dirname(cwd) === cwd && opts.path !== undefined) {
            const dir = path.dirname(path.resolve(opts.path));
            try {
                process.chdir(dir);
            } catch {
                // Keep the working directory.
            }
        }
        this.editor = new Editor(this.clipboard);
        if (opts.path !== undefined) this.editor.openFile(opts.path);
        const root = currentDir();
        this.tree = new FileTree(root);
        this.treeCwd = root;
    }

    // ----- Messages from the window ----------------------------------------------

    handleMessage(msg: ClientMessage): void {
        if (this.quitting) return;
        const layout = this.prepare();
        switch (msg.t) {
            case 'resize':
                this.metrics = {
                    width: Math.max(msg.width, 1),
                    height: Math.max(msg.height, 1),
                    charW: Math.max(msg.charW, 1),
                    lineH: Math.max(msg.lineH, 1),
                };
                break;
            case 'key': {
                const key = toKeyInput(msg);
                if (key) this.key(key);
                break;
            }
            case 'command':
                this.command(msg.name);
                break;
            case 'mouse':
                this.mouse(layout, msg.kind, msg.x, msg.y);
                break;
            case 'wheel':
                this.wheel(layout, msg);
                break;
            case 'close':
                this.requestClose();
                break;
        }
        this.render();
    }

    private command(name: 'save' | 'copy' | 'cut' | 'paste'): void {
        this.closeWarned = false;
        switch (name) {
            case 'save':
                this.editor.handleKeys(parseKeys('<Esc>:w<CR>'));
                break;
            case 'copy':
            case 'cut':
                this.editor.copySelection(name === 'cut');
                break;
            case 'paste':
                if (this.focus === 'Editor') {
                    const text = this.clipboard.getText();
                    if (text !== undefined) this.editor.pasteText(text);
                }
                break;
        }
    }

    private wheel(layout: Layout, msg: { x: number; y: number; delta: number; mode: number }): void {
        const lines = msg.mode === 1 ? msg.delta : msg.mode === 2 ? msg.delta * layout.rows : msg.delta / layout.lineH;
        this.scrollRemainder += lines;
        const whole = Math.trunc(this.scrollRemainder);
        if (whole === 0) return;
        this.scrollRemainder -= whole;
        if (layout.sidebar && contains(layout.sidebar, msg.x, msg.y)) this.tree.scrollBy(whole);
        else this.editor.scrollBy(whole);
    }

    private key(key: KeyInput): void {
        this.closeWarned = false;
        if (this.awaitingChar !== undefined) {
            const command = this.awaitingChar;
            this.awaitingChar = undefined;
            const c = charOf(key);
            if (c !== undefined) {
                const insert = command === 'InsertCharBefore' ? 'i' : 'a';
                this.editor.handleKeys([ch(insert), ch(c), plain('Esc')]);
            }
            return;
        }
        if (this.mapPending.length === 0) this.mapMode = this.currentMapMode();
        if (this.mapMode === undefined) {
            this.dispatch(key);
            return;
        }
        this.mapPending.push(key);
        this.resolveMappings(false);
    }

    /** The mapping mode for the next key, if mappings apply right now. Like
     * Neovim's Normal-mode maps, they don't apply in the middle of a command
     * (so `df,` still finds a comma even though `,` is the leader). */
    private currentMapMode(): MapMode | undefined {
        if (this.focus === 'Tree') return 'Normal';
        if (this.editor.pending.length > 0 || this.windowCmdPending) return undefined;
        switch (this.editor.mode) {
            case 'Normal':
                return 'Normal';
            case 'Visual':
            case 'VisualLine':
                return 'Visual';
            case 'Insert':
            case 'Replace':
                return 'Insert';
            default:
                return undefined;
        }
    }

    /** Run a complete mapping in `mapPending`, keep waiting on a partial or
     * ambiguous one, or pass keys through unmapped. */
    private resolveMappings(timedOut: boolean): void {
        this.clearMapTimer();
        while (this.mapPending.length > 0) {
            const mode = this.mapMode;
            if (mode === undefined) {
                const keys = this.mapPending;
                this.mapPending = [];
                for (const k of keys) this.dispatch(k);
                break;
            }
            const found = this.keymap.lookup(mode, this.mapPending, this.focus === 'Tree');
            if (found.t === 'Exact' && (timedOut || !found.ambiguous)) {
                this.mapPending = [];
                this.runMapping(found.rhs);
                return;
            }
            if ((found.t === 'Exact' || found.t === 'Prefix') && !timedOut) {
                this.mapTimer = setTimeout(() => {
                    this.mapTimer = undefined;
                    this.prepare();
                    this.resolveMappings(true);
                    this.render();
                }, TIMEOUT);
                return;
            }
            // Not a mapping: type the first key as is, then look at the rest
            // again.
            const first = this.mapPending.shift()!;
            this.dispatch(first);
            this.mapMode = this.currentMapMode();
            timedOut = false;
        }
    }

    private clearMapTimer(): void {
        if (this.mapTimer) clearTimeout(this.mapTimer);
        this.mapTimer = undefined;
    }

    private runMapping(rhs: Rhs): void {
        if (rhs.t === 'Keys') {
            this.editor.handleKeys(rhs.keys);
            return;
        }
        switch (rhs.command) {
            case 'WindowLeft':
                if (this.treeVisible) {
                    this.editorToNormal();
                    this.focus = 'Tree';
                }
                break;
            case 'WindowRight':
                this.focus = 'Editor';
                break;
            // There are no splits above or below.
            case 'WindowUp':
            case 'WindowDown':
                break;
            case 'ToggleTree':
                this.toggleTree();
                break;
            case 'InsertCharBefore':
            case 'InsertCharAfter':
                this.awaitingChar = rhs.command;
                break;
        }
    }

    /** Send an (unmapped) key to whichever pane has focus. */
    private dispatch(key: KeyInput): void {
        if (this.windowCmdPending) {
            this.windowCmdPending = false;
            this.windowCommand(key);
            return;
        }
        const editorIdle = this.editor.mode === 'Normal' && this.editor.pending.length === 0;
        if (keyEq(key, ctrl('w')) && this.treeVisible && (this.focus === 'Tree' || editorIdle)) {
            this.windowCmdPending = true;
            return;
        }
        if (this.focus === 'Editor') {
            this.editor.handleKey(key);
            return;
        }
        const action = this.tree.handleKey(key);
        switch (action.t) {
            case 'Open':
                this.openFromTree(action.path);
                break;
            case 'Close':
                this.treeVisible = false;
                this.focus = 'Editor';
                break;
            case 'FocusEditor':
                this.focus = 'Editor';
                break;
        }
    }

    /** `<C-w>h`/`l`/`w`: move focus between the tree and the editor. */
    private windowCommand(key: KeyInput): void {
        let toTree: boolean;
        if (key.key === 'h' || key.key === 'Backspace' || key.key === 'Left') toTree = true;
        else if (key.key === 'l' || key.key === 'Right') toTree = false;
        else if (key.key === 'w') toTree = this.focus === 'Editor';
        else return;
        if (toTree) {
            this.editorToNormal();
            this.focus = 'Tree';
        } else {
            this.focus = 'Editor';
        }
    }

    private toggleTree(): void {
        this.windowCmdPending = false;
        if (this.treeVisible) {
            this.treeVisible = false;
            this.focus = 'Editor';
            return;
        }
        this.editorToNormal();
        this.tree.refresh();
        this.revealed = undefined;
        this.treeVisible = true;
        this.focus = 'Tree';
    }

    private openFromTree(p: string): void {
        this.editorToNormal();
        this.editor.openFile(p);
        this.focus = 'Editor';
    }

    /** Leave Insert, Visual or command-line mode before focus moves away. */
    private editorToNormal(): void {
        if (this.editor.mode !== 'Normal' || this.editor.pending.length > 0) this.editor.handleKey(plain('Esc'));
    }

    /** Keep the tree rooted at the working directory and showing the current
     * file. */
    private syncTree(layout: Layout): void {
        if (!this.treeVisible) return;
        const cwd = currentDir();
        if (cwd !== this.treeCwd) {
            this.tree.setRoot(cwd);
            this.treeCwd = cwd;
            this.revealed = undefined;
        }
        this.tree.setViewRows(layout.treeRows);
        const file = this.editor.filePath;
        if (file !== undefined && file !== this.revealed) {
            this.tree.reveal(file);
            this.revealed = file;
        }
    }

    private mouse(layout: Layout, kind: 'down' | 'move' | 'up', x: number, y: number): void {
        if (kind === 'up') {
            this.press = undefined;
            return;
        }
        if (kind === 'move') {
            const p = this.press;
            if (!p) return;
            if (!p.dragging && Math.hypot(x - p.x, y - p.y) < DRAG_THRESHOLD) return;
            p.dragging = true;
            this.editor.dragTo(this.posAt(layout, x, y));
            return;
        }
        const sidebar = layout.sidebar;
        if (sidebar && contains(sidebar, x, y)) {
            const row = Math.floor((y - sidebar.top) / layout.lineH);
            if (this.tree.scroll + row < this.tree.rows.length) {
                this.editorToNormal();
                this.focus = 'Tree';
                this.tree.select(this.tree.scroll + row);
                const action = this.tree.activate();
                if (action.t === 'Open') this.openFromTree(action.path);
            }
            return;
        }
        if (layout.tabline && contains(layout.tabline, x, y)) {
            const hit = this.tabHits.find(([r]) => contains(r, x, y));
            if (hit) {
                this.editorToNormal();
                this.editor.switchToBuffer(hit[1]);
                this.focus = 'Editor';
            }
            return;
        }
        if (contains(layout.textArea, x, y)) {
            this.focus = 'Editor';
            this.editor.click(this.posAt(layout, x, y));
            this.press = { x, y, dragging: false };
        }
    }

    private posAt(layout: Layout, x: number, y: number): Pos {
        const ed = this.editor;
        const row = Math.max(Math.floor((y - layout.textArea.top) / layout.lineH), 0);
        const line = Math.min(ed.scrollTop + row, ed.buffer.lastLine());
        const dcol = Math.max(Math.floor((x - layout.textLeft) / layout.charW), 0) + ed.scrollLeft;
        return pos(line, ed.colFromDisplay(line, dcol));
    }

    /** The window's close button, Cmd+Q or Cmd+W. The first request with
     * unsaved changes only warns. */
    private requestClose(): void {
        const buffer = this.editor.firstModifiedBuffer();
        if (!this.editor.quitRequested && !this.closeWarned && buffer) {
            this.closeWarned = true;
            this.editor.setError(
                `E37: No write since last change in "${buffer.name}" (close again to discard, or :wa to save)`,
            );
            return;
        }
        this.editor.quitRequested = true;
    }

    /** Start a flash for a new yank; returns whether one is still showing. */
    private updateFlash(): boolean {
        const range = this.editor.takeYankFlash();
        if (range) this.flash = { range, bufferId: this.editor.bufferId(), start: Date.now() };
        const f = this.flash;
        const active = f !== undefined && Date.now() - f.start < FLASH_DURATION && f.bufferId === this.editor.bufferId();
        if (!active) this.flash = undefined;
        return active;
    }

    // ----- Frames ------------------------------------------------------------------

    /** Lay out the window and size the editor's view to it. */
    private prepare(): Layout {
        const layout = this.layout();
        this.editor.setViewport(layout.rows, layout.cols);
        return layout;
    }

    /** Bring everything up to date and send a frame (or quit). */
    render(): void {
        if (this.quitting) return;
        if (this.editor.quitRequested) {
            this.quitting = true;
            this.clearMapTimer();
            if (this.flashTimer) clearTimeout(this.flashTimer);
            this.opts.onQuit();
            return;
        }
        // Input may have changed the gutter, tabs or sidebar; lay out again.
        const layout = this.prepare();
        this.editor.scrollToCursor();
        this.syncTree(layout);
        if (this.updateFlash() && !this.flashTimer) {
            this.flashTimer = setTimeout(() => {
                this.flashTimer = undefined;
                this.render();
            }, 16);
        }
        const modified = this.editor.isModified() ? ' [+]' : '';
        const title = `${this.editor.fileName()}${modified} - Wim`;
        const dirty = this.editor.firstModifiedBuffer() !== undefined;
        const painter = new Painter(this.editor, layout, {
            metrics: this.metrics,
            gutterCols: this.gutterCols(),
            focus: this.focus,
            icons: this.icons,
            tree: this.tree,
            flash: this.flash,
            mapPending: this.mapPending,
            highlightCache: this.highlightCache,
        });
        const cmds = painter.paint();
        this.tabHits = painter.tabHits;
        this.opts.onFrame(title, dirty, cmds);
    }

    private layout(): Layout {
        const { width, height, charW, lineH } = this.metrics;
        const bottom = Math.max(height - 2 * lineH, 0);
        const sidebar = this.treeVisible ? rect(0, 0, Math.min(SIDEBAR_COLS * charW, width * 0.4), bottom) : undefined;
        const editorLeft = sidebar ? sidebar.right + 1 : 0;
        const tabline = this.editor.buffers.length > 1 ? rect(editorLeft, 0, width, lineH) : undefined;
        const textArea = rect(editorLeft, tabline ? tabline.bottom : 0, width, bottom);
        const textLeft = textArea.left + this.gutterCols() * charW + TEXT_PADDING;
        return {
            sidebar,
            tabline,
            textArea,
            textLeft,
            status: rect(0, bottom, width, bottom + lineH),
            cmdline: rect(0, bottom + lineH, width, height),
            charW,
            lineH,
            rows: Math.max(Math.floor((textArea.bottom - textArea.top) / lineH), 1),
            cols: Math.max(Math.floor((textArea.right - textLeft - TEXT_PADDING) / charW), 1),
            treeRows: sidebar ? Math.max(Math.floor((sidebar.bottom - sidebar.top) / lineH), 1) : 1,
        };
    }

    private gutterCols(): number {
        const o = this.editor.options;
        if (!o.number && !o.relativenumber) return 0;
        return Math.max(String(this.editor.buffer.lineCount()).length, 3) + 1;
    }
}

/** Translate a key from the window into the editor's representation. */
function toKeyInput(msg: { key: string; ctrl: boolean; alt: boolean }): KeyInput | undefined {
    if (typeof msg.key !== 'string') return undefined;
    if (!isNamedKey(msg.key) && Array.from(msg.key).length !== 1) return undefined;
    if (msg.ctrl) return keyNew(msg.key, true);
    return { key: msg.key, ctrl: false, alt: Boolean(msg.alt) };
}

function rgb(color: number): string {
    return '#' + color.toString(16).padStart(6, '0');
}

function tokenColor(token: Token): string {
    switch (token) {
        case 'Normal':
            return theme.FG;
        case 'Keyword':
            return theme.KEYWORD;
        case 'Type':
            return theme.TYPE;
        case 'Constant':
        case 'Number':
            return theme.CONSTANT;
        case 'String':
            return theme.STRING;
        case 'Comment':
            return theme.COMMENT;
        case 'Function':
            return theme.FUNCTION;
        case 'Macro':
            return theme.MACRO;
    }
}

/** What the painter needs to know besides the editor. */
interface PaintState {
    metrics: Metrics;
    gutterCols: number;
    focus: Focus;
    icons: boolean;
    tree: FileTree;
    flash: Flash | undefined;
    mapPending: KeyInput[];
    highlightCache: highlight.Cache;
}

/** Paints one frame. */
class Painter {
    private readonly cmds: DrawCmd[] = [];
    /** Where each buffer tab was drawn, for mouse clicks. */
    readonly tabHits: [Rect, number][] = [];

    constructor(
        private readonly ed: Editor,
        private readonly layout: Layout,
        private readonly st: PaintState,
    ) {}

    private rect(r: Rect, color: string, radius = 0): void {
        if (r.right > r.left && r.bottom > r.top) {
            this.cmds.push(['rect', r.left, r.top, r.right - r.left, r.bottom - r.top, color, radius]);
        }
    }

    /** Text whose top-left cell is at `x`, in the row starting at `y`. */
    private text(x: number, y: number, s: string, color: string): void {
        if (s !== '') this.cmds.push(['text', x, y, s, color]);
    }

    /** Text whose right edge is at `x`. */
    private textRight(x: number, y: number, s: string, color: string): void {
        this.text(x - Array.from(s).length * this.layout.charW, y, s, color);
    }

    private clip(r: Rect): void {
        this.cmds.push(['clip', r.left, r.top, r.right - r.left, r.bottom - r.top]);
    }

    paint(): DrawCmd[] {
        const { ed, layout } = this;
        this.rect(rect(0, 0, this.st.metrics.width, this.st.metrics.height), theme.BG);
        const buf = ed.buffer;
        const opts = ed.options;
        const cursor = ed.cursor;
        const selection = ed.selection();
        const searchRe = ed.highlightRegex();
        const lang = highlight.detect(ed.filePath);
        const gutterCols = this.st.gutterCols;
        const cw = layout.charW;
        const lh = layout.lineH;
        const left = ed.scrollLeft;
        const colX = (dcol: number): number => layout.textLeft + Math.max(dcol - left, 0) * cw;
        const flash = this.st.flash;
        let flashColor: string | undefined;
        if (flash) {
            const fade = 1 - (Date.now() - flash.start) / FLASH_DURATION;
            const [r, g, b] = theme.FLASH;
            flashColor = `rgba(${r},${g},${b},${((Math.min(Math.max(fade, 0), 1) * 120) / 255).toFixed(3)})`;
        }
        // Fill the display columns of `line` covered by a region.
        const fillRegion = (line: number, y: number, start: Pos, end: Pos, linewise: boolean, color: string): void => {
            if (line < start.line || line > end.line) return;
            const lineEnd = ed.displayCol(line, buf.lineLen(line)) + 1;
            let from = 0;
            let to = lineEnd;
            if (!linewise) {
                from = line === start.line ? ed.displayCol(line, start.col) : 0;
                to = line === end.line ? ed.displayCol(line, end.col) : lineEnd;
            }
            from = Math.max(from, left);
            if (to > from) this.rect(rect(colX(from), y, colX(to), y + lh), color);
        };

        this.clip(rect(layout.textArea.left, 0, layout.textArea.right, layout.textArea.bottom));
        for (let row = 0; row < layout.rows; row++) {
            const line = ed.scrollTop + row;
            const y = layout.textArea.top + row * lh;
            if (line > buf.lastLine()) {
                this.text(layout.textArea.left + TEXT_PADDING, y, '~', theme.TILDE);
                continue;
            }
            if (line === cursor.line && !selection) {
                this.rect(rect(layout.textArea.left, y, layout.textArea.right, y + lh), theme.CURSOR_LINE);
            }

            // Line number gutter: relative numbers, with the absolute number
            // on the cursor line (Vim's `number` + `relativenumber`).
            if (gutterCols > 0) {
                const current = line === cursor.line;
                const label = opts.relativenumber && !current ? String(Math.abs(line - cursor.line)) : String(line + 1);
                const color = current ? theme.GUTTER_CURRENT : theme.GUTTER;
                if (opts.relativenumber && opts.number && current) {
                    this.text(layout.textArea.left + 2, y, label, color);
                } else {
                    this.textRight(layout.textArea.left + (gutterCols - 1) * cw, y, label, color);
                }
            }

            if (selection) {
                const end = pos(selection.end.line, selection.end.col + 1);
                fillRegion(line, y, selection.start, end, selection.linewise, theme.SELECTION);
            }

            const chars = buf.line(line);
            if (searchRe) {
                for (const [s, e] of lineMatches(searchRe, chars)) {
                    const ds = ed.displayCol(line, s);
                    const de = ed.displayCol(line, e);
                    if (de > ds && de >= left) this.rect(rect(colX(Math.max(ds, left)), y, colX(de), y + lh), theme.SEARCH, 2);
                }
            }

            if (flash && flashColor) fillRegion(line, y, flash.range.start, flash.range.end, flash.range.linewise, flashColor);

            let spans: highlight.Span[] = [];
            if (lang) {
                const state = this.st.highlightCache.stateAt(lang, ed.bufferId(), buf.version(), line, (i) => buf.line(i));
                spans = highlight.highlightLine(lang, chars, state)[0];
            }
            this.lineText(chars, spans, y);
        }
        this.cmds.push(['unclip']);

        this.paintCursor();
        this.paintTabline();
        this.paintTree();
        this.paintStatus();
        this.paintCmdline();
        return this.cmds;
    }

    /** Draw the visible part of a line in its colors, expanding tabs. */
    private lineText(chars: readonly string[], spans: highlight.Span[], y: number): void {
        const { ed, layout } = this;
        const ts = Math.max(ed.options.tabstop, 1);
        const left = ed.scrollLeft;
        const right = left + layout.cols + 1;
        let run = '';
        let runColor: string = theme.FG;
        let runStart = left;
        let span = 0;
        let dcol = 0;
        const flush = (): void => {
            this.text(layout.textLeft + (runStart - left) * layout.charW, y, run, runColor);
            run = '';
        };
        for (let i = 0; i < chars.length && dcol < right; i++) {
            const c = chars[i];
            while (span < spans.length && spans[span][1] <= i) span++;
            const token = span < spans.length && spans[span][0] <= i ? spans[span][2] : 'Normal';
            const color = tokenColor(token);
            const cells = c === '\t' ? ts - (dcol % ts) : 1;
            for (let k = 0; k < cells; k++) {
                const d = dcol + k;
                if (d < left || d >= right) continue;
                if (color !== runColor || run === '') {
                    if (run !== '') flush();
                    runColor = color;
                    runStart = d;
                }
                run += c === '\t' ? ' ' : c;
            }
            dcol += cells;
        }
        if (run !== '') flush();
    }

    private paintCursor(): void {
        const { ed, layout } = this;
        const mode = ed.mode;
        const cursor = ed.cursor;
        if (isCmdLine(mode) || cursor.line < ed.scrollTop || cursor.line >= ed.scrollTop + layout.rows) return;
        const dcol = ed.displayCol(cursor.line, cursor.col);
        if (dcol < ed.scrollLeft) return;
        const c = ed.buffer.charAt(cursor) ?? ' ';
        const width = c === '\t' ? ed.displayCol(cursor.line, cursor.col + 1) - dcol : 1;
        const x = layout.textLeft + (dcol - ed.scrollLeft) * layout.charW;
        const y = layout.textArea.top + (cursor.line - ed.scrollTop) * layout.lineH;
        const cell = rect(x, y, x + layout.charW * width, y + layout.lineH);
        if (this.st.focus === 'Tree') {
            // Hollow cursor while the file tree has focus.
            this.cmds.push(['stroke', cell.left, cell.top, cell.right - cell.left, cell.bottom - cell.top, theme.CURSOR]);
            return;
        }
        if (mode === 'Insert') {
            this.rect(rect(cell.left, cell.top, cell.left + 2, cell.bottom), theme.CURSOR);
        } else if (mode === 'Replace' || ed.pending.length > 0) {
            this.rect(rect(cell.left, cell.bottom - 3, cell.right, cell.bottom), theme.CURSOR);
        } else {
            this.rect(cell, theme.CURSOR);
            if (!isWhitespace(c)) this.text(x, y, c, theme.BG);
        }
    }

    /** One tab per buffer across the top of the editor, bufferline-style:
     * file icon, name and a dot for unsaved changes. */
    private paintTabline(): void {
        const r = this.layout.tabline;
        if (!r) return;
        const cw = this.layout.charW;
        this.rect(r, theme.STATUS_BG);
        this.clip(r);
        let x = r.left;
        for (const buffer of this.ed.bufferList()) {
            const short = baseName(buffer.name);
            const iconCols = this.st.icons ? 2 : 0;
            const width = (Array.from(short).length + iconCols + 4) * cw;
            const tab = rect(x, r.top, x + width, r.bottom);
            let textColor: string = theme.COMMENT;
            if (buffer.active) {
                this.rect(tab, theme.BG);
                this.rect(rect(tab.left, tab.top, tab.right, tab.top + 2), theme.MODE_NORMAL);
                textColor = theme.FG;
            }
            let tx = x + cw;
            if (this.st.icons) {
                const icon = icons.forFile(short);
                this.text(tx, r.top, icon.glyph, buffer.active ? rgb(icon.color) : theme.COMMENT);
                tx += 2 * cw;
            }
            this.text(tx, r.top, short, textColor);
            if (buffer.modified) this.text(tab.right - 1.5 * cw, r.top, '●', theme.GUTTER_CURRENT);
            this.tabHits.push([tab, buffer.id]);
            x += width + 1;
        }
        this.cmds.push(['unclip']);
    }

    /** The tree, styled after the nvim-tree setup: no root label, folder and
     * file icons instead of arrows. */
    private paintTree(): void {
        const r = this.layout.sidebar;
        if (!r) return;
        const { charW: cw, lineH: lh } = this.layout;
        const tree = this.st.tree;
        this.rect(r, theme.STATUS_BG);
        this.rect(rect(r.right, r.top, r.right + 1, r.bottom), theme.TILDE);
        this.clip(r);
        const currentFile = this.ed.filePath;
        const first = tree.scroll;
        const last = Math.min(tree.rows.length, first + this.layout.treeRows);
        for (let i = first; i < last; i++) {
            const row = tree.rows[i];
            const y = r.top + lh * (i - first);
            if (i === tree.selected) {
                this.rect(rect(r.left, y, r.right, y + lh), this.st.focus === 'Tree' ? theme.SELECTION : theme.CURSOR_LINE);
            }
            const x = r.left + TEXT_PADDING + row.depth * 2 * cw;
            if (this.st.icons) {
                let glyph: string;
                let color: string;
                if (row.isDir) {
                    if (row.empty) glyph = row.expanded ? icons.FOLDER_EMPTY_OPEN : icons.FOLDER_EMPTY;
                    else glyph = row.expanded ? icons.FOLDER_OPEN : icons.FOLDER_CLOSED;
                    color = theme.FUNCTION;
                } else {
                    const icon = icons.forFile(row.name);
                    glyph = icon.glyph;
                    color = rgb(icon.color);
                }
                this.text(x, y, glyph, color);
            } else if (row.isDir) {
                this.disclosureTriangle(x + cw * 0.5, y + lh * 0.5, cw, row.expanded);
            }
            let color: string = theme.FG;
            if (row.isDir) color = theme.FUNCTION;
            else if (currentFile === row.path) color = theme.GUTTER_CURRENT;
            this.text(x + cw * 2, y, row.name, color);
        }
        this.cmds.push(['unclip']);
    }

    /** Folder arrows, used when no Nerd Font is installed for icons. */
    private disclosureTriangle(cx: number, cy: number, cw: number, open: boolean): void {
        const s = cw * 0.32;
        const points = open
            ? [cx - s, cy - s * 0.6, cx + s, cy - s * 0.6, cx, cy + s * 0.7]
            : [cx - s * 0.6, cy - s, cx + s * 0.7, cy, cx - s * 0.6, cy + s];
        this.cmds.push(['poly', points, theme.COMMENT]);
    }

    private paintStatus(): void {
        const { ed, layout } = this;
        const r = layout.status;
        const cw = layout.charW;
        this.rect(r, theme.STATUS_BG);

        let modeName: string;
        let modeColor: string;
        if (this.st.focus === 'Tree') {
            modeName = 'TREE';
            modeColor = theme.MODE_TREE;
        } else {
            modeName = ed.modeName();
            switch (ed.mode) {
                case 'Normal':
                    modeColor = theme.MODE_NORMAL;
                    break;
                case 'Insert':
                    modeColor = theme.MODE_INSERT;
                    break;
                case 'Replace':
                    modeColor = theme.MODE_REPLACE;
                    break;
                case 'Visual':
                case 'VisualLine':
                    modeColor = theme.MODE_VISUAL;
                    break;
                default:
                    modeColor = theme.MODE_COMMAND;
            }
        }
        const label = ` ${modeName} `;
        const pillRight = r.left + label.length * cw;
        this.rect(rect(r.left, r.top, pillRight, r.bottom), modeColor);
        this.text(r.left, r.top, label, theme.BG);

        const modified = ed.isModified() ? ' [+]' : '';
        this.text(pillRight, r.top, ` ${ed.fileName()}${modified}`, theme.FG);

        const cursor = ed.cursor;
        const lines = ed.buffer.lineCount();
        let position: string;
        if (lines <= layout.rows) position = 'All';
        else if (ed.scrollTop === 0) position = 'Top';
        else if (ed.scrollTop + layout.rows >= lines) position = 'Bot';
        else position = `${Math.floor((ed.scrollTop * 100) / (lines - layout.rows))}%`;
        const filetype = highlight.detect(ed.filePath)?.name ?? '';
        const pending = this.st.mapPending.map(keyToString).join('') + ed.pendingKeys();
        const right = `${pending}   ${filetype}   ${cursor.line + 1}:${ed.displayCol(cursor.line, cursor.col) + 1}   ${position} `;
        this.textRight(r.right - cw, r.top, right, theme.FG);
    }

    private paintCmdline(): void {
        const { ed, layout } = this;
        const r = layout.cmdline;
        const x = r.left + TEXT_PADDING;
        const text = ed.cmdlineText();
        if (text !== undefined) {
            this.text(x, r.top, text, theme.FG);
            const end = x + Array.from(text).length * layout.charW;
            this.rect(rect(end, r.top, end + 2, r.top + layout.lineH), theme.CURSOR);
        } else if (ed.message) {
            this.text(x, r.top, ed.message.text, ed.message.error ? theme.ERROR : theme.FG);
        }
    }
}
