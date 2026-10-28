// The sidebar file tree, toggled with Ctrl+n.
//
// Keys while it has focus: `j`/`k` move, `gg`/`G` jump, `<CR>`/`o` open a
// file or toggle a directory, `l` expands, `h` collapses (or goes to the
// parent), `a` creates a file or directory, `dd` deletes one (after asking),
// `R` re-reads the disk, `q` hides the tree, `<Esc>` returns to the editor.
// `<BS>` collapses like `h`.
//
// Names are colored by their git status; a directory takes the status of
// what's changed inside it.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { KeyInput } from './editor/keys';
import { stripPrefix } from './paths';

/** Entries never shown in the tree. */
const HIDDEN = ['.git', '.DS_Store'];

/** A path's git status, as the tree colors it. Deleted files aren't in the
 * tree, but make their directories `Modified`. */
export type GitStatus = 'Untracked' | 'Staged' | 'Modified' | 'Conflict';

/** Which status a directory shows when it holds several. */
const STATUS_RANK: Record<GitStatus, number> = { Untracked: 1, Staged: 2, Modified: 3, Conflict: 4 };

export interface Row {
    path: string;
    name: string;
    isDir: boolean;
    depth: number;
    expanded: boolean;
    /** A directory with nothing (visible) in it. */
    empty: boolean;
    git: GitStatus | undefined;
}

export type TreeAction =
    | { t: 'None' }
    | { t: 'Open'; path: string }
    | { t: 'Close' }
    | { t: 'FocusEditor' }
    /** Ask for the name of a file to create in `dir`. */
    | { t: 'Create'; dir: string }
    /** Ask whether to delete `path`. */
    | { t: 'Delete'; path: string; isDir: boolean };

const NONE: TreeAction = { t: 'None' };

type Entry = [name: string, isDir: boolean];

export class FileTree {
    private expanded = new Set<string>();
    /** Directory listings, cached until `refresh`. */
    private listings = new Map<string, Entry[]>();
    /** Paths git ignores, hidden like nvim-tree's `git_ignored` filter. */
    private ignored: Set<string>;
    /** Changed paths, and the directories holding them. */
    private status = new Map<string, GitStatus>();
    /** Directories git doesn't track: everything in them is untracked. */
    private untrackedDirs: string[] = [];
    rows: Row[] = [];
    selected = 0;
    scroll = 0;
    private viewRows = 20;
    private pendingG = false;
    private pendingD = false;

    constructor(private root: string) {
        this.ignored = gitIgnored(root);
        this.readGitStatus();
        this.rebuild();
    }

    setRoot(root: string): void {
        if (root === this.root) return;
        this.ignored = gitIgnored(root);
        this.root = root;
        this.readGitStatus();
        this.expanded.clear();
        this.listings.clear();
        this.rows = [];
        this.selected = 0;
        this.scroll = 0;
        this.rebuild();
    }

    setViewRows(rows: number): void {
        this.viewRows = Math.max(rows, 1);
        this.keepSelectionVisible();
    }

    /** Re-read directories from disk. */
    refresh(): void {
        this.listings.clear();
        this.ignored = gitIgnored(this.root);
        this.readGitStatus();
        this.rebuild();
    }

    /** Read git's status again (after a file is written, say), without
     * re-reading directories. */
    refreshGitStatus(): void {
        this.readGitStatus();
        for (const row of this.rows) row.git = this.gitStatus(row.path);
    }

    private readGitStatus(): void {
        const { status, untrackedDirs } = gitStatus(this.root);
        this.status = status;
        this.untrackedDirs = untrackedDirs;
    }

    /** The git status of `p`, a file or directory under the root. */
    gitStatus(p: string): GitStatus | undefined {
        const s = this.status.get(p);
        if (s) return s;
        return this.untrackedDirs.some((d) => p.startsWith(d + path.sep)) ? 'Untracked' : undefined;
    }

    private listing(dir: string): Entry[] {
        const cached = this.listings.get(dir);
        if (cached) return cached;
        let entries: Entry[] = [];
        try {
            entries = fs
                .readdirSync(dir)
                .filter((name) => !HIDDEN.includes(name) && !this.ignored.has(path.join(dir, name)))
                .map((name): Entry => [name, isDirectory(path.join(dir, name))]);
        } catch {
            // Unreadable directories show as empty.
        }
        // Directories first, then case-insensitive by name.
        entries.sort((a, b) => Number(b[1]) - Number(a[1]) || compare(a[0].toLowerCase(), b[0].toLowerCase()));
        this.listings.set(dir, entries);
        return entries;
    }

