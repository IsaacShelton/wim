// Cursor motions.

import { Buffer, Pos, isWhitespace, pos, posEq } from './buffer';
import { switchToBufferQuietly, openFile } from './buffers';
import { FindKind, Motion, findForward, findReversed, findTill } from './command';
import type { Editor } from './editor';
import { WANT_EOL, isInsert } from './mode';
import * as search from './search';
import { subwordTarget } from './subword';

export type MotionKind = 'Exclusive' | 'Inclusive' | 'Linewise';

export interface MotionTarget {
    pos: Pos;
    kind: MotionKind;
    /** Vertical motions keep the remembered column. */
    vertical: boolean;
}

function target(p: Pos, kind: MotionKind): MotionTarget {
    return { pos: p, kind, vertical: false };
}

/** Character classes for word motions: blank, punctuation, keyword. */
export function charClass(c: string, big: boolean): number {
    if (isWhitespace(c)) return 0;
    if (big || !isKeyword(c)) return 1;
    return 2;
}

export function isKeyword(c: string): boolean {
    return /^[\p{L}\p{N}_]$/u.test(c);
}

/** Class at `p`; the end-of-line position counts as blank. */
function classAt(buf: Buffer, p: Pos, big: boolean): number {
    const c = buf.charAt(p);
    return c === undefined ? 0 : charClass(c, big);
}

/** Step forward one position, treating each line break as a position.
 * Returns the new position, or `undefined` at the end of the buffer. */
export function advance(buf: Buffer, p: Pos): Pos | undefined {
    if (p.col < buf.lineLen(p.line)) return pos(p.line, p.col + 1);
    if (p.line < buf.lastLine()) return pos(p.line + 1, 0);
    return undefined;
}

export function retreat(buf: Buffer, p: Pos): Pos | undefined {
    if (p.col > 0) return pos(p.line, p.col - 1);
    if (p.line > 0) return pos(p.line - 1, buf.lineLen(p.line - 1));
    return undefined;
}

function isEmptyLineStart(buf: Buffer, p: Pos): boolean {
    return p.col === 0 && buf.lineLen(p.line) === 0;
}

export function nextWordStart(buf: Buffer, start: Pos, big: boolean): Pos {
    let p = start;
    const cls = classAt(buf, p, big);
    if (cls !== 0) {
        while (classAt(buf, p, big) === cls) {
            const q = advance(buf, p);
            if (!q) return p;
            p = q;
        }
    }
    for (;;) {
        if (classAt(buf, p, big) !== 0 || (isEmptyLineStart(buf, p) && p.line !== start.line)) return p;
        const q = advance(buf, p);
        if (!q) return p;
        p = q;
    }
}

export function prevWordStart(buf: Buffer, start: Pos, big: boolean): Pos {
    let p = retreat(buf, start);
    if (!p) return start;
    while (classAt(buf, p, big) === 0) {
        if (isEmptyLineStart(buf, p)) return p;
        const q = retreat(buf, p);
        if (!q) return p;
        p = q;
    }
    const cls = classAt(buf, p, big);
    for (;;) {
        const q = retreat(buf, p);
        if (!q || classAt(buf, q, big) !== cls) return p;
        p = q;
    }
}

export function wordEnd(buf: Buffer, start: Pos, big: boolean): Pos {
    let p = advance(buf, start);
    if (!p) return start;
    while (classAt(buf, p, big) === 0) {
        const q = advance(buf, p);
        if (!q) return p;
        p = q;
    }
    return endOfRun(buf, p, big);
}

/** The last position of the run of same-class characters containing `p`. */
export function endOfRun(buf: Buffer, p: Pos, big: boolean): Pos {
    const cls = classAt(buf, p, big);
    for (;;) {
        const q = advance(buf, p);
        if (!q || classAt(buf, q, big) !== cls || q.line !== p.line) return p;
        p = q;
    }
}

function prevWordEnd(buf: Buffer, start: Pos, big: boolean): Pos {
    let p = start;
    const cls = classAt(buf, p, big);
    if (cls !== 0) {
        while (classAt(buf, p, big) === cls) {
            const q = retreat(buf, p);
            if (!q) return p;
            p = q;
        }
    }
    for (;;) {
        if (classAt(buf, p, big) !== 0 || (isEmptyLineStart(buf, p) && !posEq(p, start))) return p;
        const q = retreat(buf, p);
        if (!q) return p;
        p = q;
    }
}

