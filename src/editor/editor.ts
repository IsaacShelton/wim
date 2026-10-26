// The editor core: modes, key dispatch, undo and dot-repeat. It knows nothing
// about windows or rendering; the UI feeds it `KeyInput`s and reads its state
// back.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { Clipboard } from '../clipboard';
import { displayName, expandTilde } from '../paths';
import { Buffer, Line, Pos, isWhitespace, order, pos } from './buffer';
import * as buffers from './buffers';
import { BufferSlot } from './buffers';
import { Action, Command, FindKind, parse } from './command';
import { runEx } from './ex';
import { KeyInput, ch, charOf, ctrl, isCharKey, keyEq, keyIs, keyToString, plain } from './keys';
import * as motion from './motion';
import * as ops from './ops';
import { CmdKind, Mode, WANT_EOL, isCmdLine, isInsert, isVisual } from './mode';
import { Range } from './range';
import { Registers } from './registers';
import * as search from './search';

export interface Options {
    number: boolean;
    relativenumber: boolean;
    ignorecase: boolean;
    smartcase: boolean;
    hlsearch: boolean;
    incsearch: boolean;
    expandtab: boolean;
    autoindent: boolean;
    tabstop: number;
    shiftwidth: number;
    scrolloff: number;
}

export function defaultOptions(): Options {
    return {
        number: true,
        relativenumber: true,
        ignorecase: false,
        smartcase: false,
        hlsearch: true,
        incsearch: true,
        expandtab: true,
        autoindent: true,
        tabstop: 4,
        shiftwidth: 4,
        scrolloff: 3,
    };
}

export interface Message {
    text: string;
    error: boolean;
}

/** A visual selection, with an inclusive end. */
export interface Selection {
    start: Pos;
    end: Pos;
    linewise: boolean;
}

export interface Snapshot {
    lines: Line[];
    version: number;
    cursor: Pos;
}

export interface InsertSession {
    count: number;
    /** For `o`/`O`: repeat by opening a new line each time. */
    openLine: boolean;
    typed: KeyInput[];
    /** A line holding only automatic indentation, removed if left empty. */
    autoindentLine?: number;
}

function newInsertSession(count = 0, openLine = false): InsertSession {
    return { count, openLine, typed: [] };
}

export interface LastSearch {
    pattern: string;
    forward: boolean;
}

/** An uppercase mark, which remembers its file as well as its position. */
export interface GlobalMark {
    bufferId: number;
    path?: string;
    pos: Pos;
}

export interface LastVisual {
    mode: Mode;
    anchor: Pos;
    cursor: Pos;
}

export class Editor {
    buffer = new Buffer();
    cursor: Pos = pos(0, 0);
    mode: Mode = 'Normal';
    options: Options = defaultOptions();
    filePath: string | undefined;
    savedVersion = 0;

    scrollTop = 0;
    scrollLeft = 0;
    viewRows = 40;
    viewCols = 120;
    /** The column vertical motions try to keep (`WANT_EOL` after `$`). */
    wantCol = 0;

    pending: KeyInput[] = [];
    registers: Registers;
    undoStack: Snapshot[] = [];
    redoStack: Snapshot[] = [];
    undoPending: Snapshot | undefined;

    lastChange: KeyInput[] = [];
    dotRecord: KeyInput[] | undefined;
    replaying = false;
    insert: InsertSession = newInsertSession();

    lastFind: [FindKind, string] | undefined;
    lastSearch: LastSearch | undefined;
    lastSubstitute: [string, string, string] | undefined;
    hlsearchActive = false;
    private regexCache: { pattern: string; ic: boolean; sc: boolean; re: RegExp | undefined } | undefined;
    searchOrigin: Pos = pos(0, 0);

    visualAnchor: Pos = pos(0, 0);
    lastVisual: LastVisual | undefined;
    marks = new Map<string, Pos>();
    globalMarks = new Map<string, GlobalMark>();

    cmdline = '';
    exHistory: string[] = [];
    searchHistory: string[] = [];
    historyIndex: number | undefined;

    message: Message | undefined;
    quitRequested = false;

    /** Every open buffer. The active buffer's state lives in the fields above
     * while its slot here holds placeholders. */
    buffers: BufferSlot[] = [new BufferSlot(1)];
    current = 0;
    nextBufferId = 2;
    /** The previously active buffer (`<C-^>`, `:b#`). */
    alternate: number | undefined;
    /** The most recent yank, for the UI to flash. */
    yankFlash: Range | undefined;

    constructor(clipboard?: Clipboard) {
        this.registers = new Registers(clipboard);
    }

