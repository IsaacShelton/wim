// Tests for the integrated terminal, with a real shell on a pseudo-terminal.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { WimApp } from '../src/app';
import { MemoryClipboard } from '../src/clipboard';
import { defaultConfig } from '../src/config';
import { parseKeys } from '../src/editor/keys';
import { DrawCmd } from '../src/protocol';
import { encodeKey, paletteColor } from '../src/terminal';
import { theme } from '../src/theme';

const posix = process.platform !== 'win32';

type TextCmd = Extract<DrawCmd, ['text', ...unknown[]]>;

function harness() {
    const frames: DrawCmd[][] = [];
    const config = defaultConfig();
    config.terminal.shell = 'sh';
    const app = new WimApp({ icons: false, clipboard: new MemoryClipboard(), servers: [], config, onFrame: (_t, _d, c) => frames.push(c), onQuit: () => {} });
    let width = 1400;
    const resize = (): void => app.handleMessage({ t: 'resize', width, height: 800, charW: 10, lineH: 20 });
    resize();
    const texts = (): TextCmd[] => frames[frames.length - 1].filter((c): c is TextCmd => c[0] === 'text');
    return {
        app,
        texts,
        type: (keys: string) => {
            for (const k of parseKeys(keys)) app.handleMessage({ t: 'key', key: k.key, ctrl: k.ctrl, alt: k.alt });
        },
        /** Ctrl and a key, as the window sends it. */
        ctrl: (key: string) => app.handleMessage({ t: 'key', key, ctrl: true, alt: false }),
        setWidth: (w: number) => {
            width = w;
            resize();
        },
        text: () => texts().map((c) => c[3]).join('\n'),
        /** Wait until the screen shows `pattern`. */
        async until(pattern: RegExp): Promise<RegExpExecArray> {
            for (let i = 0; i < 200; i++) {
                const m = pattern.exec(this.text());
                if (m) return m;
                await new Promise((r) => setTimeout(r, 25));
                resize();
            }
            assert.match(this.text(), pattern);
            throw new Error('unreachable');
        },
    };
}

test('the terminal runs the shell on a real terminal, sized to the panel', { skip: !posix }, async () => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wim-term-')));
    const h = harness();
    h.app.handleMessage({ t: 'command', name: 'terminal' });
    assert.match(h.text(), / TERMINAL /);
    assert.match(h.text(), / TERM /, 'the status line shows the terminal has the keys');
    h.type(`cd ${dir}<CR>`);
    h.type('tty -s && echo "is a $((1+1))tty"; pwd; stty size<CR>');
    await h.until(new RegExp(`is a 2tty\\n${dir}`));
    const [, rows, cols] = await h.until(/^(\d+) (\d+)$/m);
    // The panel is 1400px wide, in 10px cells, less a cell's margin each side.
    assert.equal(Number(cols), 138);
    assert.ok(Number(rows) >= 6, `${rows} rows`);
    // A narrower window makes a narrower terminal, which the shell is told.
    h.setWidth(1000);
    await new Promise((r) => setTimeout(r, 200));
    h.type('clear; stty size<CR>');
    await h.until(/^\d+ 98$/m);
    h.app.dispose();
});

test('Ctrl+c interrupts the running program; colors are shown', { skip: !posix }, async () => {
    const h = harness();
    h.app.handleMessage({ t: 'command', name: 'terminal' });
    h.type('sleep 30<CR>');
    await new Promise((r) => setTimeout(r, 300));
    h.ctrl('c');
    h.type('echo back<CR>');
    await h.until(/^back$/m);
    h.type("printf '\\033[31mred-text\\033[0m\\n'<CR>");
    await h.until(/^red-text$/m);
    const red = h.texts().find((c) => c[3] === 'red-text');
    assert.equal(red?.[4], theme.ANSI[1]);
    h.app.dispose();
});

test('Ctrl+k and Ctrl+j move between the editor and the terminal; Cmd+J hides it', { skip: !posix }, () => {
    const h = harness();
    h.app.handleMessage({ t: 'command', name: 'terminal' });
    h.type('<Esc>');
    assert.match(h.text(), / TERM /, 'Esc goes to the program');
    h.ctrl('k');
    assert.match(h.text(), /NORMAL/);
    h.type('<C-j>');
    assert.match(h.text(), / TERM /);
    h.app.handleMessage({ t: 'command', name: 'terminal' });
    assert.doesNotMatch(h.text(), / TERMINAL /);
    h.app.dispose();
});

