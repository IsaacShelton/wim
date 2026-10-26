// Converting between Wim's positions (lines of code points) and the
// protocol's, and applying the protocol's text edits to a buffer.

import { fileURLToPath, pathToFileURL } from 'node:url';

import { Buffer, Pos, posCmp, pos } from '../editor/buffer';
import type { Position, Range, TextEdit } from './types';

/** How a server counts columns: in UTF-8 bytes, UTF-16 code units (the
 * protocol's default) or code points. */
export type Encoding = 'utf-8' | 'utf-16' | 'utf-32';

export function uriFromPath(p: string): string {
    return pathToFileURL(p).href;
}

/** The file a `file:` URI names, or undefined for other schemes. */
export function pathFromUri(uri: string): string | undefined {
    if (!uri.startsWith('file:')) return undefined;
    try {
        return fileURLToPath(uri);
    } catch {
        return undefined;
    }
}

function unitLength(c: string, enc: Encoding): number {
    if (enc === 'utf-32') return 1;
    const cp = c.codePointAt(0)!;
    if (enc === 'utf-16') return cp > 0xffff ? 2 : 1;
    return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

/** The server's column for code point column `col` of `line`. */
export function toCharacter(line: readonly string[], col: number, enc: Encoding): number {
    if (enc === 'utf-32') return col;
    let n = 0;
    for (let i = 0; i < Math.min(col, line.length); i++) n += unitLength(line[i], enc);
    return n + Math.max(col - line.length, 0);
}

/** The code point column for the server's column `character` of `line`. */
export function fromCharacter(line: readonly string[], character: number, enc: Encoding): number {
    if (enc === 'utf-32') return Math.min(character, line.length);
    let n = 0;
    for (let i = 0; i < line.length; i++) {
        if (n >= character) return i;
        n += unitLength(line[i], enc);
    }
    return line.length;
}

export function toPosition(buf: Buffer, p: Pos, enc: Encoding): Position {
    return { line: p.line, character: toCharacter(buf.line(p.line), p.col, enc) };
}

/** A buffer position for a server's position, clamped to the buffer. */
export function fromPosition(buf: Buffer, p: Position, enc: Encoding): Pos {
    if (p.line > buf.lastLine()) return buf.endPos();
    const line = Math.max(p.line, 0);
    return pos(line, fromCharacter(buf.line(line), p.character, enc));
}

export function fromRange(buf: Buffer, r: Range, enc: Encoding): [Pos, Pos] {
    return [fromPosition(buf, r.start, enc), fromPosition(buf, r.end, enc)];
}

/** The position just past `text` inserted at `start`. */
function endOfInsert(start: Pos, text: string): Pos {
    const lines = text.split('\n');
    const last = Array.from(lines[lines.length - 1]).length;
    return lines.length === 1 ? pos(start.line, start.col + last) : pos(start.line + lines.length - 1, last);
}

/** Apply edits that all refer to the buffer as it is now (as the protocol
 * specifies), and return where `track` ends up. */
export function applyTextEdits(buf: Buffer, edits: readonly TextEdit[], enc: Encoding, track: Pos = pos(0, 0)): Pos {
    const resolved = edits.map((e, i) => {
        const [start, end] = fromRange(buf, e.range, enc);
        return { start, end, text: e.newText.replace(/\r\n?/g, '\n'), i };
    });
    // Last first, so earlier ranges stay valid; edits at the same place keep
    // their order.
    resolved.sort((a, b) => posCmp(b.start, a.start) || b.i - a.i);
    let p = track;
    for (const e of resolved) {
        buf.deleteRange(e.start, e.end);
        buf.insertText(e.start, e.text);
        if (posCmp(e.end, p) <= 0) {
            const newEnd = endOfInsert(e.start, e.text);
            p = p.line === e.end.line ? pos(newEnd.line, newEnd.col + p.col - e.end.col) : pos(p.line + newEnd.line - e.end.line, p.col);
        } else if (posCmp(e.start, p) < 0) {
            p = e.start;
        }
    }
    return p;
}

/** A snippet as plain text, with the offset (in code points) where the
 * cursor should go: the first tab stop, or the end. Placeholders keep their
 * default text. */
export function snippetText(snippet: string): { text: string; cursor: number } {
    let text = '';
    let first: number | undefined;
    let firstIndex = Infinity;
    let final: number | undefined;
    const at = (): number => Array.from(text).length;
    const stop = (n: number): void => {
        if (n === 0) final ??= at();
        else if (n < firstIndex) {
            firstIndex = n;
            first = at();
        }
    };
    const parse = (s: string, i: number, inside: boolean): number => {
        while (i < s.length) {
            const c = s[i];
            if (c === '\\' && i + 1 < s.length) {
                text += s[i + 1];
                i += 2;
            } else if (inside && c === '}') {
                return i + 1;
            } else if (c === '$') {
                const simple = /^\$(\d+)/.exec(s.slice(i));
                const braced = /^\$\{(\d+)([:|}])?/.exec(s.slice(i));
                const variable = /^\$\{?[A-Za-z_]\w*\}?/.exec(s.slice(i));
                if (simple) {
                    stop(Number(simple[1]));
                    i += simple[0].length;
                } else if (braced) {
                    stop(Number(braced[1]));
                    i += braced[0].length;
                    if (braced[2] === ':') {
                        i = parse(s, i, true);
                    } else if (braced[2] === '|') {
                        // A choice: keep the first option.
                        const end = s.indexOf('|}', i);
                        text += s.slice(i, end < 0 ? s.length : end).split(',')[0];
                        i = end < 0 ? s.length : end + 2;
                    }
                } else if (variable) {
                    i += variable[0].length;
                } else {
                    text += c;
                    i++;
                }
            } else {
                text += c;
                i++;
            }
        }
        return i;
    };
    parse(snippet, 0, false);
    return { text, cursor: first ?? final ?? at() };
}