    private rebuild(): void {
        const selectedPath = this.rows[this.selected]?.path;
        const rows: Row[] = [];
        this.pushChildren(this.root, 0, rows);
        this.rows = rows;
        const i = selectedPath === undefined ? -1 : rows.findIndex((r) => r.path === selectedPath);
        if (i >= 0) this.selected = i;
        this.selected = Math.min(this.selected, Math.max(rows.length - 1, 0));
        this.keepSelectionVisible();
    }

    private pushChildren(dir: string, depth: number, rows: Row[]): void {
        for (const [name, isDir] of this.listing(dir)) {
            const p = path.join(dir, name);
            const expanded = isDir && this.expanded.has(p);
            const empty = isDir && this.listing(p).length === 0;
            rows.push({ path: p, name, isDir, depth, expanded, empty, git: this.gitStatus(p) });
            if (expanded) this.pushChildren(p, depth + 1, rows);
        }
    }

    /** Expand the directories leading to `p` and select it. */
    reveal(p: string): void {
        const rel = stripPrefix(p, this.root);
        if (rel === undefined || rel === '') return;
        let dir = this.root;
        const components = rel.split(path.sep);
        for (const c of components.slice(0, -1)) {
            dir = path.join(dir, c);
            this.expanded.add(dir);
        }
        this.rebuild();
        const i = this.rows.findIndex((r) => r.path === p);
        if (i >= 0) this.select(i);
    }

    select(i: number): void {
        this.selected = Math.min(i, Math.max(this.rows.length - 1, 0));
        this.keepSelectionVisible();
    }

    /** Open the selected file, or toggle the selected directory. */
    activate(): TreeAction {
        const row = this.rows[this.selected];
        if (!row) return NONE;
        if (!row.isDir) return { t: 'Open', path: row.path };
        if (!this.expanded.delete(row.path)) this.expanded.add(row.path);
        this.rebuild();
        return NONE;
    }

    /** The directory new files go in: the selected directory, or the
     * selected file's. */
    private selectedDir(): string {
        const row = this.rows[this.selected];
        if (!row) return this.root;
        return row.isDir ? row.path : path.dirname(row.path);
    }

    /** Create `name` (relative to the tree's root) as nvim-tree's `a` does: a
     * trailing slash makes a directory, and missing parent directories are
     * created too. Selects it and returns its path; throws if it exists or
     * can't be made. */
    create(name: string): string {
        const dir = /[\\/]$/.test(name);
        const p = path.resolve(this.root, name);
        if (fs.existsSync(p)) throw new Error('it already exists');
        if (dir) {
            fs.mkdirSync(p, { recursive: true });
        } else {
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, '', { flag: 'wx' });
        }
        this.refresh();
        this.reveal(p);
        return p;
    }

    /** Delete `p` (a directory with everything in it) and re-read the
     * disk. Throws if it can't be deleted. */
    remove(p: string): void {
        const at = this.rows.findIndex((r) => r.path === p);
        fs.rmSync(p, { recursive: true });
        this.refresh();
        // The selection stays where the deleted row was.
        if (at >= 0) this.select(Math.min(at, this.rows.length - 1));
    }

    /** `p` relative to the tree's root, as shown in prompts. */
    relative(p: string): string {
        return stripPrefix(p, this.root) || p;
    }

    /** `dir` as typed in a prompt: relative to the root, with a trailing
     * separator (empty for the root itself). */
    promptPath(dir: string): string {
        const rel = stripPrefix(dir, this.root);
        return rel === undefined ? dir + path.sep : rel === '' ? '' : rel + path.sep;
    }

    private collapseOrParent(): void {
        const row = this.rows[this.selected];
        if (!row) return;
        if (row.expanded) {
            this.expanded.delete(row.path);
            this.rebuild();
            return;
        }
        const parent = path.dirname(row.path);
        const i = this.rows.findIndex((r) => r.path === parent);
        if (i >= 0) this.select(i);
    }

    scrollBy(delta: number): void {
        const max = Math.max(this.rows.length - this.viewRows, 0);
        this.scroll = Math.min(Math.max(this.scroll + delta, 0), max);
    }

    private keepSelectionVisible(): void {
        if (this.selected < this.scroll) this.scroll = this.selected;
        if (this.selected >= this.scroll + this.viewRows) this.scroll = this.selected + 1 - this.viewRows;
    }

    handleKey(key: KeyInput): TreeAction {
        const afterG = this.pendingG;
        const afterD = this.pendingD;
        this.pendingG = false;
        this.pendingD = false;
        const half = Math.max(Math.floor(this.viewRows / 2), 1);
        const k = key.key;
        const plain = !key.ctrl;
        if ((k === 'j' && plain) || k === 'Down') this.select(this.selected + 1);
        else if ((k === 'k' && plain) || k === 'Up') this.select(Math.max(this.selected - 1, 0));
        else if ((k === 'd' && key.ctrl) || k === 'PageDown') this.select(this.selected + half);
        else if ((k === 'u' && key.ctrl) || k === 'PageUp') this.select(Math.max(this.selected - half, 0));
        else if (k === 'g' && plain && afterG) this.select(0);
        else if (k === 'g' && plain) this.pendingG = true;
        else if (k === 'G' && plain) this.select(Number.MAX_SAFE_INTEGER);
        else if (k === 'Enter' || (k === 'o' && plain)) return this.activate();
        else if ((k === 'l' && plain) || k === 'Right') {
            const row = this.rows[this.selected];
            if (row && !row.expanded) return this.activate();
        } else if ((k === 'h' && plain) || k === 'Left' || k === 'Backspace') this.collapseOrParent();
        else if (k === 'R' && plain) this.refresh();
        else if (k === 'a' && plain) return { t: 'Create', dir: this.selectedDir() };
        else if (k === 'd' && plain && afterD) {
            const row = this.rows[this.selected];
            if (row) return { t: 'Delete', path: row.path, isDir: row.isDir };
        } else if (k === 'd' && plain) this.pendingD = true;
        else if (k === 'q' && plain) return { t: 'Close' };
        else if (k === 'Esc') return { t: 'FocusEditor' };
        return NONE;
    }
}

