// Finding files and searching their text for the pickers, as Telescope's
// `find_files` and `live_grep` do: with ripgrep when it is installed, and
// with git or a directory walk and JavaScript regular expressions when not.

import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** A search in progress. */
export interface Search {
    cancel: () => void;
}

export interface GrepMatch {
    /** Relative to the search root. */
    file: string;
    /** From 0. */
    line: number;
    /** In code points, from 0. */
    col: number;
    text: string;
}

/** Paths left out of results (Telescope's `file_ignore_patterns`). */
const IGNORE = /(^|[\\/])node_modules([\\/]|$)/;
/** Live grep stops after this many matches. */
const MAX_MATCHES = 5000;
/** Matched lines are cut to this many characters. */
const MAX_LINE = 500;
/** Files larger than this are skipped when searching without ripgrep. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** The ripgrep arguments from the Neovim config's `vimgrep_arguments`, plus
 * NUL after file names so names with colons parse. */
const GREP_ARGS = ['-L', '--color=never', '--no-heading', '--with-filename', '--line-number', '--column', '--smart-case', '--null'];

/** Stop a child process. One that never started has no pid, and killing it
 * anyway would signal pid 0: this whole process group. */
function stop(proc: ChildProcess): void {
    if (proc.pid !== undefined && proc.exitCode === null && proc.signalCode === null) proc.kill();
}

/** Run `rg` with `args` in `root`, passing complete lines of output to
 * `onLines`. Calls `onMissing` instead if ripgrep isn't installed. */
function ripgrep(
    root: string,
    args: string[],
    onLines: (lines: string[]) => boolean | void,
    onDone: (error?: string) => void,
    onMissing: () => void,
): Search {
    let proc: ChildProcess;
    let done = false;
    let partial = '';
    let stderr = '';
    const finish = (error?: string): void => {
        if (done) return;
        done = true;
        onDone(error);
    };
    try {
        proc = spawn('rg', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch {
        onMissing();
        return { cancel: () => {} };
    }
    proc.stdout!.setEncoding('utf8');
    proc.stdout!.on('data', (chunk: string) => {
        if (done) return;
        const lines = (partial + chunk).split('\n');
        partial = lines.pop()!;
        // Returning true stops the search.
        if (onLines(lines.map((l) => l.replace(/\r$/, '')))) {
            stop(proc);
            finish();
        }
    });
    proc.stderr!.setEncoding('utf8');
    proc.stderr!.on('data', (chunk: string) => {
        stderr += chunk;
    });
    proc.on('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT' && !done) {
            done = true;
            onMissing();
        } else {
            finish(e.message);
        }
    });
    proc.on('close', (code) => {
        if (partial !== '' && !done) onLines([partial]);
        // 1 means nothing matched; 2 is an error such as a bad pattern
        // (often with some results anyway).
        const message = stderr.trim().split('\n').filter((l) => l !== '');
        finish(code === 2 && message.length > 0 ? message[message.length - 1] : undefined);
    });
    return {
        cancel: () => {
            done = true;
            stop(proc);
        },
    };
}

/** Files under `root` that git doesn't ignore, without ripgrep. */
function listFiles(root: string): string[] {
    const git = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 256 * 1024 * 1024,
    });
    if (git.status === 0 && typeof git.stdout === 'string') {
        return git.stdout.split('\0').filter((f) => f !== '' && fs.existsSync(path.join(root, f)));
    }
    // Not a repository: walk, skipping hidden files as ripgrep does.
    const out: string[] = [];
    const walk = (dir: string): void => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            if (e.name.startsWith('.')) continue;
            const rel = dir === '' ? e.name : path.join(dir, e.name);
            if (e.isDirectory()) walk(rel);
            else if (e.isFile()) out.push(rel);
        }
    };
    walk('');
    return out;
}

/** List the files under `root`, in batches. */
export function findFiles(root: string, onFiles: (files: string[]) => void, onDone: (error?: string) => void): Search {
    let cancelled = false;
    const search = ripgrep(
        root,
        ['--files', '--color', 'never'],
        (lines) => {
            const files = lines.filter((f) => f !== '' && !IGNORE.test(f));
            if (files.length > 0) onFiles(files);
        },
        onDone,
        () =>
            setImmediate(() => {
                if (cancelled) return;
                onFiles(listFiles(root).filter((f) => !IGNORE.test(f)));
                onDone();
            }),
    );
    return {
        cancel: () => {
            cancelled = true;
            search.cancel();
        },
    };
}

/** The code point column for a byte offset into `text`. */
function charCol(text: string, byte: number): number {
    let bytes = 0;
    let col = 0;
    for (const c of text) {
        if (bytes >= byte) break;
        bytes += Buffer.byteLength(c);
        col++;
    }
    return col;
}

function truncate(text: string): string {
    return text.length > MAX_LINE ? text.slice(0, MAX_LINE) : text;
}

/** Search the files under `root` for `pattern` (a regular expression, case
 * insensitive unless it has capitals), passing matches in batches. */
export function liveGrep(
    root: string,
    pattern: string,
    onMatches: (matches: GrepMatch[]) => void,
    onDone: (error?: string) => void,
): Search {
    let cancelled = false;
    let count = 0;
    const search = ripgrep(
        root,
        [...GREP_ARGS, '--', pattern],
        (lines) => {
            const matches: GrepMatch[] = [];
            for (const l of lines) {
                const nul = l.indexOf('\0');
                const m = nul < 0 ? undefined : /^(\d+):(\d+):(.*)$/.exec(l.slice(nul + 1));
                if (!m) continue;
                const file = l.slice(0, nul);
                if (IGNORE.test(file)) continue;
                matches.push({ file, line: Number(m[1]) - 1, col: charCol(m[3], Number(m[2]) - 1), text: truncate(m[3]) });
            }
            count += matches.length;
            if (matches.length > 0) onMatches(matches);
            return count >= MAX_MATCHES;
        },
        onDone,
        () => {
            let re: RegExp;
            try {
                re = new RegExp(pattern, /\p{Lu}/u.test(pattern) ? 'u' : 'iu');
            } catch (e) {
                onDone((e as Error).message);
                return;
            }
            const files = listFiles(root).filter((f) => !IGNORE.test(f));
            // Search a few files at a time so typing stays responsive.
            const step = (i: number): void => {
                if (cancelled) return;
                const matches: GrepMatch[] = [];
                for (const file of files.slice(i, i + 50)) {
                    let bytes: Buffer;
                    try {
                        bytes = fs.readFileSync(path.join(root, file));
                    } catch {
                        continue;
                    }
                    if (bytes.length > MAX_FILE_BYTES || bytes.subarray(0, 8000).includes(0)) continue;
                    bytes
                        .toString('utf8')
                        .split(/\r?\n/)
                        .forEach((text, line) => {
                            const m = re.exec(text);
                            if (m) matches.push({ file, line, col: Array.from(text.slice(0, m.index)).length, text: truncate(text) });
                        });
                }
                count += matches.length;
                if (matches.length > 0) onMatches(matches);
                if (i + 50 < files.length && count < MAX_MATCHES) setImmediate(() => step(i + 50));
                else onDone();
            };
            setImmediate(() => step(0));
        },
    );
    return {
        cancel: () => {
            cancelled = true;
            search.cancel();
        },
    };
}
