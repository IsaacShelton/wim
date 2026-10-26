// Parsing of Normal and Visual mode key sequences into commands.
//
// The editor accumulates keys until `parse` reports a complete command (or an
// invalid sequence), which keeps multi-key grammar such as `"a3d2w`, `ci(` or
// `gUiw` in one place.

import { KeyInput, charOf, isNamedKey, keyIs } from './keys';
import { isValidName } from './registers';

export type Operator =
    | 'Delete'
    | 'Change'
    | 'Yank'
    | 'Indent'
    | 'Outdent'
    | 'Lowercase'
    | 'Uppercase'
    | 'ToggleCase';

/** The key that, when repeated, applies the operator linewise (`dd`, `g~~`). */
function lineKey(op: Operator): string {
    const keys: Record<Operator, string> = {
        Delete: 'd',
        Change: 'c',
        Yank: 'y',
        Indent: '>',
        Outdent: '<',
        Lowercase: 'u',
        Uppercase: 'U',
        ToggleCase: '~',
    };
    return keys[op];
}

function isGPrefixed(op: Operator): boolean {
    return op === 'Lowercase' || op === 'Uppercase' || op === 'ToggleCase';
}

/** `f`, `t`, `F` and `T`. */
export type FindKind = 'To' | 'Till' | 'BackTo' | 'BackTill';

export function findForward(k: FindKind): boolean {
    return k === 'To' || k === 'Till';
}

export function findTill(k: FindKind): boolean {
    return k === 'Till' || k === 'BackTill';
}

export function findReversed(k: FindKind): FindKind {
    const map: Record<FindKind, FindKind> = { To: 'BackTo', Till: 'BackTill', BackTo: 'To', BackTill: 'Till' };
    return map[k];
}

export type Motion =
    | {
          t:
              | 'Left'
              | 'Right'
              | 'Up'
              | 'Down'
              | 'LineStart'
              | 'FirstNonBlank'
              | 'LineEnd'
              | 'LastNonBlank'
              | 'Column'
              | 'FileStart'
              | 'FileEnd'
              | 'NextLineStart'
              | 'PrevLineStart'
              | 'CurrentLineStart'
              | 'RepeatFind'
              | 'RepeatFindReverse'
              | 'MatchPair'
              | 'ParagraphForward'
              | 'ParagraphBackward'
              | 'ScreenTop'
              | 'ScreenMiddle'
              | 'ScreenBottom'
              | 'SearchNext'
              | 'SearchPrev';
      }
    | { t: 'WordForward' | 'WordBackward' | 'WordEnd' | 'WordEndBackward'; big: boolean }
    | { t: 'Find'; kind: FindKind; ch: string }
    /** `[{`, `[(`, `]}`, `])`: the enclosing unmatched bracket. */
    | { t: 'Unmatched'; ch: string }
    | { t: 'Mark'; name: string; exact: boolean };

export type TextObject =
    | { t: 'Word'; big: boolean }
    | { t: 'Quote'; q: string }
    | { t: 'Pair'; open: string; close: string }
    | { t: 'Paragraph' };

export type Target =
    | { t: 'Motion'; m: Motion }
    | { t: 'Object'; obj: TextObject; around: boolean }
    /** The operator key was doubled (`dd`, `>>`): operate on whole lines. */
    | { t: 'Line' };

export type InsertKind = 'Before' | 'After' | 'LineStart' | 'LineEnd' | 'Column0' | 'OpenBelow' | 'OpenAbove';

export type Scroll =
    | 'HalfPageDown'
    | 'HalfPageUp'
    | 'PageDown'
    | 'PageUp'
    | 'LineDown'
    | 'LineUp'
    | 'CursorTop'
    | 'CursorMiddle'
    | 'CursorBottom';

