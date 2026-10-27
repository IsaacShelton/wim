// Ex (`:`) commands.

import { Line, pos } from './buffer';
import {
    alternateBuffer,
    cycleBuffer,
    deleteAllBuffers,
    deleteBuffer,
    firstOrLastBuffer,
    loadFile,
    newBuffer,
    openFile,
    switchByName,
    switchToBuffer,
    writeAll,
    writeFile,
} from './buffers';
import type { Editor, Options } from './editor';
import { EditorError, READONLY, fail } from './errors';
import { applyOperator, joinLines, shiftLines } from './ops';
import { lineRange } from './range';
import * as search from './search';
import { expandTilde } from '../paths';


/** Commands the window handles rather than the editor (as user commands),
 * by their abbreviations. */
const WINDOW_COMMANDS: Record<string, string> = {
    colo: 'colorscheme',
    colorscheme: 'colorscheme',
    sp: 'split',
    split: 'split',
    vs: 'vsplit',
    vsp: 'vsplit',
    vsplit: 'vsplit',
    new: 'new',
    vne: 'vnew',
    vnew: 'vnew',
    on: 'only',
    only: 'only',
};

export function runEx(ed: Editor, input: string): void {
    if (ed.undoPending === undefined) ed.undoPending = ed.snapshot();
    const buffer = ed.buffer;
    const version = buffer.version();
    try {
        exCommand(ed, input);
    } catch (e) {
        if (!(e instanceof EditorError)) throw e;
        ed.setError(e.message);
    }
    // An image or sound can't be changed: put back what a command like :s
    // did.
    if (ed.readonly() && ed.buffer === buffer && buffer.version() !== version) {
        const s = ed.undoPending;
        buffer.restore(s.lines, s.version);
        ed.cursor = s.cursor;
        ed.setError(READONLY);
    }
    ed.commitUndo();
    ed.clampCursor();
}

