// The integrated terminal where there is no pseudo-terminal to run the shell
// in (Windows, or without `script`): a shell that keeps its directory and
// variables between commands. It is line based: a command is typed in Wim's
// own prompt and its output is shown as text, so programs that draw on the
// whole screen (vim, less, top) and programs that ask for input don't work in
// it, and there is no tab completion.

import { ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { TextInput } from './agent/input';
import { KeyInput, keyNew } from './editor/keys';
import { Box } from './popup';
import { DrawCmd } from './protocol';
import type { TerminalAction, TerminalOptions, TerminalPane } from './terminal';
import { theme } from './theme';

const NONE: TerminalAction = { t: 'None' };
/** Lines of output kept. */
const SCROLLBACK = 5000;
/** Spaces a tab in output is shown as. */
const TAB = 4;


interface Line {
    text: string;
    kind: 'Output' | 'Command' | 'Note';
}

// Control sequences that colors, titles and cursor movement come in: output
// is shown as plain text.
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** One line of output as text: without escapes, and with what a carriage
 * return overwrote dropped (as in progress bars). */
function clean(line: string): string {
    const text = line.replace(ESCAPES, '');
    const cr = text.lastIndexOf('\r');
    return (cr >= 0 && cr < text.length - 1 ? text.slice(cr + 1) : text.replace(/\r/g, '')).replace(/\t/g, ' '.repeat(TAB));
}

function isPowerShell(shell: string): boolean {
    return /^(pwsh|powershell)(\.exe)?$/i.test(path.basename(shell));
}

export class LineTerminal implements TerminalPane {
    private lines: Line[] = [];
    /** Output of the running command that hasn't ended its line. */
    private partial = '';
    /** Output not yet split into lines. */
    private pending = '';
    readonly input = new TextInput();
    private proc: ChildProcess | undefined;
    private readonly marker = `__WIM_DONE_${randomBytes(6).toString('hex')}__`;
    /** A command is running. */
    running = false;
    /** The shell's directory after the last command. */
    cwd: string | undefined;
    /** Rows scrolled up from the end (0 follows the output). */
    scroll = 0;
    private rows = 10;

    constructor(private readonly opts: TerminalOptions) {}

    get shell(): string {
        return this.opts.shell ?? (process.platform === 'win32' ? 'powershell.exe' : 'zsh');
    }

    private note(text: string): void {
        this.lines.push({ text, kind: 'Note' });
    }

    /** Where the shell runs: where the last command left it. */
    private dir(): string {
        return this.cwd ?? this.opts.cwd();
    }

    private start(): ChildProcess | undefined {
        if (this.proc) return this.proc;
        const shell = this.shell;
        const args = isPowerShell(shell) ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'] : ['-l'];
        const spawn = this.opts.spawn ?? nodeSpawn;
        let proc: ChildProcess;
        try {
            proc = spawn(shell, args, {
                cwd: this.dir(),
                env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat' },
                stdio: ['pipe', 'pipe', 'pipe'],
                // Its own process group, so Ctrl+c can stop all of it.
                detached: process.platform !== 'win32',
                windowsHide: true,
            });
        } catch (e) {
            this.note(`Can't start ${shell}: ${(e as Error).message}`);
            return undefined;
        }
        this.proc = proc;
        const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
        proc.stdout?.on('data', (d: Buffer) => this.proc === proc && this.output(decoders[0].write(d)));
        proc.stderr?.on('data', (d: Buffer) => this.proc === proc && this.output(decoders[1].write(d)));
        // Errors on the pipe (the shell exiting) are noticed by `exit`.
        proc.stdin?.on('error', () => {});
        proc.on('error', (e) => {
            if (this.proc !== proc) return;
            this.proc = undefined;
            this.running = false;
            this.note(`Can't start ${shell}: ${e.message}`);
            this.opts.refresh();
        });
        proc.on('exit', () => {
            if (this.proc !== proc) return;
            this.proc = undefined;
            this.flush();
            this.running = false;
            this.note('[the shell exited; the next command starts a new one]');
            this.opts.refresh();
        });
        if (isPowerShell(shell)) proc.stdin?.write('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n');
        return proc;
    }

    /** Run a command line. */
    run(line: string): void {
        if (this.running) {
            this.note('A command is running (Ctrl+c stops it)');
            return;
        }
        this.scroll = 0;
        this.lines.push({ text: line, kind: 'Command' });
        this.input.remember(line);
        if (/^\s*(clear|cls)\s*$/.test(line)) {
            this.lines = [];
            return;
        }
        if (line.trim() === '') return;
        const proc = this.start();
        if (!proc) return;
        this.running = true;
        const done = isPowerShell(this.shell)
            ? `Write-Output "${this.marker}$(if ($?) {0} else {1})|$((Get-Location).Path)"`
            : `printf '%s\\n' "${this.marker}$?|$PWD"`;
        proc.stdin?.write(`${line}\n${done}\n`);
        this.trim();
    }

    /** Take in the shell's output, noticing when the command is done. */
    private output(text: string): void {
        this.pending += text.replace(/\r\n/g, '\n');
        for (;;) {
            const at = this.pending.indexOf(this.marker);
            if (at < 0) break;
            const end = this.pending.indexOf('\n', at);
            if (end < 0) {
                // The rest of the marker's line is still to come.
                this.addText(this.pending.slice(0, at));
                this.pending = this.pending.slice(at);
                this.opts.refresh();
                return;
            }
            this.addText(this.pending.slice(0, at));
            this.flush();
            const info = this.pending.slice(at + this.marker.length, end);
            this.pending = this.pending.slice(end + 1);
            this.finished(info);
        }
        const nl = this.pending.lastIndexOf('\n');
        if (nl >= 0) {
            this.addText(this.pending.slice(0, nl + 1));
            this.pending = this.pending.slice(nl + 1);
        }
        this.trim();
        this.opts.refresh();
    }

    /** Add output text; what doesn't end a line waits in `partial`. */
    private addText(text: string): void {
        if (text === '') return;
        const parts = (this.partial + text).split('\n');
        this.partial = parts.pop() ?? '';
        for (const part of parts) this.lines.push({ text: clean(part), kind: 'Output' });
    }

    /** End the line in progress. */
    private flush(): void {
        if (this.partial !== '') this.lines.push({ text: clean(this.partial), kind: 'Output' });
        this.partial = '';
    }

    private finished(info: string): void {
        const bar = info.indexOf('|');
        const code = bar >= 0 ? info.slice(0, bar) : info;
        const dir = bar >= 0 ? info.slice(bar + 1).trim() : '';
        if (dir !== '') this.cwd = dir;
        this.running = false;
        if (code !== '0' && code.trim() !== '') this.note(`[exit ${code.trim()}]`);
        this.trim();
        this.opts.refresh();
    }

    private trim(): void {
        if (this.lines.length > SCROLLBACK) this.lines.splice(0, this.lines.length - SCROLLBACK);
    }

    /** Stop the running command. That takes the shell with it; the next
     * command starts a new one in the same directory. */
    interrupt(): void {
        const proc = this.proc;
        if (!proc || !this.running) return;
        this.proc = undefined;
        this.running = false;
        kill(proc);
        this.pending = '';
        this.flush();
        this.note('^C');
        this.opts.refresh();
    }

    /** Stop the shell (Wim is exiting). */
    dispose(): void {
        const proc = this.proc;
        this.proc = undefined;
        if (proc) kill(proc);
    }

    // The line based terminal has no screen of cells to select from.
    select(): void {}

    selectedText(): string | undefined {
        return undefined;
    }

    paste(text: string): void {
        // One line: a pasted line break would run the command.
        this.input.insert(text.replace(/\s*\n\s*/g, ' ').trimEnd());
    }

    // ----- Keys and mouse ------------------------------------------------------------

    key(raw: KeyInput): TerminalAction {
        // Ctrl+c is Esc here.
        const key = raw.ctrl ? keyNew(raw.key, true) : raw;
        if (key.ctrl) {
            switch (key.key) {
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
        switch (key.key) {
            // Ctrl+c is Esc: it stops a command, else clears what is typed,
            // else goes back to the editor.
            case 'Esc':
                if (this.running) {
                    this.interrupt();
                    return NONE;
                }
                if (this.input.text !== '') {
                    this.input.clear();
                    return NONE;
                }
                return { t: 'Move', dir: 'Up' };
            case 'PageUp':
                this.scrollBy(Math.max(this.rows - 1, 1));
                return NONE;
            case 'PageDown':
                this.scrollBy(-Math.max(this.rows - 1, 1));
                return NONE;
        }
        this.scroll = 0;
        if (this.input.key(key) === 'Send') {
            const line = this.input.text;
            this.input.clear();
            this.run(line);
        }
        return NONE;
    }

    scrollBy(rows: number): void {
        this.scroll = Math.max(this.scroll + rows, 0);
    }

    // ----- Painting ------------------------------------------------------------------

    /** Draw the terminal in `r`: a title row, the output and the prompt. */
    paint(cmds: DrawCmd[], r: Box, cw: number, lh: number, focused: boolean): void {
        const text = (x: number, y: number, s: string, color: string): void => {
            if (s !== '') cmds.push(['text', x, y, s, color]);
        };
        cmds.push(['rect', r.left, r.top, r.right - r.left, r.bottom - r.top, theme.BG]);
        cmds.push(['clip', r.left, r.top, r.right - r.left, r.bottom - r.top]);
        // The title.
        cmds.push(['rect', r.left, r.top, r.right - r.left, lh, theme.STATUS_BG]);
        const shell = path.basename(this.shell).replace(/\.exe$/i, '');
        const dir = this.dir();
        const home = os.homedir();
        const shown = dir === home || dir.startsWith(home + path.sep) ? '~' + dir.slice(home.length) : dir;
        if (focused) cmds.push(['rect', r.left + cw, r.top, 10 * cw, lh, theme.MODE_TREE]);
        text(r.left + cw, r.top, ' TERMINAL ', focused ? theme.BG : theme.COMMENT);
        const info = `${shell}  ${shown}${this.running ? '  running…' : ''}`;
        text(r.left + 12 * cw, r.top, info, theme.COMMENT);

        const x = r.left + cw;
        const cols = Math.max(Math.floor((r.right - x) / cw) - 1, 4);
        const promptTop = r.bottom - lh;
        const rows = Math.max(Math.floor((promptTop - (r.top + lh)) / lh), 1);
        this.rows = rows;

        // The tail of the output, with long lines wrapped, scrolled up by
        // `scroll` rows.
        const wanted = rows + this.scroll;
        const tail: { text: string; color: string }[] = [];
        const all = this.partial === '' ? this.lines : [...this.lines, { text: clean(this.partial), kind: 'Output' as const }];
        for (let i = all.length - 1; i >= 0 && tail.length < wanted; i--) {
            const line = all[i];
            const chars = Array.from(line.kind === 'Command' ? `❯ ${line.text}` : line.text);
            const color = line.kind === 'Command' ? theme.FUNCTION : line.kind === 'Note' ? theme.COMMENT : theme.FG;
            const pieces: string[] = [];
            for (let at = 0; at < Math.max(chars.length, 1); at += cols) pieces.push(chars.slice(at, at + cols).join(''));
            for (let p = pieces.length - 1; p >= 0 && tail.length < wanted; p--) tail.push({ text: pieces[p], color });
        }
        this.scroll = Math.min(this.scroll, Math.max(tail.length - rows, 0));
        const visible = tail.slice(this.scroll, this.scroll + rows).reverse();
        let y = promptTop - visible.length * lh;
        for (const row of visible) {
            text(x, y, row.text, row.color);
            y += lh;
        }

        // The prompt, with the part of the input around the cursor.
        cmds.push(['rect', r.left, promptTop, r.right - r.left, lh, theme.CURSOR_LINE]);
        text(x, promptTop, '❯', this.running ? theme.COMMENT : theme.MODE_TREE);
        const room = Math.max(cols - 2, 1);
        const chars = Array.from(this.input.text);
        const cursor = this.input.cursor;
        const from = Math.max(cursor - room + 1, 0);
        text(x + 2 * cw, promptTop, chars.slice(from, from + room).join(''), theme.FG);
        if (focused) {
            const cx = x + (2 + cursor - from) * cw;
            cmds.push(['rect', cx, promptTop, cw, lh, theme.CURSOR]);
            const under = chars[cursor];
            if (under !== undefined && under !== ' ') text(cx, promptTop, under, theme.BG);
        }
        cmds.push(['unclip']);
    }
}

/** Stop a process and what it started. */
function kill(proc: ChildProcess): void {
    const pid = proc.pid;
    if (process.platform === 'win32' && pid !== undefined) {
        nodeSpawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
        return;
    }
    const signal = (): void => {
        try {
            if (pid !== undefined) process.kill(-pid, 'SIGKILL');
            else proc.kill('SIGKILL');
        } catch {
            // Already gone.
        }
    };
    signal();
    // A process the shell was starting at that moment can miss the first
    // signal; the group lasts as long as any of it does.
    for (const ms of [50, 300]) setTimeout(signal, ms).unref();
}
