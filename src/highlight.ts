// A small, line-oriented syntax highlighter. It understands comments,
// strings, numbers, keywords and a few naming conventions for a handful of
// common languages, carrying block-comment and string state across lines.

import * as path from 'node:path';

export type Token =
    | 'Normal'
    | 'Keyword'
    | 'Type'
    /** Types built into the language (`f32`, `usize`). */
    | 'BuiltinType'
    /** Rust's `Self`. */
    | 'SelfType'
    /** ALL_CAPS names. */
    | 'Constant'
    /** Constants built into the language (`true`, `None`). */
    | 'BuiltinConstant'
    | 'String'
    | 'Comment'
    | 'Number'
    | 'Function'
    | 'Macro'
    /** Rust lifetimes (`'a`). */
    | 'Lifetime'
    /** A path's leading modules (`std::`). */
    | 'Module'
    /** Attribute names (`#[derive]`), and the language's own (`#[inline]`). */
    | 'Attribute'
    | 'BuiltinAttribute'
    | 'Operator'
    /** `;` `,` `.` `::` `->` */
    | 'Delimiter'
    | 'Bracket'
    /** From a language server only: parameters and fields. */
    | 'Parameter'
    | 'Property';

export interface Language {
    name: string;
    keywords: readonly string[];
    types: readonly string[];
    constants: readonly string[];
    lineComments: readonly string[];
    blockComment?: [string, string];
    quotes: readonly string[];
    tripleQuotes: boolean;
    /** Rust: `'a` is a lifetime unless it closes like a char literal. */
    lifetimes: boolean;
    /** Rust: `name!` is a macro invocation. */
    bangMacros: boolean;
    /** Rust: attributes built into the language, as opposed to `derive`. */
    attributes: readonly string[];
}

export type State =
    | { t: 'Normal' }
    | { t: 'BlockComment' }
    | { t: 'Str'; q: string }
    | { t: 'TripleStr'; q: string };

export const NORMAL: State = { t: 'Normal' };

export type Span = [start: number, end: number, token: Token];

const BASE = { types: [], constants: [], lineComments: [], tripleQuotes: false, lifetimes: false, bangMacros: false, attributes: [] };

const words = (s: string): string[] => s.split(/\s+/).filter((w) => w !== '');

export const RUST: Language = {
    ...BASE,
    name: 'rust',
    keywords: words(`as async await break const continue crate dyn else enum extern fn for if impl in let loop
        match mod move mut pub ref return self Self static struct super trait type unsafe use where while yield`),
    types: words('i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str'),
    constants: words('true false None Some Ok Err'),
    lineComments: ['//'],
    blockComment: ['/*', '*/'],
    quotes: ['"', "'"],
    lifetimes: true,
    bangMacros: true,
    attributes: words(`allow warn deny forbid expect cfg cfg_attr test inline cold must_use deprecated doc path
        repr non_exhaustive no_mangle export_name link link_name used macro_export macro_use proc_macro
        proc_macro_derive proc_macro_attribute global_allocator track_caller automatically_derived ignore
        should_panic bench no_std no_main recursion_limit feature crate_type crate_name windows_subsystem`),
};

export const C: Language = {
    ...BASE,
    name: 'c',
    keywords: words(`auto break case class const constexpr continue default delete do else enum explicit extern
        for friend goto if inline namespace new operator private protected public register return sizeof static
        struct switch template this throw try catch typedef typename union using virtual volatile while
        #include #define #ifdef #ifndef #endif #if #else #pragma`),
    types: words(`void char short int long float double signed unsigned bool size_t uint8_t uint16_t uint32_t
        uint64_t int8_t int16_t int32_t int64_t auto`),
    constants: words('true false NULL nullptr'),
    lineComments: ['//'],
    blockComment: ['/*', '*/'],
    quotes: ['"', "'"],
};

