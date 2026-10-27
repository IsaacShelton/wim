// A small, line-oriented syntax highlighter. It understands comments,
// strings, numbers, keywords and a few naming conventions for a handful of
// common languages, carrying block-comment and string state across lines.
// Markdown has its own: block and inline markup, with fenced code
// highlighted in the fence's language.

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
    | 'Property'
    // Markdown.
    | 'Heading'
    /** `**strong**` */
    | 'Strong'
    /** `*emphasis*` */
    | 'Emphasis'
    /** `~~strikethrough~~` */
    | 'Strike'
    /** A link's text. */
    | 'Link'
    | 'Url'
    /** Inline code, and code blocks in no known language. */
    | 'Raw'
    | 'Quote'
    /** List bullets and numbers, and task boxes. */
    | 'ListMarker'
    /** The punctuation of markup: `#`, `**`, `` ` ``, `](`... */
    | 'Markup';

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
    | { t: 'TripleStr'; q: string }
    /** Markdown: in a code block opened by `marker` (three or more
     * backticks or tildes), with the state of its language's highlighter. */
    | { t: 'Fence'; marker: string; lang: Language | undefined; inner: State };

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

export const MARKDOWN: Language = {
    ...BASE,
    name: 'markdown',
    keywords: [],
    blockComment: ['<!--', '-->'],
    quotes: [],
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
    [MARKDOWN, 'md markdown mdx'],
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

/** File extensions for the names Markdown code blocks give languages, to
 * find a highlighter; other names are tried as extensions. */
const FENCE_EXTENSIONS: Record<string, string> = {
    rust: 'rs',
    typescript: 'ts',
    javascript: 'js',
    typescriptreact: 'tsx',
    javascriptreact: 'jsx',
    python: 'py',
    shell: 'sh',
    bash: 'sh',
    console: 'sh',
    shellsession: 'sh',
    cpp: 'cpp',
    'c++': 'cpp',
    golang: 'go',
    kotlin: 'kt',
    jsonc: 'json',
    json5: 'json',
};

/** The highlighter for a Markdown code block's language name (`rust`, `ts`). */
export function fenceLanguage(name: string): Language | undefined {
    if (name === '') return undefined;
    const lower = name.toLowerCase();
    return detect(`x.${FENCE_EXTENSIONS[lower] ?? lower}`);
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
    if (lang.name === 'markdown') return highlightMarkdown(line, state);
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

/** A line's length in characters. */
const charLen = (s: string): number => Array.from(s).length;

/** Per character of a line: its token, and for markup what Markdown's
 * rendered view shows instead (`''` drops it); unset, the character itself. */
interface Inline {
    tokens: (Token | undefined)[];
    shown: (string | undefined)[];
}

/** A stretch of a Markdown line with the same token and handling: shown as
 * is, or (`shown` set) replaced by `shown` in the rendered view. */
export interface InlineSpan {
    start: number;
    end: number;
    token: Token | undefined;
    shown?: string;
}

function isSpace(c: string | undefined): boolean {
    return c === undefined || /^\s$/u.test(c);
}

/** How many `c` there are in a row from `at`. */
function runOf(line: readonly string[], at: number, to: number, c: string): number {
    let j = at;
    while (j < to && line[j] === c) j++;
    return j - at;
}

/** The end of the code span whose backticks start at `at`: after a run of
 * just as many backticks. */
function codeSpanEnd(line: readonly string[], at: number, to: number): number | undefined {
    const n = runOf(line, at, to, '`');
    for (let j = at + n; j < to; j++) {
        if (line[j] !== '`') continue;
        const m = runOf(line, j, to, '`');
        if (m === n) return j + m;
        j += m - 1;
    }
    return undefined;
}

/** Where the `n` `c`s that close emphasis start, searching from `from`. */
function emphasisCloser(line: readonly string[], from: number, to: number, c: string, n: number): number | undefined {
    for (let j = from; j < to; j++) {
        const x = line[j];
        if (x === '\\') {
            j++;
        } else if (x === '`') {
            const end = codeSpanEnd(line, j, to);
            j = (end ?? j + runOf(line, j, to, '`')) - 1;
        } else if (x === c) {
            const m = runOf(line, j, to, c);
            if (m === n && !isSpace(line[j - 1]) && (c !== '_' || !isIdent(line[j + m] ?? ' '))) return j;
            j += m - 1;
        }
    }
    return undefined;
}

/** The bracket closing the one at `open`, counting nested pairs. */
function matching(line: readonly string[], open: number, to: number, close: string): number | undefined {
    const o = line[open];
    let depth = 0;
    for (let j = open; j < to; j++) {
        if (line[j] === '\\') j++;
        else if (line[j] === o) depth++;
        else if (line[j] === close && --depth === 0) return j;
    }
    return undefined;
}

/** Inline Markdown in `line[from..to)`, over `base` (the token of what
 * contains it). */
function inlineInto(line: readonly string[], from: number, to: number, base: Token | undefined, out: Inline): void {
    const set = (s: number, e: number, token: Token | undefined, shown?: string): void => {
        for (let k = s; k < e; k++) {
            out.tokens[k] = token;
            out.shown[k] = shown === undefined ? undefined : k === s ? shown : '';
        }
    };
    const hide = (s: number, e: number, token: Token = 'Markup'): void => set(s, e, token, '');
    set(from, to, base);
    let i = from;
    while (i < to) {
        const c = line[i];
        const rest = (): string => line.slice(i, to).join('');
        if (c === '\\' && i + 1 < to && /^[!-/:-@[-`{-~]$/.test(line[i + 1])) {
            hide(i, i + 1);
            i += 2;
            continue;
        }
        if (c === '`') {
            const end = codeSpanEnd(line, i, to);
            const n = runOf(line, i, to, '`');
            if (end !== undefined) {
                hide(i, i + n);
                set(i + n, end - n, 'Raw');
                hide(end - n, end);
                i = end;
            } else {
                i += n;
            }
            continue;
        }
        if (c === '<') {
            const r = rest();
            const comment = /^<!--.*?-->/.exec(r);
            const auto = /^<((?:https?|ftp|mailto):[^\s<>]*|[^\s<>@]+@[^\s<>@]+)>/.exec(r);
            const tag = /^<\/?[A-Za-z][\w-]*(\s[^<>]*)?\/?>/.exec(r);
            if (comment) {
                const n = charLen(comment[0]);
                hide(i, i + n, 'Comment');
                i += n;
                continue;
            }
            if (auto) {
                const n = charLen(auto[0]);
                hide(i, i + 1);
                set(i + 1, i + n - 1, 'Url');
                hide(i + n - 1, i + n);
                i += n;
                continue;
            }
            if (tag) {
                const n = charLen(tag[0]);
                hide(i, i + n);
                i += n;
                continue;
            }
        }
        if (c === 'h' && (i === from || !isIdent(line[i - 1]))) {
            const url = /^https?:\/\/[^\s<>]*[^\s<>.,:;"')\]!?*_~]/.exec(rest());
            if (url) {
                const n = charLen(url[0]);
                set(i, i + n, 'Url');
                i += n;
                continue;
            }
        }
        if (c === '[' || (c === '!' && line[i + 1] === '[')) {
            // `[text](url)`, `![alt](src)` and `[text][ref]`.
            const open = c === '!' ? i + 1 : i;
            const close = matching(line, open, to, ']');
            const after = close === undefined ? undefined : line[close + 1];
            const end =
                close === undefined
                    ? undefined
                    : after === '('
                      ? matching(line, close + 1, to, ')')
                      : after === '['
                        ? matching(line, close + 1, to, ']')
                        : undefined;
            if (close !== undefined && end !== undefined) {
                set(i, open + 1, 'Markup', c === '!' ? '▣ ' : '');
                inlineInto(line, open + 1, close, 'Link', out);
                hide(close, close + 2);
                set(close + 2, end, after === '(' ? 'Url' : 'Markup', '');
                hide(end, end + 1);
                i = end + 1;
                continue;
            }
        }
        if (c === '*' || c === '_' || c === '~') {
            // Emphasis, strong (`**`, or `***` for both) and strikethrough
            // (`~~`). `_` doesn't work inside words (`snake_case`).
            const n = runOf(line, i, to, c);
            const fits = c === '~' ? n === 2 : n <= 3;
            if (fits && !isSpace(line[i + n]) && (c !== '_' || i === 0 || !isIdent(line[i - 1]))) {
                const j = emphasisCloser(line, i + n, to, c, n);
                if (j !== undefined) {
                    hide(i, i + n);
                    inlineInto(line, i + n, j, c === '~' ? 'Strike' : n === 1 ? 'Emphasis' : 'Strong', out);
                    hide(j, j + n);
                    i = j + n;
                    continue;
                }
            }
            i += n;
            continue;
        }
        i++;
    }
}

/** The inline markup of `line[from..to)`, over `base`, as spans covering
 * it all. */
export function markdownInline(line: readonly string[], from = 0, to = line.length, base?: Token): InlineSpan[] {
    const out: Inline = { tokens: [], shown: [] };
    inlineInto(line, from, to, base, out);
    const spans: InlineSpan[] = [];
    for (let i = from; i < to; i++) {
        const token = out.tokens[i];
        const shown = out.shown[i];
        const last = spans[spans.length - 1];
        const joins = shown === '' ? last?.shown !== undefined : shown === undefined && last?.shown === undefined;
        if (last && last.token === token && joins) last.end = i + 1;
        else spans.push(shown === undefined ? { start: i, end: i + 1, token } : { start: i, end: i + 1, token, shown });
    }
    return spans;
}

/** A Markdown table's line between its header and body (`| --- | :-: |`). */
export const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;

/** Block markup (quotes, headings, lists, rules...) in `line[from..to)`,
 * then the inline markup in what's left, into `tokens`. */
function markdownBlock(line: readonly string[], from: number, to: number, base: Token | undefined, tokens: (Token | undefined)[]): void {
    const text = line.slice(from, to).join('');
    const set = (s: number, e: number, token: Token): void => {
        for (let k = from + s; k < from + e; k++) tokens[k] = token;
    };
    let m: RegExpExecArray | null;
    if ((m = /^ {0,3}>\s?/.exec(text))) {
        set(0, charLen(m[0]), 'Markup');
        markdownBlock(line, from + charLen(m[0]), to, 'Quote', tokens);
        return;
    }
    if (/^ {0,3}([-*_])( *\1){2,} *$/.test(text) || /^ {0,3}=+ *$/.test(text) || TABLE_DELIMITER.test(text)) {
        set(0, to - from, 'Markup');
        return;
    }
    const out: Inline = { tokens, shown: [] };
    if ((m = /^ {0,3}(#{1,6})(?=\s|$)/.exec(text))) {
        const at = charLen(m[0]);
        const closing = /\s#+\s*$/.exec(text.slice(m[0].length));
        const end = closing ? to - charLen(closing[0]) : to;
        set(0, at, 'Markup');
        inlineInto(line, from + at, end, 'Heading', out);
        for (let k = end; k < to; k++) tokens[k] = 'Markup';
        return;
    }
    if ((m = /^(\s*)([-*+]|\d{1,9}[.)])(\s+|$)/.exec(text))) {
        const marker = charLen(m[1]);
        set(marker, marker + charLen(m[2]), 'ListMarker');
        let at = charLen(m[0]);
        if (/^\[[ xX]\](?=\s|$)/.test(text.slice(m[0].length))) {
            set(at, at + 3, 'ListMarker');
            at += 3;
        }
        markdownBlock(line, from + at, to, base, tokens);
        return;
    }
    if ((m = /^( {0,3}\[)([^\]]+)(\]:\s*)(\S+)/.exec(text))) {
        // A link reference definition: `[ref]: url`.
        const a = charLen(m[1]);
        const b = a + charLen(m[2]);
        const c = b + charLen(m[3]);
        set(0, a, 'Markup');
        set(a, b, 'Link');
        set(b, c, 'Markup');
        set(c, c + charLen(m[4]), 'Url');
        return;
    }
    inlineInto(line, from, to, base, out);
    if (text.trimStart().startsWith('|')) {
        for (let k = from; k < to; k++) if (line[k] === '|' && (tokens[k] === undefined || tokens[k] === base)) tokens[k] = 'Markup';
    }
}

/** Where an HTML comment that doesn't close on the line opens, at or after
 * `from`. */
function openComment(line: readonly string[], from: number): number | undefined {
    for (let i = from; i < line.length; i++) {
        if (!startsWith(line, i, '<!--')) continue;
        const j = find(line, i + 4, '-->');
        if (j === undefined) return i;
        i = j + 2;
    }
    return undefined;
}

function highlightMarkdown(line: readonly string[], state: State): [Span[], State] {
    const n = line.length;
    const text = line.join('');
    if (state.t === 'Fence') {
        const close = /^ {0,3}(`+|~+)\s*$/.exec(text);
        if (close && close[1][0] === state.marker[0] && close[1].length >= state.marker.length) return [[[0, n, 'Markup']], NORMAL];
        if (!state.lang) return [n > 0 ? [[0, n, 'Raw']] : [], state];
        const [spans, inner] = highlightLine(state.lang, line, state.inner);
        return [spans, { ...state, inner }];
    }
    const tokens: (Token | undefined)[] = new Array(n).fill(undefined);
    let from = 0;
    if (state.t === 'BlockComment') {
        const j = find(line, 0, '-->');
        if (j === undefined) return [n > 0 ? [[0, n, 'Comment']] : [], state];
        from = j + 3;
        tokens.fill('Comment', 0, from);
    } else {
        // A backtick fence's info string can't have backticks (that's inline
        // code).
        const fence = /^( {0,3})(`{3,}|~{3,})\s*([^\s`{}]*)/.exec(text);
        if (fence && !(fence[2][0] === '`' && text.slice(fence[0].length).includes('`'))) {
            const at = charLen(fence[0]) - charLen(fence[3]);
            const spans: Span[] = [[0, at, 'Markup']];
            if (fence[3] !== '') spans.push([at, at + charLen(fence[3]), 'Type']);
            if (at + charLen(fence[3]) < n) spans.push([at + charLen(fence[3]), n, 'Markup']);
            return [spans, { t: 'Fence', marker: fence[2], lang: fenceLanguage(fence[3]), inner: NORMAL }];
        }
    }
    const open = openComment(line, from);
    markdownBlock(line, from, open ?? n, undefined, tokens);
    if (open !== undefined) tokens.fill('Comment', open);
    return [tokenSpans(tokens), open !== undefined ? { t: 'BlockComment' } : NORMAL];
}

/** Spans for runs of the same token, one per character in `tokens`. */
function tokenSpans(tokens: readonly (Token | undefined)[]): Span[] {
    const out: Span[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === undefined) continue;
        const last = out[out.length - 1];
        if (last && last[1] === i && last[2] === t) last[1] = i + 1;
        else out.push([i, i + 1, t]);
    }
    return out;
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
    return tokenSpans(tokens);
}
