// The integrated terminal, under the editor: a shell (zsh by default) on a
// real pseudo-terminal, so it is interactive, with its prompt, line editing,
// tab completion, colors and full-screen programs (vim, less, top).
//
// Wim has no native code, so it can't make a pseudo-terminal itself: the
// system's `script` command makes one and runs the shell in it, and
// @xterm/headless (plain JavaScript) keeps the screen the shell draws, which
// Wim then paints. `script` needs its input to be a pipe or a terminal, and
// Node's pipes are sockets on macOS, so `cat` stands between them. The
// shell's first output is the pseudo-terminal's name, to resize it with
// `stty` from outside as the panel changes size.
//
// Windows has no `script` (and its ConPTY needs native code); there, and
// wherever `script` is missing, the line-based terminal in lineterminal.ts is
// used instead.

import { ChildProcess, SpawnOptions, spawn as nodeSpawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Terminal as XTerm } from '@xterm/headless';

import { KeyInput } from './editor/keys';
import { LineTerminal } from './lineterminal';
import { Box } from './popup';
import { DrawCmd, TextStyle } from './protocol';
import { theme } from './theme';

/** What the window should do after a key in the terminal. */
export type TerminalAction = { t: 'None' } | { t: 'Move'; dir: 'Left' | 'Right' | 'Up' | 'Down' } | { t: 'Hide' };

type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface TerminalOptions {
    /** The shell program (by default zsh, or PowerShell on Windows). */
    shell?: string;
    /** The working directory, where the shell starts. */
    cwd: () => string;
    /** Repaint soon. */
    refresh: () => void;
    /** For tests. */
    spawn?: Spawn;
}

/** The terminal as the window uses it. Keys come as typed: Ctrl+c is
 * Ctrl+c, not Esc. */
export interface TerminalPane {
    key(key: KeyInput): TerminalAction;
    paste(text: string): void;
    /** Scroll back (positive) or forward through the output. */
    scrollBy(rows: number): void;
    /** Draw the terminal in `r`: a title row and the screen. */
    paint(cmds: DrawCmd[], r: Box, cw: number, lh: number, focused: boolean): void;
    dispose(): void;
}

/** The terminal for this system: on a pseudo-terminal where `script` can make
 * one, else line based. */
export function createTerminal(opts: TerminalOptions): TerminalPane {
    return process.platform !== 'win32' && onPath('script') ? new Terminal(opts) : new LineTerminal(opts);
}

const NONE: TerminalAction = { t: 'None' };
/** Lines of output kept. */
const SCROLLBACK = 5000;
/** The control sequence (OSC) number the wrapper reports on. */
const REPORT = 7777;

/** Runs in the pseudo-terminal: says which one it is (once it has its
 * size), runs the shell, and says when the shell is gone. */
const WRAPPER = [
    'stty rows "$WIM_ROWS" cols "$WIM_COLS"',
    `printf '\\033]${REPORT};tty=%s\\007' "$(tty)"`,
    // `script` on Linux runs the command with $SHELL, so that was sh.
    'if [ -n "$WIM_USER_SHELL" ]; then SHELL=$WIM_USER_SHELL; export SHELL; fi',
    'wim_shell=$WIM_SHELL',
    'unset WIM_ROWS WIM_COLS WIM_SHELL WIM_USER_SHELL',
    '"$wim_shell" -l',
    `printf '\\033]${REPORT};exit\\007'`,
].join('\n');

/** A terminal on a pseudo-terminal. */
export class Terminal implements TerminalPane {
    private readonly term: XTerm;
    private proc: ChildProcess | undefined;
    /** The pseudo-terminal's device, once the shell has said. */
    private tty: string | undefined;
    /** Its size as last set, `rows x cols`, and whether `stty` is setting
     * it now. */
    private ttySize = '';
    private sizing = false;
    /** The shell exited; Enter starts another. */
    private exited = false;
    private cursorVisible = true;
    /** What the shell or a program last set as the title. */
    private title = '';
    /** The shell's directory, when it reports it (OSC 7). */
    private dir: string | undefined;
    /** Rows scrolled back from the end (0 follows the output). */
    scroll = 0;

