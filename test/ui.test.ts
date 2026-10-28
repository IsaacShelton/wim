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

import { AppOptions, WimApp } from '../src/app';
import { MemoryClipboard } from '../src/clipboard';
import { parseKeys } from '../src/editor/keys';
import { FileTree } from '../src/filetree';
import { Buffer as TextBuffer } from '../src/editor/buffer';
import { C, Cache, JS, MARKDOWN, RUST, State, Token, detect, highlightLine, NORMAL } from '../src/highlight';
import * as icons from '../src/icons';
import { imageSize } from '../src/image';
import { Keymap } from '../src/keymap';
import { diagramId } from '../src/markdown';
import { ServerSpec } from '../src/lsp/servers';
import { AudioCommand, ClientMessage, DrawCmd } from '../src/protocol';
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

function harness(file?: string, servers: ServerSpec[] = [], opts: Partial<AppOptions> = {}): Harness {
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
        ...opts,
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

test('Ctrl+` toggles the terminal from any window', () => {
    const h = harness();
    const state = h.app as unknown as { terminalVisible: boolean; focus: string };
    try {
        h.type('<C-`>');
        assert.equal(state.terminalVisible, true);
        assert.equal(state.focus, 'Terminal');
        h.type('<C-`>');
        assert.equal(state.terminalVisible, false);
        assert.equal(state.focus, 'Editor');
        assert.equal(h.app.editor.buffer.text(), '', 'the key is not typed into the buffer');
    } finally {
        // Showing the terminal starts a shell, which would keep the test alive.
        h.app.dispose();
    }
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

test('a directory argument becomes the working directory, with no file open', () => {
    const dir = tempDir('app-dir');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'main.rs'), 'fn main() {}\n');
    const cwd = process.cwd();
    try {
        const h = harness(dir);
        assert.equal(process.cwd(), dir);
        assert.equal(h.app.editor.filePath, undefined);
        assert.equal(h.app.editor.message, undefined, 'no error about the directory');
        assert.match(h.text(), /\[No Name\]/);
        h.type('<C-n><CR>j<CR>');
        assert.equal(h.app.editor.filePath, path.join(dir, 'src', 'main.rs'));
        assert.equal(h.app.editor.buffer.text(), 'fn main() {}');
    } finally {
        process.chdir(cwd);
        fs.rmSync(dir, { recursive: true });
    }
});

test("a file argument makes the file's directory the working directory", () => {
    const dir = tempDir('app-file');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'main.rs'), 'fn main() {}\n');
    fs.writeFileSync(path.join(dir, 'src', 'lib.rs'), '');
    const cwd = process.cwd();
    try {
        process.chdir(dir);
        const h = harness('src/main.rs');
        assert.equal(process.cwd(), path.join(dir, 'src'));
        assert.equal(h.app.editor.filePath, path.join(dir, 'src', 'main.rs'));
        assert.equal(h.app.editor.buffer.text(), 'fn main() {}');
        // The tree (and so the pickers) start there.
        h.type('<C-n>');
        assert.match(h.text(), /lib\.rs/);
        assert.doesNotMatch(h.text(), /\bsrc\b/);
    } finally {
        process.chdir(cwd);
        fs.rmSync(dir, { recursive: true });
    }
});

test('a in the tree creates files and directories', () => {
    const dir = tempDir('app-create');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'main.rs'), '');
    const cwd = process.cwd();
    process.chdir(dir);
    try {
        const h = harness();
        // On a directory, the prompt starts in it.
        h.type('<C-n>a');
        assert.match(h.text(), /Create File/);
        assert.match(h.text(), new RegExp(`src\\${path.sep}`));
        h.type('lib.rs<CR>');
        assert.ok(fs.existsSync(path.join(dir, 'src', 'lib.rs')));
        assert.match(h.text(), /TREE/, 'the tree keeps focus');
        assert.match(h.text(), /lib\.rs/);
        // On a file, it starts in the file's directory; missing directories
        // are made, and a trailing slash makes a directory.
        h.type('a<C-u>deep/er/x.txt<CR>');
        assert.ok(fs.existsSync(path.join(dir, 'deep', 'er', 'x.txt')));
        h.type('a<C-u>empty/<CR>');
        assert.ok(fs.statSync(path.join(dir, 'empty')).isDirectory());
        h.type('a<C-u>deep/er/x.txt<CR>');
        assert.match(h.app.editor.message?.text ?? '', /already exists/);
        // Escape cancels.
        h.type('anever<Esc>');
        assert.ok(!fs.existsSync(path.join(dir, 'never')));
        // A new file is selected, ready to open.
        h.type('a<C-u>new.txt<CR><CR>');
        assert.equal(h.app.editor.filePath, path.join(dir, 'new.txt'));
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
    press(tree, '<CR><BS>');
    assert.deepEqual(names(tree), ['src', 'A.md', 'b.txt'], 'Backspace on an open folder collapses it');
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

test('file tree colors names by git status', (t) => {
    const root = tempDir('tree-status');
    const git = (...args: string[]) => spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
    if (git('init', '-q').status !== 0) {
        t.skip('git is not available');
        return;
    }
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'new'));
    fs.writeFileSync(path.join(root, 'src', 'a.rs'), 'a');
    fs.writeFileSync(path.join(root, 'clean.rs'), 'c');
    git('add', '.');
    git('commit', '-q', '-m', 'first');
    fs.writeFileSync(path.join(root, 'src', 'a.rs'), 'changed');
    fs.writeFileSync(path.join(root, 'new', 'b.rs'), 'b');
    fs.writeFileSync(path.join(root, 'staged.rs'), 's');
    git('add', 'staged.rs');
    const tree = new FileTree(root);
    tree.reveal(path.join(root, 'src', 'a.rs'));
    tree.reveal(path.join(root, 'new', 'b.rs'));
    const status = (rel: string) => tree.rows.find((r) => r.path === path.join(root, rel))?.git;
    assert.equal(status('src/a.rs'), 'Modified');
    assert.equal(status('src'), 'Modified', 'a directory shows what changed inside it');
    assert.equal(status('new'), 'Untracked');
    assert.equal(status('new/b.rs'), 'Untracked', 'inside an untracked directory');
    assert.equal(status('staged.rs'), 'Staged');
    assert.equal(status('clean.rs'), undefined);
    // Status is read again after files change.
    git('add', 'src/a.rs');
    tree.refreshGitStatus();
    assert.equal(status('src/a.rs'), 'Staged');
    fs.rmSync(root, { recursive: true });
});