function exCommand(ed: Editor, input: string): void {
    input = input.replace(/^[: ]+/, '');
    if (input === '') return;
    const wholeFile = input.startsWith('%');
    const [range, after] = parseRange(ed, input);
    const rest = after.trimStart();
    let nameLen = /^[A-Za-z]*/.exec(rest)![0].length;
    if (nameLen === 0 && rest !== '') nameLen = Array.from(rest)[0].length;
    const name = rest.slice(0, nameLen);
    let args = rest.slice(nameLen);
    const bang = args.startsWith('!');
    if (bang) args = args.slice(1);
    args = args.trim();
    const current = ed.cursor.line;
    const [first, last] = range ?? [current, current];

    switch (name) {
        case '':
            if (range) {
                ed.markJump();
                ed.cursor = pos(last, ed.buffer.firstNonBlank(last));
            }
            return;
        case 'w':
        case 'write':
            writeFile(ed, pathArg(args));
            return;
        case 'wa':
        case 'wall':
            if (writeAll(ed)) ed.setMessage('All buffers written');
            return;
        case 'wq':
        case 'x':
        case 'xit':
        case 'exit': {
            const needsWrite = name === 'wq' || ed.isModified() || args !== '';
            if (!needsWrite || writeFile(ed, pathArg(args))) ed.quitBuffer(bang);
            return;
        }
        case 'wqa':
        case 'wqall':
        case 'xa':
        case 'xall':
            if (writeAll(ed)) ed.requestQuit(bang);
            return;
        case 'q':
        case 'quit':
        case 'clo':
        case 'close':
            ed.quitBuffer(bang);
            return;
        case 'qa':
        case 'qall':
        case 'quitall':
            ed.requestQuit(bang);
            return;
        case 'e':
        case 'edit': {
            const p = pathArg(args);
            // Other files open in their own buffer; this one keeps its changes.
            if (p !== undefined) {
                openFile(ed, p);
                return;
            }
            if (ed.isModified() && !bang) fail('E37: No write since last change (add ! to override)');
            if (ed.filePath === undefined) fail('E32: No file name');
            loadFile(ed, ed.filePath);
            return;
        }
        case 'ene':
        case 'enew':
            newBuffer(ed);
            return;
        case 'ls':
        case 'buffers':
        case 'files':
            ed.setMessage(
                ed
                    .bufferList()
                    .map((b) => `${b.id}${b.active ? '%' : ' '} "${b.name}"${b.modified ? ' +' : ''}`)
                    .join('   '),
            );
            return;
        case 'b':
        case 'bu':
        case 'buf':
        case 'buffer':
            if (args === '') return;
            if (args === '#') alternateBuffer(ed);
            else if (/^[0-9]+$/.test(args)) switchToBuffer(ed, Number(args));
            else switchByName(ed, args);
            return;
        case 'bn':
        case 'bne':
        case 'bnex':
        case 'bnext':
            cycleBuffer(ed, 1);
            return;
        case 'bp':
        case 'bpr':
        case 'bpre':
        case 'bprev':
        case 'bprevi':
        case 'bprevio':
        case 'bpreviou':
        case 'bprevious':
        case 'bN':
        case 'bNext':
            cycleBuffer(ed, -1);
            return;
        case 'bf':
        case 'bfirst':
        case 'br':
        case 'brewind':
            firstOrLastBuffer(ed, false);
            return;
        case 'bl':
        case 'blast':
            firstOrLastBuffer(ed, true);
            return;
        case 'bo':
        case 'bonly':
            deleteAllBuffers(ed, bang, true);
            return;
        case 'bd':
        case 'bdelete':
        case 'bw':
        case 'bwipeout':
        case 'bun':
        case 'bunload': {
            if (wholeFile) {
                deleteAllBuffers(ed, bang, false);
                return;
            }
            if (args !== '' && !/^[0-9]+$/.test(args)) fail(`E94: No matching buffer for ${args}`);
            deleteBuffer(ed, args === '' ? undefined : Number(args), bang);
            return;
        }
        case 's':
        case 'substitute':
            substitute(ed, first, last, args);
            return;
        case 'd':
        case 'delete':
            applyOperator(ed, 'Delete', lineRange(first, last), registerArg(args));
            return;
        case 'y':
        case 'yank': {
            const lines: string[] = [];
            for (let l = first; l <= last; l++) lines.push(ed.buffer.lineString(l));
            ed.registers.set(registerArg(args), { text: lines.join('\n'), linewise: true }, 'Yank');
            return;
        }
        case '>':
        case '<': {
            const times = 1 + Array.from(args).filter((c) => c === name).length;
            for (let i = 0; i < times; i++) shiftLines(ed, first, last, name === '>');
            ed.cursor = pos(first, ed.buffer.firstNonBlank(first));
            return;
        }
        case 'j':
        case 'join': {
            const joins = range && last > first ? last - first : 1;
            joinLines(ed, first, joins, !bang);
            return;
        }
        case 'm':
        case 'move': {
            // Lines go below `dest`; address 0 (`dest == -1`) means the top.
            const dest = parseTarget(ed, args);
            if (first <= dest && dest < last) fail('E134: Cannot move a range of lines into itself');
            const lines = ed.buffer.removeLines(first, last);
            const n = lines.length;
            const at = dest >= last ? dest + 1 - n : dest + 1;
            ed.buffer.insertLines(at, lines);
            ed.cursor = pos(at + n - 1, ed.buffer.firstNonBlank(at + n - 1));
            shiftVisualMarks(ed, first, last, at - first);
            return;
        }
        case 't':
        case 'co':
        case 'copy': {
            const dest = parseTarget(ed, args);
            const lines: Line[] = [];
            for (let l = first; l <= last; l++) lines.push(ed.buffer.line(l).slice());
            const at = dest + 1;
            ed.buffer.insertLines(at, lines);
            ed.cursor = pos(at + lines.length - 1, ed.buffer.firstNonBlank(at + lines.length - 1));
            return;
        }
        case 'sor':
        case 'sort': {
            const [from, to] = range ?? [0, ed.buffer.lastLine()];
            let lines: string[] = [];
            for (let l = from; l <= to; l++) lines.push(ed.buffer.lineString(l));
            if (args.includes('i')) {
                lines.sort((a, b) => compareStrings(a.toLowerCase(), b.toLowerCase()));
            } else {
                lines.sort(compareStrings);
            }
            if (bang) lines.reverse();
            if (args.includes('u')) lines = lines.filter((l, i) => i === 0 || l !== lines[i - 1]);
            ed.buffer.insertLines(to + 1, lines.map((l) => Array.from(l)));
            ed.buffer.removeLines(from, to);
            return;
        }
        case 'noh':
        case 'nohlsearch':
            ed.hlsearchActive = false;
            return;
        case 'se':
        case 'set':
            setOptions(ed, args);
            return;
        case 'u':
        case 'undo':
            ed.undo();
            return;
        case 'red':
        case 'redo':
            ed.redo();
            return;
        case 'reg':
        case 'registers':
        case 'di':
        case 'display': {
            const parts: string[] = [];
            for (const c of '"0123456789abcdefghijklmnopqrstuvwxyz-') {
                const r = ed.registers.get(c);
                if (r) parts.push(`"${c} ${Array.from(r.text).slice(0, 40).join('').replace(/\n/g, '^J')}`);
            }
            ed.setMessage(parts.length === 0 ? 'No registers set' : parts.join('  |  '));
            return;
        }
        case 'pw':
        case 'pwd':
            ed.setMessage(process.cwd());
            return;
        case 'cd': {
            const dir = expandTilde(args === '' ? '~' : args);
            try {
                process.chdir(dir);
            } catch (e) {
                fail(`E344: Can't find directory "${dir}": ${(e as Error).message}`);
            }
            ed.setMessage(dir);
            return;
        }
        case 'h':
        case 'help':
            ed.setMessage(
                'Wim: :w :q[!] :wq :e file :ls :b N :bn :bp :bd :[range]s/pat/rep/[gi] :set opt :noh :sort :reg  Ctrl+n: file tree',
            );
            return;
        default:
            if (ed.userCommand && (/^[A-Z]/.test(name) || name in WINDOW_COMMANDS)) {
                ed.userCommand(WINDOW_COMMANDS[name] ?? name, args, bang);
            } else {
                fail(`E492: Not an editor command: ${input}`);
            }
    }
}