    static fromText(text: string, clipboard?: Clipboard): Editor {
        const ed = new Editor(clipboard);
        ed.buffer = Buffer.fromText(text);
        ed.savedVersion = ed.buffer.version();
        return ed;
    }

    // ----- Accessors used by the UI ------------------------------------------

    fileName(): string {
        return displayName(this.filePath);
    }

    isModified(): boolean {
        return this.buffer.version() !== this.savedVersion;
    }

    setMessage(text: string): void {
        this.message = { text, error: false };
    }

    setError(text: string): void {
        this.message = { text, error: true };
    }

    modeName(): string {
        switch (this.mode) {
            case 'Normal':
                return 'NORMAL';
            case 'Insert':
                return 'INSERT';
            case 'Replace':
                return 'REPLACE';
            case 'Visual':
                return 'VISUAL';
            case 'VisualLine':
                return 'V-LINE';
            default:
                return 'COMMAND';
        }
    }

    /** Keys typed so far for an incomplete command (Vim's `showcmd`). */
    pendingKeys(): string {
        return this.pending.map(keyToString).join('');
    }

    /** The command line contents including its prompt, when active. */
    cmdlineText(): string | undefined {
        const prompts: Partial<Record<Mode, string>> = { Ex: ':', SearchForward: '/', SearchBackward: '?' };
        const prompt = prompts[this.mode];
        return prompt === undefined ? undefined : prompt + this.cmdline;
    }

    selection(): Selection | undefined {
        if (!isVisual(this.mode)) return undefined;
        const [start, end] = order(this.visualAnchor, this.cursor);
        return { start, end, linewise: this.mode === 'VisualLine' };
    }

    /** The regex whose matches should be highlighted right now. */
    highlightRegex(): RegExp | undefined {
        if ((this.mode === 'SearchForward' || this.mode === 'SearchBackward') && this.options.incsearch) {
            return this.cmdline === '' ? undefined : this.regexFor(this.cmdline);
        }
        if (this.options.hlsearch && this.hlsearchActive && this.lastSearch) {
            return this.regexFor(this.lastSearch.pattern);
        }
        return undefined;
    }

    regexFor(pattern: string): RegExp | undefined {
        const { ignorecase: ic, smartcase: sc } = this.options;
        const c = this.regexCache;
        if (c && c.pattern === pattern && c.ic === ic && c.sc === sc) return c.re;
        let re: RegExp | undefined;
        try {
            re = search.compile(pattern, ic, sc);
        } catch {
            re = undefined;
        }
        this.regexCache = { pattern, ic, sc, re };
        return re;
    }

    /** Request to close the window. Refuses (with a message) when there are
     * unsaved changes unless `force` is set. */
    requestQuit(force: boolean): boolean {
        const b = force ? undefined : this.firstModifiedBuffer();
        if (b) {
            if (b.active) this.setError('E37: No write since last change (add ! to override)');
            else this.setError(`E162: No write since last change for buffer "${b.name}"`);
            return false;
        }
        this.quitRequested = true;
        return true;
    }

    // ----- Buffers -------------------------------------------------------------

    bufferId(): number {
        return buffers.bufferId(this);
    }

    bufferList(): buffers.BufferInfo[] {
        return buffers.bufferList(this);
    }

    switchToBuffer(id: number): boolean {
        return buffers.switchToBuffer(this, id);
    }

    openFile(p: string): void {
        buffers.openFile(this, p);
    }

    firstModifiedBuffer(): buffers.BufferInfo | undefined {
        return buffers.firstModifiedBuffer(this);
    }

    // ----- Viewport --------------------------------------------------------------

    setViewport(rows: number, cols: number): void {
        this.viewRows = Math.max(rows, 1);
        this.viewCols = Math.max(cols, 1);
    }

    scrolloff(): number {
        return Math.min(this.options.scrolloff, Math.floor(Math.max(this.viewRows - 1, 0) / 2));
    }

    scrollToCursor(): void {
        const rows = this.viewRows;
        const so = this.scrolloff();
        const line = this.cursor.line;
        if (line < this.scrollTop + so) this.scrollTop = Math.max(line - so, 0);
        if (line + so >= this.scrollTop + rows) this.scrollTop = line + so + 1 - rows;
        this.scrollTop = Math.min(this.scrollTop, this.buffer.lastLine());

        const dcol = this.displayCol(line, this.cursor.col);
        if (dcol < this.scrollLeft) this.scrollLeft = dcol;
        if (dcol >= this.scrollLeft + this.viewCols) this.scrollLeft = dcol + 1 - this.viewCols;
    }