test('dd in the tree deletes after asking', () => {
    const dir = tempDir('app-delete');
    fs.mkdirSync(path.join(dir, 'dir'));
    fs.writeFileSync(path.join(dir, 'dir', 'inner.txt'), '');
    fs.writeFileSync(path.join(dir, 'keep.txt'), '');
    fs.writeFileSync(path.join(dir, 'gone.txt'), '');
    const cwd = process.cwd();
    process.chdir(dir);
    try {
        const h = harness();
        // The tree: dir, gone.txt, keep.txt.
        h.type('<C-n>jdd');
        assert.match(h.text(), /Delete "gone\.txt"\? \(y\/n\)/);
        h.type('n');
        assert.ok(fs.existsSync(path.join(dir, 'gone.txt')), 'n keeps it');
        assert.match(h.text(), /TREE/);
        h.type('ddy');
        assert.ok(!fs.existsSync(path.join(dir, 'gone.txt')));
        assert.doesNotMatch(h.text(), /gone\.txt"\?/);
        // A directory goes with everything in it.
        h.type('ggdd');
        assert.match(h.text(), /Delete "dir" and everything in it\?/);
        h.type('y');
        assert.ok(!fs.existsSync(path.join(dir, 'dir')));
        assert.ok(fs.existsSync(path.join(dir, 'keep.txt')));
        assert.match(h.text(), /keep\.txt/);
    } finally {
        process.chdir(cwd);
        fs.rmSync(dir, { recursive: true });
    }
});

test(',x and :q ask before discarding unsaved changes', () => {
    const h = harness();
    h.type(':e one<CR>:e two<CR>ichanged<Esc>');
    assert.equal(h.app.editor.bufferList().length, 2);
    h.type(',x');
    assert.match(h.text(), /Discard changes to "two"\? \(y\/n\)/);
    h.type('n');
    assert.equal(h.app.editor.bufferList().length, 2, 'n keeps the buffer');
    assert.equal(h.app.editor.buffer.text(), 'changed');
    h.type(',xy');
    assert.equal(h.app.editor.bufferList().length, 1, 'y closes it');
    // The last buffer: `:q` asks before quitting.
    h.type('ichanged<Esc>:q<CR>');
    assert.match(h.text(), /Discard changes/);
    h.type('<Esc>');
    assert.ok(!h.quit());
    // Another key says no, and does what it does.
    h.type(':q<CR>:q!<CR>');
    assert.ok(h.quit());
});

// ----- Key map ---------------------------------------------------------------------

test(',w and friends are subword motions, after operators too', () => {
    const h = harness();
    h.type('ifooBarBaz qux<Esc>0,w');
    assert.equal(h.app.editor.cursor.col, 3);
    h.type(',e');
    assert.equal(h.app.editor.cursor.col, 5);
    h.type(',b,b');
    assert.equal(h.app.editor.cursor.col, 0);
    h.type('d,w');
    assert.equal(h.app.editor.buffer.text(), 'BarBaz qux');
    // After an operator waiting for a character, `,` is that character.
    h.type('0df,');
    assert.equal(h.app.editor.buffer.text(), 'BarBaz qux');
});

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

// ----- Finding files and text ----------------------------------------------------------

async function until(what: string, cond: () => boolean): Promise<void> {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > 5000) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 10));
    }
}

/** A project for the finders: two files and an ignored directory. */
function finderProject(): string {
    const dir = tempDir('finder');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'main.rs'), 'fn main() {\n    let é = needle();\n}\n');
    fs.writeFileSync(path.join(dir, 'README.md'), '# needle\n');
    fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), 'needle\n');
    return dir;
}

/** Run `f` in `dir`, with or without ripgrep on the PATH. */
async function inProject(dir: string, withRipgrep: boolean, f: () => Promise<void>): Promise<void> {
    const cwd = process.cwd();
    const PATH = process.env.PATH;
    process.chdir(dir);
    if (!withRipgrep) process.env.PATH = '';
    try {
        await f();
    } finally {
        process.env.PATH = PATH;
        process.chdir(cwd);
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

for (const withRipgrep of [true, false]) {
    const how = withRipgrep ? 'with ripgrep' : 'without ripgrep';

    test(`,a finds files to open (${how})`, () =>
        inProject(finderProject(), withRipgrep, async () => {
            const h = harness();
            h.type(',a');
            assert.match(h.text(), /Find Files/);
            await until('the files', () => /2 \/ 2\n/.test(h.text()));
            assert.doesNotMatch(h.text(), /node_modules/);
            h.type('main');
            assert.match(h.text(), /1 \/ 2/);
            h.type('<CR>');
            assert.equal(h.app.editor.filePath, path.join(process.cwd(), 'src', 'main.rs'));
            assert.match(h.text(), /NORMAL/);
        }));

    test(`,fw searches as you type and jumps to a match (${how})`, () =>
        inProject(finderProject(), withRipgrep, async () => {
            const h = harness();
            h.type(',fw');
            assert.match(h.text(), /Live Grep/);
            h.type('needle\\(');
            await until('the match', () => h.text().includes('src/main.rs:2:13:'));
            assert.doesNotMatch(h.text(), /README|node_modules/, 'only the matching line');
            h.type('<CR>');
            assert.equal(h.app.editor.filePath, path.join(process.cwd(), 'src', 'main.rs'));
            // The column counts characters, not the bytes of `é`.
            assert.deepEqual(h.app.editor.cursor, { line: 1, col: 12 });
        }));
}

test('a bad live grep pattern is reported', () =>
    inProject(finderProject(), true, async () => {
        const h = harness();
        h.type(',fw(');
        await until('the error', () => /regex|parse|unclosed/i.test(h.text()));
    }));

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
        ['u32', 'BuiltinType'],
        ['42', 'Number'],
        ['println!', 'Macro'],
        ['"hi"', 'String'],
        ['// done', 'Comment'],
    ]) {
        assert.ok(t.some(([s, k]) => s === expected[0] && k === expected[1]), `${expected}`);
    }
});