    constructor(private readonly opts: TerminalOptions) {
        this.term = new XTerm({ cols: 80, rows: 24, scrollback: SCROLLBACK, allowProposedApi: true });
        // Replies to the shell's questions (where is the cursor?) go back to it.
        this.term.onData((data) => this.send(data));
        this.term.onTitleChange((title) => {
            this.title = title;
        });
        this.term.onWriteParsed(() => this.opts.refresh());
        this.term.parser.registerOscHandler(REPORT, (data) => {
            if (data.startsWith('tty=')) {
                this.tty = data.slice(4);
                this.syncSize();
            } else if (data === 'exit') {
                // `cat` ends with its input, and the rest follows.
                this.proc?.stdin?.end();
            }
            return true;
        });
        this.term.parser.registerOscHandler(7, (data) => {
            const m = /^file:\/\/[^/]*(\/.*)$/.exec(data);
            if (m) {
                try {
                    this.dir = decodeURIComponent(m[1]);
                } catch {
                    this.dir = m[1];
                }
            }
            return true;
        });
        // Showing and hiding the cursor (DECTCEM), which the API doesn't
        // tell; the terminal goes on to handle the rest.
        const cursorMode = (visible: boolean) => (params: (number | number[])[]) => {
            if (params.includes(25)) this.cursorVisible = visible;
            return false;
        };
        this.term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, cursorMode(true));
        this.term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, cursorMode(false));
    }

    get shell(): string {
        return this.opts.shell ?? 'zsh';
    }

    private start(): void {
        if (this.proc) return;
        this.exited = false;
        this.tty = undefined;
        this.cursorVisible = true;
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            WIM_SHELL: this.shell,
            WIM_ROWS: String(this.term.rows),
            WIM_COLS: String(this.term.cols),
        };
        let command: string;
        if (process.platform === 'linux') {
            // util-linux's `script -c` runs the command with $SHELL.
            env.WIM_USER_SHELL = process.env.SHELL ?? '';
            env.SHELL = '/bin/sh';
            command = 'cat | script -qfc "$0" /dev/null';
        } else {
            command = 'cat | script -q /dev/null /bin/sh -c "$0"';
        }
        this.ttySize = `${this.term.rows}x${this.term.cols}`;
        const spawn = this.opts.spawn ?? nodeSpawn;
        let proc: ChildProcess;
        try {
            proc = spawn('/bin/sh', ['-c', command, WRAPPER], {
                cwd: this.opts.cwd(),
                env,
                stdio: ['pipe', 'pipe', 'pipe'],
                // Its own process group, to stop all of it when Wim exits.
                detached: true,
            });
        } catch (e) {
            this.note(`Can't start ${this.shell}: ${(e as Error).message}`);
            this.exited = true;
            return;
        }
        this.proc = proc;
        proc.stdout?.on('data', (d: Buffer) => this.proc === proc && this.term.write(d));
        proc.stderr?.on('data', (d: Buffer) => this.proc === proc && this.term.write(d));
        // Errors on the pipe (the shell exiting) are noticed by `exit`.
        proc.stdin?.on('error', () => {});
        const ended = (why: string): void => {
            if (this.proc !== proc) return;
            this.proc = undefined;
            this.tty = undefined;
            this.exited = true;
            this.scroll = 0;
            this.note(why);
            this.opts.refresh();
        };
        proc.on('error', (e) => ended(`Can't start ${this.shell}: ${e.message}`));
        proc.on('exit', () => ended('[the shell exited; Enter starts a new one]'));
    }

    /** A line from Wim in the terminal, dimmed, after resetting what the
     * program left set. */
    private note(text: string): void {
        this.term.write(`\x1b[!p\x1b[?1049l\r\n\x1b[2m${text}\x1b[0m\r\n`);
    }

    private send(data: string): void {
        if (!this.proc) return;
        this.proc.stdin?.write(data);
    }

    /** Match the terminal to `cols` by `rows` cells, starting the shell the
     * first time. */
    private fit(cols: number, rows: number): void {
        if (cols !== this.term.cols || rows !== this.term.rows) {
            this.term.resize(cols, rows);
            this.syncSize();
        }
        if (!this.proc && !this.exited) this.start();
    }

    /** Give the pseudo-terminal the terminal's size, which also tells the
     * program in it (SIGWINCH). One `stty` at a time, the last size winning. */
    private syncSize(): void {
        const size = `${this.term.rows}x${this.term.cols}`;
        if (this.sizing || !this.tty || !this.proc || size === this.ttySize) return;
        let fd: number;
        try {
            fd = fs.openSync(this.tty, fs.constants.O_RDWR | fs.constants.O_NOCTTY);
        } catch {
            return;
        }
        this.sizing = true;
        this.ttySize = size;
        const done = (): void => {
            this.sizing = false;
            this.syncSize();
        };
        try {
            const child = nodeSpawn('stty', ['rows', String(this.term.rows), 'cols', String(this.term.cols)], { stdio: [fd, 'ignore', 'ignore'] });
            child.on('error', done);
            child.on('exit', done);
        } catch {
            this.sizing = false;
        } finally {
            fs.closeSync(fd);
        }
    }

    /** Stop the shell (Wim is exiting). */
    dispose(): void {
        const proc = this.proc;
        this.proc = undefined;
        if (proc) kill(proc);
        this.term.dispose();
    }

    paste(text: string): void {
        if (!this.proc) return;
        const body = text.replace(/\r?\n/g, '\r');
        this.scroll = 0;
        this.send(this.term.modes.bracketedPasteMode ? `\x1b[200~${body}\x1b[201~` : body);
    }

    // ----- Keys and mouse ------------------------------------------------------------

    key(key: KeyInput): TerminalAction {
        if (key.ctrl) {
            switch (key.key.toLowerCase()) {
                case 'h':
                    return { t: 'Move', dir: 'Left' };
                case 'j':
                    return { t: 'Move', dir: 'Down' };
                case 'k':
                    return { t: 'Move', dir: 'Up' };
                case 'l':
                    return { t: 'Move', dir: 'Right' };
            }
        }
        const alternate = this.term.buffer.active.type === 'alternate';
        // Page keys scroll back through the shell's output; full-screen
        // programs get them.
        if (!alternate && (key.key === 'PageUp' || key.key === 'PageDown') && !key.alt) {
            const page = Math.max(this.term.rows - 1, 1);
            this.scrollBy(key.key === 'PageUp' ? page : -page);
            return NONE;
        }
        if (this.exited) {
            if (key.key === 'Enter') this.start();
            return NONE;
        }
        const data = encodeKey(key, this.term.modes.applicationCursorKeysMode);
        if (data !== undefined) {
            this.scroll = 0;
            this.send(data);
        }
        return NONE;
    }

    scrollBy(rows: number): void {
        if (this.term.buffer.active.type === 'alternate') {
            // Full-screen programs have no scrollback: the wheel is the arrow
            // keys there, as in most terminals.
            const arrow = encodeKey({ key: rows > 0 ? 'Up' : 'Down', ctrl: false, alt: false }, this.term.modes.applicationCursorKeysMode);
            if (arrow) this.send(arrow.repeat(Math.abs(rows)));
            return;
        }
        this.scroll = Math.min(Math.max(this.scroll + rows, 0), this.term.buffer.active.baseY);
    }

    // ----- Painting ------------------------------------------------------------------

    paint(cmds: DrawCmd[], r: Box, cw: number, lh: number, focused: boolean): void {
        const text = (x: number, y: number, s: string, color: string, style?: TextStyle): void => {
            if (s.trim() !== '') cmds.push(style ? ['text', x, y, s, color, style] : ['text', x, y, s, color]);
        };
        cmds.push(['rect', r.left, r.top, r.right - r.left, r.bottom - r.top, theme.BG]);
        cmds.push(['clip', r.left, r.top, r.right - r.left, r.bottom - r.top]);
        // The title.
        cmds.push(['rect', r.left, r.top, r.right - r.left, lh, theme.STATUS_BG]);
        if (focused) cmds.push(['rect', r.left + cw, r.top, 10 * cw, lh, theme.MODE_TREE]);
        text(r.left + cw, r.top, ' TERMINAL ', focused ? theme.BG : theme.COMMENT);
        const shell = path.basename(this.shell);
        const dir = this.dir ?? this.opts.cwd();
        const home = os.homedir();
        const shown = dir === home || dir.startsWith(home + path.sep) ? '~' + dir.slice(home.length) : dir;
        const info = this.title !== '' && !this.exited ? this.title : `${shell}  ${shown}`;
        const scrolled = this.scroll > 0 ? `  [${this.scroll} up]` : '';
        text(r.left + 12 * cw, r.top, info + scrolled, theme.COMMENT);

        // The screen.
        const left = r.left + cw;
        const top = r.top + lh;
        const cols = Math.max(Math.floor((r.right - left - cw / 2) / cw), 10);
        const rows = Math.max(Math.floor((r.bottom - top) / lh), 2);
        this.fit(cols, rows);
        const buf = this.term.buffer.active;
        this.scroll = Math.min(this.scroll, buf.baseY);
        const first = buf.baseY - this.scroll;
        const cell = buf.getNullCell();
        for (let row = 0; row < rows; row++) {
            const line = buf.getLine(first + row);
            if (!line) continue;
            const y = top + row * lh;
            // A run of cells with the same look, drawn as one text.
            let run = '';
            let runX = 0;
            let runColor = '';
            let runStyle: TextStyle | undefined;
            const flush = (): void => {
                // Without the blanks around it (the background is drawn).
                const lead = run.length - run.trimStart().length;
                text(runX + lead * cw, y, run.trim(), runColor, runStyle);
                run = '';
            };
            for (let col = 0; col < cols; col++) {
                if (!line.getCell(col, cell)) break;
                const width = cell.getWidth();
                // The second half of a wide character.
                if (width === 0) continue;
                let fg = cellColor(cell.isFgDefault(), cell.isFgRGB(), cell.getFgColor()) ?? theme.FG;
                let bg = cellColor(cell.isBgDefault(), cell.isBgRGB(), cell.getBgColor());
                if (cell.isInverse()) [fg, bg] = [bg ?? theme.BG, fg];
                if (cell.isDim() && cell.isFgDefault()) fg = theme.COMMENT;
                const x = left + col * cw;
                if (bg !== undefined) cmds.push(['rect', x, y, width * cw, lh, bg]);
                if (cell.isUnderline()) cmds.push(['rect', x, y + lh - 2, width * cw, 1, fg]);
                const chars = cell.isInvisible() ? ' ' : cell.getChars() || ' ';
                const style = textStyle(cell.isBold() !== 0, cell.isItalic() !== 0);
                // Wide characters are drawn on their own, as text puts each
                // character in one cell.
                if (run !== '' && (width !== 1 || fg !== runColor || style !== runStyle)) flush();
                if (run === '') {
                    runX = x;
                    runColor = fg;
                    runStyle = style;
                }
                run += chars;
                if (width !== 1) flush();
            }
            flush();
        }

        // The cursor, where the program is.
        if (this.scroll === 0 && this.cursorVisible && !this.exited && buf.cursorX < cols) {
            const cx = left + buf.cursorX * cw;
            const cy = top + buf.cursorY * lh;
            if (focused) {
                cmds.push(['rect', cx, cy, cw, lh, theme.CURSOR]);
                const under = buf.getLine(buf.baseY + buf.cursorY)?.getCell(buf.cursorX, cell)?.getChars();
                if (under) text(cx, cy, under, theme.BG);
            } else {
                cmds.push(['stroke', cx, cy, cw, lh, theme.CURSOR]);
            }
        }
        cmds.push(['unclip']);
    }
}