    /** Scroll the view (mouse wheel, `<C-e>`, `<C-y>`) and keep the cursor
     * inside it. */
    scrollBy(delta: number): void {
        const last = this.buffer.lastLine();
        this.scrollTop = Math.min(Math.max(this.scrollTop + delta, 0), last);
        const so = this.scrolloff();
        const top = this.scrollTop === 0 ? 0 : this.scrollTop + so;
        const bottom = Math.max(Math.max(this.scrollTop + this.viewRows - (1 + so), 0), top);
        const line = Math.min(Math.max(this.cursor.line, Math.min(top, last)), Math.min(bottom, last));
        if (line !== this.cursor.line) this.cursor = pos(line, this.colForWant(line));
    }

    displayCol(line: number, col: number): number {
        const ts = Math.max(this.options.tabstop, 1);
        const chars = this.buffer.line(line);
        let d = 0;
        const n = Math.min(col, chars.length);
        for (let i = 0; i < n; i++) d = chars[i] === '\t' ? (Math.floor(d / ts) + 1) * ts : d + 1;
        return d + Math.max(col - chars.length, 0);
    }

    colFromDisplay(line: number, dcol: number): number {
        const ts = Math.max(this.options.tabstop, 1);
        const chars = this.buffer.line(line);
        let d = 0;
        for (let i = 0; i < chars.length; i++) {
            const next = chars[i] === '\t' ? (Math.floor(d / ts) + 1) * ts : d + 1;
            if (dcol < next) return i;
            d = next;
        }
        return chars.length;
    }

    // ----- Mouse ---------------------------------------------------------------

    click(p: Pos): void {
        if (isCmdLine(this.mode)) return;
        if (isVisual(this.mode)) this.exitVisual();
        this.pending = [];
        this.cursor = p;
        this.clampCursor();
        this.updateWantCol();
    }

    dragTo(p: Pos): void {
        if (this.mode === 'Normal') {
            this.visualAnchor = this.cursor;
            this.mode = 'Visual';
        }
        if (isVisual(this.mode)) {
            this.cursor = p;
            this.clampCursor();
            this.updateWantCol();
        }
    }

    // ----- Paste from the OS (Cmd+V) ------------------------------------------

    pasteText(text: string): void {
        text = text.replace(/\r\n/g, '\n');
        if (isInsert(this.mode)) {
            this.cursor = this.buffer.insertText(this.cursor, text);
        } else if (isCmdLine(this.mode)) {
            this.cmdline += text.split('\n')[0];
        }
    }

    /** The region of the latest yank, once, so the UI can flash it. */
    takeYankFlash(): Range | undefined {
        const r = this.yankFlash;
        this.yankFlash = undefined;
        return r;
    }

    /** Copy (or cut) the visual selection to the system clipboard (Cmd+C/X). */
    copySelection(cut: boolean): void {
        if (!isVisual(this.mode)) return;
        this.undoPending = this.snapshot();
        ops.visualOperate(this, cut ? 'Delete' : 'Yank', false, 1, '+');
        this.commitUndo();
        this.clampCursor();
    }

    // ----- Key handling ----------------------------------------------------------

    handleKey(key: KeyInput): void {
        if (!this.replaying) this.message = undefined;
        if (isCmdLine(this.mode)) this.cmdlineKey(key, this.mode);
        else if (isInsert(this.mode)) this.insertKey(key);
        else this.normalKey(key);
        this.scrollToCursor();
    }

    handleKeys(keys: readonly KeyInput[]): void {
        for (const k of keys) this.handleKey(k);
    }

    private normalKey(key: KeyInput): void {
        if (key.key === 'Esc') {
            if (this.pending.length === 0) {
                if (isVisual(this.mode)) this.exitVisual();
                // Esc in Normal mode also clears search highlighting.
                else this.hlsearchActive = false;
            }
            this.pending = [];
            return;
        }
        this.pending.push(key);
        const result = parse(this.pending, isVisual(this.mode));
        if (result === 'Incomplete') return;
        if (result === 'Invalid') {
            this.pending = [];
            return;
        }
        const keys = this.pending;
        this.pending = [];
        this.runCommand(result.done, keys);
    }

    private runCommand(cmd: Command, keys: KeyInput[]): void {
        const change = mayChange(cmd.action);
        const fromVisual = isVisual(this.mode);
        const version = this.buffer.version();
        if (change && this.undoPending === undefined) this.undoPending = this.snapshot();
        this.execute(cmd);
        if (isInsert(this.mode)) {
            if (change && !fromVisual && !this.replaying) this.dotRecord = keys;
        } else {
            // `.`, `u` and `<C-r>` change the buffer but are not changes to repeat.
            if (change && this.buffer.version() !== version && !fromVisual && !this.replaying) {
                this.lastChange = keys;
            }
            this.commitUndo();
        }
        if (!isInsert(this.mode) && !isCmdLine(this.mode)) this.clampCursor();
    }