test('Rust tokens as tree-sitter sorts them', () => {
    const kinds = (line: string): string => tokens(RUST, line).map(([s, k]) => `${s}:${k}`).join(' ');
    assert.equal(
        kinds('use std::f32::consts::{PI, TAU};'),
        'use:Keyword std:Module :::Delimiter f32:BuiltinType :::Delimiter consts:Module :::Delimiter {:Bracket ' +
            'PI:Type ,:Delimiter TAU:Type }:Bracket ;:Delimiter',
    );
    assert.equal(
        kinds('#[derive(Copy, Debug)]'),
        '#:Operator [:Bracket derive:Attribute (:Bracket Copy:Type ,:Delimiter Debug:Type ):Bracket ]:Bracket',
    );
    assert.equal(kinds('#[inline]'), '#:Operator [:Bracket inline:BuiltinAttribute ]:Bracket');
    assert.equal(
        kinds('pub fn up() -> Self { Rotation::from_radians(TAU * 0.5) }'),
        'pub:Keyword fn:Keyword up:Function (:Bracket ):Bracket ->:Delimiter Self:SelfType {:Bracket ' +
            'Rotation:Type :::Delimiter from_radians:Function (:Bracket TAU:Constant *:Operator 0.5:Number ' +
            '):Bracket }:Bracket',
    );
    assert.equal(kinds('fn lerp<T>(&self) -> bool { self.0 == None }').includes('lerp:Function'), true);
    assert.match(kinds('fn lerp<T>(&self) -> bool { self.0 == None }'), /&:Operator self:Keyword .*0:Property .*None:BuiltinConstant/);
    assert.match(kinds('let t = (other.0 - 1.5) % TAU;'), /0:Property -:Operator 1\.5:Number/);
});

test('Rust lifetimes and chars', () => {
    const t = tokens(RUST, "fn f<'a>(c: char) { 'x' }");
    assert.ok(t.some(([s, k]) => s === "'a" && k === 'Lifetime'));
    assert.ok(t.some(([s, k]) => s === "'x'" && k === 'String'));
});

test('block comments span lines', () => {
    const [, state] = highlightLine(C, Array.from('x /* start'), NORMAL);
    assert.deepEqual(state, { t: 'BlockComment' });
    const [spans, end] = highlightLine(C, Array.from('end */ y'), state);
    assert.deepEqual(spans[0], [0, 6, 'Comment']);
    assert.deepEqual(end, NORMAL);
});

test('JavaScript regexes are told from division', () => {
    const kinds = (line: string): string => tokens(JS, line).map(([s, k]) => `${s}:${k}`).join(' ');
    assert.equal(
        kinds('const R = /"[^"]*"|[/]/g; // done'),
        'const:Keyword R:Type =:Operator /"[^"]*"|[/]/g:String ;:Delimiter // done:Comment',
    );
    assert.match(kinds('return /x/.test(s);'), /^return:Keyword \/x\/:String/);
    assert.match(kinds('const half = (a + b) / 2 / c;'), /\):Bracket \/:Operator 2:Number \/:Operator c:Normal/);
    assert.match(kinds('<div>a</div>'), /\/:Operator div:Normal/, 'a closing tag');
    // The `"` in the regex doesn't start a string that goes on.
    const [, state] = highlightLine(JS, Array.from('const R = /(?:\\s+"[^"]*")?\\s*\\)/g;'), NORMAL);
    assert.deepEqual(state, NORMAL);
});

test('only some strings go on past the end of a line', () => {
    const end = (lang: typeof RUST, line: string): State => highlightLine(lang, Array.from(line), NORMAL)[1];
    assert.deepEqual(end(JS, 'const s = "unclosed'), NORMAL);
    assert.deepEqual(end(JS, 'const s = "continued\\'), { t: 'Str', q: '"' });
    assert.deepEqual(end(JS, 'const s = `template'), { t: 'Str', q: '`' });
    assert.deepEqual(end(RUST, 'let s = "multi'), { t: 'Str', q: '"' });
    assert.deepEqual(end(C, "char c = 'x"), NORMAL);
});

test('the highlight cache starts over for a reloaded buffer', () => {
    const cache = new Cache();
    const before = TextBuffer.fromText('/* open\nstill a comment');
    assert.deepEqual(cache.stateAt(JS, before, 1), { t: 'BlockComment' });
    // A buffer read again from its file: a new one, at the same version.
    const after = TextBuffer.fromText('// closed\ncode');
    assert.equal(after.version(), before.version());
    assert.deepEqual(cache.stateAt(JS, after, 1), NORMAL);
});