function findInLine(
    line: readonly string[],
    col: number,
    kind: FindKind,
    c: string,
    count: number,
    repeat: boolean,
): number | undefined {
    for (let i = 0; i < count; i++) {
        // When repeating `t`/`T`, skip the character we are already next to.
        const skip = findTill(kind) && (i > 0 || repeat) ? 1 : 0;
        if (findForward(kind)) {
            let found: number | undefined;
            for (let j = col + 1 + skip; j < line.length; j++) {
                if (line[j] === c) {
                    found = j;
                    break;
                }
            }
            if (found === undefined) return undefined;
            col = findTill(kind) ? found - 1 : found;
        } else {
            let found: number | undefined;
            for (let j = Math.max(col - skip, 0) - 1; j >= 0; j--) {
                if (line[j] === c) {
                    found = j;
                    break;
                }
            }
            if (found === undefined) return undefined;
            col = findTill(kind) ? found + 1 : found;
        }
    }
    return col;
}

export function matchingPair(buf: Buffer, from: Pos): Pos | undefined {
    const line = buf.line(from.line);
    let col = -1;
    for (let j = from.col; j < line.length; j++) {
        if ('()[]{}'.includes(line[j])) {
            col = j;
            break;
        }
    }
    if (col < 0) return undefined;
    const c = line[col];
    const forward = '([{'.includes(c);
    const open = c === '(' || c === ')' ? '(' : c === '[' || c === ']' ? '[' : '{';
    const close = { '(': ')', '[': ']', '{': '}' }[open] as string;
    let p: Pos = pos(from.line, col);
    let depth = 0;
    for (;;) {
        const q = forward ? advance(buf, p) : retreat(buf, p);
        if (!q) return undefined;
        p = q;
        const x = buf.charAt(p);
        if (x === (forward ? open : close)) {
            depth += 1;
        } else if (x === (forward ? close : open)) {
            if (depth === 0) return p;
            depth -= 1;
        }
    }
}

/** Evaluate a motion from the cursor. `forOp` is set when the motion is the
 * target of an operator, which allows positions past the last char. */
