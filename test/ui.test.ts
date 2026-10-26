// Tests for the window logic (key mappings, focus, mouse, closing), the file
// tree, the key map, highlighting, icons and the WebSocket server.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Duplex } from 'node:stream';
import { test } from 'node:test';

import { WimApp } from '../src/app';
import { MemoryClipboard } from '../src/clipboard';
import { parseKeys } from '../src/editor/keys';
import { FileTree } from '../src/filetree';
import { C, RUST, Token, highlightLine, NORMAL } from '../src/highlight';
import * as icons from '../src/icons';
import { Keymap } from '../src/keymap';
import { ServerSpec } from '../src/lsp/servers';
import { ClientMessage, DrawCmd } from '../src/protocol';
import { startServer } from '../src/server';

function tempDir(name: string): string {
    return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `wim-${name}-`)));
}

// ----- The window logic ------------------------------------------------------------

interface Harness {
    app: WimApp;
    frames: DrawCmd[][];
    quit: () => boolean;
    send: (msg: ClientMessage) => void;
    type: (keys: string) => void;
    /** All text drawn in the last frame. */
    text: () => string;
}

function harness(file?: string, servers: ServerSpec[] = []): Harness {
    const frames: DrawCmd[][] = [];
    let quit = false;
    const app = new WimApp({
        path: file,
        icons: false,
        clipboard: new MemoryClipboard(),
        servers,
        onFrame: (_title, _dirty, cmds) => frames.push(cmds),
        onQuit: () => {
            quit = true;
        },
    });
    const send = (msg: ClientMessage): void => app.handleMessage(msg);
    send({ t: 'resize', width: 800, height: 600, charW: 10, lineH: 20 });
    return {
        app,
        frames,
        quit: () => quit,
        send,
        type: (keys) => {
            for (const k of parseKeys(keys)) send({ t: 'key', key: k.key, ctrl: k.ctrl, alt: k.alt });
        },
        text: () =>
            frames[frames.length - 1]
                .filter((c): c is Extract<DrawCmd, ['text', ...unknown[]]> => c[0] === 'text')
                .map((c) => c[3])
                .join('\n'),
    };
}

test('typing edits the buffer and repaints', () => {
    const h = harness();
    h.type('ihello<Esc>');
    assert.equal(h.app.editor.buffer.text(), 'hello');
    assert.match(h.text(), /hello/);
    assert.match(h.text(), /NORMAL/);
});

test('leader mappings wait for the next key', () => {
    const h = harness();
    h.type('ifoo<Esc>');
    h.type(',d');
    assert.equal(h.app.editor.buffer.text(), '', ',d deletes the line');
    // Inside a command mappings don't apply: `f,` finds a comma.
    h.type('ia,b<Esc>0f,');
    assert.equal(h.app.editor.cursor.col, 1);
});

test('an unmapped leader key times out and is typed', async () => {
    const h = harness();
    h.type('ia,b<Esc>0');
    h.type(',');
    assert.equal(h.app.editor.cursor.col, 0, 'waiting for the rest of the mapping');
    await new Promise((r) => setTimeout(r, 400));
    // `,` alone repeats the last `f` backwards; there was none, so no move.
    assert.equal(h.app.editor.cursor.col, 0);
    assert.match(h.text(), /NORMAL/);
});

test('insert-char mappings read one more key', () => {
    const h = harness();
    h.type('ixy<Esc>0');
    h.type('çz');
    assert.equal(h.app.editor.buffer.text(), 'zxy');
    h.type('∂q');
    assert.equal(h.app.editor.buffer.text(), 'zqxy');
});

test('Ctrl+n toggles the file tree and Ctrl+h/l move focus', () => {
    const dir = tempDir('app-tree');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'beta\n');
    const cwd = process.cwd();
    process.chdir(dir);
    try {
        const h = harness();
        h.type('<C-n>');
        assert.match(h.text(), /TREE/);
        assert.match(h.text(), /a\.txt/);
        h.type('j<CR>');
        assert.equal(h.app.editor.buffer.text(), 'beta');
        assert.match(h.text(), /NORMAL/);
        h.type('<C-h>');
        assert.match(h.text(), /TREE/);
        h.type('<C-l>');
        assert.match(h.text(), /NORMAL/);
        h.type('<C-n>');
        assert.doesNotMatch(h.text(), /a\.txt/);
    } finally {
        process.chdir(cwd);
        fs.rmSync(dir, { recursive: true });
    }
});

test('clicking places the cursor and dragging selects', () => {
    const h = harness();
    h.type('ione two<CR>three<Esc>');
    // Gutter: 4 columns of 10px, then 6px padding.
    const x = (col: number): number => 46 + col * 10 + 5;
    h.send({ t: 'mouse', kind: 'down', x: x(4), y: 5 });
    assert.deepEqual(h.app.editor.cursor, { line: 0, col: 4 });
    h.send({ t: 'mouse', kind: 'move', x: x(2), y: 25 });
    h.send({ t: 'mouse', kind: 'up', x: x(2), y: 25 });
    assert.equal(h.app.editor.mode, 'Visual');
    assert.deepEqual(h.app.editor.cursor, { line: 1, col: 2 });
});