test('Markdown tokens', () => {
    assert.equal(detect('notes/README.md'), MARKDOWN);
    const kinds = (line: string): string => tokens(MARKDOWN, line).map(([s, k]) => `${s}:${k}`).join(' ');
    assert.equal(kinds('## A `b` c'), '##:Markup  A :Heading `:Markup b:Raw `:Markup  c:Heading');
    assert.equal(kinds('**b** _e_ snake_case_name *i*'), '**:Markup b:Strong **:Markup _:Markup e:Emphasis _:Markup *:Markup i:Emphasis *:Markup');
    assert.equal(kinds('- [x] see [docs](https://x.io)'), '-:ListMarker [x]:ListMarker [:Markup docs:Link ](:Markup https://x.io:Url ):Markup');
    assert.equal(kinds('> quoted ~~old~~'), '> :Markup quoted :Quote ~~:Markup old:Strike ~~:Markup');
    assert.equal(kinds('12. \\*not emphasis\\*'), '12.:ListMarker \\:Markup \\:Markup');
    assert.equal(kinds('| a | b |'), '|:Markup |:Markup |:Markup');
    assert.equal(kinds('---'), '---:Markup');
});

test('Markdown code blocks are highlighted in their language across lines', () => {
    let state: State = NORMAL;
    const lines = ['```rust', 'fn f() { /* a', 'b */ }', '```', '*after*'];
    const out = lines.map((line) => {
        const cs = Array.from(line);
        const [spans, next] = highlightLine(MARKDOWN, cs, state);
        state = next;
        return spans.map(([a, b, t]) => `${cs.slice(a, b).join('')}:${t}`).join(' ');
    });
    assert.equal(out[0], '```:Markup rust:Type');
    assert.match(out[1], /^fn:Keyword f:Function .*\/\* a:Comment$/);
    assert.match(out[2], /^b \*\/:Comment/, 'the comment carries over');
    assert.equal(out[3], '```:Markup');
    assert.equal(out[4], '*:Markup after:Emphasis *:Markup', 'back to Markdown');
    assert.deepEqual(state, NORMAL);
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

// ----- Images ----------------------------------------------------------------------------

/** The start of a PNG file of the given size: enough for its header. */
function pngHeader(width: number, height: number): Buffer {
    const b = Buffer.alloc(33);
    b.writeUInt32BE(0x89504e47, 0);
    b.writeUInt32BE(0x0d0a1a0a, 4);
    b.writeUInt32BE(13, 8);
    b.write('IHDR', 12, 'ascii');
    b.writeUInt32BE(width, 16);
    b.writeUInt32BE(height, 20);
    return b;
}

test('image sizes come from their headers', () => {
    assert.deepEqual(imageSize(pngHeader(640, 400)), [640, 400]);
    // JPEG: an APP0 segment, then a baseline start-of-frame.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x90, 0x02, 0x80, 0x03, 0, 0, 0, 0]);
    assert.deepEqual(imageSize(jpeg), [640, 400]);
    const riff = (chunk: string, body: number[]): Buffer => {
        const b = Buffer.alloc(40);
        b.write('RIFF', 0, 'ascii');
        b.write('WEBP', 8, 'ascii');
        b.write(chunk, 12, 'ascii');
        Buffer.from(body).copy(b, 20);
        return b;
    };
    // Lossy: a frame tag, the start code, then 14-bit width and height.
    assert.deepEqual(imageSize(riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0x90, 0x01])), [640, 400]);
    // Lossless: a signature byte, then width-1 and height-1 packed in 14 bits each.
    const bits = 639 | (399 << 14);
    assert.deepEqual(imageSize(riff('VP8L', [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, bits >>> 24])), [640, 400]);
    // Extended: flags, then 24-bit width-1 and height-1.
    assert.deepEqual(imageSize(riff('VP8X', [0x10, 0, 0, 0, 0x7f, 0x02, 0x00, 0x8f, 0x01, 0x00])), [640, 400]);
    assert.deepEqual(imageSize(Buffer.from('GIF89a\x80\x02\x90\x01', 'latin1')), [640, 400]);
    assert.equal(imageSize(Buffer.from('not an image at all, just some text')), undefined);
});

test('an image opens read-only and is drawn instead of text', () => {
    const dir = tempDir('image');
    const file = path.join(dir, 'pic.png');
    fs.writeFileSync(file, pngHeader(640, 400));
    const cwd = process.cwd();
    try {
        const h = harness(file);
        const ed = h.app.editor;
        assert.equal(ed.image?.format, 'PNG');
        assert.match(ed.message?.text ?? '', /PNG 640×400/);
        const cmd = h.frames[h.frames.length - 1].find((c) => c[0] === 'image');
        assert.ok(cmd && String(cmd[5]).includes(encodeURIComponent(file)));
        assert.match(h.text(), /PNG 640×400/, 'in the status line');
        for (const keys of ['i', 'A', 'o', 'R', 'x', 'dd', 'p', ':s/^/x/<CR>']) {
            h.type(keys);
            assert.equal(ed.buffer.text(), '', keys);
            assert.match(ed.message?.text ?? '', /E21/, keys);
            assert.equal(ed.mode, 'Normal', keys);
        }
        h.type(':w<CR>');
        assert.match(ed.message?.text ?? '', /E21/);
        assert.equal(fs.readFileSync(file).length, 33, 'the file is untouched');
        assert.equal(ed.isModified(), false);
        // Other buffers are text again.
        h.type(`:e ${path.join(dir, 'notes.txt')}<CR>ihi<Esc>`);
        assert.equal(ed.image, undefined);
        assert.equal(ed.buffer.text(), 'hi');
    } finally {
        process.chdir(cwd);
        fs.rmSync(dir, { recursive: true });
    }
});