    private execute(cmd: Command): void {
        const count = cmd.count ?? 1;
        const a = cmd.action;
        switch (a.t) {
            case 'Move': {
                const target = motion.evalMotion(this, a.m, cmd.count, false);
                if (target) motion.moveTo(this, a.m, target);
                break;
            }
            case 'Operate':
                ops.operate(this, a.op, a.target, cmd.count, cmd.register);
                break;
            case 'Insert':
                ops.startInsert(this, a.kind, count);
                break;
            case 'Paste':
                ops.paste(this, cmd.register, a.before, count);
                break;
            case 'ReplaceChar':
                ops.replaceChars(this, a.c, count);
                break;
            case 'Join': {
                const sel = this.selection();
                if (sel) {
                    this.exitVisual();
                    ops.joinLines(this, sel.start.line, Math.max(sel.end.line - sel.start.line, 1), a.spaces);
                } else {
                    ops.joinLines(this, this.cursor.line, Math.max(count, 2) - 1, a.spaces);
                }
                break;
            }
            case 'Undo':
                for (let i = 0; i < count; i++) this.undo();
                break;
            case 'Redo':
                for (let i = 0; i < count; i++) this.redo();
                break;
            case 'Repeat':
                this.repeatLastChange(cmd.count);
                break;
            case 'ToggleCaseChar':
                ops.toggleCaseChars(this, count);
                break;
            case 'Visual':
            case 'VisualLine': {
                const target: Mode = a.t;
                if (this.mode === target) {
                    this.exitVisual();
                } else {
                    if (!isVisual(this.mode)) this.visualAnchor = this.cursor;
                    this.mode = target;
                }
                break;
            }
            case 'Reselect': {
                const v = this.lastVisual;
                if (v) {
                    this.mode = v.mode;
                    this.visualAnchor = v.anchor;
                    this.cursor = v.cursor;
                    this.clampPosVisual();
                }
                break;
            }
            case 'ReplaceMode':
                this.mode = 'Replace';
                this.insert = newInsertSession(1);
                break;
            case 'CmdLine':
                if (isVisual(this.mode)) {
                    this.exitVisual();
                    this.cmdline = "'<,'>";
                } else if (count > 1) {
                    this.cmdline = `.,.+${count - 1}`;
                } else {
                    this.cmdline = '';
                }
                this.historyIndex = undefined;
                this.mode = 'Ex';
                break;
            case 'Search':
                if (isVisual(this.mode)) this.exitVisual();
                this.cmdline = '';
                this.historyIndex = undefined;
                this.searchOrigin = this.cursor;
                this.mode = a.forward ? 'SearchForward' : 'SearchBackward';
                break;
            case 'SearchWord':
                ops.searchWord(this, a.forward, count);
                break;
            case 'Scroll':
                ops.scroll(this, a.s, cmd.count);
                break;
            case 'SetMark':
                if (/^[A-Z]$/.test(a.c)) {
                    this.globalMarks.set(a.c, { bufferId: this.bufferId(), path: this.filePath, pos: this.cursor });
                } else {
                    this.marks.set(a.c, this.cursor);
                }
                break;
            case 'Increment':
                ops.increment(this, a.n * count);
                break;
            case 'WriteQuit':
                if (!this.isModified() || buffers.writeFile(this, undefined)) this.quitRequested = true;
                break;
            case 'QuitForce':
                this.quitRequested = true;
                break;
            case 'FileInfo':
                this.showFileInfo();
                break;
            case 'AlternateBuffer':
                buffers.alternateBuffer(this);
                break;
            case 'VisualOp':
                ops.visualOperate(this, a.op, false, count, cmd.register);
                break;
            case 'VisualLinewiseOp':
                ops.visualOperate(this, a.op, true, count, cmd.register);
                break;
            case 'VisualObject':
                ops.visualSelectObject(this, a.obj, a.around, count);
                break;
            case 'VisualSwap':
                [this.visualAnchor, this.cursor] = [this.cursor, this.visualAnchor];
                break;
            case 'VisualReplace':
                ops.visualReplace(this, a.c);
                break;
            case 'VisualPaste':
                ops.visualPaste(this, cmd.register);
                break;
        }
    }

    // ----- Insert & Replace mode -----------------------------------------------

