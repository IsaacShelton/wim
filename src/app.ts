// The window's logic: translates window input into editor keys and paints the
// editor state (file tree, buffer tabs, text, gutter, selection, cursor,
// status and command lines) as a list of drawing commands for the window.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import { AgentBackend, SdkBackend } from './agent/backend';
import { AgentPanel, PanelAction } from './agent/panel';
import { Config, defaultConfig } from './config';
import { AudioInfo, AudioPlayer, SEEK_STEP, VOLUME_STEP, formatTime } from './audio';
import { Clipboard, SystemClipboard } from './clipboard';
import { bufferState, bufferStates, findBuffer, reloadFromDisk, switchToBufferQuietly } from './editor/buffers';
import { Buffer, Pos, isWhitespace, pos, posCmp } from './editor/buffer';
import { awaitingMotion } from './editor/command';
import { Editor, Selection } from './editor/editor';
import { fail } from './editor/errors';
import { KeyInput, ch, charOf, ctrl, isNamedKey, keyEq, keyIs, keyNew, keyToString, parseKeys, plain } from './editor/keys';
import { isCmdLine } from './editor/mode';
import { Range } from './editor/range';
import { lineMatches } from './editor/search';
import { FileTree, GitStatus } from './filetree';
import { Glide } from './glide';
import { GitDiff, LineChange } from './gitdiff';
import { GrepMatch, Search, findFiles, liveGrep } from './finder';
import { ImageInfo, formatBytes, imageUrl, isImage, readImageInfo } from './image';
import { ImageView, Placement, Size } from './imageview';
import * as highlight from './highlight';
import * as icons from './icons';
import { Command, Keymap, LspAction, MapMode, Rhs, TIMEOUT } from './keymap';
import { Link, anchorLine, linkAt, parseHref, resolveLink, vaultFiles } from './links';
import { MarkdownView, MdRow, Media, MediaHost, diagramTheme, isMarkdown } from './markdown';
import { Completion } from './lsp/completion';
import { LspFeatures, severityColor } from './lsp/features';
import { BufferDiagnostic, LspManager } from './lsp/manager';
import { ServerSpec, defaultServers } from './lsp/servers';
import { SignatureHelp } from './lsp/signature';
import { absolute, baseName, currentDir, displayName, expandTilde } from './paths';
import { Float, Overlay, Picker, PickerItem, PreviewSource, readPreview } from './popup';
import { AudioCommand, ClientMessage, DrawCmd, TextStyle } from './protocol';
import { TerminalAction, TerminalPane, createTerminal } from './terminal';
import { isThemeName, setTheme, theme, themeName, tokenColor, tokenStyle } from './theme';
import { openDefaultBrowser } from './window';
import { Direction, SplitDir, Win, WinRect, Windows } from './windows';

const TEXT_PADDING = 6;
/** Width of the file tree, in characters. */
const SIDEBAR_COLS = 30;
/** The Claude Code panel takes this share of the window, between these
 * widths in characters (and at most AGENTS_MAX_SHARE of the window). */
const AGENTS_SHARE = 0.5;
const AGENTS_MIN_COLS = 60;
const AGENTS_MAX_COLS = 140;
const AGENTS_MAX_SHARE = 0.7;
/** The terminal's share of the editor's height, and its fewest rows. */
const TERMINAL_SHARE = 0.3;
const TERMINAL_MIN_ROWS = 6;
const FLASH_DURATION = 300;
/** How far the mouse must move before a press becomes a drag, in pixels. */
const DRAG_THRESHOLD = 4;
/** Time between frames of an animation, in ms. */
/** While something glides, the window asks for each frame as the display
 * is ready for it; failing that (hidden, say), they come this often. */
const FALLBACK_FRAME = 50;
/** How quickly the caret and the text glide (with `editor.smoothCaret` and
 * `editor.smoothScroll`): each closes most of the way in about three times
 * this, in ms. */
const CARET_GLIDE = 20;
const SCROLL_GLIDE = 40;
/** How long a clicked button looks pressed, in ms. */
const BUTTON_PRESS = 150;
/** Width of the sign column for diagnostics, in characters (shown for files
 * a language server handles, like Neovim's `signcolumn=yes`). */
const SIGN_COLS = 2;
/** Width of the git change marks at the left of the gutter, in pixels. */
const GIT_MARK_WIDTH = 2;
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
    /** The Claude Code panel, on the right. */
    agents?: Rect;
    /** The integrated terminal, under the windows. */
    terminal?: Rect;
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

type Focus = 'Editor' | 'Tree' | 'Agents' | 'Terminal';

/** Where the active window's view and caret are shown: the top line (or
 * row, in a rendered Markdown view), and the caret's line and display
 * column. Fractional while they glide. */