test('the server serves only images and sounds, only with the token, in ranges', async () => {
    const dir = tempDir('serve');
    const png = path.join(dir, 'pic.png');
    const mp3 = path.join(dir, 'song.mp3');
    const txt = path.join(dir, 'secret.txt');
    fs.writeFileSync(png, pngHeader(1, 1));
    fs.writeFileSync(mp3, '0123456789');
    fs.writeFileSync(txt, 'secret');
    const server = await startServer({ onConnection: () => {} });
    const get = (url: string, range?: string): Promise<[number, string, string, string]> =>
        new Promise((resolve) =>
            http.get(url, { headers: range ? { range } : {} }, (res) => {
                let body = '';
                res.on('data', (d) => (body += d));
                res.on('end', () =>
                    resolve([res.statusCode ?? 0, String(res.headers['content-type']), String(res.headers['content-range']), body]),
                );
            }),
        );
    try {
        const base = server.url.replace(/\/\?t=.*/, '');
        const token = new URL(server.url).searchParams.get('t')!;
        const media = (file: string, t = token): string => `${base}/media?p=${encodeURIComponent(file)}&t=${t}`;
        assert.deepEqual((await get(media(png))).slice(0, 2), [200, 'image/png']);
        assert.deepEqual((await get(media(mp3))).slice(0, 2), [200, 'audio/mpeg']);
        assert.equal((await get(media(png, 'wrong')))[0], 403);
        assert.equal((await get(media(txt)))[0], 403);
        // Byte ranges, as players ask for to seek.
        assert.deepEqual(await get(media(mp3), 'bytes=2-5'), [206, 'audio/mpeg', 'bytes 2-5/10', '2345']);
        assert.deepEqual((await get(media(mp3), 'bytes=7-')).slice(2), ['bytes 7-9/10', '789']);
        assert.deepEqual((await get(media(mp3), 'bytes=-3')).slice(2), ['bytes 7-9/10', '789']);
        assert.equal((await get(media(mp3), 'bytes=20-'))[0], 416);
    } finally {
        server.close();
        fs.rmSync(dir, { recursive: true });
    }
});

test('a sound opens in a player', () => {
    const dir = tempDir('sound');
    const song = path.join(dir, 'song.mp3');
    fs.writeFileSync(song, 'not really an mp3');
    const cwd = process.cwd();
    const sent: AudioCommand[] = [];
    try {
        const frames: DrawCmd[][] = [];
        const app = new WimApp({
            path: song,
            icons: false,
            clipboard: new MemoryClipboard(),
            servers: [],
            onFrame: (_t, _d, cmds) => frames.push(cmds),
            onAudio: (cmd) => sent.push(cmd),
            onQuit: () => {},
        });
        const send = (msg: ClientMessage): void => app.handleMessage(msg);
        const type = (keys: string): void => {
            for (const k of parseKeys(keys)) send({ t: 'key', key: k.key, ctrl: k.ctrl, alt: k.alt });
        };
        const text = (): string =>
            frames[frames.length - 1]
                .filter((c): c is Extract<DrawCmd, ['text', ...unknown[]]> => c[0] === 'text')
                .map((c) => c[3])
                .join('\n');
        send({ t: 'resize', width: 800, height: 600, charW: 10, lineH: 20 });
        const ed = app.editor;
        assert.equal(ed.audio?.format, 'MP3');
        assert.match(text(), /song\.mp3/);
        assert.match(text(), /MP3 {2}17 B/, 'in the status line');
        // Shown means loaded (not played).
        assert.equal(sent.length, 1);
        const load = sent[0];
        assert.ok(load.op === 'load' && load.src.includes(encodeURIComponent(song)));
        const src = load.op === 'load' ? load.src : '';
        const report = (time: number, paused: boolean, volume = 1): void =>
            send({ t: 'audio', src, time, duration: 180, paused, volume });
        report(0, true);
        assert.match(text(), /0:00\n3:00/);
        // Space plays; the window reports back.
        type(' ');
        assert.deepEqual(sent[sent.length - 1], { op: 'play' });
        report(65, false);
        assert.match(text(), /1:05\n3:00/);
        // Seeking and volume.
        type('l');
        assert.deepEqual(sent[sent.length - 1], { op: 'seek', time: 70 });
        type('5');
        assert.deepEqual(sent[sent.length - 1], { op: 'seek', time: 90 });
        type('j');
        assert.deepEqual(sent[sent.length - 1], { op: 'volume', volume: 0.9 });
        type('m');
        assert.deepEqual(sent[sent.length - 1], { op: 'volume', volume: 0 });
        type('m');
        assert.deepEqual(sent[sent.length - 1], { op: 'volume', volume: 0.9 });
        // Clicking the scrubber halfway seeks halfway; dragging the volume
        // bar sets the volume. (The panel is 700 pixels wide at (50, 180).)
        const click = (x: number, y: number, to = x): void => {
            send({ t: 'mouse', kind: 'down', x, y });
            if (to !== x) send({ t: 'mouse', kind: 'move', x: to, y });
            send({ t: 'mouse', kind: 'up', x: to, y });
        };
        click(425, 270);
        assert.deepEqual(sent[sent.length - 1], { op: 'seek', time: 90 });
        click(300, 310, 210);
        assert.deepEqual(sent[sent.length - 1], { op: 'volume', volume: 0.5 });
        click(90, 270);
        assert.deepEqual(sent[sent.length - 1], { op: 'pause' });
        type(' ');
        // It can't be edited or written.
        type('x');
        assert.match(ed.message?.text ?? '', /E21/);
        type(':w<CR>');
        assert.match(ed.message?.text ?? '', /E21/);
        assert.equal(fs.readFileSync(song, 'utf8'), 'not really an mp3');
        // Playing on in another buffer shows in the status line.
        report(65, false);
        type(':enew<CR>');
        assert.match(text(), /♪ song\.mp3 1:05/);
        // Closing its buffer stops it.
        type(':bd! 1<CR>');
        assert.deepEqual(sent[sent.length - 1], { op: 'stop' });
        app.dispose();
    } finally {
        process.chdir(cwd);
        fs.rmSync(dir, { recursive: true });
    }
});