    private insertKey(key: KeyInput): void {
        if (key.key === 'Esc') {
            this.finishInsert();
            return;
        }
        this.dotRecord?.push(key);
        this.insert.typed.push(key);
        this.applyInsertKey(key);
    }

    beginInsert(count: number, openLine: boolean): void {
        this.mode = 'Insert';
        this.insert = newInsertSession(count, openLine);
    }

    private finishInsert(): void {
        const session = this.insert;
        this.insert = newInsertSession();
        for (let i = 1; i < session.count; i++) {
            if (session.openLine) ops.openLine(this, true);
            for (const k of session.typed) this.applyInsertKey(k);
        }
        // After repeats the replayed keys decide; otherwise the session does.
        const repeated = this.insert;
        this.insert = newInsertSession();
        const autoindentLine = session.count > 1 ? repeated.autoindentLine : session.autoindentLine;
        if (
            autoindentLine !== undefined &&
            autoindentLine === this.cursor.line &&
            autoindentLine < this.buffer.lineCount() &&
            this.buffer.isBlankLine(autoindentLine)
        ) {
            this.buffer.replaceLine(autoindentLine, []);
            this.cursor = pos(this.cursor.line, 0);
        }
        if (this.dotRecord) {
            this.dotRecord.push(plain('Esc'));
            this.lastChange = this.dotRecord;
            this.dotRecord = undefined;
        }
        this.mode = 'Normal';
        this.marks.set('^', this.cursor);
        this.cursor = pos(this.cursor.line, Math.max(this.cursor.col - 1, 0));
        this.clampCursor();
        this.updateWantCol();
        this.commitUndo();
    }

    private applyInsertKey(key: KeyInput): void {
        const replace = this.mode === 'Replace';
        const cur = this.cursor;
        const len = this.buffer.lineLen(cur.line);
        if (key.alt && ['Left', 'Right', 'Backspace', 'Delete'].includes(key.key)) {
            // macOS-style word editing with Option.
            if (key.key === 'Left') {
                this.cursor = motion.macWordLeft(this.buffer, cur);
            } else if (key.key === 'Right') {
                this.cursor = motion.macWordRight(this.buffer, cur);
            } else if (key.key === 'Backspace') {
                const start = motion.macWordLeft(this.buffer, cur);
                this.buffer.deleteRange(start, cur);
                this.cursor = start;
            } else {
                this.buffer.deleteRange(cur, motion.macWordRight(this.buffer, cur));
            }
            this.updateWantCol();
            return;
        }
        if (key.alt && isCharKey(key)) return;
        if (key.ctrl) {
            if (key.key === 'w') {
                this.insertDeleteWord();
            } else if (key.key === 'u') {
                const indent = this.buffer.indentOf(cur.line).length;
                const start = cur.col > indent ? indent : 0;
                this.buffer.deleteRange(pos(cur.line, start), cur);
                this.cursor = pos(cur.line, start);
            } else if (key.key === 't' || key.key === 'd') {
                this.insertShift(key.key === 't');
            }
            return;
        }
        switch (key.key) {
            case 'BackTab':
                this.insertShift(false);
                break;
            case 'Enter':
                this.insertNewline();
                break;
            case 'Tab':
                if (this.options.expandtab) {
                    const sw = Math.max(this.options.shiftwidth, 1);
                    const n = sw - (this.displayCol(cur.line, cur.col) % sw);
                    this.cursor = this.buffer.insertText(cur, ' '.repeat(n));
                } else {
                    this.buffer.insertChar(cur, '\t');
                    this.cursor = pos(cur.line, cur.col + 1);
                }
                break;
            case 'Backspace':
                if (replace) {
                    if (cur.col > 0) this.cursor = pos(cur.line, cur.col - 1);
                } else {
                    this.insertBackspace();
                }
                break;
            case 'Delete':
                if (cur.col < len) this.buffer.deleteRange(cur, pos(cur.line, cur.col + 1));
                else if (cur.line < this.buffer.lastLine()) this.buffer.deleteRange(cur, pos(cur.line + 1, 0));
                break;
            case 'Left':
                this.cursor = pos(cur.line, Math.max(cur.col - 1, 0));
                break;
            case 'Right':
                this.cursor = pos(cur.line, Math.min(cur.col + 1, len));
                break;
            case 'Home':
                this.cursor = pos(cur.line, 0);
                break;
            case 'End':
                this.cursor = pos(cur.line, len);
                break;
            case 'Up':
            case 'Down':
            case 'PageUp':
            case 'PageDown': {
                const rows = key.key === 'PageUp' || key.key === 'PageDown' ? this.viewRows : 1;
                const line =
                    key.key === 'Up' || key.key === 'PageUp'
                        ? Math.max(cur.line - rows, 0)
                        : Math.min(cur.line + rows, this.buffer.lastLine());
                // Keep the remembered column across consecutive vertical moves.
                this.cursor = pos(line, this.colForWant(line));
                return;
            }
            case 'Esc':
                break;
            default:
                // Every named key is handled above, so this is a character.
                if (replace) {
                    if (cur.col < len) this.buffer.setChar(cur, key.key);
                    else this.buffer.insertChar(cur, key.key);
                    this.cursor = pos(cur.line, cur.col + 1);
                } else {
                    this.insertChar(key.key);
                }
        }
        this.updateWantCol();
    }