export const JS: Language = {
    ...BASE,
    name: 'javascript',
    keywords: words(`async await break case catch class const continue debugger default delete do else export
        extends finally for from function if import in instanceof let new of return static super switch this
        throw try typeof var void while with yield interface type enum implements private public protected
        readonly as`),
    types: words('string number boolean any unknown never object symbol bigint'),
    constants: words('true false null undefined NaN Infinity'),
    lineComments: ['//'],
    blockComment: ['/*', '*/'],
    quotes: ['"', "'", '`'],
};

export const PYTHON: Language = {
    ...BASE,
    name: 'python',
    keywords: words(`and as assert async await break class continue def del elif else except finally for from
        global if import in is lambda nonlocal not or pass raise return try while with yield match case self`),
    types: words('int float str bool list dict set tuple bytes object'),
    constants: words('True False None'),
    lineComments: ['#'],
    quotes: ['"', "'"],
    tripleQuotes: true,
};

export const GO: Language = {
    ...BASE,
    name: 'go',
    keywords: words(`break case chan const continue default defer else fallthrough for func go goto if import
        interface map package range return select struct switch type var`),
    types: words(`bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint
        uint8 uint16 uint32 uint64 uintptr any`),
    constants: words('true false nil iota'),
    lineComments: ['//'],
    blockComment: ['/*', '*/'],
    quotes: ['"', "'", '`'],
};

export const JAVA: Language = {
    ...BASE,
    name: 'java',
    keywords: words(`abstract assert break case catch class continue default do else enum extends final finally
        for if implements import instanceof interface native new package private protected public return static
        super switch synchronized this throw throws try var volatile while fun val when object override`),
    types: words('boolean byte char double float int long short void'),
    constants: words('true false null'),
    lineComments: ['//'],
    blockComment: ['/*', '*/'],
    quotes: ['"', "'"],
};

export const SHELL: Language = {
    ...BASE,
    name: 'sh',
    keywords: words(`if then else elif fi for while until do done case esac in function return local export echo
        exit source set unset`),
    constants: words('true false'),
    lineComments: ['#'],
    quotes: ['"', "'"],
};

export const CONFIG: Language = {
    ...BASE,
    name: 'conf',
    keywords: [],
    constants: words('true false null yes no on off'),
    lineComments: ['#'],
    quotes: ['"', "'"],
};

export const JSON_LANG: Language = {
    ...BASE,
    name: 'json',
    keywords: [],
    constants: words('true false null'),
    quotes: ['"'],
};

export const LUA: Language = {
    ...BASE,
    name: 'lua',
    keywords: words(`and break do else elseif end for function goto if in local not or repeat return then until
        while`),
    constants: words('true false nil'),
    lineComments: ['--'],
    blockComment: ['--[[', ']]'],
    quotes: ['"', "'"],
};

const BY_EXTENSION = new Map<string, Language>();
for (const [lang, exts] of [
    [RUST, 'rs'],
    [C, 'c h cc cpp cxx hpp hh m mm'],
    [JS, 'js jsx ts tsx mjs cjs'],
    [PYTHON, 'py pyi'],
    [GO, 'go'],
    [JAVA, 'java kt kts scala cs swift dart'],
    [SHELL, 'sh bash zsh fish'],
    [CONFIG, 'toml yaml yml ini cfg conf'],
    [JSON_LANG, 'json'],
    [LUA, 'lua'],
] as const) {
    for (const ext of words(exts)) BY_EXTENSION.set(ext, lang);
}

export function detect(p: string | undefined): Language | undefined {
    if (p === undefined) return undefined;
    const name = path.basename(p).toLowerCase();
    if (['makefile', 'dockerfile', '.bashrc', '.zshrc', '.profile'].includes(name)) return SHELL;
    const dot = name.lastIndexOf('.');
    return dot > 0 ? BY_EXTENSION.get(name.slice(dot + 1)) : undefined;
}

function startsWith(line: readonly string[], at: number, pat: string): boolean {
    let i = at;
    for (const c of pat) {
        if (line[i] !== c) return false;
        i++;
    }
    return true;
}

function find(line: readonly string[], from: number, pat: string): number | undefined {
    for (let i = from; i < line.length; i++) if (startsWith(line, i, pat)) return i;
    return undefined;
}

