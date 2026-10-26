// Closing brackets and quotes typed along with opening ones, as nvim-autopairs
// does with the Neovim config: its default rules, without the one for `'`.

const PAIRS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}', '"': '"', '`': '`' };
const CLOSERS = new Set(Object.values(PAIRS));

/** nvim-autopairs' `ignored_next_char`: nothing is added before these. */
const IGNORED_NEXT = /^[\p{L}\p{N}%'["`.$]$/u;

/** What typing a character does instead of inserting just it. */
export interface Typed {
    /** Inserted at the cursor. */
    text: string;
    /** How far the cursor then moves right. */
    advance: number;
}

function count(chars: readonly string[], c: string): number {
    return chars.filter((x) => x === c).length;
}

/** Whether a file takes triple quotes for `q`: `"""` in Python, ``` in
 * Markdown. */
function triples(q: string, file: string | undefined): boolean {
    const ext = file?.toLowerCase().match(/\.(\w+)$/)?.[1];
    return (q === '"' && (ext === 'py' || ext === 'pyi')) || (q === '`' && (ext === 'md' || ext === 'markdown'));
}

/** What typing `c` at column `col` of `line` should do, or undefined to type
 * it as usual. */
export function typed(line: readonly string[], col: number, c: string, file: string | undefined): Typed | undefined {
    const next = line[col];
    const prev = line[col - 1];
    // Typing the closer that is already there steps over it.
    if (CLOSERS.has(c) && next === c) return { text: '', advance: 1 };
    const close = PAIRS[c];
    if (close === undefined) return undefined;
    if (next !== undefined && IGNORED_NEXT.test(next)) return undefined;
    if (c === close) {
        // A quote: the third of three opens a block, `"""|"""`.
        if (prev === c && line[col - 2] === c && triples(c, file)) return { text: c + c.repeat(3), advance: 1 };
        // Not right after a word, and not to close a string.
        if (prev !== undefined && /[\p{L}\p{N}_]/u.test(prev)) return undefined;
        if (count(line.slice(0, col), c) % 2 === 1) return undefined;
    } else if (count(line, close) > count(line, c)) {
        // The line already has a closer waiting for this opener.
        return undefined;
    }
    return { text: c + close, advance: 1 };
}

/** Whether the cursor is between an empty pair, which `<BS>` deletes
 * together. */
export function betweenPair(line: readonly string[], col: number): boolean {
    const prev = line[col - 1];
    return prev !== undefined && PAIRS[prev] !== undefined && line[col] === PAIRS[prev];
}