export type Action =
    | { t: 'Move'; m: Motion }
    | { t: 'Operate'; op: Operator; target: Target }
    | { t: 'Insert'; kind: InsertKind }
    | { t: 'Paste'; before: boolean }
    | { t: 'ReplaceChar'; c: string }
    | { t: 'Join'; spaces: boolean }
    | {
          t:
              | 'Undo'
              | 'Redo'
              | 'Repeat'
              | 'ToggleCaseChar'
              | 'Visual'
              | 'VisualLine'
              | 'Reselect'
              | 'ReplaceMode'
              | 'CmdLine'
              | 'WriteQuit'
              | 'QuitForce'
              | 'FileInfo'
              | 'AlternateBuffer'
              | 'VisualSwap'
              | 'VisualPaste';
      }
    | { t: 'Search' | 'SearchWord'; forward: boolean }
    | { t: 'Scroll'; s: Scroll }
    | { t: 'SetMark'; c: string }
    | { t: 'Increment'; n: number }
    // Visual mode only.
    | { t: 'VisualOp' | 'VisualLinewiseOp'; op: Operator }
    | { t: 'VisualObject'; obj: TextObject; around: boolean }
    | { t: 'VisualReplace'; c: string };

export interface Command {
    register?: string;
    count?: number;
    action: Action;
}

export type Parse = 'Incomplete' | 'Invalid' | { done: Command };

/** Thrown to stop parsing early with an incomplete or invalid result. */
class Stop {
    constructor(readonly result: 'Incomplete' | 'Invalid') {}
}

const INCOMPLETE = new Stop('Incomplete');
const INVALID = new Stop('Invalid');

export function parse(keys: readonly KeyInput[], visual: boolean): Parse {
    try {
        return { done: parseCommand(new Keys(keys), visual) };
    } catch (e) {
        if (e instanceof Stop) return e.result;
        throw e;
    }
}

class Keys {
    i = 0;

    constructor(private readonly keys: readonly KeyInput[]) {}

    next(): KeyInput {
        const key = this.peek();
        this.i += 1;
        return key;
    }

    peek(): KeyInput {
        const key = this.keys[this.i];
        if (!key) throw INCOMPLETE;
        return key;
    }

    /** The literal character argument of commands such as `f`, `r` and `m`. */
    nextChar(): string {
        const key = this.next();
        if (key.ctrl) throw INVALID;
        if (key.key === 'Tab') return '\t';
        if (key.key === 'Enter') return '\n';
        if (isNamedKey(key.key)) throw INVALID;
        return key.key;
    }

    count(): number | undefined {
        let n: number | undefined;
        for (;;) {
            const c = charOf(this.peek());
            if (c !== undefined && /^[0-9]$/.test(c) && (n !== undefined || c !== '0')) {
                n = Math.min((n ?? 0) * 10 + Number(c), 99_999);
                this.i += 1;
            } else {
                return n;
            }
        }
    }
}

function multiply(a: number | undefined, b: number | undefined): number | undefined {
    if (a === undefined && b === undefined) return undefined;
    return Math.min((a ?? 1) * (b ?? 1), 99_999);
}

function parseCommand(k: Keys, visual: boolean): Command {
    let count = k.count();
    let register: string | undefined;
    if (keyIs(k.peek(), '"')) {
        k.i += 1;
        const name = k.nextChar();
        if (!isValidName(name)) throw INVALID;
        register = name;
        count = multiply(count, k.count());
    }
    const key = k.next();
    const counter = { count };
    const action = visual ? parseVisual(k, key) : parseNormal(k, key, counter);
    return { register, count: counter.count, action };
}

function parseScroll(key: KeyInput): Action | undefined {
    if (key.ctrl) {
        const scroll: Record<string, Scroll> = {
            d: 'HalfPageDown',
            u: 'HalfPageUp',
            f: 'PageDown',
            b: 'PageUp',
            e: 'LineDown',
            y: 'LineUp',
        };
        const s = scroll[key.key];
        return s && { t: 'Scroll', s };
    }
    if (key.key === 'PageDown') return { t: 'Scroll', s: 'PageDown' };
    if (key.key === 'PageUp') return { t: 'Scroll', s: 'PageUp' };
    return undefined;
}