    /** Indent or outdent the current line, keeping the cursor on its text. */
    private insertShift(indent: boolean): void {
        const cur = this.cursor;
        const before = this.buffer.lineLen(cur.line);
        ops.shiftLines(this, cur.line, cur.line, indent);
        const after = this.buffer.lineLen(cur.line);
        this.cursor = pos(cur.line, Math.max(cur.col + after - before, 0));
    }

    private insertChar(c: string): void {
        const cur = this.cursor;
        const sw = Math.max(this.options.shiftwidth, 1);
        // Typing a closing brace on a line of pure indentation dedents it.
        if (c === '}' && cur.col > 0 && this.buffer.line(cur.line).slice(0, cur.col).every((x) => x === ' ')) {
            const remove = Math.min(cur.col, sw);
            this.buffer.deleteRange(pos(cur.line, 0), pos(cur.line, remove));
            this.cursor = pos(cur.line, cur.col - remove);
        }
        this.buffer.insertChar(this.cursor, c);
        this.cursor = pos(this.cursor.line, this.cursor.col + 1);
        this.insert.autoindentLine = undefined;
    }

    private insertNewline(): void {
        const cur = this.cursor;
        const line = this.buffer.line(cur.line);
        const indent: Line = [];
        if (this.options.autoindent) {
            for (const c of line.slice(0, cur.col)) {
                if (c !== ' ' && c !== '\t') break;
                indent.push(c);
            }
        }
        const before = line.slice(0, cur.col).reverse().find((c) => !isWhitespace(c));
        const after = line[cur.col];
        const opens = before === '{' || before === '(' || before === '[';
        const closesPair =
            (before === '{' && after === '}') || (before === '(' && after === ')') || (before === '[' && after === ']');

        // A line that only held automatic indentation is cleared.
        if (this.insert.autoindentLine === cur.line && this.buffer.isBlankLine(cur.line)) {
            this.buffer.replaceLine(cur.line, []);
            this.cursor = pos(cur.line, 0);
        }
        const outer = indent.join('');
        if (opens && this.options.autoindent) indent.push(...this.indentUnit());
        this.cursor = this.buffer.insertText(this.cursor, '\n' + indent.join(''));
        if (closesPair) this.buffer.insertText(this.cursor, '\n' + outer);
        this.insert.autoindentLine = indent.length > 0 ? this.cursor.line : undefined;
    }

    private insertBackspace(): void {
        const cur = this.cursor;
        if (cur.col === 0) {
            if (cur.line > 0) {
                const prev = pos(cur.line - 1, this.buffer.lineLen(cur.line - 1));
                this.buffer.deleteRange(prev, cur);
                this.cursor = prev;
            }
            return;
        }
        const line = this.buffer.line(cur.line);
        const sw = Math.max(this.options.shiftwidth, 1);
        const n =
            this.options.expandtab && line.slice(0, cur.col).every((c) => c === ' ') ? ((cur.col - 1) % sw) + 1 : 1;
        this.buffer.deleteRange(pos(cur.line, cur.col - n), cur);
        this.cursor = pos(cur.line, cur.col - n);
    }

    private insertDeleteWord(): void {
        const cur = this.cursor;
        if (cur.col === 0) {
            this.insertBackspace();
            return;
        }
        let start = motion.prevWordStart(this.buffer, cur, false);
        if (start.line !== cur.line) start = pos(cur.line, 0);
        this.buffer.deleteRange(start, cur);
        this.cursor = start;
    }

    indentUnit(): Line {
        return this.options.expandtab ? Array(Math.max(this.options.shiftwidth, 1)).fill(' ') : ['\t'];
    }

    // ----- Command line ----------------------------------------------------------

