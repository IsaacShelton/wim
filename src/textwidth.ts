// How wide a character is on the character grid. Most characters take one
// cell; East Asian wide ones (Chinese, Japanese, Korean, full-width forms and
// emoji) take two, as they do in a terminal, so they don't overlap the
// characters after them.

/** Ranges of code points that take two cells (Unicode East Asian Width W and
 * F, and the emoji that terminals show wide). */
const WIDE: readonly (readonly [number, number])[] = [
    [0x1100, 0x115f], // Hangul Jamo
    [0x2329, 0x232a], // Angle brackets
    [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols and punctuation
    [0x3041, 0x33ff], // Hiragana, Katakana, Bopomofo, Hangul, CJK compatibility
    [0x3400, 0x4dbf], // CJK unified ideographs extension A
    [0x4e00, 0x9fff], // CJK unified ideographs
    [0xa000, 0xa4cf], // Yi
    [0xa960, 0xa97f], // Hangul Jamo extended A
    [0xac00, 0xd7a3], // Hangul syllables
    [0xf900, 0xfaff], // CJK compatibility ideographs
    [0xfe10, 0xfe19], // Vertical forms
    [0xfe30, 0xfe6f], // CJK compatibility forms, small form variants
    [0xff00, 0xff60], // Full-width forms
    [0xffe0, 0xffe6], // Full-width signs
    [0x16fe0, 0x16fe4], // Tangut, Nushu, Khitan
    [0x16ff0, 0x16ff1],
    [0x17000, 0x18cff], // Tangut, Khitan, Nushu
    [0x1aff0, 0x1b2ff], // Kana extensions, Nushu, small Kana
    [0x1f004, 0x1f004], // Mahjong tile red dragon
    [0x1f0cf, 0x1f0cf], // Playing card black joker
    [0x1f18e, 0x1f18e],
    [0x1f191, 0x1f19a],
    [0x1f200, 0x1f320],
    [0x1f32d, 0x1f335],
    [0x1f337, 0x1f37c],
    [0x1f37e, 0x1f393],
    [0x1f3a0, 0x1f3ca],
    [0x1f3cf, 0x1f3d3],
    [0x1f3e0, 0x1f3f0],
    [0x1f3f4, 0x1f3f4],
    [0x1f3f8, 0x1f43e],
    [0x1f440, 0x1f440],
    [0x1f442, 0x1f4fc],
    [0x1f4ff, 0x1f53d],
    [0x1f54b, 0x1f54e],
    [0x1f550, 0x1f567],
    [0x1f57a, 0x1f57a],
    [0x1f595, 0x1f596],
    [0x1f5a4, 0x1f5a4],
    [0x1f5fb, 0x1f64f],
    [0x1f680, 0x1f6c5],
    [0x1f6cc, 0x1f6cc],
    [0x1f6d0, 0x1f6d2],
    [0x1f6d5, 0x1f6d7],
    [0x1f6eb, 0x1f6ec],
    [0x1f6f4, 0x1f6fc],
    [0x1f7e0, 0x1f7eb],
    [0x1f7f0, 0x1f7f0],
    [0x1f90c, 0x1f93a],
    [0x1f93c, 0x1f945],
    [0x1f947, 0x1f9ff],
    [0x1fa70, 0x1fa7c],
    [0x1fa80, 0x1fa88],
    [0x1fa90, 0x1fabd],
    [0x1fabf, 0x1fac5],
    [0x1face, 0x1fadb],
    [0x1fae0, 0x1fae8],
    [0x1faf0, 0x1faf8],
    [0x20000, 0x2fffd], // CJK unified ideographs extensions B onward
    [0x30000, 0x3fffd],
];

/** Whether `code` is drawn in two cells. */
export function isWide(code: number): boolean {
    let low = 0;
    let high = WIDE.length - 1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        const [from, to] = WIDE[mid];
        if (code < from) high = mid - 1;
        else if (code > to) low = mid + 1;
        else return true;
    }
    return false;
}

/** How many cells a character takes: two for a wide one (a Chinese character,
 * a full-width form, an emoji), one for the rest. */
export function charWidth(c: string): number {
    return isWide(c.codePointAt(0) ?? 0) ? 2 : 1;
}

/** How many cells a string takes. */
export function textWidth(s: string): number {
    let n = 0;
    for (const c of s) n += charWidth(c);
    return n;
}

/** `s` cut to at most `cols` cells, with `…` for what was left out. */
export function cutText(s: string, cols: number): string {
    if (cols <= 0) return '';
    if (textWidth(s) <= cols) return s;
    const room = cols - 1;
    let out = '';
    let used = 0;
    for (const c of s) {
        const w = charWidth(c);
        if (used + w > room) break;
        out += c;
        used += w;
    }
    return out + '…';
}

/** `s` cut from the start to at most `cols` cells, keeping its end. */
export function cutTextStart(s: string, cols: number): string {
    if (cols <= 0) return '';
    if (textWidth(s) <= cols) return s;
    const chars = Array.from(s);
    let used = 0;
    let at = chars.length;
    while (at > 0) {
        const w = charWidth(chars[at - 1]);
        if (used + w > cols - 1) break;
        used += w;
        at--;
    }
    return '…' + chars.slice(at).join('');
}