function parseNormal(k: Keys, key: KeyInput, counter: { count?: number }): Action {
    const m = parseMotion(k, key);
    if (m) return { t: 'Move', m };
    const scroll = parseScroll(key);
    if (scroll) return scroll;
    if (key.ctrl) {
        switch (key.key) {
            case 'r':
                return { t: 'Redo' };
            case 'a':
                return { t: 'Increment', n: 1 };
            case 'x':
                return { t: 'Increment', n: -1 };
            case 'g':
                return { t: 'FileInfo' };
            case '6':
            case '^':
                return { t: 'AlternateBuffer' };
            default:
                throw INVALID;
        }
    }
    if (key.key === 'Delete') return { t: 'Operate', op: 'Delete', target: { t: 'Motion', m: { t: 'Right' } } };
    const c = charOf(key);
    if (c === undefined) throw INVALID;
    const motion = (m: Motion): Target => ({ t: 'Motion', m });
    switch (c) {
        case 'd':
            return parseOperator(k, 'Delete', counter);
        case 'c':
            return parseOperator(k, 'Change', counter);
        case 'y':
            return parseOperator(k, 'Yank', counter);
        case '>':
            return parseOperator(k, 'Indent', counter);
        case '<':
            return parseOperator(k, 'Outdent', counter);
        case 'x':
            return { t: 'Operate', op: 'Delete', target: motion({ t: 'Right' }) };
        case 'X':
            return { t: 'Operate', op: 'Delete', target: motion({ t: 'Left' }) };
        case 's':
            return { t: 'Operate', op: 'Change', target: motion({ t: 'Right' }) };
        case 'S':
            return { t: 'Operate', op: 'Change', target: { t: 'Line' } };
        case 'D':
            return { t: 'Operate', op: 'Delete', target: motion({ t: 'LineEnd' }) };
        case 'C':
            return { t: 'Operate', op: 'Change', target: motion({ t: 'LineEnd' }) };
        case 'Y':
            return { t: 'Operate', op: 'Yank', target: { t: 'Line' } };
        case 'p':
            return { t: 'Paste', before: false };
        case 'P':
            return { t: 'Paste', before: true };
        case 'r':
            return { t: 'ReplaceChar', c: k.nextChar() };
        case 'J':
            return { t: 'Join', spaces: true };
        case 'u':
            return { t: 'Undo' };
        case '.':
            return { t: 'Repeat' };
        case '~':
            return { t: 'ToggleCaseChar' };
        case 'i':
            return { t: 'Insert', kind: 'Before' };
        case 'a':
            return { t: 'Insert', kind: 'After' };
        case 'I':
            return { t: 'Insert', kind: 'LineStart' };
        case 'A':
            return { t: 'Insert', kind: 'LineEnd' };
        case 'o':
            return { t: 'Insert', kind: 'OpenBelow' };
        case 'O':
            return { t: 'Insert', kind: 'OpenAbove' };
        case 'v':
            return { t: 'Visual' };
        case 'V':
            return { t: 'VisualLine' };
        case 'R':
            return { t: 'ReplaceMode' };
        case ':':
            return { t: 'CmdLine' };
        case '/':
            return { t: 'Search', forward: true };
        case '?':
            return { t: 'Search', forward: false };
        case '*':
            return { t: 'SearchWord', forward: true };
        case '#':
            return { t: 'SearchWord', forward: false };
        case 'm': {
            const name = k.nextChar();
            if (!/^[A-Za-z]$/.test(name)) throw INVALID;
            return { t: 'SetMark', c: name };
        }
        case 'z': {
            const next = k.next();
            const scroll: Record<string, Scroll> = {
                z: 'CursorMiddle',
                '.': 'CursorMiddle',
                t: 'CursorTop',
                Enter: 'CursorTop',
                b: 'CursorBottom',
                '-': 'CursorBottom',
            };
            const s = scroll[next.key];
            if (!s) throw INVALID;
            return { t: 'Scroll', s };
        }
        case 'Z':
            switch (k.nextChar()) {
                case 'Z':
                    return { t: 'WriteQuit' };
                case 'Q':
                    return { t: 'QuitForce' };
                default:
                    throw INVALID;
            }
        case 'g':
            switch (k.nextChar()) {
                case '~':
                    return parseOperator(k, 'ToggleCase', counter);
                case 'u':
                    return parseOperator(k, 'Lowercase', counter);
                case 'U':
                    return parseOperator(k, 'Uppercase', counter);
                case 'v':
                    return { t: 'Reselect' };
                case 'J':
                    return { t: 'Join', spaces: false };
                case 'I':
                    return { t: 'Insert', kind: 'Column0' };
                default:
                    throw INVALID;
            }
        default:
            throw INVALID;
    }
}