test('closing with unsaved changes warns once', () => {
    const h = harness();
    h.type('ix<Esc>');
    h.send({ t: 'close' });
    assert.ok(!h.quit());
    assert.match(h.text(), /E37/);
    h.send({ t: 'close' });
    assert.ok(h.quit());
});

test(':q exits when nothing is modified', () => {
    const h = harness();
    h.type(':q<CR>');
    assert.ok(h.quit());
});

test('Cmd+V pastes the clipboard in Insert mode', () => {
    const clipboard = new MemoryClipboard();
    clipboard.text = 'pasted';
    const app = new WimApp({ icons: false, clipboard, onFrame: () => {}, onQuit: () => {} });
    app.handleMessage({ t: 'key', key: 'i', ctrl: false, alt: false });
    app.handleMessage({ t: 'command', name: 'paste' });
    assert.equal(app.editor.buffer.text(), 'pasted');
});

test('malformed keys from the window are ignored', () => {
    const h = harness();
    h.send({ t: 'key', key: 'NotAKey', ctrl: false, alt: false });
    h.send({ t: 'key', key: '', ctrl: false, alt: false });
    assert.equal(h.app.editor.buffer.text(), '');
});

// ----- File tree -------------------------------------------------------------------

function names(tree: FileTree): string[] {
    return tree.rows.map((r) => '  '.repeat(r.depth) + r.name);
}

function press(tree: FileTree, keys: string) {
    let last = tree.handleKey(parseKeys('<Esc>')[0]);
    for (const k of parseKeys(keys)) last = tree.handleKey(k);
    return last;
}

test('file tree navigates directories', () => {
    const root = tempDir('tree');
    fs.mkdirSync(path.join(root, 'src/deep'), { recursive: true });
    fs.mkdirSync(path.join(root, '.git'));
    for (const f of ['b.txt', 'A.md', 'src/main.rs', 'src/deep/x.rs']) fs.writeFileSync(path.join(root, f), '');
    const tree = new FileTree(root);
    assert.deepEqual(names(tree), ['src', 'A.md', 'b.txt'], 'dirs first, case-insensitive, .git hidden');

    assert.deepEqual(press(tree, '<CR>'), { t: 'None' });
    assert.deepEqual(names(tree), ['src', '  deep', '  main.rs', 'A.md', 'b.txt']);
    assert.deepEqual(press(tree, 'jj<CR>'), { t: 'Open', path: path.join(root, 'src/main.rs') });
    press(tree, 'hh');
    assert.deepEqual(names(tree), ['src', 'A.md', 'b.txt'], 'h goes to parent, then collapses it');
    assert.deepEqual(press(tree, 'G<CR>'), { t: 'Open', path: path.join(root, 'b.txt') });

    tree.reveal(path.join(root, 'src/deep/x.rs'));
    assert.equal(tree.rows[tree.selected].path, path.join(root, 'src/deep/x.rs'));
    assert.deepEqual(press(tree, 'q'), { t: 'Close' });
    fs.rmSync(root, { recursive: true });
});

test('file tree hides git-ignored files', (t) => {
    const root = tempDir('tree-git');
    fs.mkdirSync(path.join(root, 'target/debug'), { recursive: true });
    fs.mkdirSync(path.join(root, 'empty'));
    fs.writeFileSync(path.join(root, '.gitignore'), 'target/\n*.log\n');
    fs.writeFileSync(path.join(root, 'main.rs'), '');
    fs.writeFileSync(path.join(root, 'debug.log'), '');
    if (spawnSync('git', ['init', '-q', root]).status !== 0) {
        t.skip('git is not available');
        return;
    }
    const tree = new FileTree(root);
    assert.deepEqual(names(tree), ['empty', '.gitignore', 'main.rs']);
    assert.ok(tree.rows[0].empty);
    fs.rmSync(root, { recursive: true });
});

// ----- Key map ---------------------------------------------------------------------

test('leader mappings', () => {
    const map = Keymap.fromNeovimConfig();
    assert.deepEqual(map.lookup('Normal', parseKeys(','), false), { t: 'Prefix' });
    assert.deepEqual(map.lookup('Normal', parseKeys(',;'), false), {
        t: 'Exact',
        rhs: { t: 'Keys', keys: parseKeys(':w<CR>') },
        ambiguous: false,
    });
    assert.deepEqual(map.lookup('Normal', parseKeys(',y'), false), { t: 'None' });
    assert.deepEqual(map.lookup('Insert', parseKeys(',;'), false), { t: 'None' });
});

test('the tree only gets window and ex mappings', () => {
    const map = Keymap.fromNeovimConfig();
    assert.equal(map.lookup('Normal', parseKeys('<Tab>'), true).t, 'Exact');
    assert.equal(map.lookup('Normal', parseKeys('<C-l>'), true).t, 'Exact');
    assert.equal(map.lookup('Normal', parseKeys('∆'), true).t, 'None');
});

