// Operators and the other buffer-changing Normal/Visual mode commands.

import { Line, chars, isWhitespace, order, pos, posMax } from './buffer';
import { InsertKind, Motion, Operator, Scroll, Target, TextObject } from './command';
import type { Editor } from './editor';
import { evalMotion, endOfRun, isKeyword, moveTo, MotionTarget, retreat, wordEnd } from './motion';
import { Register } from './registers';
import { escape } from './search';
import { Range, charRange, lineRange } from './range';
import { textObject } from './textobj';

export function operate(ed: Editor, op: Operator, t: Target, count: number | undefined, reg: string | undefined): void {
    const n = count ?? 1;
    let range: Range | undefined;
    if (t.t === 'Line') {
        range = lineRange(ed.cursor.line, Math.min(ed.cursor.line + n - 1, ed.buffer.lastLine()));
    } else if (t.t === 'Object') {
        range = textObject(ed, t.obj, t.around, n);
    } else {
        const m = t.m;
        let mt: MotionTarget | undefined;
        const c = ed.buffer.charAt(ed.cursor);
        if (m.t === 'WordForward' && op === 'Change' && c !== undefined && !isWhitespace(c)) {
            // `cw` on a word behaves like `ce`.
            let p = endOfRun(ed.buffer, ed.cursor, m.big);
            for (let i = 1; i < n; i++) p = wordEnd(ed.buffer, p, m.big);
            mt = { pos: p, kind: 'Inclusive', vertical: false };
        } else {
            mt = evalMotion(ed, m, count, true);
        }
        range = mt && motionRange(ed, m, mt);
    }
    if (range) applyOperator(ed, op, range, reg);
}

function motionRange(ed: Editor, motion: Motion, t: MotionTarget): Range {
    const buf = ed.buffer;
    const [s, e0] = order(ed.cursor, t.pos);
    let e = e0;
    switch (t.kind) {
        case 'Linewise':
            return lineRange(s.line, e.line);
        case 'Inclusive':
            return charRange(s, pos(e.line, e.col + 1));
        case 'Exclusive':
            if (e.line > s.line && buf.line(e.line).slice(0, Math.min(e.col, buf.lineLen(e.line))).every(isWhitespace)) {
                if (motion.t === 'WordForward') {
                    // `dw` on the last word of a line stops at the line end.
                    e = pos(e.line - 1, buf.lineLen(e.line - 1));
                } else if (e.col === 0) {
                    if (buf.line(s.line).slice(0, s.col).every(isWhitespace)) return lineRange(s.line, e.line - 1);
                    e = pos(e.line - 1, buf.lineLen(e.line - 1));
                }
            }
            return charRange(s, e);
    }
}

function rangeRegister(ed: Editor, r: Range): Register {
    if (r.linewise) {
        const lines: string[] = [];
        for (let l = r.start.line; l <= r.end.line; l++) lines.push(ed.buffer.lineString(l));
        return { text: lines.join('\n'), linewise: true };
    }
    return { text: ed.buffer.textRange(r.start, r.end), linewise: false };
}

export function applyOperator(ed: Editor, op: Operator, r: Range, reg: string | undefined): void {
    switch (op) {
        case 'Yank': {
            ed.yankFlash = r;
            ed.registers.set(reg, rangeRegister(ed, r), 'Yank');
            if (r.linewise) {
                if (ed.cursor.line !== r.start.line) ed.cursor = pos(r.start.line, ed.cursor.col);
            } else {
                ed.cursor = r.start;
            }
            break;
        }
        case 'Delete': {
            const content = rangeRegister(ed, r);
            if (r.linewise) {
                ed.buffer.removeLines(r.start.line, r.end.line);
                const line = Math.min(r.start.line, ed.buffer.lastLine());
                ed.cursor = pos(line, ed.buffer.firstNonBlank(line));
            } else {
                ed.buffer.deleteRange(r.start, r.end);
                ed.cursor = r.start;
            }
            ed.registers.set(reg, content, 'Delete');
            break;
        }
        case 'Change': {
            const content = rangeRegister(ed, r);
            if (r.linewise) {
                const indent = ed.options.autoindent ? ed.buffer.indentOf(r.start.line) : [];
                const col = indent.length;
                ed.buffer.replaceLine(r.start.line, indent);
                if (r.end.line > r.start.line) ed.buffer.removeLines(r.start.line + 1, r.end.line);
                ed.cursor = pos(r.start.line, col);
            } else {
                ed.buffer.deleteRange(r.start, r.end);
                ed.cursor = r.start;
            }
            ed.registers.set(reg, content, 'Delete');
            ed.beginInsert(1, false);
            break;
        }
        case 'Indent':
        case 'Outdent': {
            const last = !r.linewise && r.end.col === 0 && r.end.line > r.start.line ? r.end.line - 1 : r.end.line;
            shiftLines(ed, r.start.line, last, op === 'Indent');
            ed.cursor = pos(r.start.line, ed.buffer.firstNonBlank(r.start.line));
            break;
        }
        case 'Lowercase':
        case 'Uppercase':
        case 'ToggleCase': {
            for (let line = r.start.line; line <= r.end.line; line++) {
                const cs = ed.buffer.line(line).slice();
                let from = 0;
                let to = cs.length;
                if (!r.linewise) {
                    from = line === r.start.line ? r.start.col : 0;
                    to = line === r.end.line ? Math.min(r.end.col, cs.length) : cs.length;
                }
                for (let i = Math.min(from, to); i < to; i++) cs[i] = changeCase(cs[i], op);
                ed.buffer.replaceLine(line, cs);
            }
            if (!r.linewise || ed.cursor.line !== r.start.line) {
                ed.cursor = pos(r.start.line, r.linewise ? ed.cursor.col : r.start.col);
            }
            break;
        }
    }
}

