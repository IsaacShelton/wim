// Which lines of a buffer differ from git's copy of its file, for the marks
// at the left of the gutter. As gitsigns does in Neovim, the copy is the one
// in the index, and the buffer's text is compared as it is edited, not as
// last written.

import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

/** How a line differs: new, changed, or with lines removed just below it
 * (`DeletedAbove`: just above the first line). */
export type LineChange = 'Added' | 'Modified' | 'Deleted' | 'DeletedAbove';

/** Hunks of `a` replaced by `b`: `[aStart, aEnd, bStart, bEnd]`. */
export type Hunk = [number, number, number, number];

/** Past this many lines changed, the changed middle is one hunk. */
const MAX_EDITS = 1000;

/** The hunks that turn `a` into `b` (Myers' diff, after the lines the two
 * start and end with in common). */
export function diffLines(a: readonly string[], b: readonly string[]): Hunk[] {
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let aEnd = a.length;
    let bEnd = b.length;
    while (aEnd > start && bEnd > start && a[aEnd - 1] === b[bEnd - 1]) {
        aEnd--;
        bEnd--;
    }
    if (start === aEnd && start === bEnd) return [];
    const aKept = new Uint8Array(aEnd - start);
    const bKept = new Uint8Array(bEnd - start);
    if (!matchLines(a.slice(start, aEnd), b.slice(start, bEnd), aKept, bKept)) return [[start, aEnd, start, bEnd]];
    // Runs of lines that aren't kept, between the kept ones (which pair up
    // in order), are the hunks.
    const hunks: Hunk[] = [];
    let i = 0;
    let j = 0;
    while (i < aKept.length || j < bKept.length) {
        if (i < aKept.length && j < bKept.length && aKept[i] && bKept[j]) {
            i++;
            j++;
            continue;
        }
        const i0 = i;
        const j0 = j;
        while (i < aKept.length && !aKept[i]) i++;
        while (j < bKept.length && !bKept[j]) j++;
        hunks.push([start + i0, start + i, start + j0, start + j]);
    }
    return hunks;
}

/** Mark the lines of `a` and `b` in a longest common subsequence, or return
 * false when they differ by more than `MAX_EDITS`. */
function matchLines(a: readonly string[], b: readonly string[], aKept: Uint8Array, bKept: Uint8Array): boolean {
    const n = a.length;
    const m = b.length;
    const limit = Math.min(n + m, MAX_EDITS);
    const offset = limit + 1;
    // The furthest x reached on each diagonal k = x - y, at `offset + k`.
    const v = new Int32Array(2 * limit + 3);
    // `v` on diagonals -d..d before each step d, for walking back.
    const trace: Int32Array[] = [];
    for (let d = 0; d <= limit; d++) {
        trace.push(v.slice(offset - d, offset + d + 1));
        for (let k = -d; k <= d; k += 2) {
            let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
            let y = x - k;
            while (x < n && y < m && a[x] === b[y]) {
                x++;
                y++;
            }
            v[offset + k] = x;
            if (x >= n && y >= m) {
                walkBack(trace, d, n, m, aKept, bKept);
                return true;
            }
        }
    }
    return false;
}

function walkBack(trace: readonly Int32Array[], last: number, n: number, m: number, aKept: Uint8Array, bKept: Uint8Array): void {
    let x = n;
    let y = m;
    for (let d = last; d > 0; d--) {
        const v = trace[d];
        const at = (k: number): number => v[k + d];
        const k = x - y;
        const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
        const prevX = at(prevK);
        const prevY = prevX - prevK;
        // The diagonal run after the edit is in common.
        while (x > prevX && y > prevY) {
            aKept[--x] = 1;
            bKept[--y] = 1;
        }
        x = prevX;
        y = prevY;
    }
    while (x > 0 && y > 0) {
        aKept[--x] = 1;
        bKept[--y] = 1;
    }
}

/** How each line of `current` differs from `base` (undefined: it doesn't). */
export function lineChanges(base: readonly string[], current: readonly string[]): (LineChange | undefined)[] {
    const out: (LineChange | undefined)[] = new Array(current.length).fill(undefined);
    for (const [aStart, aEnd, bStart, bEnd] of diffLines(base, current)) {
        const removed = aEnd - aStart;
        if (bEnd === bStart) {
            if (bStart > 0) out[bStart - 1] = 'Deleted';
            else if (current.length > 0) out[0] = 'DeletedAbove';
            continue;
        }
        // Lines in place of removed ones are changed; any beyond are new.
        for (let j = bStart; j < bEnd; j++) out[j] = j - bStart < removed ? 'Modified' : 'Added';
    }
    return out;
}

/** A buffer's text, whose version changes with its content. */
export interface Source {
    version(): number;
    lineCount(): number;
    lineString(i: number): string;
}

/** How long git's copy of a file is trusted before being read again, in ms
 * (it can change from outside: a commit in another terminal). */
const BASE_TTL = 3000;

/** The lines of a file's text, as a buffer splits them. */
function splitLines(text: string): string[] {
    const body = text.endsWith('\n') ? text.slice(0, -1) : text;
    return body.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** Git's copy of `file`: its lines in the index, empty for a file git
 * doesn't track yet (every line is new), or undefined outside a repository
 * and for ignored files. */
export function readBase(file: string): string[] | undefined {
    const dir = path.dirname(file);
    const name = path.basename(file);
    const git = (args: string[]) =>
        spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    const shown = git(['show', `:./${name}`]);
    if (shown.status === 0 && typeof shown.stdout === 'string') return splitLines(shown.stdout);
    // Not in the index: 0 is ignored, 1 untracked, and anything else isn't
    // in a repository.
    return git(['check-ignore', '-q', '--', name]).status === 1 ? [] : undefined;
}

/** The changes in each buffer, kept until the buffer or git's copy changes. */
export class GitDiff {
    private bases = new Map<string, { at: number; lines: string[] | undefined }>();
    private changes = new WeakMap<Source, { version: number; base: string[]; out: (LineChange | undefined)[] }>();

    constructor(private readonly read: (file: string) => string[] | undefined = readBase) {}

    /** Files may have changed in git: read its copies again. */
    invalidate(): void {
        this.bases.clear();
    }

    /** How each line of the buffer for `file` differs from git's copy, or
     * undefined when git has no say. */
    lineChanges(file: string | undefined, buffer: Source): readonly (LineChange | undefined)[] | undefined {
        if (file === undefined) return undefined;
        const p = path.resolve(file);
        const now = Date.now();
        let base = this.bases.get(p);
        if (!base || now - base.at > BASE_TTL) {
            base = { at: now, lines: this.read(p) };
            // Keep the same lines while they're the same, so the diff isn't
            // done again.
            const old = this.bases.get(p)?.lines;
            if (old && base.lines && old.length === base.lines.length && old.every((l, i) => l === base!.lines![i])) base.lines = old;
            this.bases.set(p, base);
        }
        if (!base.lines) return undefined;
        const cached = this.changes.get(buffer);
        if (cached && cached.version === buffer.version() && cached.base === base.lines) return cached.out;
        const current: string[] = [];
        for (let i = 0; i < buffer.lineCount(); i++) current.push(buffer.lineString(i));
        const out = lineChanges(base.lines, current);
        this.changes.set(buffer, { version: buffer.version(), base: base.lines, out });
        return out;
    }
}