function isIdent(c: string): boolean {
    return /^[\p{L}\p{N}_]$/u.test(c);
}

function isUpper(c: string): boolean {
    return /^\p{Uppercase}$/u.test(c);
}

function isAsciiDigit(c: string | undefined): boolean {
    return c !== undefined && c >= '0' && c <= '9';
}

/** Keywords that a function's name follows. */
const DEFINERS = ['fn', 'function', 'def', 'func'];

/** Highlight one line given the state at its start. Returns the spans
 * `[start, end, token]` in char columns and the state at the line's end. */
export function highlightLine(lang: Language, line: readonly string[], state: State): [Span[], State] {
    const n = line.length;
    const spans: Span[] = [];
    let i = 0;
    let seg = 0;
    /** The last word, for names after `fn`. */
    let prevWord = '';
    /** Just after `#[` (Rust): the attribute's name comes next. */
    let attributeNext = false;
    // In a Rust `use`, capitalized names are types, even all in capitals.
    const inUse = lang.name === 'rust' && /^\s*(pub(\([^)]*\))?\s+)?use\s/.test(line.join(''));
    while (i < n) {
        if (state.t === 'BlockComment') {
            const end = lang.blockComment?.[1] ?? '*/';
            const j = find(line, i, end);
            if (j !== undefined) {
                const e = j + Array.from(end).length;
                spans.push([seg, e, 'Comment']);
                i = e;
                state = NORMAL;
            } else {
                spans.push([seg, n, 'Comment']);
                i = n;
            }
        } else if (state.t === 'Str') {
            const q = state.q;
            let j = i;
            let closed: number | undefined;
            while (j < n) {
                if (line[j] === '\\') {
                    j += 2;
                    continue;
                }
                if (line[j] === q) {
                    closed = j + 1;
                    break;
                }
                j++;
            }
            const end = closed ?? n;
            spans.push([seg, end, 'String']);
            i = end;
            if (closed !== undefined || q === "'") state = NORMAL;
        } else if (state.t === 'TripleStr') {
            const j = find(line, i, state.q.repeat(3));
            if (j !== undefined) {
                spans.push([seg, j + 3, 'String']);
                i = j + 3;
                state = NORMAL;
            } else {
                spans.push([seg, n, 'String']);
                i = n;
            }
        } else {
            const c = line[i];
            seg = i;
            const block = lang.blockComment;
            const blockStart = block && startsWith(line, i, block[0]);
            if (lang.lineComments.some((p) => startsWith(line, i, p))) {
                if (blockStart) {
                    i += Array.from(block[0]).length;
                    state = { t: 'BlockComment' };
                    continue;
                }
                spans.push([i, n, 'Comment']);
                break;
            }
            if (blockStart) {
                i += Array.from(block[0]).length;
                state = { t: 'BlockComment' };
                continue;
            }
            if (lang.quotes.includes(c)) {
                if (lang.tripleQuotes && startsWith(line, i, c.repeat(3))) {
                    i += 3;
                    state = { t: 'TripleStr', q: c };
                    continue;
                }
                if (c === "'" && lang.lifetimes) {
                    const isChar = line[i + 1] === '\\' || line[i + 2] === "'";
                    if (!isChar) {
                        let j = i + 1;
                        while (j < n && isIdent(line[j])) j++;
                        const end = Math.max(j, i + 1);
                        spans.push([i, end, 'Lifetime']);
                        i = end;
                        continue;
                    }
                }
                i++;
                state = { t: 'Str', q: c };
                continue;
            }
            if (isAsciiDigit(c) && (i === 0 || !isIdent(line[i - 1]))) {
                let j = i + 1;
                // `self.0`: a tuple field, not a number.
                const field = line[i - 1] === '.' && (isIdent(line[i - 2] ?? ' ') || line[i - 2] === ')');
                while (j < n && (isIdent(line[j]) || (!field && line[j] === '.' && isAsciiDigit(line[j + 1])))) j++;
                spans.push([i, j, field ? 'Property' : 'Number']);
                i = j;
                continue;
            }
            // A Rust attribute: `#[...]` or `#![...]`.
            if (c === '#' && lang.attributes.length > 0 && (line[i + 1] === '[' || (line[i + 1] === '!' && line[i + 2] === '['))) {
                spans.push([i, i + 1, 'Operator']);
                attributeNext = true;
                i++;
                continue;
            }
            if (isIdent(c) || (c === '#' && lang.name === 'c') || (c === '@' && lang.name !== 'c')) {
                let j = i + 1;
                while (j < n && isIdent(line[j])) j++;
                const word = line.slice(i, j).join('');
                const next = line.slice(j).find((x) => !/^\s$/u.test(x));
                let token: Token;
                if (attributeNext) {
                    token = lang.attributes.includes(word) ? 'BuiltinAttribute' : 'Attribute';
                } else if (word === 'Self' && lang.name === 'rust') {
                    token = 'SelfType';
                } else if (lang.keywords.includes(word)) {
                    token = 'Keyword';
                } else if (lang.constants.includes(word)) {
                    token = 'BuiltinConstant';
                } else if (c === '@' || (lang.bangMacros && line[j] === '!')) {
                    token = 'Macro';
                } else if (lang.types.includes(word)) {
                    token = 'BuiltinType';
                } else if (isUpper(c)) {
                    const allCaps = Array.from(word).every((x) => isUpper(x) || isAsciiDigit(x) || x === '_');
                    token = word.length > 1 && allCaps && !inUse ? 'Constant' : 'Type';
                } else if (next === '(' || DEFINERS.includes(prevWord)) {
                    token = 'Function';
                } else if (line[j] === ':' && line[j + 1] === ':') {
                    token = 'Module';
                } else {
                    token = 'Normal';
                }
                attributeNext = false;
                prevWord = word;
                const end = token === 'Macro' && line[j] === '!' ? j + 1 : j;
                spans.push([i, end, token]);
                i = end;
                continue;
            }
            const two = c + (line[i + 1] ?? '');
            if (two === '->' || two === '::') {
                spans.push([i, i + 2, 'Delimiter']);
                i += 2;
                continue;
            }
            if ('()[]{}'.includes(c)) spans.push([i, i + 1, 'Bracket']);
            else if (';,.:'.includes(c)) spans.push([i, i + 1, 'Delimiter']);
            else if ('=+-*/%<>!&|^~?'.includes(c)) spans.push([i, i + 1, 'Operator']);
            i++;
        }
    }
    return [spans, state];
}