test('images zoom and pan with keys, the wheel, dragging and buttons', async () => {
    const dir = tempDir('zoom');
    const file = path.join(dir, 'pic.png');
    fs.writeFileSync(file, pngHeader(640, 400));
    const cwd = process.cwd();
    try {
        // An 800×600 window: the image area is 760×520 at (20, 20).
        const h = harness(file);
        const drawn = (): number[] => {
            const cmd = h.frames[h.frames.length - 1].find((c) => c[0] === 'image')!;
            return cmd.slice(1, 5).map((n) => Math.round(Number(n)));
        };
        // Keys glide there over a few frames.
        const settles = (expected: number[]): Promise<void> =>
            until(`the image at ${expected}`, () => drawn().join() === expected.join());
        // It fits, so it is drawn at its size, in the middle.
        assert.deepEqual(drawn(), [80, 80, 640, 400]);
        assert.match(h.text(), /PNG 640×400 {2}33 B {2}100%/);
        // h/j/k/l and the arrows move it (by a tenth of the view, 76 pixels),
        // as far as its edge reaching the middle of the view.
        h.type('l');
        assert.notDeepEqual(drawn(), [4, 80, 640, 400], 'not there at once');
        await settles([4, 80, 640, 400]);
        h.type('<Left>kj<Down>');
        await settles([80, 4, 640, 400]);
        h.type('llllllllll');
        await settles([-240, 4, 640, 400]);
        // 0 fits it again; +, = and - zoom around the middle.
        h.type('0');
        await settles([80, 80, 640, 400]);
        h.type('+');
        await settles([0, 30, 800, 500]);
        assert.match(h.text(), /125%/);
        h.type('-=');
        await settles([0, 30, 800, 500]);
        h.type('0-');
        await until('80%', () => /80%/.test(h.text()));
        h.type('0');
        await settles([80, 80, 640, 400]);
        // Scrolling zooms at once, around the pointer: the point under it stays.
        h.send({ t: 'wheel', x: 80, y: 80, delta: -100, dx: 0, mode: 0, zoom: false });
        assert.deepEqual(drawn(), [80, 80, 800, 500]);
        assert.match(h.text(), /125%/);
        h.send({ t: 'wheel', x: 80, y: 80, delta: 100, dx: 0, mode: 0, zoom: true });
        assert.match(h.text(), /100%/);
        // The buttons in the bottom right: +, - and =, which fits it again.
        // A clicked one looks pressed for a moment.
        assert.match(h.text(), /\+\n-\n=/);
        const buttonFill = (): unknown => h.frames[h.frames.length - 1].find((c) => c[0] === 'rect' && c[1] === 712 && c[2] === 528)?.[5];
        const unpressed = buttonFill();
        h.send({ t: 'mouse', kind: 'down', x: 724, y: 540 });
        h.send({ t: 'mouse', kind: 'up', x: 724, y: 540 });
        assert.notEqual(buttonFill(), unpressed, 'pressed');
        await settles([0, 30, 800, 500]);
        await until('the button to come back up', () => buttonFill() === unpressed);
        h.send({ t: 'mouse', kind: 'down', x: 780, y: 540 });
        h.send({ t: 'mouse', kind: 'up', x: 780, y: 540 });
        await settles([80, 80, 640, 400]);
        // Dragging moves it at once.
        h.type('+');
        await settles([0, 30, 800, 500]);
        h.send({ t: 'mouse', kind: 'down', x: 400, y: 300 });
        h.send({ t: 'mouse', kind: 'move', x: 390, y: 300 });
        h.send({ t: 'mouse', kind: 'up', x: 390, y: 300 });
        assert.equal(drawn()[0], -10);
        // `:` still works.
        h.type(':enew<CR>');
        assert.equal(h.app.editor.image, undefined);
        // A small image opens enlarged as many whole times as fit (the tab
        // line leaves 500 pixels: 31 times 16).
        const tiny = path.join(dir, 'tiny.png');
        fs.writeFileSync(tiny, pngHeader(16, 16));
        h.type(`:e ${tiny}<CR>`);
        assert.deepEqual(drawn(), [152, 42, 496, 496]);
        assert.match(h.text(), /3100%/);
        h.type('+0');
        await settles([152, 42, 496, 496]);
        h.app.dispose();
    } finally {
        process.chdir(cwd);
        fs.rmSync(dir, { recursive: true });
    }
});

// ----- Split windows and themes -------------------------------------------------------------

