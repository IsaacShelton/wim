// Subword motions, as nvim-spider does them with its defaults: words split at
// camelCase humps, snake_case underscores and between letters and digits;
// punctuation is skipped unless it is two characters or more (`=>`, `::`).

import { Buffer, Pos, pos } from './buffer';

export type SubwordMotion = 'w' | 'b' | 'e' | 'ge';

const isUpper = (c: string | undefined): boolean => c !== undefined && /\p{Lu}/u.test(c);
const isDigit = (c: string | undefined): boolean => c !== undefined && /\p{N}/u.test(c);
const isLetter = (c: string | undefined): boolean => c !== undefined && /\p{L}/u.test(c);
const isBlank = (c: string): boolean => /\s/u.test(c);

/** The subwords of a line, as `[start, end)` columns. */
export function subwords(line: readonly string[]): [number, number][] {
    const out: [number, number][] = [];
    const n = line.length;
    let i = 0;
    while (i < n) {
        const c = line[i];
        let j = i + 1;
        if (isBlank(c)) {
            i = j;
            continue;
        }
        if (isDigit(c)) {
            while (j < n && isDigit(line[j])) j++;
        } else if (isUpper(c)) {
            while (j < n && isUpper(line[j])) j++;
            if (j < n && isLetter(line[j])) {
                // `HTMLParser`: the last capital starts the next word.
                if (j - i > 1) j--;
                else while (j < n && isLetter(line[j]) && !isUpper(line[j])) j++;
            }
        } else if (isLetter(c)) {
            while (j < n && isLetter(line[j]) && !isUpper(line[j])) j++;
        } else {
            // Punctuation (and `_`): only a run of two or more is a stop.
            while (j < n && !isBlank(line[j]) && !isLetter(line[j]) && !isDigit(line[j])) j++;
            if (j - i < 2) {
                i = j;
                continue;
            }
        }
        out.push([i, j]);
        i = j;
    }
    return out;
}

/** Every subword start (or, with `ends`, last character) in the buffer, by
 * line, in order. */
function stops(buf: Buffer, line: number, ends: boolean): Pos[] {
    return subwords(buf.line(line)).map(([s, e]) => pos(line, ends ? e - 1 : s));
}

/** Where a subword motion goes from `from`, `count` times. Past the first or
 * last subword it stops at the buffer's start or end. */
export function subwordTarget(buf: Buffer, from: Pos, motion: SubwordMotion, count: number): Pos {
    const forward = motion === 'w' || motion === 'e';
    const ends = motion === 'e' || motion === 'ge';
    let p = from;
    for (let n = 0; n < count; n++) {
        let next: Pos | undefined;
        if (forward) {
            for (let l = p.line; l <= buf.lastLine() && !next; l++) {
                next = stops(buf, l, ends).find((s) => l > p.line || s.col > p.col);
            }
        } else {
            for (let l = p.line; l >= 0 && !next; l--) {
                next = stops(buf, l, ends)
                    .reverse()
                    .find((s) => l < p.line || s.col < p.col);
            }
        }
        if (!next) {
            const last = buf.lastLine();
            return forward ? pos(last, Math.max(buf.lineLen(last) - 1, 0)) : pos(0, 0);
        }
        p = next;
    }
    return p;
}