interface Shown {
    top: number;
    line: number;
    col: number;
}

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
    /** How the Claude Code panel reaches Claude Code (by default, the Claude
     * Agent SDK). */
    agents?: AgentBackend;
    /** Wim's settings (by default, the built-in ones). */
    config?: Config;
    /** Problems found in the settings file, shown at startup. */
    configWarnings?: string[];
    /** Called whenever the window should be repainted. */
    onFrame: (title: string, dirty: boolean, cmds: DrawCmd[], animating: boolean) => void;
    /** Called to control the window's sound player. */
    onAudio?: (cmd: AudioCommand) => void;
    /** Called once when Wim should exit. */
    onQuit: () => void;
    /** Opens a web link from a Markdown file (by default, in the default
     * browser). */
    openUrl?: (url: string) => void;
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
    /** Files may have changed since the tree last asked git for their
     * status: written, changed by an agent, or by commands in the terminal. */
    private gitStale = false;
    /** Lines changed from git's copy of each file, for the gutter. */
    private readonly gitDiff = new GitDiff();
    /** Where the keys went in the last frame. */
    private lastFocus: Focus = 'Editor';
    private flash: Flash | undefined;
    private flashTimer: NodeJS.Timeout | undefined;
    /** Buffer tabs from the last frame, for mouse clicks. */
    private tabHits: [Rect, number][] = [];
    /** Highlighter states, by buffer. */
    private readonly highlightCaches = new Map<number, highlight.Cache>();
    private scrollRemainder = 0;
    private closeWarned = false;
    private metrics: Metrics = { width: 1000, height: 720, charW: 9, lineH: 23 };
    /** A press that may become a drag: in the text area, or on the sound
     * player's scrubber or volume bar (`control`). */
    private press: { x: number; y: number; dragging: boolean; control?: 'Scrub' | 'Volume'; agents?: true } | undefined;
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
    /** Watches the tree's root for files coming and going. */
    private treeWatcher: fs.FSWatcher | undefined;
    private treeWatchTimer: NodeJS.Timeout | undefined;
    private treeWatchRoot: string | undefined;
    /** The active window's view and caret on their way to where they are
     * (with smooth scrolling or caret), for that window and buffer. */
    private readonly topGlide = new Glide(SCROLL_GLIDE);
    private readonly lineGlide = new Glide(CARET_GLIDE);
    private readonly colGlide = new Glide(CARET_GLIDE);
    private glidesFor: { win: Win; bufferId: number; markdown: boolean } | undefined;
    /** Draws the next frame while something glides, if the window doesn't
     * ask for it first. */
    private frameTimer: NodeJS.Timeout | undefined;
    /** An image zoom button just clicked, drawn pressed for a moment. */
    private pressedButton: ImageAction | undefined;
    private pressedTimer: NodeJS.Timeout | undefined;
    /** How each image buffer is zoomed, by buffer id. */
    private readonly imageViews = new Map<number, { image: ImageInfo; view: ImageView }>();
    /** Markdown buffers shown rendered rather than as text, by buffer id. */
    private readonly markdownViews = new Map<number, MarkdownView>();
    /** A `g` typed in a rendered Markdown view, waiting for the second `g`. */
    private markdownG = false;
    /** How big the window drew each Mermaid diagram, by id, or why it
     * couldn't; `diagramVersion` counts the answers. */
    private readonly diagramSizes = new Map<string, { width: number; height: number } | { error: string }>();
    private diagramVersion = 0;
    /** Images that Markdown files show, by path, read again when they change. */
    private readonly imageInfos = new Map<string, ImageInfo | undefined>();
    /** The working directory's files, for finding a wikilink's note, kept
     * for a few seconds. */
    private vault: { root: string; files: string[]; at: number } | undefined;
    /** Claude Code sessions, in the panel on the right. */
    readonly agents: AgentPanel;
    private agentsVisible = false;
    readonly config: Config;
    /** The shell under the editor. */
    readonly terminal: TerminalPane;
    private terminalVisible = false;
    /** The status line's Claude badge in the last frame, for clicks. */
    private badgeHit: Rect | undefined;

    constructor(private readonly opts: AppOptions) {
        this.icons = opts.icons;
        this.config = opts.config ?? defaultConfig();
        setTheme(this.config.theme);
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
        const lspWrite = this.editor.onWrite;
        this.editor.onWrite = (p) => {
            lspWrite?.(p);
            this.gitChanged();
        };
        if (dirError !== undefined) this.editor.setError(dirError);
        const root = currentDir();
        this.tree = new FileTree(root);
        this.treeCwd = root;
        this.agents = new AgentPanel({
            backend: opts.agents ?? new SdkBackend(),
            clipboard: this.clipboard,
            cwd: currentDir,
            refresh,
            onFiles: (paths) => this.reloadChanged(paths),
            presets: this.config.claude.presets,
            defaultPreset: this.config.claude.defaultPreset,
            cacheMinutes: this.config.claude.cacheMinutes,
            smoothScroll: () => this.config.editor.smoothScroll,
        });
        this.terminal = createTerminal({ shell: this.config.terminal.shell, cwd: currentDir, refresh });
        if (opts.configWarnings?.length) this.editor.setError(opts.configWarnings.join('; '));
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
                // The terminal gets keys as typed (Ctrl+c isn't Esc there).
                if (key) this.key(key, msg.ctrl ? { key: msg.key, ctrl: true, alt: false } : key);
                break;
            }
            case 'command':
                this.command(msg.name);
                break;
            case 'mouse':
                this.mouse(layout, msg.kind, msg.x, msg.y, msg.mod ?? false);
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
            case 'diagram':
                this.diagramSizes.set(msg.id, msg.error !== undefined ? { error: msg.error } : { width: msg.width, height: msg.height });
                this.diagramVersion++;
                break;
            case 'tick':
                // The window is ready for the next frame of a glide, drawn
                // below.
                break;
            case 'drop':
                // Images dropped on the agents panel go with the next message.
                if (layout.agents && contains(layout.agents, msg.x, msg.y)) {
                    this.editorToNormal();
                    this.focus = 'Agents';
                    this.agents.drop(msg.name, msg.data, msg.error);
                } else {
                    this.editor.setError('Drop images on the agents panel (Cmd+L) to attach them');
                }
                break;
        }
        this.render();
    }

    private command(name: 'save' | 'copy' | 'cut' | 'paste' | 'agents' | 'terminal'): void {
        this.closeWarned = false;
        switch (name) {
            case 'agents':
                this.picker?.dispose();
                this.picker = undefined;
                this.toggleAgents();
                break;
            case 'terminal':
                this.picker?.dispose();
                this.picker = undefined;
                this.toggleTerminal();
                break;
            case 'save':
                this.editor.handleKeys(parseKeys('<Esc>:w<CR>'));
                break;
            case 'copy':
            case 'cut':
                if (this.focus === 'Agents') {
                    this.agents.copySelection();
                    break;
                }
                this.editor.copySelection(name === 'cut');
                break;
            case 'paste':
                if (this.picker) {
                    const text = this.clipboard.getText();
                    if (text !== undefined) this.picker.paste(text);
                } else if (this.focus === 'Agents') {
                    const text = this.clipboard.getText();
                    if (text !== undefined) this.agents.paste(text);
                } else if (this.focus === 'Terminal') {
                    const text = this.clipboard.getText();
                    if (text !== undefined) this.terminal.paste(text);
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
        } else if (layout.agents && contains(layout.agents, msg.x, msg.y)) {
            this.agents.wheel(whole);
        } else if (layout.terminal && contains(layout.terminal, msg.x, msg.y)) {
            this.terminal.scrollBy(-whole);
        } else if (under && under.win !== this.windows.active) {
            this.scrollWindow(under, whole);
        } else if (this.markdownView()) {
            const view = this.markdownView()!;
            const { rows, height } = this.markdownRows(view, layout);
            view.scrollBy(rows, height, whole);
        } else {
            this.editor.scrollBy(whole);
        }
    }

    private key(key: KeyInput, raw = key): void {
        this.closeWarned = false;
        // Ctrl+` toggles the terminal from anywhere, even where other keys go elsewhere.
        if (keyEq(key, ctrl('`'))) {
            this.toggleTerminal();
            return;
        }
        // A question on the command line (from the editor or the tree) is
        // answered by the next key.
        if (this.editor.question && this.editor.answer(key)) {
            this.mapPending = [];
            return;
        }
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
        // The panel has its own keys; mappings don't apply in it.
        if (this.focus === 'Agents') {
            this.mapPending = [];
            this.agentAction(this.agents.key(key));
            return;
        }
        if (this.focus === 'Terminal') {
            this.mapPending = [];
            this.terminalAction(this.terminal.key(raw));
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
        if (this.windowCmdPending || this.markdownG) return undefined;
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
            // A rendered Markdown view can't be edited; `:` commands still work.
            if (this.markdownView() && !(rhs.keys.length > 0 && keyIs(rhs.keys[0], ':'))) return;
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
            case 'ToggleAgents':
                this.toggleAgents();
                break;
            case 'ToggleTerminal':
                this.toggleTerminal();
                break;
            case 'ToggleTheme':
                setTheme(themeName() === 'nord' ? 'onedark' : 'nord');
                this.editor.setMessage(`colorscheme ${themeName()}`);
                break;
            case 'ToggleMarkdownView':
                this.toggleMarkdown();
                break;
            case 'FollowLink':
                if (!this.followLinkAtCursor()) this.gotoFileAtCursor();
                break;
            case 'EnterOrFollowLink':
                if (!this.followLinkAtCursor()) this.dispatch(plain('Enter'));
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
            case 'Terminal':
                this.toggleTerminal();
                return;
            case 'MarkdownPreview':
                this.toggleMarkdown();
                return;
            case 'Agents':
                // `:Agents` shows the panel; `:Agents message` also sends it.
                this.showAgents();
                if (args !== '') this.agents.session?.send(args);
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

    /** Refresh the tree when files or folders under `root` change on disk
     * (made by a shell, an agent, git...). Changes come in bursts, so the
     * tree is read again once they settle. */
    private watchTree(root: string): void {
        if (root === this.treeWatchRoot) return;
        this.treeWatcher?.close();
        this.treeWatcher = undefined;
        this.treeWatchRoot = root;
        try {
            this.treeWatcher = fs.watch(root, { recursive: true, persistent: false }, (_event, name) => {
                if (name && /(^|[\\/])(\.git|node_modules)([\\/]|$)/.test(String(name))) return;
                if (this.treeWatchTimer) clearTimeout(this.treeWatchTimer);
                this.treeWatchTimer = setTimeout(() => {
                    this.treeWatchTimer = undefined;
                    if (!this.treeVisible) return;
                    this.tree.refresh();
                    this.refresh();
                }, 200);
            });
            this.treeWatcher.on('error', () => {
                this.treeWatcher?.close();
                this.treeWatcher = undefined;
            });
        } catch {
            // Watching isn't supported here: `R` and focusing still refresh.
        }
    }

    /** Stop the language servers (Wim is exiting). */
    dispose(): void {
        this.treeWatcher?.close();
        if (this.treeWatchTimer) clearTimeout(this.treeWatchTimer);
        if (this.frameTimer) clearTimeout(this.frameTimer);
        if (this.pressedTimer) clearTimeout(this.pressedTimer);
        this.completion.close();
        this.signature.close();
        this.features.dispose();
        this.lsp.dispose();
        this.agents.dispose();
        this.terminal.dispose();
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
            if (this.imageKey(key) || this.audioKey(key) || this.markdownKey(key)) return;
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
            case 'Delete': {
                const name = this.tree.relative(action.path);
                this.editor.ask(`Delete ${action.isDir ? `"${name}" and everything in it` : `"${name}"`}?`, () => {
                    try {
                        this.tree.remove(action.path);
                        this.editor.setMessage(`Deleted "${name}"`);
                    } catch (e) {
                        this.editor.setError(`Can't delete ${name}: ${(e as Error).message}`);
                    }
                });
                break;
            }
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

    /** The active buffer's rendered view, when it's shown. */
    private markdownView(): MarkdownView | undefined {
        return this.markdownViews.get(this.editor.bufferId());
    }

    /** The active buffer's rendered rows and how many fit its window. */
    private markdownRows(view: MarkdownView, layout = this.layout()): { rows: MdRow[]; height: number } {
        const area = layout.textArea;
        return {
            rows: view.rows(this.editor.buffer, markdownCols(area, layout.charW), this.mediaHost(this.editor.filePath, area)),
            height: Math.max(Math.floor((area.bottom - area.top) / layout.lineH), 1),
        };
    }

    /** What a rendered view of `file` in a window's `area` needs for its
     * images and diagrams. */
    private mediaHost(file: string | undefined, area: Rect): MediaHost {
        const { charW, lineH } = this.metrics;
        const maxHeight = Math.max(area.bottom - area.top - 2 * lineH, lineH);
        return {
            key: `${charW}:${lineH}:${maxHeight}:${this.diagramVersion}`,
            charW,
            lineH,
            maxHeight,
            image: (href) => {
                const link = parseHref(href);
                if (link?.t !== 'File' || link.path === '') return undefined;
                const target = resolveLink(link.path, file, currentDir(), () => this.vaultFiles());
                if (!target.exists || !isImage(target.file)) return undefined;
                const info = this.imageInfo(target.file);
                return info ? { file: target.file, src: imageUrl(target.file, info), width: info.width, height: info.height } : undefined;
            },
            diagram: (id) => this.diagramSizes.get(id),
        };
    }

    /** An image's format and size, if it can be shown; read again when the
     * file changes. */
    private imageInfo(file: string): ImageInfo | undefined {
        let mtime: number;
        try {
            mtime = fs.statSync(file).mtimeMs;
        } catch {
            return undefined;
        }
        const known = this.imageInfos.get(file);
        if (known && known.mtime === mtime) return known;
        let info: ImageInfo | undefined;
        try {
            info = readImageInfo(file);
        } catch {
            info = undefined;
        }
        if (info && (info.width === 0 || info.height === 0)) info = undefined;
        this.imageInfos.set(file, info);
        return info;
    }

    private vaultFiles(): string[] {
        const root = currentDir();
        const now = Date.now();
        if (!this.vault || this.vault.root !== root || now - this.vault.at > VAULT_TTL) {
            this.vault = { root, files: vaultFiles(root), at: now };
        }
        return this.vault.files;
    }

    /** `gf` and Enter in a Markdown file: follow the link under the cursor.
     * Returns whether there was one. */
    private followLinkAtCursor(): boolean {
        const ed = this.editor;
        if (this.markdownView() || !isMarkdown(ed.filePath)) return false;
        const link = linkAt(ed.buffer.line(ed.cursor.line), ed.cursor.col);
        if (!link) return false;
        this.followLink(link, false);
        return true;
    }

    /** `gf` elsewhere, as in Vim: open the file whose name is under the
     * cursor, beside this file or in the working directory. */
    private gotoFileAtCursor(): void {
        const ed = this.editor;
        if (this.markdownView()) return;
        const line = ed.buffer.line(ed.cursor.line);
        const isName = (c: string | undefined): boolean => c !== undefined && /[^\s"'`<>()[\]{},;|*?]/.test(c);
        let start = ed.cursor.col;
        let end = ed.cursor.col;
        while (start > 0 && isName(line[start - 1])) start--;
        while (isName(line[end])) end++;
        const name = expandTilde(line.slice(start, end).join('').replace(/:\d+(:\d+)?$/, ''));
        if (name === '') {
            ed.setError('E446: No file name under cursor');
            return;
        }
        const dirs = ed.filePath === undefined ? [currentDir()] : [path.dirname(ed.filePath), currentDir()];
        const file = dirs.map((d) => path.resolve(d, name)).find((f) => fs.existsSync(f) && !isDirectory(f));
        if (file === undefined) {
            ed.setError(`E447: Can't find file "${name}" in path`);
            return;
        }
        this.openAt(file);
    }

    /** Go where a link from the active buffer leads, as Obsidian does: a URL
     * opens in the browser, a note opens (made if it doesn't exist yet, when
     * written), and a heading or block in it is shown. From a rendered view,
     * a Markdown file opens rendered too. `<C-o>` comes back. */
    private followLink(link: Link, rendered: boolean): void {
        const ed = this.editor;
        if (link.t === 'Url') {
            if (!/^(https?|mailto):/i.test(link.url)) {
                ed.setError(`Can't open ${link.url}`);
                return;
            }
            (this.opts.openUrl ?? openDefaultBrowser)(link.url);
            ed.setMessage(`Opening ${link.url}`);
            return;
        }
        let file = ed.filePath;
        let exists = true;
        if (link.path !== '') ({ file, exists } = resolveLink(link.path, ed.filePath, currentDir(), () => this.vaultFiles()));
        if (file === undefined) return;
        const from = this.markdownView();
        if (from) {
            // Coming back (`<C-o>`) returns to what was being read.
            const { rows } = this.markdownRows(from);
            ed.cursor = pos(Math.min(from.sourceAtTop(rows), ed.buffer.lastLine()), 0);
        }
        this.openAt(file);
        if (ed.filePath !== file) return;
        if (!exists) ed.setMessage(`"${displayName(file)}" [New]: written with :w`);
        const id = ed.bufferId();
        let view = this.markdownViews.get(id);
        if (!view && rendered && isMarkdown(file) && !ed.image && !ed.audio) {
            view = new MarkdownView();
            this.markdownViews.set(id, view);
            this.markdownG = false;
        }
        let line: number | undefined;
        if (link.anchor !== undefined) {
            const lines = Array.from({ length: ed.buffer.lineCount() }, (_, i) => ed.buffer.lineString(i));
            line = anchorLine(lines, link.anchor);
            if (line === undefined) {
                ed.setError(`No heading or block "${link.anchor}" in ${displayName(file)}`);
            } else {
                ed.cursor = pos(line, 0);
                ed.clampCursor();
                ed.updateWantCol();
                ed.scrollTop = Math.max(line - ed.options.scrolloff, 0);
            }
        }
        if (view && (line !== undefined || !exists || view === from)) {
            const { rows, height } = this.markdownRows(view);
            view.showSource(rows, height, line ?? 0);
        }
    }

    /** A click in a rendered Markdown view: on a link, follow it; on an
     * image, open it. */
    private markdownClick(layout: Layout, view: MarkdownView, x: number, y: number): void {
        const area = layout.textArea;
        const { rows } = this.markdownRows(view, layout);
        const cols = markdownCols(area, layout.charW);
        const at = view.top + Math.floor((y - area.top) / layout.lineH);
        const row = rows[at];
        if (!row) return;
        const x0 = markdownLeft(area, cols, layout.charW) + (row.quote * 2 + row.indent) * layout.charW;
        if (row.kind === 'media') {
            let start = at;
            while (start > 0 && !rows[start].media) start--;
            const media = rows[start].media;
            if (media?.t === 'Image' && x >= x0 && x < x0 + media.width) this.openAt(media.file);
            return;
        }
        const col = Math.floor((x - x0) / layout.charW);
        const hit = row.links?.find((l) => l.from <= col && col < l.to);
        const link = hit && parseHref(hit.href);
        if (link) this.followLink(link, true);
    }

    /** `,m` and `:MarkdownPreview`: switch a Markdown buffer between editing
     * it and reading it rendered, staying at the same place in it. */
    private toggleMarkdown(): void {
        const ed = this.editor;
        const id = ed.bufferId();
        const shown = this.markdownViews.get(id);
        if (shown) {
            const { rows, height } = this.markdownRows(shown);
            this.markdownViews.delete(id);
            ed.scrollTop = Math.min(shown.sourceAtTop(rows), ed.buffer.lastLine());
            // The cursor stays if it's in view, `scrolloff` lines from the
            // edges; otherwise it goes to the top, so the text doesn't move.
            const so = ed.scrollTop > 0 ? Math.min(ed.options.scrolloff, Math.floor((height - 1) / 2)) : 0;
            const visible = ed.cursor.line >= ed.scrollTop + so && ed.cursor.line < ed.scrollTop + height - so;
            if (!visible) ed.cursor = pos(Math.min(ed.scrollTop + so, ed.buffer.lastLine()), 0);
            ed.clampCursor();
            return;
        }
        if (!isMarkdown(ed.filePath)) {
            ed.setError('Not a Markdown file');
            return;
        }
        this.editorToNormal();
        const view = new MarkdownView();
        const { rows, height } = this.markdownRows(view);
        view.showSource(rows, height, ed.scrollTop);
        this.markdownViews.set(id, view);
        this.markdownG = false;
    }

    /** Scrolling keys for a rendered Markdown view: `j`/`k` and the arrows by
     * a row, Ctrl+d/Ctrl+u by half a screen, Ctrl+f/Ctrl+b, Space and
     * PageDown/PageUp by a screen, `gg` and `G` to the ends. `:` goes to the
     * editor; other keys do nothing, as the view can't be edited. */
    private markdownKey(key: KeyInput): boolean {
        const view = this.markdownView();
        if (!view || this.editor.mode !== 'Normal' || this.editor.pending.length > 0) return false;
        if (keyIs(key, ':')) return false;
        const { rows, height } = this.markdownRows(view);
        const half = Math.max(Math.floor(height / 2), 1);
        const g = this.markdownG;
        this.markdownG = false;
        const k = key.key;
        if (key.ctrl && (k === 'o' || k === 'i')) {
            // The jump list, as after following a link; a jump within this
            // file shows where it goes.
            const id = this.editor.bufferId();
            this.editor.handleKey(key);
            if (this.editor.bufferId() === id) view.showSource(rows, height, this.editor.cursor.line);
            return true;
        }
        if (key.ctrl) {
            const by: Record<string, number> = { d: half, u: -half, f: height, b: -height, e: 1, y: -1 };
            if (k in by) view.scrollBy(rows, height, by[k]);
        } else if (k === 'j' || k === 'Down') view.scrollBy(rows, height, 1);
        else if (k === 'k' || k === 'Up') view.scrollBy(rows, height, -1);
        else if (k === ' ' || k === 'PageDown') view.scrollBy(rows, height, height);
        else if (k === 'PageUp') view.scrollBy(rows, height, -height);
        else if (k === 'G' || k === 'End') view.scrollBy(rows, height, rows.length);
        else if ((k === 'g' && g) || k === 'Home') view.top = 0;
        else if (k === 'g') this.markdownG = true;
        return true;
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

    /** Zoom in, out, or back to fitting the window, gliding there. */
    private imageAction(view: ImageView, action: ImageAction, layout = this.layout()): void {
        const size = rectSize(imageArea(layout.textArea, layout.lineH));
        if (action === 'In') view.zoom(1, size, undefined, true);
        else if (action === 'Out') view.zoom(-1, size, undefined, true);
        else view.reset(size, true);
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
        for (const id of this.markdownViews.keys()) if (!open.has(id)) this.markdownViews.delete(id);
        for (const id of this.highlightCaches.keys()) if (!open.has(id)) this.highlightCaches.delete(id);
    }

    /** Scroll an inactive window, keeping its cursor in view as Vim does. */
    private scrollWindow(rect: WinRect, lines: number): void {
        const win = rect.win;
        const st = bufferState(this.editor, win.bufferId);
        if (!st || st.image || st.audio) return;
        const rows = Math.max(Math.floor((rect.area.bottom - rect.area.top) / this.metrics.lineH), 1);
        const md = this.markdownViews.get(win.bufferId);
        if (md) {
            md.scrollBy(md.rows(st.buffer, markdownCols(rect.area, this.metrics.charW), this.mediaHost(st.filePath, rect.area)), rows, lines);
            return;
        }
        const last = st.buffer.lastLine();
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
        if (this.focus === 'Agents') {
            if (dir === 'Left') this.focus = this.terminalVisible ? 'Terminal' : 'Editor';
            return;
        }
        if (this.focus === 'Terminal') {
            if (dir === 'Up') this.focus = 'Editor';
            else if (dir === 'Left' && this.treeVisible) this.focus = 'Tree';
            else if (dir === 'Right' && this.agentsVisible) this.focus = 'Agents';
            return;
        }
        this.saveWindow();
        const next = this.windows.neighbor(this.layout().windows, this.windows.active, dir);
        if (next) {
            this.focusWindow(next);
        } else if (dir === 'Left' && this.treeVisible) {
            this.editorToNormal();
            this.focus = 'Tree';
        } else if (dir === 'Right' && this.agentsVisible) {
            this.editorToNormal();
            this.focus = 'Agents';
        } else if (dir === 'Down' && this.terminalVisible) {
            this.editorToNormal();
            this.focus = 'Terminal';
        }
    }

    /** `<C-w>w`/`W`: the next or previous window, with the tree (if shown)
     * before the first and the Claude panel (if shown) after the last. */
    private cycleFocus(delta: number): void {
        const wins = this.windows.list();
        const stops: (Win | 'Tree' | 'Agents' | 'Terminal')[] = [
            ...(this.treeVisible ? ['Tree' as const] : []),
            ...wins,
            ...(this.terminalVisible ? ['Terminal' as const] : []),
            ...(this.agentsVisible ? ['Agents' as const] : []),
        ];
        const at = this.focus === 'Editor' ? stops.indexOf(this.windows.active) : stops.indexOf(this.focus);
        const next = stops[(((at + delta) % stops.length) + stops.length) % stops.length];
        if (next === 'Tree' || next === 'Agents' || next === 'Terminal') {
            this.editorToNormal();
            this.focus = next;
        } else {
            this.focusWindow(next);
        }
    }

    /** Cmd+L, `,cc`: show the Claude panel and move to it; from the panel,
     * hide it. */
    private toggleAgents(): void {
        this.windowCmdPending = false;
        if (this.agentsVisible && this.focus === 'Agents') {
            this.agentsVisible = false;
            this.focus = 'Editor';
            return;
        }
        this.showAgents();
    }

    private showAgents(): void {
        if (!this.config.claude.enabled) {
            this.editor.setError('Claude Code is turned off: set claude.enabled to true in wim.config.json');
            return;
        }
        this.editorToNormal();
        this.agentsVisible = true;
        this.agents.open();
        this.focus = 'Agents';
    }

    /** Ctrl+`, `,tt`, `:Terminal`: show the terminal and move to it; from
     * the terminal, hide it. */
    private toggleTerminal(): void {
        this.windowCmdPending = false;
        if (this.terminalVisible && this.focus === 'Terminal') {
            this.terminalVisible = false;
            this.focus = 'Editor';
            return;
        }
        this.editorToNormal();
        this.terminalVisible = true;
        this.focus = 'Terminal';
    }

    private terminalAction(action: TerminalAction): void {
        switch (action.t) {
            case 'Move':
                this.moveFocus(action.dir);
                break;
            case 'Hide':
                this.terminalVisible = false;
                this.focus = 'Editor';
                break;
        }
    }

    private agentAction(action: PanelAction): void {
        switch (action.t) {
            case 'FocusEditor':
                this.focus = 'Editor';
                break;
            case 'Hide':
                this.agentsVisible = false;
                this.focus = 'Editor';
                break;
            case 'ToggleTree':
                this.toggleTree();
                break;
            case 'Cmdline':
                this.focus = 'Editor';
                this.editor.handleKey(ch(':'));
                break;
            case 'Picker':
                this.picker = action.picker;
                break;
        }
    }

    /** Claude changed files (`paths`, or perhaps any, after a command):
     * bring the buffers showing them up to date, as Vim's `autoread` does.
     * A buffer with unsaved changes is kept, with a warning when Claude
     * edited its file. */
    private reloadChanged(paths: string[] | undefined): void {
        const named = paths?.map((p) => absolute(p));
        const reloaded: string[] = [];
        for (const [id, st] of bufferStates(this.editor)) {
            const file = st.filePath;
            if (file === undefined || (named && !named.includes(file))) continue;
            const result = reloadFromDisk(this.editor, id);
            if (result === 'Reloaded') reloaded.push(displayName(file));
            else if (result === 'Modified' && named) {
                this.editor.setError(`W12: Warning: an agent changed "${displayName(file)}", and its buffer has unsaved changes too`);
            }
        }
        if (reloaded.length > 0) this.editor.setMessage(`Reloaded ${reloaded.join(', ')}, changed by an agent`);
        this.gitChanged();
        this.refresh();
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

    /** Files may have changed in git: written, changed by an agent, or by
     * commands in the terminal. */
    private gitChanged(): void {
        this.gitStale = true;
        this.gitDiff.invalidate();
    }

    /** Keep the tree rooted at the working directory and showing the current
     * file. */
    private syncTree(layout: Layout): void {
        // Leaving the terminal or the agents panel, files may have changed.
        if (this.focus !== this.lastFocus && (this.lastFocus === 'Terminal' || this.lastFocus === 'Agents')) this.gitChanged();
        this.lastFocus = this.focus;
        if (!this.treeVisible) return;
        const cwd = currentDir();
        if (cwd !== this.treeCwd) {
            this.tree.setRoot(cwd);
            this.treeCwd = cwd;
            this.revealed = undefined;
        } else if (this.gitStale) {
            this.tree.refreshGitStatus();
        }
        this.gitStale = false;
        this.watchTree(cwd);
        this.tree.setViewRows(layout.treeRows);
        const file = this.editor.filePath;
        if (file !== undefined && file !== this.revealed) {
            this.tree.reveal(file);
            this.revealed = file;
        }
    }

    private mouse(layout: Layout, kind: 'down' | 'move' | 'up', x: number, y: number, mod = false): void {
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
            if (this.press?.agents) this.agents.endSelect();
            this.press = undefined;
            return;
        }
        if (kind === 'move') {
            const p = this.press;
            if (!p) return;
            if (p.agents) {
                this.agents.dragTo(x, y);
                return;
            }
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
            if (this.editor.audio || this.markdownView()) return;
            this.editor.dragTo(this.posAt(layout, x, y));
            return;
        }
        if (layout.terminal && contains(layout.terminal, x, y)) {
            this.editorToNormal();
            this.focus = 'Terminal';
            return;
        }
        if (this.badgeHit && contains(this.badgeHit, x, y)) {
            if (!this.agentsVisible) {
                this.showAgents();
            } else {
                this.agentsVisible = false;
                if (this.focus === 'Agents') this.focus = 'Editor';
            }
            return;
        }
        if (layout.agents && contains(layout.agents, x, y)) {
            this.editorToNormal();
            this.focus = 'Agents';
            this.agentAction(this.agents.mouse(x, y));
            this.press = { x, y, dragging: false, agents: true };
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
            const md = this.markdownView();
            if (md) {
                this.markdownClick(layout, md, x, y);
            } else if (!view && !this.editor.audio) {
                this.editor.click(this.posAt(layout, x, y));
                // Cmd+click (Ctrl+click) follows a link, as in Obsidian.
                if (mod && this.followLinkAtCursor()) return;
            }
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
            if (this.frameTimer) clearTimeout(this.frameTimer);
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
        const now = performance.now();
        const image = this.imageView();
        image?.tick(rectSize(imageArea(layout.textArea, layout.lineH)), now);
        const panes = this.panes(layout);
        const shown = this.shown(layout, panes, now);
        const animating = this.gliding() || (image?.moving ?? false) || (this.agentsVisible && this.agents.moving);
        if (this.frameTimer) clearTimeout(this.frameTimer);
        this.frameTimer = animating
            ? setTimeout(() => {
                  this.frameTimer = undefined;
                  this.render();
              }, FALLBACK_FRAME)
            : undefined;
        const modified = this.editor.isModified() ? ' [+]' : '';
        const title = `${this.editor.fileName()}${modified} - Wim`;
        const dirty = this.editor.firstModifiedBuffer() !== undefined;
        const painter = new Painter(this.editor, layout, {
            metrics: this.metrics,
            panes,
            shown,
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
            agents: this.agentsVisible ? this.agents : undefined,
            terminal: this.terminalVisible ? this.terminal : undefined,
            badge: this.config.claude.enabled ? this.agents.badge(Date.now()) : undefined,
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
        this.badgeHit = painter.badgeHit;
        this.opts.onFrame(title, dirty, cmds, animating);
    }

    /** Where the active window's view and caret are shown: gliding toward
     * where they are when smooth scrolling or caret is on, and jumping there
     * in another window or buffer, or between a Markdown file's text and its
     * rendered view. A long jump only glides its last screen. */
    private shown(layout: Layout, panes: Pane[], now: number): Shown {
        const ed = this.editor;
        const line = ed.cursor.line;
        const col = ed.displayCol(line, ed.cursor.col);
        const win = this.windows.active;
        const content = panes.find((p) => p.active)?.content;
        const markdown = content?.t === 'Markdown';
        const g = this.glidesFor;
        if (!g || g.win !== win || g.bufferId !== ed.bufferId() || g.markdown !== markdown) {
            this.topGlide.reset();
            this.lineGlide.reset();
            this.colGlide.reset();
            this.glidesFor = { win, bufferId: ed.bufferId(), markdown };
        }
        const { smoothCaret, smoothScroll } = this.config.editor;
        // A rendered Markdown view scrolls by its rows.
        const top = content?.t === 'Markdown' ? content.top : ed.scrollTop;
        return {
            top: smoothScroll ? this.topGlide.step(top, now, layout.rows) : top,
            line: smoothCaret ? this.lineGlide.step(line, now, layout.rows) : line,
            col: smoothCaret ? this.colGlide.step(col, now, layout.cols) : col,
        };
    }

    private gliding(): boolean {
        return this.topGlide.moving || this.lineGlide.moving || this.colGlide.moving;
    }

    private layout(): Layout {
        const { width, height, charW, lineH } = this.metrics;
        const bottom = Math.max(height - 2 * lineH, 0);
        const sidebar = this.treeVisible ? rect(0, 0, Math.min(SIDEBAR_COLS * charW, width * 0.4), bottom) : undefined;
        const editorLeft = sidebar ? sidebar.right + 1 : 0;
        const agentsCols = Math.min(Math.max(Math.round((width / charW) * AGENTS_SHARE), AGENTS_MIN_COLS), AGENTS_MAX_COLS);
        const agentsW = Math.round(Math.min(agentsCols * charW, width * AGENTS_MAX_SHARE));
        const agents = this.agentsVisible ? rect(width - agentsW, 0, width, bottom) : undefined;
        const editorRight = agents ? agents.left : width;
        const tabline = this.editor.buffers.length > 1 ? rect(editorLeft, 0, editorRight, lineH) : undefined;
        const termRows = Math.min(Math.max(Math.round((bottom / lineH) * TERMINAL_SHARE), TERMINAL_MIN_ROWS), Math.floor((bottom * 0.7) / lineH));
        const terminal = this.terminalVisible ? rect(editorLeft, bottom - termRows * lineH, editorRight, bottom) : undefined;
        const windows = this.windows.layout(rect(editorLeft, tabline ? tabline.bottom : 0, editorRight, terminal ? terminal.top : bottom), lineH, charW);
        const textArea = windows.find((w) => w.win === this.windows.active)!.area;
        const textLeft = textArea.left + this.gutterCols() * charW + TEXT_PADDING;
        return {
            sidebar,
            agents,
            terminal,
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
            const md = this.markdownViews.get(win.bufferId);
            if (md) {
                const cols = markdownCols(rect.area, cw);
                const rows = md.rows(st.buffer, cols, this.mediaHost(file, rect.area));
                const height = Math.max(Math.floor((rect.area.bottom - rect.area.top) / lh), 1);
                md.scrollBy(rows, height, 0);
                return [{ ...pane, content: { t: 'Markdown', rows, top: md.top, cols } }];
            }
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
                gitChanges: this.gitDiff.lineChanges(file, buffer),
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

/** The least space beside a rendered Markdown view, in columns. */
const MARKDOWN_MARGIN = 2;
/** The widest a rendered Markdown view's text gets, in columns. */
const MARKDOWN_WIDTH = 100;

/** How long the list of files for finding wikilinks' notes is kept, in ms. */
const VAULT_TTL = 5000;

/** How wide a rendered Markdown view is in a window's area `r`. */
function markdownCols(r: Rect, cw: number): number {
    return Math.max(Math.min(Math.floor((r.right - r.left) / cw) - 2 * MARKDOWN_MARGIN, MARKDOWN_WIDTH), 1);
}

/** Where a rendered Markdown view `cols` wide starts in a window's area `r`:
 * centered in it. */
function markdownLeft(r: Rect, cols: number, cw: number): number {
    const areaCols = Math.floor((r.right - r.left) / cw);
    return r.left + Math.max(Math.floor((areaCols - cols) / 2), MARKDOWN_MARGIN) * cw;
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

const BRANCH_REFRESH_MS = 2000;
let branchCache: { dir: string; at: number; name: string } | undefined;

/** The git branch checked out in `dir` (a short commit when detached), or an
 * empty string outside a repository. Asked of git at most every couple of
 * seconds, as the status bar paints often. */
function gitBranch(dir: string): string {
    const now = Date.now();
    if (branchCache && branchCache.dir === dir && now - branchCache.at < BRANCH_REFRESH_MS) return branchCache.name;
    const git = (args: string[]): string => {
        const out = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        return out.status === 0 && typeof out.stdout === 'string' ? out.stdout.trim() : '';
    };
    const name = git(['branch', '--show-current']) || git(['rev-parse', '--short', 'HEAD']);
    branchCache = { dir, at: now, name };
    return name;
}

/** The color of a name in the tree with a git status. */
function gitColor(status: GitStatus): string {
    switch (status) {
        case 'Untracked':
            return theme.GIT_UNTRACKED;
        case 'Staged':
            return theme.GIT_STAGED;
        case 'Modified':
            return theme.GIT_MODIFIED;
        case 'Conflict':
            return theme.GIT_CONFLICT;
    }
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
    /** The top line; fractional while the text glides. */
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
    /** How each line differs from git's copy, when the file is in a
     * repository. */
    gitChanges: readonly (LineChange | undefined)[] | undefined;
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
        | { t: 'Audio'; file: string; info: AudioInfo }
        /** A Markdown file's rendered view, from row `top`, `cols` wide. */
        | { t: 'Markdown'; rows: MdRow[]; top: number; cols: number };
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
    /** The Claude panel, when it is shown. */
    agents: AgentPanel | undefined;
    /** The terminal, when it is shown. */
    terminal: TerminalPane | undefined;
    /** The Claude badge at the end of the status line (not with Claude Code
     * turned off). */
    badge: { text: string; color: string; bg: string } | undefined;
    mapPending: KeyInput[];
    /** Highlighter states for a buffer. */
    highlightCache: (bufferId: number) => highlight.Cache;
    /** Every window, the active one among them. */
    panes: Pane[];
    /** Where the active window's view and caret are shown. */
    shown: Shown;
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
    /** Where the Claude badge was drawn. */
    badgeHit: Rect | undefined;

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
    private text(x: number, y: number, s: string, color: string, style?: TextStyle): void {
        if (s !== '') this.cmds.push(style ? ['text', x, y, s, color, style] : ['text', x, y, s, color]);
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
        const agents = this.layout.agents;
        if (agents && this.st.agents) {
            this.st.agents.paint(this.cmds, agents, this.layout.charW, this.layout.lineH, this.st.focus === 'Agents', Date.now());
        }
        const terminal = this.layout.terminal;
        if (terminal && this.st.terminal) {
            this.st.terminal.paint(this.cmds, terminal, this.layout.charW, this.layout.lineH, this.st.focus === 'Terminal');
        }
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
        // The active window is drawn where its view has glided to.
        const top = this.st.shown.top;
        if (c.t === 'Text') this.paintText(pane.active ? { ...c.view, scrollTop: top } : c.view);
        else if (c.t === 'Image') this.paintImage(area, c.file, c.image, c.placement);
        else if (c.t === 'Markdown') this.paintMarkdown(area, c.rows, pane.active ? top : c.top, c.cols);
        else this.paintAudio(area, c.file, c.info);
        this.cmds.push(['unclip']);
        if (bar) {
            this.rect(bar, pane.active ? theme.SELECTION : theme.STATUS_BG);
            const name = ` ${pane.name}${pane.modified ? ' [+]' : ''}`;
            const cols = Math.floor((bar.right - bar.left) / cw);
            const shown = Array.from(name).length <= cols ? name : ' …' + Array.from(name).slice(-Math.max(cols - 2, 0)).join('');
            this.text(bar.left, bar.top, shown, pane.active ? theme.FG : theme.COMMENT);
        }
        if (area.right < (this.layout.agents?.left ?? this.st.metrics.width)) {
            const x = Math.round(area.right + cw / 2);
            this.rect(rect(x, area.top, x + 1, bar ? bar.bottom : area.bottom), theme.POPUP_BORDER);
        }
    }

    /** A rendered Markdown view: its rows centered in the window, with bars
     * for quotes, a background for code, lines for rules, and pictures. */
    private paintMarkdown(area: Rect, rows: readonly MdRow[], top: number, cols: number): void {
        const { charW: cw, lineH: lh } = this.layout;
        const left = markdownLeft(area, cols, cw);
        const right = left + cols * cw;
        const height = Math.max(Math.floor((area.bottom - area.top) / lh), 1);
        const diagram = diagramTheme();
        // The window draws diagrams to say how big they are, so ask for all
        // of them, in view or not.
        for (const row of rows) {
            const m = row.media;
            if (m?.t === 'Diagram' && m.width === 0) this.cmds.push(['diagram', 0, 0, 0, 0, m.id, m.source, diagram]);
        }
        // While the view glides, its top row is partly above the area, and
        // one more row shows at the bottom.
        const start = Math.floor(top);
        const offset = (top - start) * lh;
        const shownRows = offset > 0 ? height + 1 : height;
        // Pictures, from the first row of each in view (which may start above it).
        let first = start;
        while (first > 0 && rows[first]?.kind === 'media' && !rows[first].media) first--;
        for (let r = first; r < start + shownRows && r < rows.length; r++) {
            const row = rows[r];
            const m: Media | undefined = row.media;
            if (!m || m.width === 0) continue;
            const x0 = left + (row.quote * 2 + row.indent) * cw;
            const y = area.top + (r - top) * lh;
            if (m.t === 'Image') {
                this.cmds.push(['image', x0, y, m.width, m.height, m.src]);
            } else {
                const room = right - x0;
                const x = x0 + Math.max(Math.floor((room - m.width) / 2), 0);
                this.cmds.push(['diagram', x, y, m.width, m.height, m.id, m.source, diagram]);
            }
        }
        for (let r = 0; r < shownRows; r++) {
            const row = rows[start + r];
            const y = area.top + r * lh - offset;
            if (!row) {
                this.text(area.left + TEXT_PADDING, y, '~', theme.TILDE);
                continue;
            }
            for (let q = 0; q < row.quote; q++) {
                const x = left + q * 2 * cw + Math.round(cw / 3);
                this.rect(rect(x, y, x + 3, y + lh), theme.GUTTER);
            }
            const x0 = left + (row.quote * 2 + row.indent) * cw;
            if (row.kind === 'code') {
                this.rect(rect(x0, y, Math.max(right, x0 + cw), y + lh), theme.CURSOR_LINE);
            } else if (row.kind === 'rule') {
                const mid = y + Math.floor(lh / 2);
                this.rect(rect(x0, mid, right, mid + 1), theme.GUTTER);
            }
            let x = x0 + (row.kind === 'code' ? cw : 0);
            for (const [s, color, style] of row.runs) {
                this.text(x, y, s, color, style);
                x += Array.from(s).length * cw;
            }
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

        // While the text glides, the top line is partly above the area, and
        // one more line shows at the bottom.
        const first = Math.floor(v.scrollTop);
        const offset = (v.scrollTop - first) * lh;
        const rows = offset > 0 ? v.rows + 1 : v.rows;

        // Diagnostics by line, most severe first.
        const lineDiagnostics = new Map<number, BufferDiagnostic[]>();
        for (const d of v.diagnostics) {
            for (let l = Math.max(d.start.line, first); l <= Math.min(d.end.line, first + rows); l++) {
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
        for (let row = 0; row < rows; row++) {
            const line = first + row;
            const y = area.top + row * lh - offset;
            if (line > buf.lastLine()) {
                this.text(area.left + TEXT_PADDING, y, '~', theme.TILDE);
                continue;
            }
            if (line === cursor.line && !selection) {
                this.rect(rect(area.left, y, area.right, y + lh), theme.CURSOR_LINE);
            }
            const change = v.gitChanges?.[line];
            if (change) this.gitMark(area.left, y, change);

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
                const state = this.st.highlightCache(v.bufferId).stateAt(lang, buf, line);
                spans = highlight.highlightLine(lang, chars, state)[0];
            }
            const semantic = v.semantic(line, chars);
            if (semantic) spans = highlight.overlaySpans(spans, semantic, chars.length);
            this.lineText(v, chars, spans, y);
            this.lineDiagnostics(v, line, y, diags);
        }
        this.cmds.push(['unclip']);
    }

    /** A line's git change at the left of the gutter: a thin bar beside a
     * new or changed line, or a tick at the edge where lines were removed
     * (gitsigns' `│` and `_`). */
    private gitMark(x: number, y: number, change: LineChange): void {
        const { charW: cw, lineH: lh } = this.layout;
        const w = GIT_MARK_WIDTH;
        switch (change) {
            case 'Added':
                return this.rect(rect(x, y, x + w, y + lh), theme.GIT_ADD);
            case 'Modified':
                return this.rect(rect(x, y, x + w, y + lh), theme.GIT_CHANGE);
            case 'Deleted':
                return this.rect(rect(x, y + lh - w, x + Math.round(cw / 2), y + lh), theme.GIT_DELETE);
            case 'DeletedAbove':
                return this.rect(rect(x, y, x + Math.round(cw / 2), y + w), theme.GIT_DELETE);
        }
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
            area.top + (p.line - this.st.shown.top) * layout.lineH,
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
        let runStyle: TextStyle | undefined;
        let runStart = left;
        let span = 0;
        let dcol = 0;
        const flush = (): void => {
            this.text(v.textLeft + (runStart - left) * layout.charW, y, run, runColor, runStyle);
            run = '';
        };
        for (let i = 0; i < chars.length && dcol < right; i++) {
            const c = chars[i];
            while (span < spans.length && spans[span][1] <= i) span++;
            const token = span < spans.length && spans[span][0] <= i ? spans[span][2] : 'Normal';
            const color = tokenColor(token);
            const style = tokenStyle(token);
            const cells = c === '\t' ? ts - (dcol % ts) : 1;
            for (let k = 0; k < cells; k++) {
                const d = dcol + k;
                if (d < left || d >= right) continue;
                if (color !== runColor || style !== runStyle || run === '') {
                    if (run !== '') flush();
                    runColor = color;
                    runStyle = style;
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
        const area = layout.textArea;
        // Where the caret is shown, which glides behind the cursor with
        // `editor.smoothCaret`.
        const shown = this.st.shown;
        const y = area.top + (shown.line - shown.top) * layout.lineH;
        if (isCmdLine(mode) || y + layout.lineH <= area.top || y >= area.bottom) return;
        const dcol = ed.displayCol(cursor.line, cursor.col);
        if (dcol < ed.scrollLeft) return;
        const c = ed.buffer.charAt(cursor) ?? ' ';
        const width = c === '\t' ? ed.displayCol(cursor.line, cursor.col + 1) - dcol : 1;
        const x = layout.textLeft + (shown.col - ed.scrollLeft) * layout.charW;
        const cell = rect(x, y, x + layout.charW * width, y + layout.lineH);
        this.clip(area);
        this.paintCaret(cell, c);
        this.cmds.push(['unclip']);
    }

    private paintCaret(cell: Rect, c: string): void {
        const mode = this.ed.mode;
        if (this.st.focus !== 'Editor') {
            // Hollow cursor while the file tree or the Claude panel has focus.
            this.cmds.push(['stroke', cell.left, cell.top, cell.right - cell.left, cell.bottom - cell.top, theme.CURSOR]);
            return;
        }
        if (mode === 'Insert') {
            this.rect(rect(cell.left, cell.top, cell.left + 2, cell.bottom), theme.CURSOR);
        } else if (mode === 'Replace' || this.ed.pending.length > 0) {
            this.rect(rect(cell.left, cell.bottom - 3, cell.right, cell.bottom), theme.CURSOR);
        } else {
            this.rect(cell, theme.CURSOR);
            if (!isWhitespace(c)) this.text(cell.left, cell.top, c, theme.BG);
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
            // The open file has the selection's background, until the tree has
            // focus and its own cursor takes over.
            const treeFocused = this.st.focus === 'Tree';
            if (treeFocused ? i === tree.selected : currentFile === row.path) {
                this.rect(rect(r.left, y, r.right, y + lh), theme.SELECTION);
            }
            const x = r.left + TEXT_PADDING + row.depth * 2 * cw;
            if (this.st.icons) {
                let glyph: string;
                let color: string;
                if (row.isDir) {
                    if (row.empty) glyph = row.expanded ? icons.FOLDER_EMPTY_OPEN : icons.FOLDER_EMPTY;
                    else glyph = row.expanded ? icons.FOLDER_OPEN : icons.FOLDER_CLOSED;
                    color = theme.TREE_FOLDER_ICON;
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
            if (row.git) color = gitColor(row.git);
            else if (row.isDir) color = row.expanded ? theme.TREE_OPEN_FOLDER : theme.TREE_FOLDER;
            else if (row.special) color = theme.TREE_SPECIAL_FILE;
            else if (currentFile === row.path) color = theme.GUTTER_CURRENT;
            this.text(x + cw * 2, y, row.name, color);
            if (row.special) {
                const left = x + cw * 2;
                this.rect(rect(left, y + lh - 2, left + Array.from(row.name).length * cw, y + lh - 1), color);
            }
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
        const full = layout.status;
        const cw = layout.charW;
        this.rect(full, theme.STATUS_BG);

        // At the end, the Claude badge, which shows and hides the panel.
        const badge = this.st.badge;
        let badgeHit: Rect | undefined;
        if (badge) {
            badgeHit = rect(full.right - Array.from(badge.text).length * cw, full.top, full.right, full.bottom);
            this.rect(badgeHit, badge.bg);
            this.text(badgeHit.left, full.top, badge.text, badge.color);
        }
        this.badgeHit = badgeHit;
        const r = rect(full.left, full.top, badgeHit ? badgeHit.left : full.right, full.bottom);

        const active = this.st.panes.find((p) => p.active)?.content;
        const markdown = active?.t === 'Markdown' ? active : undefined;
        let modeName: string;
        let modeColor: string;
        if (this.st.focus === 'Tree') {
            modeName = 'TREE';
            modeColor = theme.MODE_TREE;
        } else if (this.st.focus === 'Terminal') {
            modeName = 'TERM';
            modeColor = theme.MODE_TREE;
        } else if (this.st.focus === 'Agents') {
            modeName = 'AGENT';
            modeColor = theme.MODE_AGENT;
        } else if (markdown && ed.mode === 'Normal') {
            modeName = 'VIEW';
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

        const branch = gitBranch(currentDir());
        const branchLabel = branch === '' ? '' : ` ${this.st.icons ? '\ue0a0 ' : ''}${branch} `;
        const branchRight = pillRight + Array.from(branchLabel).length * cw;

        const cursor = ed.cursor;
        // A rendered Markdown view goes by its rows.
        const lines = markdown ? markdown.rows.length : ed.buffer.lineCount();
        const top = markdown ? markdown.top : ed.scrollTop;
        let position: string;
        if (lines <= layout.rows) position = 'All';
        else if (top === 0) position = 'Top';
        else if (top + layout.rows >= lines) position = 'Bot';
        else position = `${Math.floor((top * 100) / (lines - layout.rows))}%`;
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
        const where =
            image || audio
                ? ''
                : markdown
                  ? `   ${position}`
                  : `   ${cursor.line + 1}:${ed.displayCol(cursor.line, cursor.col) + 1}   ${position}`;
        const right = `${pending}   ${filetype}${where} `;
        this.textRight(r.right - cw, r.top, right, theme.FG);

        // Between the two, the file name and (to the right) language server
        // progress or diagnostic counts. When short of room, the progress is
        // cut, then left out, while the name keeps at least MIN_NAME columns;
        // after that the name loses its start.
        const width = (s: string): number => Array.from(s).length;
        const room = Math.floor((r.right - r.left) / cw) - label.length - width(branchLabel) - width(right) - 1;
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
        const nameCols = Math.floor((x - branchRight) / cw);
        const shown = width(name) <= nameCols ? name : ' …' + Array.from(name).slice(-Math.max(nameCols - 2, 0)).join('');
        if (nameCols > 2) {
            if (branchLabel !== '') this.text(pillRight, r.top, branchLabel, theme.MODE_TREE);
            this.text(branchRight, r.top, shown, theme.FG);
        }
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