function parseOperator(k: Keys, op: Operator, counter: { count?: number }): Action {
    counter.count = multiply(counter.count, k.count());
    const key = k.next();
    const lk = lineKey(op);
    if (keyIs(key, lk)) return { t: 'Operate', op, target: { t: 'Line' } };
    if (isGPrefixed(op) && keyIs(key, 'g') && keyIs(k.peek(), lk)) {
        k.i += 1;
        return { t: 'Operate', op, target: { t: 'Line' } };
    }
    if (keyIs(key, 'i') || keyIs(key, 'a')) {
        const obj = textObject(k.nextChar());
        if (!obj) throw INVALID;
        return { t: 'Operate', op, target: { t: 'Object', obj, around: keyIs(key, 'a') } };
    }
    const m = parseMotion(k, key);
    if (!m) throw INVALID;
    return { t: 'Operate', op, target: { t: 'Motion', m } };
}

function parseVisual(k: Keys, key: KeyInput): Action {
    const m = parseMotion(k, key);
    if (m) return { t: 'Move', m };
    const scroll = parseScroll(key);
    if (scroll) return scroll;
    if (key.ctrl) throw INVALID;
    if (key.key === 'Delete') return { t: 'VisualOp', op: 'Delete' };
    const c = charOf(key);
    if (c === undefined) throw INVALID;
    const vop = (op: Operator): Action => ({ t: 'VisualOp', op });
    const vlop = (op: Operator): Action => ({ t: 'VisualLinewiseOp', op });
    switch (c) {
        case 'd':
        case 'x':
            return vop('Delete');
        case 'c':
        case 's':
            return vop('Change');
        case 'y':
            return vop('Yank');
        case '>':
            return vop('Indent');
        case '<':
            return vop('Outdent');
        case '~':
            return vop('ToggleCase');
        case 'u':
            return vop('Lowercase');
        case 'U':
            return vop('Uppercase');
        case 'D':
        case 'X':
            return vlop('Delete');
        case 'C':
        case 'S':
        case 'R':
            return vlop('Change');
        case 'Y':
            return vlop('Yank');
        case 'J':
            return { t: 'Join', spaces: true };
        case 'p':
        case 'P':
            return { t: 'VisualPaste' };
        case 'r':
            return { t: 'VisualReplace', c: k.nextChar() };
        case 'o':
        case 'O':
            return { t: 'VisualSwap' };
        case 'i':
        case 'a': {
            const obj = textObject(k.nextChar());
            if (!obj) throw INVALID;
            return { t: 'VisualObject', obj, around: c === 'a' };
        }
        case 'v':
            return { t: 'Visual' };
        case 'V':
            return { t: 'VisualLine' };
        case ':':
            return { t: 'CmdLine' };
        case '/':
            return { t: 'Search', forward: true };
        case '?':
            return { t: 'Search', forward: false };
        case 'g':
            switch (k.nextChar()) {
                case 'J':
                    return { t: 'Join', spaces: false };
                case '~':
                    return vop('ToggleCase');
                case 'u':
                    return vop('Lowercase');
                case 'U':
                    return vop('Uppercase');
                default:
                    throw INVALID;
            }
        default:
            throw INVALID;
    }
}

function textObject(c: string): TextObject | undefined {
    switch (c) {
        case 'w':
            return { t: 'Word', big: false };
        case 'W':
            return { t: 'Word', big: true };
        case 'p':
            return { t: 'Paragraph' };
        case '"':
        case "'":
        case '`':
            return { t: 'Quote', q: c };
        case '(':
        case ')':
        case 'b':
            return { t: 'Pair', open: '(', close: ')' };
        case '{':
        case '}':
        case 'B':
            return { t: 'Pair', open: '{', close: '}' };
        case '[':
        case ']':
            return { t: 'Pair', open: '[', close: ']' };
        case '<':
        case '>':
            return { t: 'Pair', open: '<', close: '>' };
        default:
            return undefined;
    }
}