    private cmdlineKey(key: KeyInput, kind: CmdKind): void {
        const isSearch = kind !== 'Ex';
        // Option+Backspace deletes a word, like <C-w>; <C-h> is backspace.
        if (key.alt && key.key === 'Backspace') key = ctrl('w');
        else if (keyEq(key, ctrl('h'))) key = plain('Backspace');
        switch (key.key) {
            case 'Esc':
                this.cancelCmdline(isSearch);
                return;
            case 'Enter': {
                const line = this.cmdline;
                this.cmdline = '';
                this.mode = 'Normal';
                if (isSearch) {
                    pushHistory(this.searchHistory, line);
                    this.submitSearch(line, kind === 'SearchForward');
                } else {
                    pushHistory(this.exHistory, line);
                    runEx(this, line);
                }
                return;
            }
            case 'Backspace': {
                if (this.cmdline === '') {
                    this.cancelCmdline(isSearch);
                    return;
                }
                this.cmdline = Array.from(this.cmdline).slice(0, -1).join('');
                break;
            }
            case 'Up':
            case 'Down': {
                const history = isSearch ? this.searchHistory : this.exHistory;
                if (history.length > 0) {
                    const up = key.key === 'Up';
                    const i = this.historyIndex;
                    let idx: number | undefined;
                    if (i === undefined) idx = up ? history.length - 1 : undefined;
                    else if (up) idx = Math.max(i - 1, 0);
                    else idx = i + 1 < history.length ? i + 1 : undefined;
                    this.cmdline = idx === undefined ? '' : history[idx];
                    this.historyIndex = idx;
                }
                break;
            }
            case 'Tab':
                this.completeCmdline();
                break;
            default:
                if (key.ctrl && key.key === 'u') {
                    this.cmdline = '';
                } else if (key.ctrl && key.key === 'w') {
                    const trimmed = this.cmdline.replace(/ +$/, '');
                    const kept = trimmed.replace(/[\p{L}\p{N}_]+$/u, '');
                    this.cmdline = kept.length === trimmed.length ? Array.from(trimmed).slice(0, -1).join('') : kept;
                } else if (!key.ctrl && !key.alt && isCharKey(key)) {
                    this.cmdline += key.key;
                }
        }
        if (isSearch && this.options.incsearch) {
            this.cursor = this.searchOrigin;
            const re = this.regexFor(this.cmdline);
            const found = re && search.find(this.buffer, re, this.searchOrigin, kind === 'SearchForward');
            if (found) this.cursor = found[0];
        }
    }

    private cancelCmdline(isSearch: boolean): void {
        this.cmdline = '';
        this.mode = 'Normal';
        if (isSearch) this.cursor = this.searchOrigin;
    }