export function shiftLines(ed: Editor, first: number, last: number, indent: boolean): void {
    const sw = Math.max(ed.options.shiftwidth, 1);
    const unit = ed.indentUnit();
    for (let line = first; line <= Math.min(last, ed.buffer.lastLine()); line++) {
        let cs = ed.buffer.line(line).slice();
        if (indent) {
            if (cs.length > 0) cs = unit.concat(cs);
        } else if (cs[0] === '\t') {
            cs.shift();
        } else {
            let n = 0;
            while (n < sw && cs[n] === ' ') n++;
            cs.splice(0, n);
        }
        ed.buffer.replaceLine(line, cs);
    }
}

export function paste(ed: Editor, reg: string | undefined, before: boolean, count: number): void {
    const content = ed.registers.get(reg);
    if (!content) {
        ed.setError(`E353: Nothing in register ${reg ?? '"'}`);
        return;
    }
    const cur = ed.cursor;
    if (content.linewise) {
        const lines: Line[] = [];
        for (let i = 0; i < count; i++) lines.push(...content.text.split('\n').map(chars));
        const at = before ? cur.line : cur.line + 1;
        ed.buffer.insertLines(at, lines);
        ed.cursor = pos(at, ed.buffer.firstNonBlank(at));
    } else {
        const text = content.text.repeat(count);
        const at = before || ed.buffer.lineLen(cur.line) === 0 ? cur : pos(cur.line, cur.col + 1);
        const end = ed.buffer.insertText(at, text);
        ed.cursor = text.includes('\n') ? at : pos(end.line, Math.max(end.col - 1, 0));
    }
    ed.updateWantCol();
}

export function replaceChars(ed: Editor, c: string, count: number): void {
    const cur = ed.cursor;
    if (cur.col + count > ed.buffer.lineLen(cur.line)) return;
    if (c === '\n') {
        ed.buffer.deleteRange(cur, pos(cur.line, cur.col + count));
        ed.buffer.insertText(cur, '\n');
        ed.cursor = pos(cur.line + 1, 0);
        return;
    }
    for (let i = 0; i < count; i++) ed.buffer.setChar(pos(cur.line, cur.col + i), c);
    ed.cursor = pos(cur.line, cur.col + count - 1);
}

/** Join `joins` following lines onto `line`. */
export function joinLines(ed: Editor, line: number, joins: number, spaces: boolean): void {
    if (line >= ed.buffer.lastLine()) return;
    let col = 0;
    for (let i = 0; i < joins; i++) {
        if (line >= ed.buffer.lastLine()) break;
        let current = ed.buffer.line(line).slice();
        let next = ed.buffer.line(line + 1).slice();
        if (spaces) {
            const k = next.findIndex((c) => !isWhitespace(c));
            next = k < 0 ? [] : next.slice(k);
            while (current.length > 0 && isWhitespace(current[current.length - 1])) current.pop();
        }
        col = current.length;
        if (spaces && current.length > 0 && next.length > 0 && next[0] !== ')') current.push(' ');
        current = current.concat(next);
        ed.buffer.replaceLine(line, current);
        ed.buffer.removeLines(line + 1, line + 1);
    }
    ed.cursor = pos(line, col);
}

