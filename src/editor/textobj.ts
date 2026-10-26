// Text objects (`iw`, `a"`, `i(`, `ap`, ...).

import { Pos, isWhitespace, pos, posEq } from './buffer';
import { TextObject } from './command';
import type { Editor } from './editor';
import { advance, charClass, retreat } from './motion';
import { Range, charRange, lineRange } from './range';

export function textObject(ed: Editor, obj: TextObject, around: boolean, count: number): Range | undefined {
    switch (obj.t) {
        case 'Word':
            return wordObject(ed, obj.big, around, count);
        case 'Quote':
            return quoteObject(ed, obj.q, around);
        case 'Pair':
            return pairObject(ed, obj.open, obj.close, around, count);
        case 'Paragraph':
            return paragraphObject(ed, around, count);
    }
}

function wordObject(ed: Editor, big: boolean, around: boolean, count: number): Range | undefined {
    const lineNo = ed.cursor.line;
    const line = ed.buffer.line(lineNo);
    if (line.length === 0) return undefined;
    const len = line.length;
    const cls = (i: number): number => charClass(line[i], big);
    const col = Math.min(ed.cursor.col, len - 1);
    const runEnd = (e: number): number => {
        const c = cls(e);
        while (e < len && cls(e) === c) e++;
        return e;
    };
    const startCls = cls(col);
    let s = col;
    while (s > 0 && cls(s - 1) === startCls) s--;
    let e = runEnd(col);
    for (let i = 1; i < count; i++) {
        if (e >= len) break;
        e = runEnd(e);
    }
    if (around) {
        if (startCls !== 0) {
            if (e < len && cls(e) === 0) {
                e = runEnd(e);
            } else {
                while (s > 0 && cls(s - 1) === 0) s--;
            }
        } else if (e < len) {
            e = runEnd(e);
        }
    }
    return charRange(pos(lineNo, s), pos(lineNo, e));
}

function quoteObject(ed: Editor, q: string, around: boolean): Range | undefined {
    const lineNo = ed.cursor.line;
    const line = ed.buffer.line(lineNo);
    const col = ed.cursor.col;
    const quotes: number[] = [];
    for (let i = 0; i < line.length; i++) {
        if (line[i] === q && (i === 0 || line[i - 1] !== '\\')) quotes.push(i);
    }
    let a: number;
    let b: number;
    const idx = quotes.indexOf(col);
    if (idx >= 0) {
        if (idx % 2 === 0) {
            if (idx + 1 >= quotes.length) return undefined;
            [a, b] = [col, quotes[idx + 1]];
        } else {
            [a, b] = [quotes[idx - 1], col];
        }
    } else {
        const before = quotes.filter((i) => i < col).pop();
        const after = quotes.find((i) => i > col);
        if (before !== undefined && after !== undefined) {
            [a, b] = [before, after];
        } else if (before === undefined && after !== undefined) {
            const next = quotes.find((i) => i > after);
            if (next === undefined) return undefined;
            [a, b] = [after, next];
        } else {
            return undefined;
        }
    }
    if (!around) return charRange(pos(lineNo, a + 1), pos(lineNo, b));
    let s = a;
    let e = b + 1;
    if (e < line.length && isWhitespace(line[e])) {
        while (e < line.length && isWhitespace(line[e])) e++;
    } else {
        while (s > 0 && isWhitespace(line[s - 1])) s--;
    }
    return charRange(pos(lineNo, s), pos(lineNo, e));
}

function pairObject(ed: Editor, open: string, close: string, around: boolean, count: number): Range | undefined {
    const buf = ed.buffer;
    let from: Pos = ed.cursor;
    let openPos: Pos | undefined;
    for (let i = 0; i < count; i++) {
        let p = from;
        let depth = 0;
        for (;;) {
            const c = buf.charAt(p);
            if (c === open) {
                if (depth === 0) break;
                depth--;
            } else if (c === close && !posEq(p, ed.cursor)) {
                depth++;
            }
            const q = retreat(buf, p);
            if (!q) return undefined;
            p = q;
        }
        openPos = p;
        const q = retreat(buf, p);
        if (!q) break;
        from = q;
    }
    if (!openPos) return undefined;
    let closePos = openPos;
    let depth = 0;
    for (;;) {
        const q = advance(buf, closePos);
        if (!q) return undefined;
        closePos = q;
        const c = buf.charAt(closePos);
        if (c === open) {
            depth++;
        } else if (c === close) {
            if (depth === 0) break;
            depth--;
        }
    }
    if (around) return charRange(openPos, pos(closePos.line, closePos.col + 1));
    let start = pos(openPos.line, openPos.col + 1);
    let end = closePos;
    // A block whose braces sit on their own lines is operated on linewise.
    if (start.col === buf.lineLen(start.line) && start.line < end.line) start = pos(start.line + 1, 0);
    if (buf.line(end.line).slice(0, end.col).every(isWhitespace) && end.line > start.line) {
        end = pos(end.line, 0);
        if (start.col === 0) return lineRange(start.line, end.line - 1);
        end = pos(end.line - 1, buf.lineLen(end.line - 1));
    }
    return charRange(start, end);
}

function paragraphObject(ed: Editor, around: boolean, count: number): Range {
    const buf = ed.buffer;
    const last = buf.lastLine();
    const line = ed.cursor.line;
    const blank = (l: number): boolean => buf.isBlankLine(l);
    const kind = blank(line);
    let s = line;
    while (s > 0 && blank(s - 1) === kind) s--;
    const runEnd = (e: number): number => {
        const k = blank(e);
        while (e < last && blank(e + 1) === k) e++;
        return e;
    };
    let e = runEnd(line);
    const extra = around ? 1 : 0;
    for (let i = 1; i < count + extra; i++) {
        if (e >= last) {
            if (around) {
                // No trailing blank lines: take the preceding ones instead.
                while (s > 0 && blank(s - 1) !== kind) s--;
            }
            break;
        }
        e = runEnd(e + 1);
    }
    return lineRange(s, e);
}