export function evalMotion(
    ed: Editor,
    motion: Motion,
    count: number | undefined,
    forOp: boolean,
): MotionTarget | undefined {
    if (motion.t === 'Mark' && /^[A-Z]$/.test(motion.name) && !enterMarkBuffer(ed, motion.name, forOp)) {
        ed.setError('E20: Mark not set');
        return undefined;
    }
    const n = count ?? 1;
    const buf = ed.buffer;
    const cur = ed.cursor;
    const last = buf.lastLine();
    const len = buf.lineLen(cur.line);
    const firstNonBlank = (line: number): Pos => pos(line, buf.firstNonBlank(line));

    switch (motion.t) {
        case 'Left':
            return target(pos(cur.line, Math.max(cur.col - n, 0)), 'Exclusive');
        case 'Right': {
            const max = forOp || isInsert(ed.mode) ? len : Math.max(len - 1, 0);
            return target(pos(cur.line, Math.min(cur.col + n, max)), 'Exclusive');
        }
        case 'Up':
        case 'Down': {
            const line = motion.t === 'Up' ? Math.max(cur.line - n, 0) : Math.min(cur.line + n, last);
            if (line === cur.line) return undefined;
            return { pos: pos(line, ed.colForWant(line)), kind: 'Linewise', vertical: true };
        }
        case 'WordForward':
        case 'WordBackward':
        case 'WordEnd':
        case 'WordEndBackward': {
            const step = {
                WordForward: nextWordStart,
                WordBackward: prevWordStart,
                WordEnd: wordEnd,
                WordEndBackward: prevWordEnd,
            }[motion.t];
            let p = cur;
            for (let i = 0; i < n; i++) p = step(buf, p, motion.big);
            const inclusive = motion.t === 'WordEnd' || motion.t === 'WordEndBackward';
            return target(p, inclusive ? 'Inclusive' : 'Exclusive');
        }
        case 'Subword': {
            const inclusive = motion.motion === 'e' || motion.motion === 'ge';
            return target(subwordTarget(buf, cur, motion.motion, n), inclusive ? 'Inclusive' : 'Exclusive');
        }
        case 'LineStart':
            return target(pos(cur.line, 0), 'Exclusive');
        case 'FirstNonBlank':
            return target(firstNonBlank(cur.line), 'Exclusive');
        case 'LineEnd': {
            const line = Math.min(cur.line + n - 1, last);
            return target(pos(line, Math.max(buf.lineLen(line) - 1, 0)), 'Inclusive');
        }
        case 'LastNonBlank': {
            const line = Math.min(cur.line + n - 1, last);
            const chars = buf.line(line);
            let col = 0;
            for (let i = chars.length - 1; i >= 0; i--) {
                if (!isWhitespace(chars[i])) {
                    col = i;
                    break;
                }
            }
            return target(pos(line, col), 'Inclusive');
        }
        case 'Column': {
            const col = Math.min(ed.colFromDisplay(cur.line, n - 1), Math.max(len - 1, 0));
            return target(pos(cur.line, col), 'Exclusive');
        }
        case 'FileStart':
        case 'FileEnd': {
            const fallback = motion.t === 'FileStart' ? 0 : last;
            const line = count === undefined ? fallback : Math.min(Math.max(count - 1, 0), last);
            return target(firstNonBlank(line), 'Linewise');
        }
        case 'NextLineStart':
        case 'PrevLineStart':
        case 'CurrentLineStart': {
            let line: number;
            if (motion.t === 'NextLineStart') line = cur.line + n;
            else if (motion.t === 'PrevLineStart') line = cur.line - n;
            else line = cur.line + n - 1;
            if (line < 0 || line > last) return undefined;
            return target(firstNonBlank(line), 'Linewise');
        }
        case 'Find':
            ed.lastFind = [motion.kind, motion.ch];
            return findChar(ed, motion.kind, motion.ch, n, false);
        case 'RepeatFind':
        case 'RepeatFindReverse': {
            if (!ed.lastFind) return undefined;
            const [kind, c] = ed.lastFind;
            return findChar(ed, motion.t === 'RepeatFind' ? kind : findReversed(kind), c, n, true);
        }
        case 'MatchPair': {
            if (count !== undefined) {
                const line = Math.max(Math.ceil((Math.min(count, 100) * buf.lineCount()) / 100) - 1, 0);
                return target(firstNonBlank(line), 'Linewise');
            }
            const p = matchingPair(buf, cur);
            return p && target(p, 'Inclusive');
        }
        case 'ParagraphForward': {
            // Over blank lines, then to the blank line after the paragraph.
            let line = cur.line;
            for (let i = 0; i < n; i++) {
                while (line <= last && buf.lineLen(line) === 0) line += 1;
                while (line <= last && buf.lineLen(line) !== 0) line += 1;
                if (line > last) break;
            }
            return target(line > last ? buf.endPos() : pos(line, 0), 'Exclusive');
        }
        case 'ParagraphBackward': {
            let line = cur.line;
            for (let i = 0; i < n; i++) {
                while (line >= 0 && buf.lineLen(line) === 0) line -= 1;
                while (line >= 0 && buf.lineLen(line) !== 0) line -= 1;
                if (line < 0) break;
            }
            return target(pos(Math.max(line, 0), 0), 'Exclusive');
        }
        case 'ScreenTop':
        case 'ScreenMiddle':
        case 'ScreenBottom': {
            const so = ed.scrolloff();
            const top = ed.scrollTop;
            const bottom = Math.min(top + ed.viewRows - 1, last);
            let line: number;
            if (motion.t === 'ScreenTop') {
                const min = top === 0 ? 0 : so;
                line = Math.min(top + Math.max(n - 1, min), bottom);
            } else if (motion.t === 'ScreenBottom') {
                const min = bottom === last ? 0 : so;
                line = Math.max(bottom - Math.max(n - 1, min), top, 0);
            } else {
                line = top + Math.floor((bottom - top) / 2);
            }
            return target(firstNonBlank(line), 'Linewise');
        }
        case 'SearchNext':
        case 'SearchPrev':
            return searchMotion(ed, motion.t === 'SearchNext', n);
        case 'Unmatched': {
            const forward = motion.ch === '}' || motion.ch === ')';
            const [open, close] = motion.ch === '{' || motion.ch === '}' ? ['{', '}'] : ['(', ')'];
            let p: Pos | undefined = cur;
            for (let i = 0; i < n && p; i++) p = findUnmatched(buf, p, open, close, forward);
            return p && target(p, 'Exclusive');
        }
        case 'Mark': {
            const name = motion.name === '`' ? "'" : motion.name;
            const p = markPos(ed, name);
            if (!p) {
                ed.setError('E20: Mark not set');
                return undefined;
            }
            const line = Math.min(p.line, last);
            if (motion.exact) {
                return target(pos(line, Math.min(p.col, Math.max(buf.lineLen(line) - 1, 0))), 'Exclusive');
            }
            return target(firstNonBlank(line), 'Linewise');
        }
    }
}

/** Make the buffer holding uppercase mark `name` active. Operators can't span
 * buffers, so for them the mark must be in this buffer. */