/** Parse a motion starting with `key`. Returns `undefined` without consuming
 * further keys when `key` does not start a motion. */
function parseMotion(k: Keys, key: KeyInput): Motion | undefined {
    if (key.ctrl) {
        if (key.key === 'n') return { t: 'Down' };
        if (key.key === 'p') return { t: 'Up' };
        return undefined;
    }
    switch (key.key) {
        // Option+arrows move by word, as in other macOS editors.
        case 'Left':
            return key.alt ? { t: 'WordBackward', big: false } : { t: 'Left' };
        case 'Right':
            return key.alt ? { t: 'WordForward', big: false } : { t: 'Right' };
        case 'Backspace':
            return { t: 'Left' };
        case 'Up':
            return { t: 'Up' };
        case 'Down':
            return { t: 'Down' };
        case 'Home':
            return { t: 'LineStart' };
        case 'End':
            return { t: 'LineEnd' };
        case 'Enter':
            return { t: 'NextLineStart' };
    }
    if (isNamedKey(key.key)) return undefined;
    const c = key.key;
    switch (c) {
        case 'h':
            return { t: 'Left' };
        case 'l':
        case ' ':
            return { t: 'Right' };
        case 'j':
            return { t: 'Down' };
        case 'k':
            return { t: 'Up' };
        case 'w':
            return { t: 'WordForward', big: false };
        case 'W':
            return { t: 'WordForward', big: true };
        case 'b':
            return { t: 'WordBackward', big: false };
        case 'B':
            return { t: 'WordBackward', big: true };
        case 'e':
            return { t: 'WordEnd', big: false };
        case 'E':
            return { t: 'WordEnd', big: true };
        case '0':
            return { t: 'LineStart' };
        case '^':
            return { t: 'FirstNonBlank' };
        case '$':
            return { t: 'LineEnd' };
        case '|':
            return { t: 'Column' };
        case 'G':
            return { t: 'FileEnd' };
        case '+':
            return { t: 'NextLineStart' };
        case '-':
            return { t: 'PrevLineStart' };
        case '_':
            return { t: 'CurrentLineStart' };
        case 'f':
        case 'F':
        case 't':
        case 'T': {
            const kinds: Record<string, FindKind> = { f: 'To', F: 'BackTo', t: 'Till', T: 'BackTill' };
            return { t: 'Find', kind: kinds[c], ch: k.nextChar() };
        }
        case ';':
            return { t: 'RepeatFind' };
        case ',':
            return { t: 'RepeatFindReverse' };
        case '%':
            return { t: 'MatchPair' };
        case '[':
        case ']': {
            const ch = k.nextChar();
            if ((c === '[' && (ch === '{' || ch === '(')) || (c === ']' && (ch === '}' || ch === ')'))) {
                return { t: 'Unmatched', ch };
            }
            throw INVALID;
        }
        case '}':
            return { t: 'ParagraphForward' };
        case '{':
            return { t: 'ParagraphBackward' };
        case 'H':
            return { t: 'ScreenTop' };
        case 'M':
            return { t: 'ScreenMiddle' };
        case 'L':
            return { t: 'ScreenBottom' };
        case 'n':
            return { t: 'SearchNext' };
        case 'N':
            return { t: 'SearchPrev' };
        case "'":
        case '`':
            return { t: 'Mark', name: k.nextChar(), exact: c === '`' };
        case 'g': {
            const motions: Record<string, Motion> = {
                g: { t: 'FileStart' },
                e: { t: 'WordEndBackward', big: false },
                E: { t: 'WordEndBackward', big: true },
                _: { t: 'LastNonBlank' },
                '0': { t: 'LineStart' },
                j: { t: 'Down' },
                k: { t: 'Up' },
            };
            const next = charOf(k.peek());
            const m = next === undefined ? undefined : motions[next];
            if (!m) return undefined;
            k.i += 1;
            return m;
        }
        default:
            return undefined;
    }
}
