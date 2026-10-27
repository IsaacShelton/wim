// The window's logic: translates window input into editor keys and paints the
// editor state (file tree, buffer tabs, text, gutter, selection, cursor,
// status and command lines) as a list of drawing commands for the window.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { AudioInfo, AudioPlayer, SEEK_STEP, VOLUME_STEP, formatTime } from './audio';
import { Clipboard, SystemClipboard } from './clipboard';
import { bufferState, bufferStates, findBuffer, switchToBufferQuietly } from './editor/buffers';
import { Buffer, Pos, isWhitespace, pos, posCmp } from './editor/buffer';
import { awaitingMotion } from './editor/command';
import { Editor, Selection } from './editor/editor';
import { fail } from './editor/errors';
import { KeyInput, ch, charOf, ctrl, isNamedKey, keyEq, keyNew, keyToString, parseKeys, plain } from './editor/keys';
import { isCmdLine } from './editor/mode';
import { Range } from './editor/range';
import { lineMatches } from './editor/search';
import { FileTree } from './filetree';
import { GrepMatch, Search, findFiles, liveGrep } from './finder';
import { ImageInfo, formatBytes, imageUrl, isImage, readImageInfo } from './image';
import { ImageView, Placement, Size } from './imageview';
import * as highlight from './highlight';
import * as icons from './icons';
import { Command, Keymap, LspAction, MapMode, Rhs, TIMEOUT } from './keymap';
import { Completion } from './lsp/completion';
import { LspFeatures, severityColor } from './lsp/features';
import { BufferDiagnostic, LspManager } from './lsp/manager';
import { ServerSpec, defaultServers } from './lsp/servers';
import { SignatureHelp } from './lsp/signature';
import { baseName, currentDir, displayName, expandTilde } from './paths';
import { Float, Overlay, Picker, PickerItem, PreviewSource, readPreview } from './popup';
import { AudioCommand, ClientMessage, DrawCmd } from './protocol';
import { isThemeName, setTheme, theme, themeName, tokenColor } from './theme';
import { Direction, SplitDir, Win, WinRect, Windows } from './windows';

const TEXT_PADDING = 6;
/** Width of the file tree, in characters. */
const SIDEBAR_COLS = 30;
const FLASH_DURATION = 300;
/** How far the mouse must move before a press becomes a drag, in pixels. */
const DRAG_THRESHOLD = 4;
/** Time between frames of an animation, in ms. */
const FRAME = 16;
/** How long a clicked button looks pressed, in ms. */
const BUTTON_PRESS = 150;
/** Width of the sign column for diagnostics, in characters (shown for files
 * a language server handles, like Neovim's `signcolumn=yes`). */
const SIGN_COLS = 2;
/** Columns the status line keeps for the file name before giving it all
 * to language server progress. */
const MIN_NAME = 20;
/** Diagnostic signs by severity, from the Neovim config, and without a Nerd
 * Font. */
const SIGNS = ['', '\u{f0159}', '\u{f071}', '\u{f02fc}', '\u{f0335}'];
const PLAIN_SIGNS = ['', 'E', 'W', 'I', 'H'];

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