function compare(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function isDirectory(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

/** Changed paths under `root` with their status (directories take the
 * strongest status inside them), and directories git doesn't track. Empty
 * outside a repository. */
function gitStatus(root: string): { status: Map<string, GitStatus>; untrackedDirs: string[] } {
    const status = new Map<string, GitStatus>();
    const untrackedDirs: string[] = [];
    const git = (args: string[]) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    // Status paths are relative to the top of the repository.
    const top = git(['rev-parse', '--show-toplevel']);
    if (top.status !== 0 || typeof top.stdout !== 'string') return { status, untrackedDirs };
    const out = git(['status', '--porcelain=v1', '-z']);
    if (out.status !== 0 || typeof out.stdout !== 'string') return { status, untrackedDirs };
    // On Windows, git gives the top with forward slashes.
    const base = path.resolve(top.stdout.trim());
    const realRoot = realpath(root);
    const mark = (p: string, s: GitStatus): void => {
        // Through the directories up to the root, each keeping the strongest
        // status inside it.
        for (let at = p; ; at = path.dirname(at)) {
            const rel = stripPrefix(at, realRoot);
            if (rel === undefined) break;
            const shown = rel === '' ? root : path.join(root, rel);
            const old = status.get(shown);
            if (!old || STATUS_RANK[s] > STATUS_RANK[old]) status.set(shown, s);
            if (rel === '') break;
        }
    };
    const entries = out.stdout.split('\0');
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.length < 4) continue;
        const x = entry[0];
        const y = entry[1];
        const file = entry.slice(3);
        // A rename or copy is followed by the path it came from.
        if (x === 'R' || x === 'C') i++;
        const p = path.join(base, file.replace(/\/$/, ''));
        let s: GitStatus;
        if (x === '?') s = 'Untracked';
        else if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) s = 'Conflict';
        else if (y !== ' ') s = 'Modified';
        else s = x === 'D' ? 'Modified' : 'Staged';
        // A whole untracked directory is listed as just the directory.
        if (s === 'Untracked' && file.endsWith('/')) {
            const rel = stripPrefix(p, realRoot);
            if (rel !== undefined) untrackedDirs.push(rel === '' ? root : path.join(root, rel));
        }
        mark(p, s);
    }
    return { status, untrackedDirs };
}

function realpath(p: string): string {
    try {
        return fs.realpathSync.native(p);
    } catch {
        return p;
    }
}

/** Paths that git ignores under `root`; empty outside a repository. */
function gitIgnored(root: string): Set<string> {
    const out = spawnSync(
        'git',
        ['-C', root, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory'],
        { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
    );
    if (out.status !== 0 || typeof out.stdout !== 'string') return new Set();
    return new Set(
        out.stdout
            .split('\n')
            .filter((l) => l !== '')
            .map((l) => path.join(root, l.replace(/\/$/, ''))),
    );
}