export function toggleCaseChars(ed: Editor, count: number): void {
    const cur = ed.cursor;
    const len = ed.buffer.lineLen(cur.line);
    if (len === 0) return;
    const end = Math.min(cur.col + count, len);
    for (let col = cur.col; col < end; col++) {
        const p = pos(cur.line, col);
        const c = ed.buffer.charAt(p);
        if (c !== undefined) ed.buffer.setChar(p, changeCase(c, 'ToggleCase'));
    }
    ed.cursor = pos(cur.line, Math.min(end, len - 1));
    ed.updateWantCol();
}

export function startInsert(ed: Editor, kind: InsertKind, count: number): void {
    const line = ed.cursor.line;
    const len = ed.buffer.lineLen(line);
    switch (kind) {
        case 'Before':
            break;
        case 'After':
            ed.cursor = pos(line, Math.min(ed.cursor.col + 1, len));
            break;
        case 'LineStart':
            ed.cursor = pos(line, ed.buffer.isBlankLine(line) ? len : ed.buffer.firstNonBlank(line));
            break;
        case 'LineEnd':
            ed.cursor = pos(line, len);
            break;
        case 'Column0':
            ed.cursor = pos(line, 0);
            break;
        case 'OpenBelow':
        case 'OpenAbove':
            openLine(ed, kind === 'OpenBelow');
            ed.beginInsert(count, true);
            return;
    }
    ed.beginInsert(count, false);
}

export function openLine(ed: Editor, below: boolean): void {
    const line = ed.cursor.line;
    const indent = ed.options.autoindent ? ed.buffer.indentOf(line) : [];
    const lastNonBlank = ed.buffer
        .line(line)
        .slice()
        .reverse()
        .find((c) => !isWhitespace(c));
    const opensBlock = below && ed.options.autoindent && (lastNonBlank === '{' || lastNonBlank === '(' || lastNonBlank === '[');
    if (opensBlock) indent.push(...ed.indentUnit());
    const at = below ? line + 1 : line;
    const col = indent.length;
    ed.buffer.insertLines(at, [indent]);
    ed.cursor = pos(at, col);
    if (col > 0) ed.insert.autoindentLine = at;
}

export function scroll(ed: Editor, kind: Scroll, count: number | undefined): void {
    const rows = ed.viewRows;
    const last = ed.buffer.lastLine();
    const n = count ?? 1;
    switch (kind) {
        case 'HalfPageDown':
        case 'HalfPageUp': {
            const amount = count ?? Math.max(Math.floor(rows / 2), 1);
            const down = kind === 'HalfPageDown';
            if ((down && ed.cursor.line === last) || (!down && ed.cursor.line === 0)) return;
            const delta = down ? amount : -amount;
            ed.scrollTop = Math.min(Math.max(ed.scrollTop + delta, 0), last);
            const line = Math.min(Math.max(ed.cursor.line + delta, 0), last);
            ed.cursor = pos(line, ed.colForWant(line));
            break;
        }
        case 'PageDown':
        case 'PageUp': {
            const amount = Math.max(rows - 2, 1) * n;
            ed.scrollBy(kind === 'PageDown' ? amount : -amount);
            break;
        }
        case 'LineDown':
            ed.scrollBy(n);
            break;
        case 'LineUp':
            ed.scrollBy(-n);
            break;
        case 'CursorTop':
        case 'CursorMiddle':
        case 'CursorBottom': {
            if (count !== undefined) ed.cursor = pos(Math.min(Math.max(count - 1, 0), last), ed.cursor.col);
            const line = ed.cursor.line;
            if (kind === 'CursorTop') ed.scrollTop = Math.max(line - ed.scrolloff(), 0);
            else if (kind === 'CursorMiddle') ed.scrollTop = Math.max(line - Math.floor(rows / 2), 0);
            else ed.scrollTop = Math.max(line + 1 + ed.scrolloff() - rows, 0);
            break;
        }
    }
}

export function searchWord(ed: Editor, forward: boolean, count: number): void {
    const line = ed.buffer.line(ed.cursor.line);
    let start = -1;
    for (let i = ed.cursor.col; i < line.length; i++) {
        if (isKeyword(line[i])) {
            start = i;
            break;
        }
    }
    if (start < 0) {
        ed.setError('E348: No string under cursor');
        return;
    }
    let s = start;
    while (s > 0 && isKeyword(line[s - 1])) s--;
    let e = start;
    while (e < line.length && isKeyword(line[e])) e++;
    const word = line.slice(s, e).join('');
    ed.lastSearch = { pattern: `\\<${escape(word)}\\>`, forward };
    // Start from the beginning of the word so the current one is skipped.
    ed.cursor = pos(ed.cursor.line, s);
    const m = { t: 'SearchNext' } as const;
    const target = evalMotion(ed, m, count, false);
    if (target) moveTo(ed, m, target);
}

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