/** Compare by UTF-16 code units, like a byte-wise sort for most text. */
function compareStrings(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function registerArg(args: string): string | undefined {
    const c = Array.from(args)[0];
    return c !== undefined && /^[A-Za-z]$/.test(c) ? c : undefined;
}

/** Parse an optional line range at the start of `s`. */
function parseRange(ed: Editor, s: string): [[number, number] | undefined, string] {
    if (s.startsWith('%')) return [[0, ed.buffer.lastLine()], s.slice(1)];
    const firstAddr = parseAddress(ed, s);
    if (!firstAddr) return [undefined, s];
    let [first, rest] = firstAddr;
    let last = first;
    if (rest.startsWith(',') || rest.startsWith(';')) {
        const second = parseAddress(ed, rest.slice(1));
        if (!second) fail('E14: Invalid address');
        [last, rest] = second;
    }
    return [first <= last ? [first, last] : [last, first], rest];
}

/** The destination address of `:m` and `:t`, where `-1` is address 0 (above
 * the first line). */
function parseTarget(ed: Editor, args: string): number {
    const addr = parseAddressRaw(ed, args);
    if (!addr) fail('E14: Invalid address');
    return addr[0];
}

/** Move the visual marks (and `gv`'s selection) along with lines that `:m`
 * moved, so mappings like `:m '>+1<CR>gv` keep the selection. */
function shiftVisualMarks(ed: Editor, first: number, last: number, delta: number): void {
    const shift = <T extends { line: number; col: number }>(p: T): T =>
        p.line >= first && p.line <= last ? { ...p, line: p.line + delta } : p;
    for (const name of ['<', '>']) {
        const p = ed.marks.get(name);
        if (p) ed.marks.set(name, shift(p));
    }
    const v = ed.lastVisual;
    if (v) {
        v.anchor = shift(v.anchor);
        v.cursor = shift(v.cursor);
    }
}

function parseAddress(ed: Editor, s: string): [number, string] | undefined {
    const addr = parseAddressRaw(ed, s);
    return addr && [Math.max(addr[0], 0), addr[1]];
}

/** Parse a single address (`12`, `.`, `$`, `'a`, with `+N`/`-N` offsets). */
function parseAddressRaw(ed: Editor, s: string): [number, string] | undefined {
    const last = ed.buffer.lastLine();
    let line: number | undefined;
    let consumed = 0;
    const digits = /^[0-9]+/.exec(s);
    if (digits) {
        line = Number(digits[0]) - 1;
        consumed = digits[0].length;
    } else if (s.startsWith('.')) {
        line = ed.cursor.line;
        consumed = 1;
    } else if (s.startsWith('$')) {
        line = last;
        consumed = 1;
    } else if (s.startsWith("'")) {
        const mark = Array.from(s.slice(1))[0];
        const p = mark === undefined ? undefined : ed.marks.get(mark);
        if (!p) fail('E20: Mark not set');
        line = p.line;
        consumed = 1 + mark!.length;
    }
    let rest = s.slice(consumed);
    for (;;) {
        const m = /^([+-])([0-9]*)/.exec(rest);
        if (!m) break;
        const amount = m[2] === '' ? 1 : Number(m[2]);
        const base = line ?? ed.cursor.line;
        line = m[1] === '+' ? base + amount : base - amount;
        rest = rest.slice(m[0].length);
    }
    if (line === undefined) return undefined;
    if (line > last || line < -1) fail('E16: Invalid range');
    return [line, rest];
}

function substitute(ed: Editor, first: number, last: number, args: string): void {
    let parts: [string, string, string];
    if (args === '') {
        if (!ed.lastSubstitute) fail('E35: No previous regular expression');
        parts = ed.lastSubstitute;
    } else {
        parts = parseSubstitute(args);
    }
    let [pattern] = parts;
    const [, replacement, flags] = parts;
    if (pattern === '') {
        if (!ed.lastSearch) fail('E35: No previous regular expression');
        pattern = ed.lastSearch.pattern;
    }
    ed.lastSubstitute = [pattern, replacement, flags];
    const ignorecase = flags.includes('i') ? true : flags.includes('I') ? false : ed.options.ignorecase;
    const smartcase = ed.options.smartcase && !flags.includes('i');
    let re: RegExp;
    try {
        re = search.compile(pattern, ignorecase, smartcase);
    } catch (e) {
        fail(`E486: Invalid pattern: ${(e as Error).message}`);
    }
    const global = flags.includes('g');

    let total = 0;
    let linesChanged = 0;
    let lastChanged: number | undefined;
    for (let line = last; line >= first; line--) {
        const [text, n] = search.substituteLine(re, ed.buffer.lineString(line), replacement, global);
        if (n === 0) continue;
        total += n;
        linesChanged += 1;
        lastChanged ??= line;
        const [head, ...extra] = text.split('\n');
        ed.buffer.replaceLine(line, Array.from(head));
        if (extra.length > 0) ed.buffer.insertLines(line + 1, extra.map((l) => Array.from(l)));
    }
    ed.lastSearch = { pattern, forward: true };
    ed.hlsearchActive = true;
    if (lastChanged === undefined) {
        if (flags.includes('e')) return;
        fail(`E486: Pattern not found: ${pattern}`);
    }
    ed.cursor = pos(lastChanged, ed.buffer.firstNonBlank(lastChanged));
    if (linesChanged > 1) {
        ed.setMessage(`${total} substitution${total === 1 ? '' : 's'} on ${linesChanged} lines`);
    }
}

type BoolOption =
    | 'number'
    | 'relativenumber'
    | 'ignorecase'
    | 'smartcase'
    | 'hlsearch'
    | 'incsearch'
    | 'expandtab'
    | 'autoindent'
    | 'autopairs';
const BOOL_OPTIONS: readonly string[] = [
    'number',
    'relativenumber',
    'ignorecase',
    'smartcase',
    'hlsearch',
    'incsearch',
    'expandtab',
    'autoindent',
    'autopairs',
];

function setOptions(ed: Editor, args: string): void {
    if (args === '') {
        const o = ed.options;
        const flag = (on: boolean, n: string): string => (on ? '' : 'no') + n;
        ed.setMessage(
            [
                flag(o.number, 'number'),
                flag(o.relativenumber, 'relativenumber'),
                flag(o.ignorecase, 'ignorecase'),
                flag(o.smartcase, 'smartcase'),
                flag(o.hlsearch, 'hlsearch'),
                flag(o.expandtab, 'expandtab'),
                flag(o.autopairs, 'autopairs'),
                `tabstop=${o.tabstop}`,
                `shiftwidth=${o.shiftwidth}`,
                `scrolloff=${o.scrolloff}`,
            ].join(' '),
        );
        return;
    }
    for (const arg of args.split(/\s+/).filter((a) => a !== '')) setOption(ed, arg);
}

function setOption(ed: Editor, arg: string): void {
    const eq = arg.search(/[=:]/);
    if (eq >= 0) {
        const name = arg.slice(0, eq);
        const value = arg.slice(eq + 1);
        if (name === 'clipboard' || name === 'cb') {
            ed.registers.useSystemClipboard = value.includes('unnamed');
            return;
        }
        if (!/^[0-9]+$/.test(value)) fail(`E521: Number required after =: ${arg}`);
        const n = Number(value);
        const o = ed.options;
        switch (canonicalOption(name)) {
            case 'tabstop':
                o.tabstop = Math.max(n, 1);
                return;
            case 'shiftwidth':
                o.shiftwidth = Math.max(n, 1);
                return;
            case 'scrolloff':
                o.scrolloff = n;
                return;
            default:
                fail(`E518: Unknown option: ${name}`);
        }
    }
    let name = arg;
    const query = name.endsWith('?');
    if (query) name = name.slice(0, -1);
    let toggle = false;
    if (name.endsWith('!')) {
        name = name.slice(0, -1);
        toggle = true;
    } else if (name.startsWith('inv')) {
        name = name.slice(3);
        toggle = true;
    }
    let value = true;
    if (name.startsWith('no') && isBoolOption(name.slice(2))) {
        name = name.slice(2);
        value = false;
    }
    const full = canonicalOption(name);
    if (!isBoolOption(name)) {
        if (query && (full === 'tabstop' || full === 'shiftwidth' || full === 'scrolloff')) {
            ed.setMessage(`${full}=${ed.options[full as 'tabstop' | 'shiftwidth' | 'scrolloff']}`);
            return;
        }
        fail(`E518: Unknown option: ${name}`);
    }
    const key = full as BoolOption;
    if (query) {
        ed.setMessage((ed.options[key] ? '' : 'no') + full);
    } else if (toggle) {
        ed.options[key] = !ed.options[key];
    } else {
        ed.options[key] = value;
        if (full === 'hlsearch' && value) ed.hlsearchActive = true;
    }
}

function isBoolOption(name: string): boolean {
    return BOOL_OPTIONS.includes(canonicalOption(name));
}

function canonicalOption(name: string): keyof Options | string {
    const aliases: Record<string, keyof Options> = {
        nu: 'number',
        rnu: 'relativenumber',
        ic: 'ignorecase',
        scs: 'smartcase',
        hls: 'hlsearch',
        is: 'incsearch',
        et: 'expandtab',
        ai: 'autoindent',
        ts: 'tabstop',
        sw: 'shiftwidth',
        so: 'scrolloff',
    };
    return aliases[name] ?? name;
}

function pathArg(args: string): string | undefined {
    return args === '' ? undefined : expandTilde(args);
}

/** Split `/pattern/replacement/flags`, honouring escaped delimiters. */
function parseSubstitute(args: string): [string, string, string] {
    const cs = Array.from(args);
    const delim = cs[0];
    if (delim === undefined) fail('E35: No previous regular expression');
    if (/^[\p{L}\p{N}]$/u.test(delim) || delim === '\\' || delim === '"' || delim === '|') {
        fail("E146: Regular expressions can't be delimited by letters");
    }
    const parts = [''];
    let escaped = false;
    for (const c of cs.slice(1)) {
        if (escaped) {
            if (c !== delim) parts[parts.length - 1] += '\\';
            parts[parts.length - 1] += c;
            escaped = false;
        } else if (c === '\\') {
            escaped = true;
        } else if (c === delim && parts.length < 3) {
            parts.push('');
        } else {
            parts[parts.length - 1] += c;
        }
    }
    if (escaped) parts[parts.length - 1] += '\\';
    while (parts.length < 3) parts.push('');
    return [parts[0], parts[1], parts[2].trim()];
}