function textStyle(bold: boolean, italic: boolean): TextStyle | undefined {
    if (bold && italic) return 'italic bold';
    return bold ? 'bold' : italic ? 'italic' : undefined;
}

/** A cell's color: undefined for the default, else from its RGB value or
 * the 256-color palette. */
function cellColor(isDefault: boolean, isRgb: boolean, value: number): string | undefined {
    if (isDefault) return undefined;
    if (isRgb) return '#' + value.toString(16).padStart(6, '0');
    return paletteColor(value);
}

/** One of the 256 colors: the theme's 16, then xterm's color cube and grays. */
export function paletteColor(n: number): string {
    if (n < 16) return theme.ANSI[n];
    const hex = (v: number): string => v.toString(16).padStart(2, '0');
    if (n < 232) {
        const levels = [0, 95, 135, 175, 215, 255];
        const i = n - 16;
        return '#' + hex(levels[Math.floor(i / 36)]) + hex(levels[Math.floor(i / 6) % 6]) + hex(levels[i % 6]);
    }
    const gray = 8 + (n - 232) * 10;
    return '#' + hex(gray) + hex(gray) + hex(gray);
}

/** What a key sends to the program, as xterm sends it. Option (Alt) with
 * the arrows and Backspace moves and deletes by word, as in macOS
 * terminals. */