function rectSize(r: Rect): Size {
    return { width: r.right - r.left, height: r.bottom - r.top };
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
    /** Every window's place; `textArea` is the active one's. */
    windows: WinRect[];
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
    /** Language servers to use (by default rust-analyzer and
     * typescript-language-server). */
    servers?: ServerSpec[];
    /** Called whenever the window should be repainted. */
    onFrame: (title: string, dirty: boolean, cmds: DrawCmd[]) => void;
    /** Called to control the window's sound player. */
    onAudio?: (cmd: AudioCommand) => void;
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
    /** Highlighter states, by buffer. */
    private readonly highlightCaches = new Map<number, highlight.Cache>();
    private scrollRemainder = 0;
    private closeWarned = false;
    private metrics: Metrics = { width: 1000, height: 720, charW: 9, lineH: 23 };
    /** The press that may become a drag in the text area. */
    /** A press that may become a drag: in the text area, or on the sound
     * player's scrubber or volume bar (`control`). */
    private press: { x: number; y: number; dragging: boolean; control?: 'Scrub' | 'Volume' } | undefined;
    /** The one sound that can be playing. */
    readonly player: AudioPlayer;
    /** Split windows; the editor works in the active one. */
    readonly windows: Windows;
    private quitting = false;
    readonly lsp: LspManager;
    private readonly features: LspFeatures;
    private readonly completion: Completion;
    private readonly signature: SignatureHelp;
    /** A picker (references, symbols, code actions...) has the keyboard. */
    private picker: Picker<never> | undefined;
    /** Hover documentation or diagnostics next to the cursor. */
    private float: Float | undefined;
    private refreshQueued = false;
    /** Draws the next frame while an image glides to a new zoom or place. */
    private imageTimer: NodeJS.Timeout | undefined;
    /** An image zoom button just clicked, drawn pressed for a moment. */
    private pressedButton: ImageAction | undefined;
    private pressedTimer: NodeJS.Timeout | undefined;
    /** How each image buffer is zoomed, by buffer id. */
    private readonly imageViews = new Map<number, { image: ImageInfo; view: ImageView }>();

    constructor(private readonly opts: AppOptions) {
        this.icons = opts.icons;
        this.clipboard = opts.clipboard ?? new SystemClipboard();
        // `wim .` or `wim some/dir`: work in that directory, with no file open.
        let file = opts.path;
        let dirError: string | undefined;
        if (file !== undefined && isDirectory(file)) {
            try {
                process.chdir(file);
            } catch (e) {
                dirError = `E344: Can't find directory "${file}": ${(e as Error).message}`;
            }
            file = undefined;
        }
        // `wim some/file`: work in the file's directory, so the tree, the
        // pickers and relative paths start there.
        if (file !== undefined) {
            file = path.resolve(file);
            try {
                process.chdir(path.dirname(file));
            } catch {
                // A new file in a directory that doesn't exist yet: stay put.
            }
        }
        this.editor = new Editor(this.clipboard);
        const refresh = (): void => this.refresh();
        this.lsp = new LspManager(this.editor, opts.servers ?? defaultServers(), { refresh });
        this.features = new LspFeatures(this.editor, this.lsp, {
            openPicker: (picker) => {
                this.picker = picker;
            },
            showFloat: (float) => {
                this.float = float;
            },
            refresh,
        });
        this.completion = new Completion(this.editor, this.lsp, refresh);
        this.signature = new SignatureHelp(this.editor, this.lsp, refresh);
        this.completion.onParens = () => this.signature.trigger('(');
        this.player = new AudioPlayer((cmd) => opts.onAudio?.(cmd), refresh);
        this.editor.userCommand = (name, args) => this.userCommand(name, args);
        if (file !== undefined) this.editor.openFile(file);
        this.windows = new Windows(this.editor.bufferId());
        // `:q` closes a window while there are others.
        this.editor.closeWindow = () => this.closeWindow();
        if (dirError !== undefined) this.editor.setError(dirError);
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
            case 'audio':
                this.player.update(msg);
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
                if (this.picker) {
                    const text = this.clipboard.getText();
                    if (text !== undefined) this.picker.paste(text);
                } else if (this.focus === 'Editor') {
                    const text = this.clipboard.getText();
                    if (text !== undefined) this.editor.pasteText(text);
                }
                break;
        }
    }

    private wheel(layout: Layout, msg: { x: number; y: number; delta: number; dx: number; mode: number; zoom: boolean }): void {
        const view = this.imageView();
        if (view && contains(layout.textArea, msg.x, msg.y)) {
            const area = imageArea(layout.textArea, layout.lineH);
            // In pixels: a line is a line height, a page the view's height.
            const unit = msg.mode === 1 ? layout.lineH : msg.mode === 2 ? area.bottom - area.top : 1;
            // Scrolling (or pinching) zooms around the pointer: a mouse wheel
            // notch (about 100 pixels) is one step, and a trackpad goes
            // smoothly. Dragging pans.
            view.zoom((-msg.delta * unit) / 100, rectSize(area), { x: msg.x - area.left, y: msg.y - area.top });
            return;
        }
        if (msg.zoom) return;
        const lines = msg.mode === 1 ? msg.delta : msg.mode === 2 ? msg.delta * layout.rows : msg.delta / layout.lineH;
        this.scrollRemainder += lines;
        const whole = Math.trunc(this.scrollRemainder);
        if (whole === 0) return;
        this.scrollRemainder -= whole;
        const under = layout.windows.find((w) => contains(w.area, msg.x, msg.y));
        if (layout.sidebar && contains(layout.sidebar, msg.x, msg.y)) {
            this.tree.scrollBy(whole);
        } else if (under && under.win !== this.windows.active) {
            this.scrollWindow(under, whole);
        } else {
            this.editor.scrollBy(whole);
        }
    }

    private key(key: KeyInput): void {
        this.closeWarned = false;
        if (this.picker) {
            const picker = this.picker;
            const before = [this.editor.bufferId(), this.editor.cursor];
            if (!picker.key(key)) {
                picker.dispose();
                if (this.picker === picker) this.picker = undefined;
                // A choice that went somewhere (a symbol from the tree, say)
                // moves to the editor to show it.
                if (this.editor.bufferId() !== before[0] || this.editor.cursor !== before[1]) this.focus = 'Editor';
            }
            return;
        }
        if (this.float?.focused) {
            if (!this.float.key(key)) this.float = undefined;
            return;
        }
        if (this.focus === 'Editor' && this.completion.key(key)) return;
        const before = this.completion.snapshot();
        this.typeKey(key);
        if (before.mode === 'Insert') {
            this.completion.afterKey(key, before);
            this.signature.afterKey(key, before);
        }
    }

    private typeKey(key: KeyInput): void {
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
        if (this.windowCmdPending) return undefined;
        if (this.editor.pending.length > 0) {
            return this.editor.mode === 'Normal' && awaitingMotion(this.editor.pending) ? 'Operator' : undefined;
        }
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
        if (rhs.t === 'Lsp') {
            this.lspAction(rhs.action);
            return;
        }
        switch (rhs.command) {
            case 'WindowLeft':
                this.moveFocus('Left');
                break;
            case 'WindowRight':
                this.moveFocus('Right');
                break;
            case 'WindowUp':
                this.moveFocus('Up');
                break;
            case 'WindowDown':
                this.moveFocus('Down');
                break;
            case 'ToggleTree':
                this.toggleTree();
                break;
            case 'ToggleTheme':
                setTheme(themeName() === 'nord' ? 'onedark' : 'nord');
                this.editor.setMessage(`colorscheme ${themeName()}`);
                break;
            case 'FindFiles':
                this.findFiles();
                break;
            case 'LiveGrep':
                this.liveGrep();
                break;
            case 'InsertCharBefore':
            case 'InsertCharAfter':
                this.awaitingChar = rhs.command;
                break;
        }
    }

    private lspAction(action: LspAction): void {
        // Asking for hover again moves into it, to scroll it.
        const f = this.float;
        if (action.t === 'Hover' && f && f.bufferId === this.editor.bufferId() && this.focus === 'Editor') {
            f.focused = true;
            return;
        }
        this.features.run(action);
    }

    /** `:LspInfo`, `:LspRestart`. */
    private userCommand(name: string, args: string): void {
        switch (name) {
            case 'LspInfo':
                this.editor.setMessage(this.lsp.info());
                return;
            case 'LspRestart':
                this.lsp.restart();
                this.editor.setMessage('Restarting language servers');
                return;
            case 'split':
            case 'vsplit':
                this.split(name === 'split' ? 'Column' : 'Row', false, args === '' ? undefined : expandTilde(args));
                return;
            case 'new':
            case 'vnew':
                this.split(name === 'new' ? 'Column' : 'Row', true);
                return;
            case 'only':
                this.onlyWindow();
                return;
            case 'colorscheme':
                if (args === '') this.editor.setMessage(themeName());
                else if (isThemeName(args)) setTheme(args);
                else fail(`E185: Cannot find color scheme '${args}' (there are onedark and nord)`);
                return;
            case 'LspFormatOnSave':
                if (args === 'on' || args === 'off') this.lsp.formatOnSave = args === 'on';
                this.editor.setMessage(`Format on save is ${this.lsp.formatOnSave ? 'on' : 'off'}`);
                return;
            default:
                fail(`E492: Not an editor command: ${name}${args ? ' ' + args : ''}`);
        }
    }

    /** Repaint soon, for something that happened outside of input (a server
     * answering). Several requests make one frame. */
    private refresh(): void {
        if (this.refreshQueued || this.quitting) return;
        this.refreshQueued = true;
        setImmediate(() => {
            this.refreshQueued = false;
            try {
                this.render();
            } catch (e) {
                process.stderr.write(`wim: internal error: ${(e as Error).stack ?? String(e)}\n`);
            }
        });
    }

    /** Stop the language servers (Wim is exiting). */
    dispose(): void {
        if (this.imageTimer) clearTimeout(this.imageTimer);
        if (this.pressedTimer) clearTimeout(this.pressedTimer);
        this.completion.close();
        this.signature.close();
        this.features.dispose();
        this.lsp.dispose();
    }

    /** Send an (unmapped) key to whichever pane has focus. */
    private dispatch(key: KeyInput): void {
        if (this.windowCmdPending) {
            this.windowCmdPending = false;
            this.windowCommand(key);
            return;
        }
        const editorIdle = this.editor.mode === 'Normal' && this.editor.pending.length === 0;
        if (keyEq(key, ctrl('w')) && (this.focus === 'Tree' || editorIdle)) {
            this.windowCmdPending = true;
            return;
        }
        if (this.focus === 'Editor') {
            if (this.imageKey(key) || this.audioKey(key)) return;
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
            case 'Create':
                this.picker = new Picker<never>('Create File', () => {}, {
                    initialQuery: this.tree.promptPath(action.dir),
                    onInput: (name) => {
                        if (name.trim() === '') return;
                        try {
                            this.tree.create(name);
                        } catch (e) {
                            this.editor.setError(`Can't create ${name}: ${(e as Error).message}`);
                        }
                    },
                });
                break;
        }
    }

    /** The zoom and position of the active buffer's image, if it is an image
     * whose size is known. */
    private imageView(): ImageView | undefined {
        const image = this.editor.image;
        if (!image || image.width === 0 || image.height === 0) return undefined;
        return this.imageViewFor(this.editor.bufferId(), image);
    }

    /** The zoom and position of buffer `id`'s image. */
    private imageViewFor(id: number, image: ImageInfo): ImageView {
        let entry = this.imageViews.get(id);
        if (!entry || entry.image !== image) {
            entry = { image, view: new ImageView(image) };
            this.imageViews.set(id, entry);
        }
        return entry.view;
    }

    private imagePlacement(layout: Layout): PaintState['imageView'] {
        const view = this.imageView();
        if (!view) return undefined;
        const size = rectSize(imageArea(layout.textArea, layout.lineH));
        return { placement: view.place(size), scale: view.currentScale(size) };
    }

    /** Zoom and pan keys for an image: `+` or `=` zooms in, `-` out, `0` fits
     * the window, `h`/`j`/`k`/`l` and the arrows pan, all gliding there. Other
     * keys go to the editor (`:` and buffer switching work as usual). */
    private imageKey(key: KeyInput): boolean {
        const view = this.imageView();
        if (!view || this.editor.mode !== 'Normal' || this.editor.pending.length > 0 || key.ctrl) return false;
        const size = rectSize(imageArea(this.layout().textArea, this.metrics.lineH));
        const step = Math.max(size.width, size.height) / 10;
        const pans: Record<string, [number, number]> = {
            h: [step, 0],
            Left: [step, 0],
            l: [-step, 0],
            Right: [-step, 0],
            k: [0, step],
            Up: [0, step],
            j: [0, -step],
            Down: [0, -step],
        };
        if (key.key === '+' || key.key === '=') this.imageAction(view, 'In');
        else if (key.key === '-') this.imageAction(view, 'Out');
        else if (key.key === '0') this.imageAction(view, 'Fit');
        else if (key.key in pans && !key.alt) view.pan(...pans[key.key], size, true);
        else return false;
        this.glideImage();
        return true;
    }

    /** Player keys for a sound: Space, Enter or `p` play and pause, `h`/`l`
     * and the arrows seek, `k`/`j` and up/down change the volume, `m` mutes,
     * and `0`-`9` go to that tenth of the way through. */
    private audioKey(key: KeyInput): boolean {
        const ed = this.editor;
        const info = ed.audio;
        if (!info || ed.filePath === undefined || ed.mode !== 'Normal' || ed.pending.length > 0 || key.ctrl || key.alt) {
            return false;
        }
        const p = this.player;
        const here = p.file === ed.filePath;
        switch (key.key) {
            case ' ':
            case 'Enter':
            case 'p':
                p.toggle(ed.filePath, info);
                return true;
            case 'h':
            case 'Left':
            case 'l':
            case 'Right':
                if (here) p.seek(p.time + (key.key === 'h' || key.key === 'Left' ? -SEEK_STEP : SEEK_STEP));
                return true;
            case 'k':
            case 'Up':
            case 'j':
            case 'Down':
                p.setVolume(p.volume + (key.key === 'k' || key.key === 'Up' ? VOLUME_STEP : -VOLUME_STEP));
                return true;
            case 'm':
                p.toggleMute();
                return true;
            default:
                if (/^[0-9]$/.test(key.key) && here) {
                    p.seek((Number(key.key) / 10) * p.duration);
                    return true;
                }
                return false;
        }
    }

    /** A click or drag on the sound player's controls. Returns whether it hit
     * one. */
    private audioMouse(layout: Layout, x: number, y: number, control?: 'Scrub' | 'Volume'): boolean {
        const ed = this.editor;
        const info = ed.audio;
        if (!info || ed.filePath === undefined) return false;
        const c = audioControls(layout.textArea, layout.charW, layout.lineH);
        const p = this.player;
        const fraction = (r: Rect): number => Math.min(Math.max((x - r.left) / (r.right - r.left), 0), 1);
        if (control === 'Scrub' || (!control && contains(c.scrubber, x, y))) {
            if (p.file === ed.filePath) p.seek(fraction(c.scrubber) * p.duration);
            if (this.press) this.press.control = 'Scrub';
            return true;
        }
        if (control === 'Volume' || (!control && contains(c.volume, x, y))) {
            p.setVolume(fraction(c.volume));
            if (this.press) this.press.control = 'Volume';
            return true;
        }
        if (contains(c.play, x, y)) {
            p.toggle(ed.filePath, info);
            return true;
        }
        if (contains(c.mute, x, y)) {
            p.toggleMute();
            return true;
        }
        return false;
    }

    /** Draw frames until the image has glided to where it is going. */
    private glideImage(): void {
        if (this.imageTimer) return;
        const frame = (): void => {
            this.imageTimer = undefined;
            const view = this.imageView();
            if (!view || this.quitting) return;
            const moving = view.tick(rectSize(imageArea(this.layout().textArea, this.metrics.lineH)));
            this.render();
            if (moving) this.imageTimer = setTimeout(frame, FRAME);
        };
        this.imageTimer = setTimeout(frame, FRAME);
    }

    /** Zoom in, out, or back to fitting the window, gliding there. */
    private imageAction(view: ImageView, action: ImageAction, layout = this.layout()): void {
        const size = rectSize(imageArea(layout.textArea, layout.lineH));
        if (action === 'In') view.zoom(1, size, undefined, true);
        else if (action === 'Out') view.zoom(-1, size, undefined, true);
        else view.reset(size, true);
        this.glideImage();
    }

    /** After `<C-w>`: `h`/`j`/`k`/`l` (or arrows) move to the window that way,
     * `w`/`W` to the next/previous (the tree first, if shown), `p` to the
     * previous one; `s`/`v` split, `n` splits with a new buffer, `c` closes,
     * `q` quits (`:q`), `o` keeps only this one. */
    private windowCommand(key: KeyInput): void {
        const k = key.key;
        const moves: Record<string, Direction> = {
            h: 'Left', Left: 'Left', Backspace: 'Left',
            l: 'Right', Right: 'Right',
            k: 'Up', Up: 'Up',
            j: 'Down', Down: 'Down',
        };
        if (k in moves) {
            this.moveFocus(moves[k]);
            return;
        }
        switch (k) {
            case 'w':
            case 'W':
                this.cycleFocus(k === 'w' ? 1 : -1);
                break;
            case 'p':
                if (this.windows.previous) this.focusWindow(this.windows.previous);
                break;
            case 's':
            case 'S':
            case 'v':
            case 'n':
                this.focus = 'Editor';
                this.split(k === 'v' ? 'Row' : 'Column', k === 'n');
                break;
            case 'c':
                this.focus = 'Editor';
                if (!this.closeWindow()) this.editor.setError('E444: Cannot close last window');
                break;
            case 'q':
                this.focus = 'Editor';
                this.editor.handleKeys(parseKeys(':q<CR>'));
                break;
            case 'o':
                this.focus = 'Editor';
                this.onlyWindow();
                break;
        }
    }

    // ----- Split windows -----------------------------------------------------------

    /** Remember the active window's place, from the editor. */
    private saveWindow(): void {
        const w = this.windows.active;
        const ed = this.editor;
        w.bufferId = ed.bufferId();
        w.cursor = ed.cursor;
        w.scrollTop = ed.scrollTop;
        w.scrollLeft = ed.scrollLeft;
        w.wantCol = ed.wantCol;
    }

    /** Make `win` the active window: the editor shows its buffer, cursor and
     * scroll position. */
    private focusWindow(win: Win): void {
        this.focus = 'Editor';
        if (win === this.windows.active) return;
        this.editorToNormal();
        this.saveWindow();
        this.windows.focus(win);
        this.loadWindow(win);
    }

    private loadWindow(win: Win): void {
        const ed = this.editor;
        if (win.bufferId !== ed.bufferId() && !switchToBufferQuietly(ed, win.bufferId)) win.bufferId = ed.bufferId();
        ed.cursor = win.cursor;
        ed.scrollTop = win.scrollTop;
        ed.scrollLeft = win.scrollLeft;
        ed.wantCol = win.wantCol;
        ed.clampCursor();
    }

    /** Keep the windows in step with the editor: the active one shows what it
     * shows, and windows whose buffer was closed go too. */
    private syncWindows(): void {
        this.saveWindow();
        const open = new Set(this.editor.buffers.map((s) => s.id));
        for (const w of this.windows.list()) {
            if (!open.has(w.bufferId) && w !== this.windows.active) this.windows.close(w);
        }
    }

    /** Scroll an inactive window, keeping its cursor in view as Vim does. */
    private scrollWindow(rect: WinRect, lines: number): void {
        const win = rect.win;
        const st = bufferState(this.editor, win.bufferId);
        if (!st || st.image || st.audio) return;
        const last = st.buffer.lastLine();
        const rows = Math.max(Math.floor((rect.area.bottom - rect.area.top) / this.metrics.lineH), 1);
        win.scrollTop = Math.min(Math.max(win.scrollTop + lines, 0), last);
        const line = Math.min(Math.max(win.cursor.line, win.scrollTop), Math.min(win.scrollTop + rows - 1, last));
        if (line !== win.cursor.line) win.cursor = pos(line, 0);
    }

    /** Split the active window (`:split`, `:vsplit`): the new window shows the
     * same buffer, or `file`, or with `empty` a new buffer. */
    private split(dir: SplitDir, empty = false, file?: string): void {
        this.editorToNormal();
        this.saveWindow();
        this.windows.split(dir);
        if (empty) this.editor.handleKeys(parseKeys(':enew<CR>'));
        else if (file !== undefined) this.editor.openFile(file);
    }

    /** Close the active window (`:close`, and `:q` while there are others).
     * Returns false for the last window. */
    private closeWindow(): boolean {
        if (this.windows.count === 1) return false;
        this.editorToNormal();
        this.saveWindow();
        this.windows.close(this.windows.active);
        this.loadWindow(this.windows.active);
        return true;
    }

    private onlyWindow(): void {
        this.saveWindow();
        this.windows.only();
    }

    /** Move to the window (or the tree) in a direction (Ctrl+h/j/k/l). */
    private moveFocus(dir: Direction): void {
        if (this.focus === 'Tree') {
            if (dir === 'Right') this.focus = 'Editor';
            return;
        }
        this.saveWindow();
        const next = this.windows.neighbor(this.layout().windows, this.windows.active, dir);
        if (next) {
            this.focusWindow(next);
        } else if (dir === 'Left' && this.treeVisible) {
            this.editorToNormal();
            this.focus = 'Tree';
        }
    }

    /** `<C-w>w`/`W`: the next or previous window, with the tree (if shown)
     * before the first. */
    private cycleFocus(delta: number): void {
        const wins = this.windows.list();
        const stops: (Win | 'Tree')[] = this.treeVisible ? ['Tree', ...wins] : wins;
        const at = this.focus === 'Tree' ? 0 : stops.indexOf(this.windows.active);
        const next = stops[(((at + delta) % stops.length) + stops.length) % stops.length];
        if (next === 'Tree') {
            this.editorToNormal();
            this.focus = 'Tree';
        } else {
            this.focusWindow(next);
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

    /** `,a`: pick a file under the working directory to open. */
    private findFiles(): void {
        const root = currentDir();
        const items: PickerItem<string>[] = [];
        const picker = new Picker<string>('Find Files', (file) => this.openAt(path.join(root, file)), {
            preview: true,
            message: 'No files',
            onClose: () => search.cancel(),
        });
        picker.busy = true;
        const search = findFiles(
            root,
            (files) => {
                for (const file of files) {
                    items.push({ label: file, icon: this.fileIcon(file), truncateStart: true, preview: { file: path.join(root, file) }, value: file });
                }
                picker.setItems(items, 'No files', true);
                this.refresh();
            },
            (error) => {
                picker.busy = false;
                if (error) picker.setItems(items, error, true);
                this.refresh();
            },
        );
        this.picker = picker as unknown as Picker<never>;
    }

    /** `,fw`: search the working directory's files as you type, and jump to a
     * match. */
    private liveGrep(): void {
        const root = currentDir();
        let search: Search | undefined;
        const picker: Picker<GrepMatch> = new Picker<GrepMatch>(
            'Live Grep',
            (m) => this.openAt(path.join(root, m.file), m.line, m.col),
            {
                preview: true,
                message: 'Type to search',
                onClose: () => search?.cancel(),
                onQuery: (query) => {
                    search?.cancel();
                    if (query === '') {
                        picker.busy = false;
                        picker.setItems([], 'Type to search');
                        return;
                    }
                    const items: PickerItem<GrepMatch>[] = [];
                    let first = true;
                    picker.busy = true;
                    const show = (message: string): void => {
                        // New results start at the top; more of them keep the
                        // selection.
                        picker.setItems(items, message, !first);
                        first = false;
                        this.refresh();
                    };
                    search = liveGrep(
                        root,
                        query,
                        (matches) => {
                            for (const m of matches) {
                                items.push({
                                    label: `${m.file}:${m.line + 1}:${m.col + 1}: ${m.text.trim()}`,
                                    icon: this.fileIcon(m.file),
                                    preview: { file: path.join(root, m.file), line: m.line },
                                    value: m,
                                });
                            }
                            show('No matches');
                        },
                        (error) => {
                            picker.busy = false;
                            show(error ?? 'No matches');
                        },
                    );
                },
            },
        );
        this.picker = picker as unknown as Picker<never>;
    }

    private fileIcon(file: string): [string, string] | undefined {
        if (!this.icons) return undefined;
        const icon = icons.forFile(path.basename(file));
        return [icon.glyph, rgb(icon.color)];
    }

    /** Open a file chosen from a picker, at a line and column if given. */
    private openAt(file: string, line?: number, col = 0): void {
        const ed = this.editor;
        this.editorToNormal();
        this.focus = 'Editor';
        ed.markJump();
        if (ed.filePath !== file) ed.openFile(file);
        if (line === undefined || ed.filePath !== file) return;
        ed.cursor = pos(Math.min(line, ed.buffer.lastLine()), col);
        ed.clampCursor();
        ed.updateWantCol();
    }

    /** What a picker previews for a file: an image, or its lines (an open
     * buffer's, with unsaved changes, or the file's). */
    private previewLines(file: string): PreviewSource {
        if (isImage(file)) {
            try {
                const info = readImageInfo(file);
                const size = info.width > 0 ? ` ${info.width}×${info.height}` : '';
                return { src: imageUrl(file, info), caption: `${info.format}${size}, ${formatBytes(info.bytes)}` };
            } catch (e) {
                return `(${(e as Error).message})`;
            }
        }
        const id = findBuffer(this.editor, file);
        const st = id === undefined ? undefined : bufferState(this.editor, id);
        return st ? st.buffer.text().split('\n') : readPreview(file);
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
        if (kind === 'down') {
            this.picker?.dispose();
            this.picker = undefined;
            this.float = undefined;
            this.completion.close();
            this.signature.close();
            // A press in another window (or on its name bar) moves there first.
            const hit = layout.windows.find((w) => contains(w.area, x, y) || (w.bar && contains(w.bar, x, y)));
            if (hit && (hit.win !== this.windows.active || this.focus !== 'Editor')) {
                this.focusWindow(hit.win);
                layout = this.prepare();
            }
            if (hit?.bar && contains(hit.bar, x, y)) return;
        }
        if (kind === 'up') {
            this.press = undefined;
            return;
        }
        if (kind === 'move') {
            const p = this.press;
            if (!p) return;
            if (p.control) {
                this.audioMouse(layout, x, y, p.control);
                return;
            }
            if (!p.dragging && Math.hypot(x - p.x, y - p.y) < DRAG_THRESHOLD) return;
            p.dragging = true;
            const view = this.imageView();
            if (view) {
                // Dragging an image moves it.
                view.pan(x - p.x, y - p.y, rectSize(imageArea(layout.textArea, layout.lineH)));
                p.x = x;
                p.y = y;
                return;
            }
            if (this.editor.audio) return;
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
            const view = this.imageView();
            const button = view && imageButtons(layout.textArea, layout.lineH).find(([r]) => contains(r, x, y));
            this.press = { x, y, dragging: false };
            if (this.audioMouse(layout, x, y)) return;
            if (view && button) {
                this.imageAction(view, button[1], layout);
                // Show the button pressed for a moment.
                this.pressedButton = button[1];
                if (this.pressedTimer) clearTimeout(this.pressedTimer);
                this.pressedTimer = setTimeout(() => {
                    this.pressedTimer = undefined;
                    this.pressedButton = undefined;
                    this.render();
                }, BUTTON_PRESS);
                return;
            }
            if (!view && !this.editor.audio) this.editor.click(this.posAt(layout, x, y));
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
            if (this.imageTimer) clearTimeout(this.imageTimer);
            if (this.pressedTimer) clearTimeout(this.pressedTimer);
            this.dispose();
            this.opts.onQuit();
            return;
        }
        // Input may have changed the gutter, tabs, sidebar or windows; lay out
        // again.
        this.syncWindows();
        const layout = this.prepare();
        this.editor.scrollToCursor();
        this.syncTree(layout);
        this.lsp.sync();
        this.features.cursorMoved();
        // Ready a sound to play when its buffer is shown; stop it when its
        // buffer is closed.
        if (this.editor.audio && this.editor.filePath !== undefined) this.player.show(this.editor.filePath, this.editor.audio);
        const playing = this.player.file;
        if (playing !== undefined && !bufferStates(this.editor).some(([, st]) => st.filePath === playing)) this.player.stop(playing);
        const f = this.float;
        const ed = this.editor;
        if (f && !f.focused && (f.bufferId !== ed.bufferId() || posCmp(f.anchor, ed.cursor) !== 0 || ed.mode !== 'Normal' || this.focus !== 'Editor')) {
            this.float = undefined;
        }
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
            panes: this.panes(layout),
            diagnosticCounts: this.lsp.counts(this.editor.filePath),
            lspProgress: this.lsp.progressText(),
            completion: this.completion.visible && this.focus === 'Editor' ? this.completion : undefined,
            signature: this.editor.mode === 'Insert' && this.focus === 'Editor' ? this.signature.float : undefined,
            float: this.float,
            picker: this.picker,
            previewLines: (file) => this.previewLines(file),
            imageView: this.imagePlacement(layout),
            pressedButton: this.pressedButton,
            player: this.player,
            focus: this.focus,
            icons: this.icons,
            tree: this.tree,
            mapPending: this.mapPending,
            highlightCache: (id) => {
                let cache = this.highlightCaches.get(id);
                if (!cache) {
                    cache = new highlight.Cache();
                    this.highlightCaches.set(id, cache);
                }
                return cache;
            },
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
        const windows = this.windows.layout(rect(editorLeft, tabline ? tabline.bottom : 0, width, bottom), lineH, charW);
        const textArea = windows.find((w) => w.win === this.windows.active)!.area;
        const textLeft = textArea.left + this.gutterCols() * charW + TEXT_PADDING;
        return {
            sidebar,
            tabline,
            windows,
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

    private signCols(file = this.editor.filePath): number {
        return this.lsp.handles(file) ? SIGN_COLS : 0;
    }

    /** The sign column and line numbers, for the active buffer or another. */
    private gutterCols(buffer = this.editor.buffer, file = this.editor.filePath): number {
        const o = this.editor.options;
        if (!o.number && !o.relativenumber) return this.signCols(file);
        return this.signCols(file) + Math.max(String(buffer.lineCount()).length, 3) + 1;
    }

    /** What each window shows, for painting. */
    private panes(layout: Layout): Pane[] {
        const ed = this.editor;
        const { charW: cw, lineH: lh } = layout;
        return layout.windows.flatMap((rect): Pane[] => {
            const win = rect.win;
            const active = win === this.windows.active;
            const st = active ? ed : bufferState(ed, win.bufferId);
            if (!st) return [];
            const file = st.filePath;
            const name = displayName(file);
            const modified = st.buffer.version() !== st.savedVersion;
            const pane = { rect, active, name, modified };
            if (st.image && file !== undefined) {
                const area = rectSize(imageArea(rect.area, lh));
                const view = st.image.width > 0 && st.image.height > 0 ? this.imageViewFor(win.bufferId, st.image) : undefined;
                return [{ ...pane, content: { t: 'Image', file, image: st.image, placement: view?.place(area) } }];
            }
            if (st.audio && file !== undefined) return [{ ...pane, content: { t: 'Audio', file, info: st.audio } }];
            const buffer = st.buffer;
            const last = buffer.lastLine();
            const cursor = active ? ed.cursor : pos(Math.min(win.cursor.line, last), win.cursor.col);
            const gutterCols = this.gutterCols(buffer, file);
            const textLeft = rect.area.left + gutterCols * cw + TEXT_PADDING;
            const view: TextView = {
                buffer,
                bufferId: win.bufferId,
                filePath: file,
                cursor,
                scrollTop: active ? ed.scrollTop : Math.min(win.scrollTop, last),
                scrollLeft: active ? ed.scrollLeft : win.scrollLeft,
                selection: active ? ed.selection() : undefined,
                area: rect.area,
                textLeft,
                rows: Math.max(Math.floor((rect.area.bottom - rect.area.top) / lh), 1),
                cols: Math.max(Math.floor((rect.area.right - textLeft - TEXT_PADDING) / cw), 1),
                gutterCols,
                signCols: this.signCols(file),
                diagnostics: this.lsp.diagnosticsFor(file, buffer),
                references: active ? this.features.highlights() : [],
                flash: active ? this.flash : undefined,
                semantic: (line, chars) => this.lsp.semanticFor(file, line, chars),
            };
            return [{ ...pane, content: { t: 'Text', view } }];
        });
    }
}

function isDirectory(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

/** Where an image is shown in a window's area `r`: less a margin. */
function imageArea(r: Rect, lh: number): Rect {
    const pad = Math.min(lh, (r.right - r.left) / 4, (r.bottom - r.top) / 4);
    return rect(r.left + pad, r.top + pad, r.right - pad, r.bottom - pad);
}

/** Where the sound player and its controls go: a panel in the middle of a
 * window's area `r`, with rows for the title (and details under it), the play
 * button and scrubber, the volume, and the key reminder. */
function audioControls(r: Rect, cw: number, lh: number): {
    panel: Rect;
    title: number;
    play: Rect;
    scrubber: Rect;
    mute: Rect;
    volume: Rect;
    hint: number;
} {
    const width = Math.max(Math.min(r.right - r.left - 4 * cw, 70 * cw), 30 * cw);
    const height = 10 * lh;
    const left = Math.round((r.left + r.right - width) / 2);
    const top = Math.max(Math.round((r.top + r.bottom - height) / 2), r.top);
    const row = (n: number): number => top + n * lh;
    const play = rect(left + 2 * cw, row(4) - lh * 0.5, left + 2 * cw + 2 * lh, row(4) + lh * 1.5);
    const scrubLeft = play.right + 8 * cw;
    return {
        panel: rect(left, top, left + width, top + height),
        title: row(1),
        play,
        scrubber: rect(scrubLeft, row(4), Math.max(left + width - 9 * cw, scrubLeft + cw), row(5)),
        mute: rect(left + 2 * cw, row(6), left + 2 * cw + 2 * cw, row(7)),
        volume: rect(left + 6 * cw, row(6), left + 6 * cw + Math.min(20 * cw, width / 3), row(7)),
        hint: row(8),
    };
}

type ImageAction = 'In' | 'Out' | 'Fit';

/** The zoom buttons in the bottom right corner of an image in a window's
 * area `r`: where they are, what they do and their labels. */
function imageButtons(r: Rect, lh: number): [Rect, ImageAction, string][] {
    const size = Math.round(lh * 1.2);
    const gap = 4;
    const bottom = r.bottom - 8;
    const buttons: [ImageAction, string][] = [
        ['In', '+'],
        ['Out', '-'],
        ['Fit', '='],
    ];
    return buttons.map(([action, label], i) => {
        const right = r.right - 8 - (buttons.length - 1 - i) * (size + gap);
        return [rect(right - size, bottom - size, right, bottom), action, label];
    });
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

/** One window's text to paint: its buffer, where it is in it, and where it
 * goes on screen. */
interface TextView {
    buffer: Buffer;
    bufferId: number;
    filePath: string | undefined;
    cursor: Pos;
    scrollTop: number;
    scrollLeft: number;
    /** Only the active window's. */
    selection: Selection | undefined;
    area: Rect;
    /** Where the text starts, after the gutter. */
    textLeft: number;
    rows: number;
    cols: number;
    gutterCols: number;
    signCols: number;
    diagnostics: BufferDiagnostic[];
    references: [Pos, Pos][];
    flash: Flash | undefined;
    /** A language server's semantic token spans for a line, if it has them. */
    semantic: (line: number, chars: readonly string[]) => highlight.Span[] | undefined;
}

/** A window to paint. */
interface Pane {
    rect: WinRect;
    active: boolean;
    name: string;
    modified: boolean;
    content:
        | { t: 'Text'; view: TextView }
        | { t: 'Image'; file: string; image: ImageInfo; placement: Placement | undefined }
        | { t: 'Audio'; file: string; info: AudioInfo };
}

/** The display column of `col` on `line`, with tabs `tabstop` wide (as
 * `Editor.displayCol`, for any buffer). */
function displayColIn(buf: Buffer, tabstop: number, line: number, col: number): number {
    const ts = Math.max(tabstop, 1);
    const chars = buf.line(line);
    let d = 0;
    const n = Math.min(col, chars.length);
    for (let i = 0; i < n; i++) d = chars[i] === '\t' ? (Math.floor(d / ts) + 1) * ts : d + 1;
    return d + Math.max(col - chars.length, 0);
}

/** What the painter needs to know besides the editor. */
interface PaintState {
    metrics: Metrics;
    focus: Focus;
    icons: boolean;
    tree: FileTree;
    mapPending: KeyInput[];
    /** Highlighter states for a buffer. */
    highlightCache: (bufferId: number) => highlight.Cache;
    /** Every window, the active one among them. */
    panes: Pane[];
    /** Diagnostics by severity (1 to 4). */
    diagnosticCounts: number[];
    lspProgress: string | undefined;
    completion: Completion | undefined;
    /** The signature of the call being typed. */
    signature: Float | undefined;
    float: Float | undefined;
    picker: Picker<never> | undefined;
    previewLines: (file: string) => PreviewSource;
    /** Where the active buffer's image goes and its zoom, when it is an image
     * of known size. */
    imageView: { placement: Placement; scale: number } | undefined;
    /** An image zoom button drawn pressed. */
    pressedButton: ImageAction | undefined;
    player: AudioPlayer;
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
    private text(x: number, y: number, s: string, color: string, italic = false): void {
        if (s !== '') this.cmds.push(italic ? ['text', x, y, s, color, true] : ['text', x, y, s, color]);
    }

    /** Text whose right edge is at `x`. */
    private textRight(x: number, y: number, s: string, color: string): void {
        this.text(x - Array.from(s).length * this.layout.charW, y, s, color);
    }

    private clip(r: Rect): void {
        this.cmds.push(['clip', r.left, r.top, r.right - r.left, r.bottom - r.top]);
    }

    paint(): DrawCmd[] {
        this.rect(rect(0, 0, this.st.metrics.width, this.st.metrics.height), theme.BG);
        for (const pane of this.st.panes) this.paintPane(pane);
        if (this.st.panes.find((p) => p.active)?.content.t === 'Text') this.paintCursor();
        this.paintTabline();
        this.paintTree();
        this.paintStatus();
        this.paintCmdline();
        this.paintPopups();
        return this.cmds;
    }

    /** One window: its text, image or sound, its name bar when there are
     * several, and a divider on its right if another window is there. */
    private paintPane(pane: Pane): void {
        const cw = this.layout.charW;
        const { area, bar } = pane.rect;
        const c = pane.content;
        this.clip(area);
        if (c.t === 'Text') this.paintText(c.view);
        else if (c.t === 'Image') this.paintImage(area, c.file, c.image, c.placement);
        else this.paintAudio(area, c.file, c.info);
        this.cmds.push(['unclip']);
        if (bar) {
            this.rect(bar, pane.active ? theme.SELECTION : theme.STATUS_BG);
            const name = ` ${pane.name}${pane.modified ? ' [+]' : ''}`;
            const cols = Math.floor((bar.right - bar.left) / cw);
            const shown = Array.from(name).length <= cols ? name : ' …' + Array.from(name).slice(-Math.max(cols - 2, 0)).join('');
            this.text(bar.left, bar.top, shown, pane.active ? theme.FG : theme.COMMENT);
        }
        if (area.right < this.st.metrics.width) {
            const x = Math.round(area.right + cw / 2);
            this.rect(rect(x, area.top, x + 1, bar ? bar.bottom : area.bottom), theme.POPUP_BORDER);
        }
    }

    /** The sound player: the file, a play button, the scrubber with times,
     * the volume, and a reminder of the keys. */
    private paintAudio(area: Rect, file: string, info: AudioInfo): void {
        const { charW: cw, lineH: lh } = this.layout;
        const c = audioControls(area, cw, lh);
        const p = this.st.player;
        const here = p.file === file;
        const time = here ? p.time : 0;
        const duration = here ? p.duration : 0;
        const playing = here && p.playing;
        this.rect(c.panel, theme.POPUP_BG, 6);
        this.cmds.push(['stroke', c.panel.left, c.panel.top, c.panel.right - c.panel.left, c.panel.bottom - c.panel.top, theme.POPUP_BORDER]);
        const x = c.panel.left + 2 * cw;
        const icon = this.st.icons ? icons.forFile(path.basename(file)) : undefined;
        if (icon) this.text(x, c.title, icon.glyph, rgb(icon.color));
        this.text(x + (icon ? 2 * cw : 0), c.title, path.basename(file), theme.FG);
        const details = [info.format, formatBytes(info.bytes), duration > 0 ? formatTime(duration) : ''].filter((s) => s !== '');
        this.text(x, c.title + lh, details.join(' · '), theme.COMMENT);

        // Play/pause: a round button with a triangle or two bars.
        const b = c.play;
        const size = b.right - b.left;
        this.rect(b, theme.MODE_NORMAL, size / 2);
        const cx = (b.left + b.right) / 2;
        const cy = (b.top + b.bottom) / 2;
        const s = size * 0.22;
        if (playing) {
            this.rect(rect(cx - s, cy - s, cx - s / 3, cy + s), theme.BG);
            this.rect(rect(cx + s / 3, cy - s, cx + s, cy + s), theme.BG);
        } else {
            this.cmds.push(['poly', [cx - s * 0.7, cy - s * 1.1, cx + s * 1.1, cy, cx - s * 0.7, cy + s * 1.1], theme.BG]);
        }

        // The scrubber, with the time on either side.
        const r = c.scrubber;
        const mid = (r.top + r.bottom) / 2;
        const done = duration > 0 ? Math.min(time / duration, 1) : 0;
        this.textRight(r.left - cw, r.top, formatTime(time), theme.FG);
        this.text(r.right + cw, r.top, duration > 0 ? formatTime(duration) : '-:--', theme.COMMENT);
        this.rect(rect(r.left, mid - 2, r.right, mid + 2), theme.TILDE, 2);
        const knob = r.left + (r.right - r.left) * done;
        this.rect(rect(r.left, mid - 2, knob, mid + 2), theme.FUNCTION, 2);
        this.rect(rect(knob - 6, mid - 6, knob + 6, mid + 6), theme.FG, 6);

        // Volume: a speaker, the level and a bar.
        const m = c.mute;
        const my = (m.top + m.bottom) / 2;
        const u = (m.bottom - m.top) / 6;
        this.cmds.push(['poly', [m.left, my - u, m.left + 2 * u, my - u, m.left + 4 * u, my - 3 * u, m.left + 4 * u, my + 3 * u, m.left + 2 * u, my + u, m.left, my + u], p.volume > 0 ? theme.FG : theme.COMMENT]);
        if (p.volume === 0) this.text(m.left + 4.5 * u, m.top, '×', theme.ERROR);
        const v = c.volume;
        const vmid = (v.top + v.bottom) / 2;
        this.rect(rect(v.left, vmid - 2, v.right, vmid + 2), theme.TILDE, 2);
        this.rect(rect(v.left, vmid - 2, v.left + (v.right - v.left) * p.volume, vmid + 2), theme.STRING, 2);
        this.text(v.right + cw, v.top, `${Math.round(p.volume * 100)}%`, theme.COMMENT);

        const error = here ? p.error : undefined;
        const hint = 'Space play/pause   ←/→ seek   ↑/↓ volume   m mute';
        this.text(x, c.hint, error ?? hint, error ? theme.ERROR : theme.COMMENT);
    }

    /** An image file, as zoomed and moved (at first shrunk to fit if it is
     * larger than the window). */
    private paintImage(pane: Rect, file: string, image: ImageInfo, p: Placement | undefined): void {
        const { charW: cw, lineH: lh } = this.layout;
        const area = imageArea(pane, lh);
        const src = imageUrl(file, image);
        if (!p) {
            // Its size is unknown: the window fits it.
            this.cmds.push(['image', area.left, area.top, area.right - area.left, area.bottom - area.top, src, true]);
            return;
        }
        this.cmds.push(['image', area.left + p.x, area.top + p.y, p.width, p.height, src]);
        for (const [b, action, label] of imageButtons(pane, lh)) {
            // Pressed: lit up, and the label nudged down.
            const pressed = this.st.pressedButton === action;
            this.rect(b, pressed ? theme.POPUP_SELECTION : theme.POPUP_BG, 3);
            this.cmds.push(['stroke', b.left, b.top, b.right - b.left, b.bottom - b.top, pressed ? theme.CURSOR : theme.POPUP_BORDER]);
            const nudge = pressed ? 1 : 0;
            this.text(b.left + (b.right - b.left - cw) / 2, b.top + nudge + (b.bottom - b.top - lh) / 2, label, theme.FG);
        }
    }

    /** The buffer's lines, with the gutter, selection, search matches and
     * diagnostics. */
    private paintText(v: TextView): void {
        const { ed, layout } = this;
        const buf = v.buffer;
        const opts = ed.options;
        const cursor = v.cursor;
        const selection = v.selection;
        const searchRe = ed.highlightRegex();
        const lang = highlight.detect(v.filePath);
        const gutterCols = v.gutterCols;
        const cw = layout.charW;
        const lh = layout.lineH;
        const left = v.scrollLeft;
        const colX = (dcol: number): number => v.textLeft + Math.max(dcol - left, 0) * cw;
        const ts = ed.options.tabstop;
        const displayCol = (line: number, col: number): number => displayColIn(buf, ts, line, col);
        const flash = v.flash;
        let flashColor: string | undefined;
        if (flash) {
            const fade = 1 - (Date.now() - flash.start) / FLASH_DURATION;
            const [r, g, b] = theme.FLASH;
            flashColor = `rgba(${r},${g},${b},${((Math.min(Math.max(fade, 0), 1) * 120) / 255).toFixed(3)})`;
        }
        // Fill the display columns of `line` covered by a region.
        const fillRegion = (line: number, y: number, start: Pos, end: Pos, linewise: boolean, color: string): void => {
            if (line < start.line || line > end.line) return;
            const lineEnd = displayCol(line, buf.lineLen(line)) + 1;
            let from = 0;
            let to = lineEnd;
            if (!linewise) {
                from = line === start.line ? displayCol(line, start.col) : 0;
                to = line === end.line ? displayCol(line, end.col) : lineEnd;
            }
            from = Math.max(from, left);
            if (to > from) this.rect(rect(colX(from), y, colX(to), y + lh), color);
        };

        // Diagnostics by line, most severe first.
        const lineDiagnostics = new Map<number, BufferDiagnostic[]>();
        for (const d of v.diagnostics) {
            for (let l = Math.max(d.start.line, v.scrollTop); l <= Math.min(d.end.line, v.scrollTop + v.rows); l++) {
                const list = lineDiagnostics.get(l) ?? [];
                list.push(d);
                lineDiagnostics.set(l, list);
            }
        }
        for (const list of lineDiagnostics.values()) list.sort((a, b) => a.severity - b.severity);
        const signCols = v.signCols;
        const area = v.area;
        const numbersLeft = area.left + signCols * cw;

        this.clip(area);
        for (let row = 0; row < v.rows; row++) {
            const line = v.scrollTop + row;
            const y = area.top + row * lh;
            if (line > buf.lastLine()) {
                this.text(area.left + TEXT_PADDING, y, '~', theme.TILDE);
                continue;
            }
            if (line === cursor.line && !selection) {
                this.rect(rect(area.left, y, area.right, y + lh), theme.CURSOR_LINE);
            }

            // Line number gutter: relative numbers, with the absolute number
            // on the cursor line (Vim's `number` + `relativenumber`).
            // A sign for the line's most severe diagnostic, which also colors
            // its number.
            const diags = lineDiagnostics.get(line) ?? [];
            const starting = diags.find((d) => d.start.line === line);
            if (starting && signCols > 0) {
                const sign = (this.st.icons ? SIGNS : PLAIN_SIGNS)[starting.severity] ?? '';
                this.text(area.left + TEXT_PADDING / 2, y, sign, severityColor(starting.severity));
            }
            if (gutterCols > signCols) {
                const current = line === cursor.line;
                const label = opts.relativenumber && !current ? String(Math.abs(line - cursor.line)) : String(line + 1);
                let color: string = current ? theme.GUTTER_CURRENT : theme.GUTTER;
                if (starting) color = severityColor(starting.severity);
                if (opts.relativenumber && opts.number && current) {
                    this.text(numbersLeft + 2, y, label, color);
                } else {
                    this.textRight(area.left + (gutterCols - 1) * cw, y, label, color);
                }
            }

            if (selection) {
                const end = pos(selection.end.line, selection.end.col + 1);
                fillRegion(line, y, selection.start, end, selection.linewise, theme.SELECTION);
            }

            for (const [start, end] of v.references) fillRegion(line, y, start, end, false, theme.REFERENCE);

            const chars = buf.line(line);
            if (searchRe) {
                for (const [s, e] of lineMatches(searchRe, chars)) {
                    const ds = displayCol(line, s);
                    const de = displayCol(line, e);
                    if (de > ds && de >= left) this.rect(rect(colX(Math.max(ds, left)), y, colX(de), y + lh), theme.SEARCH, 2);
                }
            }

            if (flash && flashColor) fillRegion(line, y, flash.range.start, flash.range.end, flash.range.linewise, flashColor);

            let spans: highlight.Span[] = [];
            if (lang) {
                const state = this.st.highlightCache(v.bufferId).stateAt(lang, v.bufferId, buf.version(), line, (i) => buf.line(i));
                spans = highlight.highlightLine(lang, chars, state)[0];
            }
            const semantic = v.semantic(line, chars);
            if (semantic) spans = highlight.overlaySpans(spans, semantic, chars.length);
            this.lineText(v, chars, spans, y);
            this.lineDiagnostics(v, line, y, diags);
        }
        this.cmds.push(['unclip']);
    }

    /** Underline a line's diagnostics and show the most severe message after
     * its end (Neovim's `underline` and `virtual_text`). */
    private lineDiagnostics(v: TextView, line: number, y: number, diags: readonly BufferDiagnostic[]): void {
        if (diags.length === 0) return;
        const { ed, layout } = this;
        const cw = layout.charW;
        const left = v.scrollLeft;
        const displayCol = (l: number, col: number): number => displayColIn(v.buffer, ed.options.tabstop, l, col);
        const lineEnd = displayCol(line, v.buffer.lineLen(line));
        const x = (dcol: number): number => v.textLeft + (dcol - left) * cw;
        for (const d of [...diags].reverse()) {
            let from = d.start.line === line ? displayCol(line, d.start.col) : 0;
            let to = d.end.line === line ? displayCol(line, d.end.col) : lineEnd;
            // An empty range marks the character there.
            if (to <= from) to = from + 1;
            from = Math.max(from, left);
            if (to > from) this.rect(rect(x(from), y + layout.lineH - 2, x(to), y + layout.lineH - 1), severityColor(d.severity));
        }
        const first = diags.find((d) => d.start.line === line);
        const at = lineEnd + 4;
        if (first && at >= left) this.text(x(at), y, `■ ${first.message.split('\n')[0]}`, severityColor(first.severity));
    }

    /** The completion menu, a float and a picker, over everything else. */
    private paintPopups(): void {
        const { ed, layout } = this;
        const overlay = new Overlay(this.cmds, layout.charW, layout.lineH);
        const area = layout.textArea;
        const screen = (p: Pos): [number, number] => [
            layout.textLeft + (ed.displayCol(p.line, p.col) - ed.scrollLeft) * layout.charW,
            area.top + (p.line - ed.scrollTop) * layout.lineH,
        ];
        const menu = this.st.completion;
        const anchor = menu?.anchor();
        const menuBox = menu && anchor ? overlay.completion(menu, area, ...screen(anchor), this.st.icons) : undefined;
        const f = this.st.float;
        if (f) overlay.float(f, area, ...screen(f.anchor));
        const sig = this.st.signature;
        if (sig) overlay.float(sig, area, ...screen(sig.anchor), menuBox);
        const picker = this.st.picker;
        if (picker) overlay.picker(picker, rect(0, 0, this.st.metrics.width, layout.status.top), this.st.previewLines);
    }

    /** Draw the visible part of a line in its colors, expanding tabs. */
    private lineText(v: TextView, chars: readonly string[], spans: highlight.Span[], y: number): void {
        const { ed, layout } = this;
        const ts = Math.max(ed.options.tabstop, 1);
        const left = v.scrollLeft;
        const right = left + v.cols + 1;
        let run = '';
        let runColor: string = theme.FG;
        let runItalic = false;
        let runStart = left;
        let span = 0;
        let dcol = 0;
        const flush = (): void => {
            this.text(v.textLeft + (runStart - left) * layout.charW, y, run, runColor, runItalic);
            run = '';
        };
        for (let i = 0; i < chars.length && dcol < right; i++) {
            const c = chars[i];
            while (span < spans.length && spans[span][1] <= i) span++;
            const token = span < spans.length && spans[span][0] <= i ? spans[span][2] : 'Normal';
            const color = tokenColor(token);
            const italic = token === 'Comment' && theme.ITALIC_COMMENTS;
            const cells = c === '\t' ? ts - (dcol % ts) : 1;
            for (let k = 0; k < cells; k++) {
                const d = dcol + k;
                if (d < left || d >= right) continue;
                if (color !== runColor || italic !== runItalic || run === '') {
                    if (run !== '') flush();
                    runColor = color;
                    runItalic = italic;
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

        const cursor = ed.cursor;
        const lines = ed.buffer.lineCount();
        let position: string;
        if (lines <= layout.rows) position = 'All';
        else if (ed.scrollTop === 0) position = 'Top';
        else if (ed.scrollTop + layout.rows >= lines) position = 'Bot';
        else position = `${Math.floor((ed.scrollTop * 100) / (lines - layout.rows))}%`;
        const image = ed.image;
        const zoom = this.st.imageView ? `  ${Math.round(this.st.imageView.scale * 100)}%` : '';
        const audio = ed.audio;
        const filetype = image
            ? `${image.format}${image.width > 0 ? ` ${image.width}×${image.height}` : ''}  ${formatBytes(image.bytes)}${zoom}`
            : audio
              ? `${audio.format}  ${formatBytes(audio.bytes)}`
              : (highlight.detect(ed.filePath)?.name ?? '');
        const pending = this.st.mapPending.map(keyToString).join('') + ed.pendingKeys();
        // An image or sound has no cursor or lines to place.
        const where = image || audio ? '' : `   ${cursor.line + 1}:${ed.displayCol(cursor.line, cursor.col) + 1}   ${position}`;
        const right = `${pending}   ${filetype}${where} `;
        this.textRight(r.right - cw, r.top, right, theme.FG);

        // Between the two, the file name and (to the right) language server
        // progress or diagnostic counts. When short of room, the progress is
        // cut, then left out, while the name keeps at least MIN_NAME columns;
        // after that the name loses its start.
        const width = (s: string): number => Array.from(s).length;
        const room = Math.floor((r.right - r.left) / cw) - label.length - width(right) - 1;
        const name = ` ${ed.fileName()}${ed.isModified() ? ' [+]' : ''}`;
        let spare = room - Math.min(width(name), MIN_NAME);
        const parts: [string, string][] = [];
        // A sound playing from another buffer.
        const player = this.st.player;
        if (player.playing && player.file !== undefined && player.file !== ed.filePath) {
            const playing = `♪ ${path.basename(player.file)} ${formatTime(player.time)}`;
            if (spare >= width(playing) + 2) {
                parts.push([playing, theme.STRING]);
                spare -= width(playing) + 2;
            }
        }
        const progress = this.st.lspProgress;
        if (progress) {
            const most = Math.min(50, spare - 2);
            if (most >= 10) parts.push([width(progress) > most ? Array.from(progress).slice(0, most - 1).join('') + '…' : progress, theme.COMMENT]);
        } else {
            this.st.diagnosticCounts.forEach((n, severity) => {
                const text = `${(this.st.icons ? SIGNS : PLAIN_SIGNS)[severity]} ${n}`;
                if (n > 0 && spare >= width(text) + 2) {
                    parts.push([text, severityColor(severity)]);
                    spare -= width(text) + 2;
                }
            });
        }
        let x = r.right - cw - width(right) * cw;
        for (const [text, color] of parts.reverse()) {
            // Two spaces before each, after the name or the part before.
            x -= (width(text) + 2) * cw;
            this.text(x + 2 * cw, r.top, text, color);
        }
        // Each part's width includes its two spaces of gap.
        const nameCols = Math.floor((x - pillRight) / cw);
        const shown = width(name) <= nameCols ? name : ' …' + Array.from(name).slice(-Math.max(nameCols - 2, 0)).join('');
        if (nameCols > 2) this.text(pillRight, r.top, shown, theme.FG);
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