    /** Complete a file name argument for `:e`/`:w`. */
    private completeCmdline(): void {
        const space = this.cmdline.indexOf(' ');
        if (space < 0) return;
        const cmd = this.cmdline.slice(0, space);
        const arg = this.cmdline.slice(space + 1);
        if (!['e', 'edit', 'w', 'write', 'sp', 'r'].includes(cmd)) return;
        const p = expandTilde(arg);
        const sep = Math.max(p.lastIndexOf('/'), process.platform === 'win32' ? p.lastIndexOf('\\') : -1);
        const dir = sep >= 0 ? p.slice(0, sep + 1) : '';
        const prefix = sep >= 0 ? p.slice(sep + 1) : p;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir === '' ? '.' : dir, { withFileTypes: true });
        } catch {
            return;
        }
        const matches = entries
            .filter((e) => e.name.startsWith(prefix))
            .map((e) => (isDir(dir, e) ? e.name + '/' : e.name))
            .sort();
        if (matches.length === 0) return;
        let common = Array.from(matches[0]);
        for (const m of matches) {
            const mc = Array.from(m);
            let i = 0;
            while (i < common.length && i < mc.length && common[i] === mc[i]) i++;
            common = common.slice(0, i);
        }
        this.cmdline = `${cmd} ${dir}${common.join('')}`;
        if (matches.length > 1) this.setMessage(matches.join('  '));
    }

    private submitSearch(pattern: string, forward: boolean): void {
        this.cursor = this.searchOrigin;
        if (pattern === '') {
            if (!this.lastSearch) {
                this.setError('E35: No previous regular expression');
                return;
            }
            pattern = this.lastSearch.pattern;
        }
        this.lastSearch = { pattern, forward };
        const m = { t: 'SearchNext' } as const;
        const target = motion.evalMotion(this, m, undefined, false);
        if (target) motion.moveTo(this, m, target);
    }

    // ----- Undo ------------------------------------------------------------------

    snapshot(): Snapshot {
        const { lines, version } = this.buffer.snapshot();
        return { lines, version, cursor: this.cursor };
    }

    commitUndo(): void {
        const s = this.undoPending;
        this.undoPending = undefined;
        if (s && s.version !== this.buffer.version()) {
            this.undoStack.push(s);
            this.redoStack = [];
        }
    }

    private restore(s: Snapshot): void {
        this.buffer.restore(s.lines, s.version);
        this.cursor = s.cursor;
        this.clampCursor();
        this.updateWantCol();
    }

    undo(): void {
        const s = this.undoStack.pop();
        if (!s) {
            this.setMessage('Already at oldest change');
            return;
        }
        this.redoStack.push({ ...this.snapshot(), cursor: s.cursor });
        this.restore(s);
    }

    redo(): void {
        const s = this.redoStack.pop();
        if (!s) {
            this.setMessage('Already at newest change');
            return;
        }
        this.undoStack.push({ ...this.snapshot(), cursor: s.cursor });
        this.restore(s);
    }

    // ----- Dot repeat --------------------------------------------------------------

    private repeatLastChange(count: number | undefined): void {
        if (this.lastChange.length === 0 || this.replaying) return;
        const keys = this.lastChange.slice();
        if (count !== undefined) {
            // A count given to `.` replaces the original count.
            const i = keys.length > 0 && keyIs(keys[0], '"') ? Math.min(2, keys.length) : 0;
            let digits = 0;
            while (i + digits < keys.length && /^[0-9]$/.test(charOf(keys[i + digits]) ?? '')) digits++;
            keys.splice(i, digits, ...Array.from(String(count)).map(ch));
        }
        this.replaying = true;
        for (const k of keys) this.handleKey(k);
        this.replaying = false;
    }

    // ----- Visual mode helpers -------------------------------------------------------

    exitVisual(): void {
        if (!isVisual(this.mode)) return;
        const [start, end] = order(this.visualAnchor, this.cursor);
        this.marks.set('<', start);
        this.marks.set('>', end);
        this.lastVisual = { mode: this.mode, anchor: this.visualAnchor, cursor: this.cursor };
        this.mode = 'Normal';
    }

    private clampPosVisual(): void {
        const last = this.buffer.lastLine();
        const clamp = (p: Pos): Pos => {
            const line = Math.min(p.line, last);
            return pos(line, Math.min(p.col, Math.max(this.buffer.lineLen(line) - 1, 0)));
        };
        this.visualAnchor = clamp(this.visualAnchor);
        this.cursor = clamp(this.cursor);
    }

    // ----- Cursor helpers --------------------------------------------------------------

    clampCursor(): void {
        const line = Math.min(this.cursor.line, this.buffer.lastLine());
        const len = this.buffer.lineLen(line);
        const max = isInsert(this.mode) ? len : Math.max(len - 1, 0);
        this.cursor = pos(line, Math.min(this.cursor.col, max));
    }

    /** Remember the cursor's display column for later vertical motions. */
    updateWantCol(): void {
        this.wantCol = this.displayCol(this.cursor.line, this.cursor.col);
    }

    /** The column on `line` closest to the remembered display column. */
    colForWant(line: number): number {
        const len = this.buffer.lineLen(line);
        const max = isInsert(this.mode) ? len : Math.max(len - 1, 0);
        if (this.wantCol === WANT_EOL) return max;
        return Math.min(this.colFromDisplay(line, this.wantCol), max);
    }

    private showFileInfo(): void {
        const lines = this.buffer.lineCount();
        const pct = Math.floor(((this.cursor.line + 1) * 100) / lines);
        const modified = this.isModified() ? ' [Modified]' : '';
        this.setMessage(`"${this.fileName()}"${modified} ${lines} lines --${pct}%--`);
    }
}

function mayChange(a: Action): boolean {
    switch (a.t) {
        case 'Operate':
        case 'VisualOp':
        case 'VisualLinewiseOp':
            return a.op !== 'Yank';
        case 'Insert':
        case 'Paste':
        case 'ReplaceChar':
        case 'Join':
        case 'ToggleCaseChar':
        case 'ReplaceMode':
        case 'Increment':
        case 'VisualReplace':
        case 'VisualPaste':
            return true;
        default:
            return false;
    }
}

function pushHistory(history: string[], line: string): void {
    if (line === '') return;
    const i = history.indexOf(line);
    if (i >= 0) history.splice(i, 1);
    history.push(line);
}

function isDir(dir: string, e: fs.Dirent): boolean {
    if (e.isDirectory()) return true;
    if (!e.isSymbolicLink()) return false;
    try {
        return fs.statSync(path.join(dir === '' ? '.' : dir, e.name)).isDirectory();
    } catch {
        return false;
    }
}
