// The sidebar file tree, toggled with Ctrl+n.
//
// Keys while it has focus: `j`/`k` move, `gg`/`G` jump, `<CR>`/`o` open a
// file or toggle a directory, `l` expands, `h` collapses (or goes to the
// parent), `a` creates a file or directory, `R` re-reads the disk, `q` hides
// the tree, `<Esc>` returns to the editor.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { KeyInput } from './editor/keys';
import { stripPrefix } from './paths';

/** Entries never shown in the tree. */
const HIDDEN = ['.git', '.DS_Store'];

export interface Row {
    path: string;
    name: string;
    isDir: boolean;
    depth: number;
    expanded: boolean;
    /** A directory with nothing (visible) in it. */
    empty: boolean;
}

export type TreeAction =
    | { t: 'None' }
    | { t: 'Open'; path: string }
    | { t: 'Close' }
    | { t: 'FocusEditor' }
    /** Ask for the name of a file to create in `dir`. */
    | { t: 'Create'; dir: string };

const NONE: TreeAction = { t: 'None' };

type Entry = [name: string, isDir: boolean];

export class FileTree {
    private expanded = new Set<string>();
    /** Directory listings, cached until `refresh`. */
    private listings = new Map<string, Entry[]>();
    /** Paths git ignores, hidden like nvim-tree's `git_ignored` filter. */
    private ignored: Set<string>;
    rows: Row[] = [];
    selected = 0;
    scroll = 0;
    private viewRows = 20;
    private pendingG = false;

    constructor(private root: string) {
        this.ignored = gitIgnored(root);
        this.rebuild();
    }

    setRoot(root: string): void {
        if (root === this.root) return;
        this.ignored = gitIgnored(root);
        this.root = root;
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
        this.rebuild();
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
            rows.push({ path: p, name, isDir, depth, expanded, empty });
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
        this.pendingG = false;
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
        } else if ((k === 'h' && plain) || k === 'Left') this.collapseOrParent();
        else if (k === 'R' && plain) this.refresh();
        else if (k === 'a' && plain) return { t: 'Create', dir: this.selectedDir() };
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