test('split windows show buffers side by side and one above another', () => {
    const dir = tempDir('splits');
    const a = path.join(dir, 'a.txt');
    const b = path.join(dir, 'b.txt');
    fs.writeFileSync(a, 'alpha\nline two\n');
    fs.writeFileSync(b, 'beta\n');
    const cwd = process.cwd();
    try {
        const h = harness(a);
        const ed = h.app.editor;
        // Name bars, and the status line's name.
        const names = (): string[] => h.text().split('\n').filter((t) => /^ (a|b)\.txt/.test(t));
        // :vsplit shows the same buffer twice, each window with a name bar.
        h.type(':vs<CR>');
        assert.equal(h.app.windows.count, 2);
        assert.deepEqual(names(), [' a.txt', ' a.txt', ' a.txt']);
        // Editing shows in both; each window keeps its own cursor.
        h.type('Aa<Esc>');
        assert.equal((h.text().match(/alphaa/g) ?? []).length, 2);
        h.type('j');
        assert.equal(ed.cursor.line, 1);
        h.type('<C-l>');
        assert.equal(ed.cursor.line, 0, 'the other window remembers its place');
        h.type('<C-h>');
        assert.equal(ed.cursor.line, 1);
        // :split with a file opens it above; Ctrl+j goes back down.
        h.type(`:sp ${b}<CR>`);
        assert.equal(ed.filePath, b);
        assert.equal(h.app.windows.count, 3);
        h.type('<C-j>');
        assert.equal(ed.filePath, a);
        assert.equal(ed.cursor.line, 1);
        h.type('<C-k>');
        assert.equal(ed.filePath, b);
        // <C-w>w goes round them all; <C-w>p back to the previous.
        h.type('<C-w>w');
        assert.equal(ed.filePath, a);
        h.type('<C-w>p');
        assert.equal(ed.filePath, b);
        // :q closes a window while there are others, keeping its buffer; the
        // previous window is active again.
        h.type(':q<CR>');
        assert.equal(h.app.windows.count, 2);
        assert.equal(ed.filePath, a);
        assert.equal(ed.buffers.length, 2);
        // <C-w>o keeps one; then <C-w>c can't close it.
        h.type('<C-w>o');
        assert.equal(h.app.windows.count, 1);
        assert.deepEqual(names(), [' a.txt [+]'], 'no name bars for one window');
        h.type('<C-w>c');
        assert.match(ed.message?.text ?? '', /E444/);
        // <C-w>s and <C-w>v split too; closing a buffer closes its windows.
        h.type(`<C-w>v:e ${b}<CR>`);
        assert.equal(h.app.windows.count, 2);
        h.type('<C-w>l:bd 2<CR>');
        assert.equal(h.app.windows.count, 1);
        assert.equal(ed.filePath, a);
    } finally {
        process.chdir(cwd);
        fs.rmSync(dir, { recursive: true });
    }
});

test('clicking a window moves there, and Ctrl+h reaches the tree', () => {
    const dir = tempDir('split-mouse');
    const a = path.join(dir, 'a.txt');
    fs.writeFileSync(a, 'one\ntwo\nthree\n');
    const cwd = process.cwd();
    try {
        const h = harness(a);
        h.type(':vs<CR>j');
        // The left window is active (x < 400); click the right one's third line.
        h.send({ t: 'mouse', kind: 'down', x: 600, y: 45 });
        h.send({ t: 'mouse', kind: 'up', x: 600, y: 45 });
        assert.equal(h.app.editor.cursor.line, 2);
        h.type('<C-h><C-n><C-l><C-h><C-h>');
        assert.match(h.text(), /TREE/);
        h.type('<C-l>');
        assert.match(h.text(), /NORMAL/);
    } finally {
        process.chdir(cwd);
        fs.rmSync(dir, { recursive: true });
    }
});

test(',th switches between the themes, as does :colorscheme', () => {
    const h = harness();
    const background = (): unknown => h.frames[h.frames.length - 1][0][5];
    assert.equal(background(), '#282c34');
    h.type(',th');
    assert.equal(background(), '#2E3440');
    assert.match(h.app.editor.message?.text ?? '', /nord/);
    h.type(':colorscheme onedark<CR>');
    assert.equal(background(), '#282c34');
    h.type(':colo solarized<CR>');
    assert.match(h.app.editor.message?.text ?? '', /E185/);
});