export function increment(ed: Editor, delta: number): void {
    const line = ed.buffer.line(ed.cursor.line);
    const isDigit = (c: string | undefined): boolean => c !== undefined && /^[0-9]$/.test(c);
    let first = -1;
    for (let i = ed.cursor.col; i < line.length; i++) {
        if (isDigit(line[i])) {
            first = i;
            break;
        }
    }
    if (first < 0) return;
    let s = first;
    while (s > 0 && isDigit(line[s - 1])) s--;
    let e = first;
    while (e < line.length && isDigit(line[e])) e++;
    if (s > 0 && line[s - 1] === '-') s--;
    const value = BigInt(line.slice(s, e).join(''));
    if (value < I64_MIN || value > I64_MAX) return;
    let next = value + BigInt(delta);
    if (next < I64_MIN) next = I64_MIN;
    if (next > I64_MAX) next = I64_MAX;
    const text = next.toString();
    const start = pos(ed.cursor.line, s);
    ed.buffer.deleteRange(start, pos(ed.cursor.line, e));
    ed.buffer.insertText(start, text);
    ed.cursor = pos(ed.cursor.line, s + text.length - 1);
    ed.updateWantCol();
}

// ----- Visual mode ---------------------------------------------------------------

function visualRange(ed: Editor, forceLinewise: boolean): Range {
    const [s, e] = order(ed.visualAnchor, ed.cursor);
    if (forceLinewise || ed.mode === 'VisualLine') return lineRange(s.line, e.line);
    return charRange(s, pos(e.line, e.col + 1));
}

export function visualOperate(ed: Editor, op: Operator, linewise: boolean, count: number, reg: string | undefined): void {
    const range = visualRange(ed, linewise);
    ed.exitVisual();
    if (op === 'Indent' || op === 'Outdent') {
        for (let i = 0; i < count; i++) applyOperator(ed, op, range, reg);
        return;
    }
    applyOperator(ed, op, range, reg);
}

export function visualSelectObject(ed: Editor, obj: TextObject, around: boolean, count: number): void {
    const r = textObject(ed, obj, around, count);
    if (!r) return;
    ed.visualAnchor = r.start;
    if (r.linewise) {
        ed.cursor = pos(r.end.line, 0);
        ed.mode = 'VisualLine';
    } else {
        const end = retreat(ed.buffer, r.end) ?? r.start;
        ed.cursor = posMax(end, r.start);
    }
    ed.updateWantCol();
}

export function visualReplace(ed: Editor, c: string): void {
    const r = visualRange(ed, false);
    ed.exitVisual();
    const first = r.start.line;
    const last = r.end.line;
    for (let line = first; line <= last; line++) {
        const len = ed.buffer.lineLen(line);
        let from = 0;
        let to = len;
        if (!r.linewise) {
            from = line === first ? r.start.col : 0;
            to = line === last ? Math.min(r.end.col, len) : len;
        }
        const cs = ed.buffer.line(line).slice();
        for (let i = Math.min(from, to); i < to; i++) cs[i] = c;
        ed.buffer.replaceLine(line, cs);
    }
    ed.cursor = r.start;
}

export function visualPaste(ed: Editor, reg: string | undefined): void {
    const content = ed.registers.get(reg);
    if (!content) {
        ed.setError('E353: Nothing in register');
        ed.exitVisual();
        return;
    }
    const r = visualRange(ed, false);
    ed.exitVisual();
    const replaced = rangeRegister(ed, r);
    if (r.linewise) {
        const text = content.linewise ? content.text : content.text.replace(/\n+$/, '');
        ed.buffer.insertLines(r.end.line + 1, text.split('\n').map(chars));
        ed.buffer.removeLines(r.start.line, r.end.line);
        ed.cursor = pos(r.start.line, ed.buffer.firstNonBlank(r.start.line));
    } else {
        ed.buffer.deleteRange(r.start, r.end);
        const text = content.linewise ? `\n${content.text}\n` : content.text;
        const end = ed.buffer.insertText(r.start, text);
        ed.cursor = content.linewise ? pos(r.start.line + 1, 0) : pos(end.line, Math.max(end.col - 1, 0));
    }
    ed.registers.set(undefined, replaced, 'Delete');
}

function changeCase(c: string, op: Operator): string {
    const single = (s: string): string => (Array.from(s).length === 1 ? s : c);
    if (op === 'Lowercase') return single(c.toLowerCase());
    if (op === 'Uppercase') return single(c.toUpperCase());
    if (/\p{Lowercase}/u.test(c)) return single(c.toUpperCase());
    if (/\p{Uppercase}/u.test(c)) return single(c.toLowerCase());
    return c;
}