// ----- Highlighting and icons ------------------------------------------------------

function tokens(lang: typeof RUST, s: string): [string, Token][] {
    const cs = Array.from(s);
    return highlightLine(lang, cs, NORMAL)[0].map(([a, b, t]) => [cs.slice(a, b).join(''), t]);
}

test('Rust tokens', () => {
    const t = tokens(RUST, 'fn main() { let x: u32 = 42; println!("hi"); } // done');
    for (const expected of [
        ['fn', 'Keyword'],
        ['main', 'Function'],
        ['u32', 'Type'],
        ['42', 'Number'],
        ['println!', 'Macro'],
        ['"hi"', 'String'],
        ['// done', 'Comment'],
    ]) {
        assert.ok(t.some(([s, k]) => s === expected[0] && k === expected[1]), `${expected}`);
    }
});

test('Rust lifetimes and chars', () => {
    const t = tokens(RUST, "fn f<'a>(c: char) { 'x' }");
    assert.ok(t.some(([s, k]) => s === "'a" && k === 'Macro'));
    assert.ok(t.some(([s, k]) => s === "'x'" && k === 'String'));
});

test('block comments span lines', () => {
    const [, state] = highlightLine(C, Array.from('x /* start'), NORMAL);
    assert.deepEqual(state, { t: 'BlockComment' });
    const [spans, end] = highlightLine(C, Array.from('end */ y'), state);
    assert.deepEqual(spans[0], [0, 6, 'Comment']);
    assert.deepEqual(end, NORMAL);
});

test('icons look up names and extensions', () => {
    assert.notEqual(icons.forFile('main.rs'), icons.DEFAULT_FILE);
    assert.equal(icons.forFile('Makefile'), icons.forFile('makefile'));
    assert.equal(icons.forFile('noext'), icons.DEFAULT_FILE);
    assert.equal(icons.forFile('x.test.ts').glyph, '\u{f499}', 'longest extension first');
    assert.equal(icons.DEFAULT_FILE.glyph.codePointAt(0), 0xf021a);
});

// ----- WebSocket server ------------------------------------------------------------

/** A minimal WebSocket client, enough to talk to the server. */
function connect(url: string): Promise<{ socket: Duplex; status: number }> {
    return new Promise((resolve, reject) => {
        const req = http.request(url, {
            headers: {
                Connection: 'Upgrade',
                Upgrade: 'websocket',
                'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
                'Sec-WebSocket-Version': '13',
            },
        });
        req.on('upgrade', (res, socket) => resolve({ socket, status: res.statusCode ?? 0 }));
        req.on('response', (res) => resolve({ socket: res.socket, status: res.statusCode ?? 0 }));
        req.on('error', reject);
        req.end();
    });
}

function maskedFrame(text: string): Buffer {
    const payload = Buffer.from(text);
    const mask = randomBytes(4);
    const masked = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]));
    const header = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
    return Buffer.concat([header, mask, masked]);
}

test('the server serves the page and talks WebSocket with the token', async () => {
    const received: string[] = [];
    let reply: (() => void) | undefined;
    const server = await startServer({
        onConnection: (conn) => {
            conn.on('message', (text: string) => {
                received.push(text);
                conn.send('x'.repeat(70000));
                reply?.();
            });
        },
    });
    try {
        const pageText = await new Promise<string>((resolve) =>
            http.get(server.url, (res) => {
                let body = '';
                res.on('data', (d) => (body += d));
                res.on('end', () => resolve(body));
            }),
        );
        assert.match(pageText, /<canvas id="wim"/);

        const bad = await connect(server.url.replace('/?t=', '/ws?t=wrong'));
        assert.equal(bad.status, 403);
        bad.socket.destroy();

        const { socket, status } = await connect(server.url.replace('/?t=', '/ws?t='));
        assert.equal(status, 101);
        const answer = new Promise<Buffer>((resolve) => {
            let data = Buffer.alloc(0);
            socket.on('data', (chunk: Buffer) => {
                data = Buffer.concat([data, chunk]);
                if (data.length >= 10 + 70000) resolve(data);
            });
        });
        await new Promise<void>((resolve) => {
            reply = resolve;
            socket.write(maskedFrame('{"t":"close"}'));
        });
        assert.deepEqual(received, ['{"t":"close"}']);
        const data = await answer;
        assert.equal(data[0], 0x81);
        assert.equal(data[1], 127);
        assert.equal(Number(data.readBigUInt64BE(2)), 70000);
        socket.destroy();
    } finally {
        server.close();
    }
});

test('Alt+letter works like the Option mappings', () => {
    const h = harness();
    h.type('ia<CR><CR>b<Esc>gg');
    h.type('<M-j>');
    assert.equal(h.app.editor.cursor.line, 1, 'Alt+j is }');
    h.type('<M-c>z');
    assert.equal(h.app.editor.buffer.lineString(1), 'z');
    h.type('i<M-x><Esc>');
    assert.equal(h.app.editor.buffer.lineString(1), 'z', 'Alt+letter types nothing');
});
