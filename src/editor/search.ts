// Pattern search. Vim's "magic" regex syntax is translated to JavaScript
// regular expression syntax so that patterns like `\<foo\>` and `\(a\|b\)`
// behave as Vim users expect.

import { Buffer, Pos, pos } from './buffer';

const WORD = '[\\p{L}\\p{N}_]';
/** `\<`: the start of a word. */
const WORD_START = `(?<!${WORD})(?=${WORD})`;
/** `\>`: the end of a word. */
const WORD_END = `(?<=${WORD})(?!${WORD})`;
/** Characters that must be escaped to be literal (in Unicode mode). */
const SYNTAX = '^$\\.*+?()[]{}|/';

/** Compile a Vim pattern into a global, Unicode-aware regex. Throws on an
 * invalid pattern. */
export function compile(pattern: string, ignorecase: boolean, smartcase: boolean): RegExp {
    const [translated, caseOverride] = translate(pattern);
    const insensitive = caseOverride ?? (ignorecase && !(smartcase && /\p{Lu}/u.test(pattern)));
    return new RegExp(translated, insensitive ? 'giu' : 'gu');
}

/** Translate a Vim pattern. Returns the JavaScript regex source and an
 * explicit case-insensitivity request (`\c` / `\C`) if present. */
export function translate(pattern: string): [string, boolean | undefined] {
    let out = '';
    let veryMagic = false;
    let caseOverride: boolean | undefined;
    let inCountBrace = false;
    const cs = Array.from(pattern);
    for (let i = 0; i < cs.length; i++) {
        const c = cs[i];
        if (c === '\\') {
            const n = cs[++i];
            if (n === undefined) {
                out += '\\\\';
                break;
            }
            if (n === 'v') veryMagic = true;
            else if (n === 'V' || n === 'm' || n === 'M') veryMagic = false;
            else if (n === 'c') caseOverride = true;
            else if (n === 'C') caseOverride = false;
            else if (n === '<') out += WORD_START;
            else if (n === '>') out += WORD_END;
            else if ('()|+{}'.includes(n) && !veryMagic) {
                out += n;
                inCountBrace = n === '{';
            } else if ((n === '=' || n === '?') && !veryMagic) out += '?';
            else if (/^[A-Za-z0-9]$/.test(n) || SYNTAX.includes(n)) out += '\\' + n;
            else out += n;
        } else if (veryMagic) {
            if (c === '<') out += WORD_START;
            else if (c === '>') out += WORD_END;
            else if (c === '=') out += '?';
            else out += c;
        } else if (c === '}' && inCountBrace) {
            out += '}';
            inCountBrace = false;
        } else if ('()|+?{}'.includes(c)) {
            out += '\\' + c;
        } else {
            out += c;
        }
    }
    return [out, caseOverride];
}

/** Escape `s` so it matches literally. */
export function escape(s: string): string {
    return s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

/** Expand a Vim substitution replacement (`&`, `\1`, `\n`) for one match. */
export function expandReplacement(rep: string, match: RegExpExecArray): string {
    let out = '';
    const cs = Array.from(rep);
    for (let i = 0; i < cs.length; i++) {
        const c = cs[i];
        if (c === '&') {
            out += match[0];
        } else if (c === '\\') {
            const n = cs[++i];
            if (n === undefined) out += '\\';
            else if (/^[0-9]$/.test(n)) out += match[Number(n)] ?? '';
            else if (n === 'n' || n === 'r') out += '\n';
            else if (n === 't') out += '\t';
            else out += n;
        } else {
            out += c;
        }
    }
    return out;
}

/** All matches in `text`, each with its start and end as UTF-16 offsets. */
function* matchesIn(re: RegExp, text: string): Generator<RegExpExecArray> {
    re.lastIndex = 0;
    for (;;) {
        const m = re.exec(text);
        if (!m) return;
        yield m;
        if (m[0] === '') {
            // Step over an empty match, by a whole code point.
            const cp = text.codePointAt(re.lastIndex);
            re.lastIndex += cp !== undefined && cp > 0xffff ? 2 : 1;
        }
        if (re.lastIndex > text.length) return;
    }
}

/** All matches in a line, as `[start, end]` char columns. */
export function lineMatches(re: RegExp, line: readonly string[]): [number, number][] {
    const s = line.join('');
    const out: [number, number][] = [];
    if (s.length === line.length) {
        for (const m of matchesIn(re, s)) out.push([m.index, m.index + m[0].length]);
        return out;
    }
    // Map UTF-16 offsets back to code point columns.
    const offsets: number[] = [];
    let off = 0;
    for (const c of line) {
        offsets.push(off);
        off += c.length;
    }
    const toCol = (u: number): number => {
        let lo = 0;
        let hi = offsets.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (offsets[mid] < u) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };
    for (const m of matchesIn(re, s)) out.push([toCol(m.index), toCol(m.index + m[0].length)]);
    return out;
}

/** Replace the first match of `re` in `text`, or every match with `all`.
 * Returns the new text and the number of replacements. */
export function substituteLine(re: RegExp, text: string, rep: string, all: boolean): [string, number] {
    let out = '';
    let last = 0;
    let n = 0;
    for (const m of matchesIn(re, text)) {
        out += text.slice(last, m.index) + expandReplacement(rep, m);
        last = m.index + m[0].length;
        n += 1;
        if (!all) break;
    }
    return [out + text.slice(last), n];
}

/** Find the next match strictly after (or before) `from`. Returns the match
 * start and whether the search wrapped around the buffer. */
export function find(buf: Buffer, re: RegExp, from: Pos, forward: boolean): [Pos, boolean] | undefined {
    const n = buf.lineCount();
    for (let i = 0; i <= n; i++) {
        if (forward) {
            const line = (from.line + i) % n;
            const wrapped = from.line + i >= n;
            const hit = lineMatches(re, buf.line(line))
                .map(([s]) => s)
                .find((s) => i > 0 || s > from.col);
            if (hit !== undefined) return [pos(line, hit), wrapped];
        } else {
            const line = (from.line + n * 2 - i) % n;
            const wrapped = i > from.line;
            const hits = lineMatches(re, buf.line(line))
                .map(([s]) => s)
                .filter((s) => i > 0 || s < from.col);
            if (hits.length > 0) return [pos(line, hits[hits.length - 1]), wrapped];
        }
    }
    return undefined;
}