test('keys are sent as xterm sends them', () => {
    const k = (key: string, ctrl = false, alt = false) => ({ key, ctrl, alt });
    assert.equal(encodeKey(k('c', true), false), '\x03');
    assert.equal(encodeKey(k('a'), false), 'a');
    assert.equal(encodeKey(k('Enter'), false), '\r');
    assert.equal(encodeKey(k('Backspace'), false), '\x7f');
    assert.equal(encodeKey(k('Up'), false), '\x1b[A');
    assert.equal(encodeKey(k('Up'), true), '\x1bOA', 'application cursor keys');
    assert.equal(encodeKey(k('Left', false, true), false), '\x1bb', 'Option+Left is back a word');
    assert.equal(encodeKey(k('Backspace', false, true), false), '\x1b\x7f');
    assert.equal(encodeKey(k('Delete'), false), '\x1b[3~');
    assert.equal(paletteColor(1), theme.ANSI[1]);
    assert.equal(paletteColor(196), '#ff0000');
    assert.equal(paletteColor(232), '#080808');
});

test('dragging selects terminal text, and the right-click menu copies and pastes it', { skip: !posix }, async () => {
    const clipboard = new MemoryClipboard();
    const frames: DrawCmd[][] = [];
    const config = defaultConfig();
    config.terminal.shell = 'sh';
    const app = new WimApp({ icons: false, clipboard, servers: [], config, onFrame: (_t, _d, c) => frames.push(c), onQuit: () => {} });
    const resize = (): void => app.handleMessage({ t: 'resize', width: 1400, height: 800, charW: 10, lineH: 20 });
    resize();
    const texts = (): TextCmd[] => frames[frames.length - 1].filter((c): c is TextCmd => c[0] === 'text');
    const find = (re: RegExp): TextCmd | undefined => texts().find((c) => re.test(String(c[3])));
    app.handleMessage({ t: 'command', name: 'terminal' });
    try {
    for (const k of parseKeys('echo selectme<CR>')) app.handleMessage({ t: 'key', key: k.key, ctrl: k.ctrl, alt: k.alt });
    let out: TextCmd | undefined;
    for (let i = 0; i < 200 && !(out = texts().find((c) => c[3] === 'selectme')); i++) {
        await new Promise((r) => setTimeout(r, 25));
        resize();
    }
    assert.ok(out, 'the output is on the screen');
    const [x, y] = [Number(out[1]), Number(out[2])];
    app.handleMessage({ t: 'mouse', kind: 'down', x: x + 1, y: y + 5 });
    app.handleMessage({ t: 'mouse', kind: 'move', x: x + 10 * 8 - 1, y: y + 5 });
    app.handleMessage({ t: 'mouse', kind: 'up', x: x + 10 * 8 - 1, y: y + 5 });

    app.handleMessage({ t: 'context', x: x + 20, y: y + 5 });
    const copy = find(/^Copy$/)!;
    assert.ok(copy && find(/^Paste$/), 'the menu has Copy and Paste');
    app.handleMessage({ t: 'mouse', kind: 'down', x: Number(copy[1]) + 5, y: Number(copy[2]) + 5 });
    assert.equal(clipboard.text, 'selectme');

    app.handleMessage({ t: 'context', x: x + 20, y: y + 5 });
    const paste = find(/^Paste$/)!;
    app.handleMessage({ t: 'mouse', kind: 'down', x: Number(paste[1]) + 5, y: Number(paste[2]) + 5 });
    for (let i = 0; i < 200 && !texts().some((c) => /\$ selectme|> selectme|selectme$/.test(String(c[3])) && c !== out); i++) {
        await new Promise((r) => setTimeout(r, 25));
        resize();
    }
    assert.ok(texts().filter((c) => /selectme/.test(String(c[3]))).length >= 2, 'the pasted text is at the prompt');
    } finally {
        app.dispose();
    }
});