/** Caches the highlighter state at the start of each line, recomputed when
 * the buffer content changes. */
export class Cache {
    /** The buffer id and content version the states were computed for. */
    private key: string | undefined;
    private states: State[] = [];

    /** The state at the start of `line`, computing states as far as needed. */
    stateAt(lang: Language, bufferId: number, version: number, line: number, lines: (i: number) => readonly string[]): State {
        const key = `${bufferId}:${version}:${lang.name}`;
        if (this.key !== key) {
            this.key = key;
            this.states = [NORMAL];
        }
        while (this.states.length <= line) {
            const i = this.states.length - 1;
            this.states.push(highlightLine(lang, lines(i), this.states[i])[1]);
        }
        return this.states[line];
    }
}

/** `top`'s spans laid over `base`'s, on a line `n` characters long: where
 * `top` has a token it wins (as a language server's semantic tokens do over
 * syntax highlighting). */
export function overlaySpans(base: readonly Span[], top: readonly Span[], n: number): Span[] {
    if (top.length === 0) return base.slice();
    const tokens: (Token | undefined)[] = new Array(n).fill(undefined);
    for (const spans of [base, top]) {
        for (const [s, e, t] of spans) for (let i = Math.max(s, 0); i < Math.min(e, n); i++) tokens[i] = t;
    }
    const out: Span[] = [];
    for (let i = 0; i < n; i++) {
        const t = tokens[i];
        if (t === undefined) continue;
        const last = out[out.length - 1];
        if (last && last[1] === i && last[2] === t) last[1] = i + 1;
        else out.push([i, i + 1, t]);
    }
    return out;
}