function enterMarkBuffer(ed: Editor, name: string, forOp: boolean): boolean {
    const mark = ed.globalMarks.get(name);
    if (!mark) return false;
    if (mark.bufferId === ed.bufferId()) return true;
    if (forOp) return false;
    if (!switchToBufferQuietly(ed, mark.bufferId)) {
        if (mark.path === undefined) return false;
        openFile(ed, mark.path);
    }
    mark.bufferId = ed.bufferId();
    return true;
}

function markPos(ed: Editor, name: string): Pos | undefined {
    return /^[A-Z]$/.test(name) ? ed.globalMarks.get(name)?.pos : ed.marks.get(name);
}

function findChar(ed: Editor, kind: FindKind, c: string, count: number, repeat: boolean): MotionTarget | undefined {
    const col = findInLine(ed.buffer.line(ed.cursor.line), ed.cursor.col, kind, c, count, repeat);
    if (col === undefined) return undefined;
    return target(pos(ed.cursor.line, col), findForward(kind) ? 'Inclusive' : 'Exclusive');
}

function searchMotion(ed: Editor, sameDirection: boolean, count: number): MotionTarget | undefined {
    const last = ed.lastSearch;
    if (!last) {
        ed.setError('E35: No previous regular expression');
        return undefined;
    }
    const re = ed.regexFor(last.pattern);
    if (!re) {
        ed.setError(`E486: Invalid pattern: ${last.pattern}`);
        return undefined;
    }
    const forward = last.forward === sameDirection;
    let p = ed.cursor;
    let wrapped = false;
    for (let i = 0; i < count; i++) {
        const found = search.find(ed.buffer, re, p, forward);
        if (!found) {
            ed.setError(`E486: Pattern not found: ${last.pattern}`);
            return undefined;
        }
        p = found[0];
        wrapped ||= found[1];
    }
    ed.hlsearchActive = true;
    if (wrapped) {
        ed.setError(forward ? 'search hit BOTTOM, continuing at TOP' : 'search hit TOP, continuing at BOTTOM');
    } else {
        ed.setMessage((last.forward ? '/' : '?') + last.pattern);
    }
    return target(p, 'Exclusive');
}

/** Move the cursor to a motion target (outside of an operator). */
export function moveTo(ed: Editor, motion: Motion, t: MotionTarget): void {
    if (isJump(motion) && t.pos.line !== ed.cursor.line) ed.markJump();
    ed.cursor = t.pos;
    ed.clampCursor();
    if (motion.t === 'LineEnd') ed.wantCol = WANT_EOL;
    else if (!t.vertical) ed.updateWantCol();
}

function isJump(m: Motion): boolean {
    return [
        'FileStart',
        'FileEnd',
        'SearchNext',
        'SearchPrev',
        'MatchPair',
        'Mark',
        'ParagraphForward',
        'ParagraphBackward',
        'ScreenTop',
        'ScreenMiddle',
        'ScreenBottom',
    ].includes(m.t);
}

/** The next (or previous) bracket that is not matched between it and `from`
 * (`]}`, `[{`, `])`, `[(`). */
function findUnmatched(buf: Buffer, from: Pos, open: string, close: string, forward: boolean): Pos | undefined {
    const [same, wanted] = forward ? [open, close] : [close, open];
    let p = from;
    let depth = 0;
    for (;;) {
        const q = forward ? advance(buf, p) : retreat(buf, p);
        if (!q) return undefined;
        p = q;
        const c = buf.charAt(p);
        if (c === same) {
            depth += 1;
        } else if (c === wanted) {
            if (depth === 0) return p;
            depth -= 1;
        }
    }
}

/** Option+Left in macOS text fields: back over non-word characters, then to
 * the start of the word before them. */
export function macWordLeft(buf: Buffer, start: Pos): Pos {
    const isWordBefore = (p: Pos): boolean => {
        const q = retreat(buf, p);
        const c = q && buf.charAt(q);
        return c !== undefined && isKeyword(c);
    };
    let p = start;
    while (!isWordBefore(p)) {
        const q = retreat(buf, p);
        if (!q) return p;
        p = q;
    }
    while (isWordBefore(p)) p = retreat(buf, p) ?? p;
    return p;
}

/** Option+Right in macOS text fields: over non-word characters, then to the
 * end of the following word. */
export function macWordRight(buf: Buffer, start: Pos): Pos {
    const isWord = (p: Pos): boolean => {
        const c = buf.charAt(p);
        return c !== undefined && isKeyword(c);
    };
    let p = start;
    while (!isWord(p)) {
        const q = advance(buf, p);
        if (!q) return p;
        p = q;
    }
    while (isWord(p)) {
        const q = advance(buf, p);
        if (!q) break;
        p = q;
    }
    return p;
}