export function encodeKey(key: KeyInput, appCursor: boolean): string | undefined {
    const meta = key.alt ? '\x1b' : '';
    const arrows: Record<string, string> = { Up: 'A', Down: 'B', Right: 'C', Left: 'D', Home: 'H', End: 'F' };
    switch (key.key) {
        case 'Esc':
            return '\x1b';
        case 'Enter':
            return meta + '\r';
        case 'Backspace':
            return meta + '\x7f';
        case 'Delete':
            return key.alt ? '\x1bd' : '\x1b[3~';
        case 'Tab':
            return '\t';
        case 'BackTab':
            return '\x1b[Z';
        case 'PageUp':
            return '\x1b[5~';
        case 'PageDown':
            return '\x1b[6~';
        case 'Left':
        case 'Right':
            if (key.alt) return key.key === 'Left' ? '\x1bb' : '\x1bf';
            return (appCursor ? '\x1bO' : '\x1b[') + arrows[key.key];
        case 'Up':
        case 'Down':
        case 'Home':
        case 'End':
            return (appCursor ? '\x1bO' : '\x1b[') + arrows[key.key];
    }
    if (Array.from(key.key).length !== 1) return undefined;
    if (!key.ctrl) return meta + key.key;
    const c = key.key.toLowerCase();
    if (/^[a-z]$/.test(c)) return meta + String.fromCharCode(c.charCodeAt(0) - 96);
    const controls: Record<string, string> = { '@': '\x00', ' ': '\x00', '[': '\x1b', '\\': '\x1c', ']': '\x1d', '^': '\x1e', _: '\x1f', '?': '\x7f' };
    return controls[c] === undefined ? undefined : meta + controls[c];
}

/** Whether `command` is a program on the PATH. */
function onPath(command: string): boolean {
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
        if (dir === '') continue;
        try {
            fs.accessSync(path.join(dir, command), fs.constants.X_OK);
            return true;
        } catch {
            // Not here.
        }
    }
    return false;
}

/** Stop the shell's process group: `sh`, `cat` and `script`. The programs in
 * the pseudo-terminal get a hangup when it closes. */
function kill(proc: ChildProcess): void {
    try {
        if (proc.pid !== undefined) process.kill(-proc.pid, 'SIGKILL');
        else proc.kill('SIGKILL');
    } catch {
        // Already gone.
    }
}
