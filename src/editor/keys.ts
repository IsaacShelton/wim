// Toolkit-independent key representation used by the editor core.

export type NamedKey =
    | 'Esc'
    | 'Enter'
    | 'Backspace'
    | 'Delete'
    | 'Tab'
    /** Shift+Tab. */
    | 'BackTab'
    | 'Left'
    | 'Right'
    | 'Up'
    | 'Down'
    | 'Home'
    | 'End'
    | 'PageUp'
    | 'PageDown';

const NAMED: readonly NamedKey[] = [
    'Esc', 'Enter', 'Backspace', 'Delete', 'Tab', 'BackTab', 'Left', 'Right', 'Up', 'Down',
    'Home', 'End', 'PageUp', 'PageDown',
];

export function isNamedKey(s: string): s is NamedKey {
    return (NAMED as readonly string[]).includes(s);
}

export interface KeyInput {
    /** A named key, or a single character. */
    readonly key: NamedKey | string;
    readonly ctrl: boolean;
    /** Option on macOS. */
    readonly alt: boolean;
}

/** Map terminal aliases onto their canonical keys. Like Neovim, `<C-h>`,
 * `<C-j>` and `<C-i>` stay distinct from `<BS>`, `<CR>` and `<Tab>` so they
 * can be mapped. */
export function keyNew(key: string, ctrl: boolean): KeyInput {
    if (ctrl && !isNamedKey(key)) {
        if (key === '[' || key === 'c') return plain('Esc');
        if (key === 'm') return plain('Enter');
        return { key: asciiLower(key), ctrl: true, alt: false };
    }
    return { key, ctrl, alt: false };
}

export function plain(key: string): KeyInput {
    return { key, ctrl: false, alt: false };
}

export function alt(key: string): KeyInput {
    return { key, ctrl: false, alt: true };
}

export function ch(c: string): KeyInput {
    return plain(c);
}

export function ctrl(c: string): KeyInput {
    return keyNew(c, true);
}

export function isCharKey(k: KeyInput): boolean {
    return !isNamedKey(k.key);
}

/** The typed character, if this is an unmodified printable key. */
export function charOf(k: KeyInput): string | undefined {
    return !isNamedKey(k.key) && !k.ctrl && !k.alt ? k.key : undefined;
}

export function keyIs(k: KeyInput, c: string): boolean {
    return charOf(k) === c;
}

export function keyEq(a: KeyInput, b: KeyInput): boolean {
    return a.key === b.key && a.ctrl === b.ctrl && a.alt === b.alt;
}

export function keysStartWith(keys: readonly KeyInput[], prefix: readonly KeyInput[]): boolean {
    return prefix.length <= keys.length && prefix.every((k, i) => keyEq(k, keys[i]));
}

export function keysEq(a: readonly KeyInput[], b: readonly KeyInput[]): boolean {
    return a.length === b.length && keysStartWith(a, b);
}

function asciiLower(c: string): string {
    return /^[A-Z]$/.test(c) ? c.toLowerCase() : c;
}

export function keyToString(k: KeyInput): string {
    if (k.ctrl && !isNamedKey(k.key)) return '^' + (/^[a-z]$/.test(k.key) ? k.key.toUpperCase() : k.key);
    const prefix = k.alt ? 'M-' : '';
    if (!isNamedKey(k.key)) return prefix + k.key;
    const names: Record<NamedKey, string> = {
        Esc: '<Esc>',
        Enter: '<CR>',
        Backspace: '<BS>',
        Delete: '<Del>',
        Tab: '<Tab>',
        BackTab: '<S-Tab>',
        Left: '<Left>',
        Right: '<Right>',
        Up: '<Up>',
        Down: '<Down>',
        Home: '<Home>',
        End: '<End>',
        PageUp: '<PageUp>',
        PageDown: '<PageDown>',
    };
    return prefix + names[k.key];
}

/** Parse Vim key notation such as `dw`, `<Esc>`, `<C-r>` or `<CR>`. */
export function parseKeys(s: string): KeyInput[] {
    const out: KeyInput[] = [];
    const cs = Array.from(s);
    for (let i = 0; i < cs.length; i++) {
        const c = cs[i];
        if (c === '<') {
            const close = cs.indexOf('>', i + 1);
            if (close >= 0) {
                const key = parseNamed(cs.slice(i + 1, close).join(''));
                if (key) {
                    out.push(key);
                    i = close;
                    continue;
                }
            }
        }
        out.push(ch(c));
    }
    return out;
}

function parseNamed(name: string): KeyInput | undefined {
    const lower = name.toLowerCase();
    if (lower.startsWith('c-')) {
        const rest = Array.from(lower.slice(2));
        return rest.length === 1 ? ctrl(rest[0]) : undefined;
    }
    if (lower.startsWith('m-') || lower.startsWith('a-')) {
        const rest = name.slice(2);
        const inner = Array.from(rest).length === 1 ? rest : parseNamed(rest)?.key;
        return inner === undefined ? undefined : alt(inner);
    }
    const table: Record<string, string> = {
        esc: 'Esc',
        cr: 'Enter',
        enter: 'Enter',
        return: 'Enter',
        bs: 'Backspace',
        del: 'Delete',
        tab: 'Tab',
        's-tab': 'BackTab',
        left: 'Left',
        right: 'Right',
        up: 'Up',
        down: 'Down',
        home: 'Home',
        end: 'End',
        pageup: 'PageUp',
        pagedown: 'PageDown',
        space: ' ',
        lt: '<',
    };
    const key = table[lower];
    return key === undefined ? undefined : plain(key);
}