test(',m switches a Markdown file between editing it and reading it rendered', () => {
    const dir = tempDir('markdown');
    const file = path.join(dir, 'notes.md');
    const source = ['# Title', '', 'Some **bold** text.', '', ...Array.from({ length: 60 }, (_, i) => `- item ${i}`)].join('\n');
    fs.writeFileSync(file, source + '\n');
    const cwd = process.cwd();
    try {
        const h = harness(file);
        const ed = h.app.editor;
        assert.match(h.text(), /^#$/m, 'the heading marker, highlighted on its own');
        assert.match(h.text(), /markdown/, 'the filetype');
        h.type(',m');
        assert.match(h.text(), /VIEW/);
        assert.doesNotMatch(h.text(), /^(#|\*\*|-)$/m, 'markup is gone');
        assert.match(h.text(), /^Title$/m);
        assert.match(h.text(), /^• $/m);
        const bold = h.frames[h.frames.length - 1].find((c) => c[0] === 'text' && c[3] === 'bold');
        assert.equal(bold?.[5], 'bold');
        // Editing keys do nothing; mappings that edit don't either.
        for (const keys of ['x', 'dd', 'ihello<Esc>', 'o', 'p', ',d']) {
            h.type(keys);
            assert.equal(ed.buffer.text(), source, keys);
            assert.equal(ed.mode, 'Normal', keys);
        }
        h.type('G');
        assert.match(h.text(), /item 59/);
        assert.match(h.text(), /Bot/);
        h.type('gg');
        assert.match(h.text(), /Top/);
        h.type('<C-d>');
        // Back to editing, at the same place.
        h.type(',m');
        assert.doesNotMatch(h.text(), /VIEW/);
        assert.ok(ed.scrollTop > 4, `scrolled to ${ed.scrollTop}`);
        assert.ok(ed.cursor.line >= ed.scrollTop, 'the cursor is in view');
        assert.match(h.text(), /^ item/m);
        h.type(':e other.txt<CR>,m');
        assert.match(ed.message?.text ?? '', /Not a Markdown file/);
    } finally {
        process.chdir(cwd);
        fs.rmSync(dir, { recursive: true });
    }
});

/** Where text was drawn in the last frame. */
function textAt(h: Harness, text: string): { x: number; y: number } {
    const cmd = h.frames[h.frames.length - 1].find((c) => c[0] === 'text' && c[3].includes(text));
    assert.ok(cmd, `"${text}" is drawn`);
    const [, x, y, s] = cmd as Extract<DrawCmd, ['text', ...unknown[]]>;
    return { x: x + Array.from(s.slice(0, s.indexOf(text))).length * 10 + 5, y: y + 5 };
}

test('gf, Enter and Cmd+click follow links between Markdown files, and <C-o> comes back', () => {
    const dir = tempDir('links');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'index.md'), 'See [[Other#Part two]] and [b](sub/b%20c.md).\n[[New]] https://x.io [[#Top]]\n# Top\n');
    fs.writeFileSync(path.join(dir, 'sub', 'Other.md'), '# Other\n\n## Part one\n\n## Part two\ntext\n');
    fs.writeFileSync(path.join(dir, 'sub', 'b c.md'), 'b\n');
    const cwd = process.cwd();
    const opened: string[] = [];
    try {
        const h = harness(path.join(dir, 'index.md'), [], { openUrl: (url) => opened.push(url) });
        const ed = h.app.editor;
        h.type('fOgf');
        assert.equal(ed.filePath, path.join(dir, 'sub', 'Other.md'), 'found by name in the vault');
        assert.equal(ed.cursor.line, 4, 'at the heading');
        h.type('<C-o>');
        assert.equal(ed.filePath, path.join(dir, 'index.md'));
        h.type('0fb<CR>');
        assert.equal(ed.filePath, path.join(dir, 'sub', 'b c.md'));
        h.type('<C-o>j0');
        h.type('<CR>');
        assert.equal(ed.filePath, path.join(dir, 'New.md'), 'a new note beside this one');
        assert.match(ed.message?.text ?? '', /\[New\]/);
        assert.equal(fs.existsSync(path.join(dir, 'New.md')), false, 'made when written');
        h.type('<C-o>');
        assert.equal(ed.cursor.line, 1);
        h.type('0fh');
        h.type('gf');
        assert.deepEqual(opened, ['https://x.io']);
        h.type('$<CR>');
        assert.equal(ed.cursor.line, 2, 'a heading in the same file');
        // Enter off a link moves down as usual.
        h.type('gg0<CR>');
        assert.equal(ed.cursor.line, 1);
        // Cmd+click.
        h.type('gg');
        const at = textAt(h, 'Other');
        h.send({ t: 'mouse', kind: 'down', x: at.x, y: at.y });
        h.send({ t: 'mouse', kind: 'up', x: at.x, y: at.y });
        assert.equal(ed.filePath, path.join(dir, 'index.md'), 'a plain click only moves the cursor');
        h.send({ t: 'mouse', kind: 'down', x: at.x, y: at.y, mod: true });
        h.send({ t: 'mouse', kind: 'up', x: at.x, y: at.y });
        assert.equal(ed.filePath, path.join(dir, 'sub', 'Other.md'));
    } finally {
        process.chdir(cwd);
        fs.rmSync(dir, { recursive: true });
    }
});

test('links in a rendered Markdown view are clicked, and open rendered', () => {
    const dir = tempDir('md-click');
    fs.writeFileSync(path.join(dir, 'index.md'), '# Index\n\nGo to [[Other|the other note]].\n');
    fs.writeFileSync(path.join(dir, 'Other.md'), ['# Other', ...Array.from({ length: 50 }, (_, i) => `line ${i}`), '## End', 'last'].join('\n'));
    const cwd = process.cwd();
    try {
        const h = harness(path.join(dir, 'index.md'));
        const ed = h.app.editor;
        h.type(',m');
        assert.doesNotMatch(h.text(), /\[\[/);
        const at = textAt(h, 'the other note');
        h.send({ t: 'mouse', kind: 'down', x: at.x, y: at.y });
        h.send({ t: 'mouse', kind: 'up', x: at.x, y: at.y });
        assert.equal(ed.filePath, path.join(dir, 'Other.md'));
        assert.match(h.text(), /VIEW/, 'rendered, as the note it came from');
        assert.match(h.text(), /^Other$/m);
        h.type('<C-o>');
        assert.equal(ed.filePath, path.join(dir, 'index.md'));
        assert.match(h.text(), /VIEW/);
    } finally {
        process.chdir(cwd);
        fs.rmSync(dir, { recursive: true });
    }
});

test('rendered Markdown shows images and asks the window to draw diagrams', () => {
    const dir = tempDir('md-media');
    fs.mkdirSync(path.join(dir, 'attachments'));
    fs.writeFileSync(path.join(dir, 'attachments', 'pic.png'), pngHeader(200, 100));
    fs.writeFileSync(path.join(dir, 'notes.md'), ['![[pic.png]]', '', '```mermaid', 'graph LR', '  A --> B', '```', 'after'].join('\n'));
    const cwd = process.cwd();
    try {
        const h = harness(path.join(dir, 'notes.md'));
        h.type(',m');
        const cmds = (): DrawCmd[] => h.frames[h.frames.length - 1];
        const image = cmds().find((c) => c[0] === 'image');
        assert.ok(image, 'the image is drawn');
        assert.deepEqual(image.slice(3, 5), [200, 100]);
        assert.match(String(image[5]), /pic\.png/);
        const id = diagramId('graph LR\n  A --> B');
        const measure = cmds().find((c) => c[0] === 'diagram');
        assert.deepEqual(measure?.slice(3, 7), [0, 0, id, 'graph LR\n  A --> B'], 'drawn first to be sized');
        assert.match(h.text(), /Drawing the diagram/);
        h.send({ t: 'diagram', id, width: 300, height: 120 });
        const diagram = cmds().find((c) => c[0] === 'diagram');
        assert.deepEqual(diagram?.slice(3, 5), [300, 120]);
        assert.doesNotMatch(h.text(), /Drawing the diagram/);
        // Clicking the image opens it.
        const [, x, y] = image as Extract<DrawCmd, ['image', ...unknown[]]>;
        h.send({ t: 'mouse', kind: 'down', x: x + 5, y: y + 5 });
        h.send({ t: 'mouse', kind: 'up', x: x + 5, y: y + 5 });
        assert.equal(h.app.editor.filePath, path.join(dir, 'attachments', 'pic.png'));
    } finally {
        process.chdir(cwd);
        fs.rmSync(dir, { recursive: true });
    }
});
