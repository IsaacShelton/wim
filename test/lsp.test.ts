// Tests for the language server client: position conversion, edits,
// snippets, hover Markdown, the JSON-RPC framing, and the features driven
// through the window logic against a small fake server.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { WimApp } from '../src/app';
import { MemoryClipboard } from '../src/clipboard';
import { Buffer, pos } from '../src/editor/buffer';
import { parseKeys } from '../src/editor/keys';
import { fuzzyScore } from '../src/fuzzy';
import { markdownLines } from '../src/lsp/markdown';
import { RpcConnection } from '../src/lsp/rpc';
import { ServerSpec, defaultServers } from '../src/lsp/servers';
import { applyTextEdits, fromCharacter, snippetText, toCharacter } from '../src/lsp/text';
import { DrawCmd } from '../src/protocol';

function tempDir(name: string): string {
    return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `wim-${name}-`)));
}

// ----- Helpers -----------------------------------------------------------------------

test('columns convert between code points and each encoding', () => {
    const line = Array.from('a😀é=x');
    assert.equal(toCharacter(line, 4, 'utf-16'), 5);
    assert.equal(toCharacter(line, 4, 'utf-8'), 8);
    assert.equal(toCharacter(line, 4, 'utf-32'), 4);
    assert.equal(fromCharacter(line, 5, 'utf-16'), 4);
    assert.equal(fromCharacter(line, 8, 'utf-8'), 4);
    assert.equal(fromCharacter(line, 99, 'utf-16'), line.length);
});

test('text edits apply together and keep a position on its text', () => {
    const buf = Buffer.fromText('fn  main(){\nlet x=1;\n}');
    const range = (l1: number, c1: number, l2: number, c2: number) => ({
        start: { line: l1, character: c1 },
        end: { line: l2, character: c2 },
    });
    const cursor = applyTextEdits(
        buf,
        [
            { range: range(0, 2, 0, 4), newText: ' ' },
            { range: range(0, 0, 0, 0), newText: 'use a;\n\n' },
            { range: range(1, 0, 1, 0), newText: '    ' },
        ],
        'utf-16',
        pos(1, 4),
    );
    assert.equal(buf.text(), 'use a;\n\nfn main(){\n    let x=1;\n}');
    assert.equal(buf.line(cursor.line).slice(cursor.col).join(''), 'x=1;');
});

test('a whole-file edit only changes what differs, keeping the cursor in place', () => {
    const lines = ['x=1', ...Array.from({ length: 50 }, (_, i) => `y${i} = ${i}`), 'z  =  2'];
    const buf = Buffer.fromText(lines.join('\n'));
    const version = buf.version();
    const formatted = ['x = 1', ...lines.slice(1, -1), 'z = 2'].join('\n');
    const whole = { start: { line: 0, character: 0 }, end: { line: 52, character: 0 } };
    const cursor = applyTextEdits(buf, [{ range: whole, newText: formatted }], 'utf-16', pos(30, 2));
    assert.equal(buf.text(), formatted);
    assert.deepEqual(cursor, pos(30, 2));
    assert.notEqual(buf.version(), version);
    // Edits reaching past the last line include the file's final newline.
    const buf3 = Buffer.fromText('a\nb\n');
    const eof = { line: 2, character: 0 };
    applyTextEdits(buf3, [{ range: { start: { line: 0, character: 0 }, end: eof }, newText: 'A\nB\n' }], 'utf-16');
    assert.equal(buf3.toFileText(), 'A\nB\n');
    applyTextEdits(buf3, [{ range: { start: eof, end: eof }, newText: 'C\n' }], 'utf-16');
    assert.equal(buf3.toFileText(), 'A\nB\nC\n');
    // A cursor inside a changed stretch stays on its line.
    const buf2 = Buffer.fromText('a\nb\nc\nd');
    const range = { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } };
    assert.deepEqual(applyTextEdits(buf2, [{ range, newText: 'A\nB\nC\nD' }], 'utf-16', pos(2, 0)), pos(2, 0));
});

test('snippets become plain text with the cursor at the first tab stop', () => {
    assert.deepEqual(snippetText('foo(${1:a}, $2)$0'), { text: 'foo(a, )', cursor: 4 });
    assert.deepEqual(snippetText('bar()$0'), { text: 'bar()', cursor: 5 });
    assert.deepEqual(snippetText('x \\$1 ${1|one,two|}'), { text: 'x $1 one', cursor: 5 });
    assert.deepEqual(snippetText('plain'), { text: 'plain', cursor: 5 });
});

test('fuzzy matching prefers prefixes and word starts', () => {
    assert.equal(fuzzyScore('xyz', 'floor'), undefined);
    assert.ok(fuzzyScore('fl', 'floor')! > fuzzyScore('fl', 'selfLoop')!);
    assert.ok(fuzzyScore('gb', 'getBuffer')! > fuzzyScore('gb', 'garbage')!);
});

test('hover Markdown loses its markup and highlights code', () => {
    const lines = markdownLines('```rust\nfn foo()\n```\n\n---\n\nDocs for **foo**, see [`bar`](x).\n\n\n');
    const text = lines.map((l) => l.map(([s]) => s).join(''));
    assert.deepEqual(text, ['fn foo()', '', 'Docs for foo, see bar.']);
    assert.ok(lines[0].length > 1, 'the code is highlighted');
});

test('JSON-RPC messages are framed and matched to their requests', async () => {
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    const client = new RpcConnection(toClient, toServer);
    const server = new RpcConnection(toServer, toClient);
    server.onRequest = (method, params) => ({ method, echo: params });
    const notes: unknown[] = [];
    client.onNotification = (method, params) => notes.push([method, params]);
    assert.deepEqual(await client.request('a/b', { x: 'é' }), { method: 'a/b', echo: { x: 'é' } });
    server.notify('note', [1]);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(notes, [['note', [1]]]);
});

test('pylsp prefers the project\'s virtual environment', { skip: process.platform === 'win32' }, () => {
    const dir = tempDir('venv');
    const bin = path.join(dir, '.venv', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    for (const name of ['pylsp', 'python3']) fs.writeFileSync(path.join(bin, name), '', { mode: 0o755 });
    const pylsp = defaultServers().find((s) => s.name === 'pylsp')!;
    const venv = process.env.VIRTUAL_ENV;
    delete process.env.VIRTUAL_ENV;
    try {
        const commands = pylsp.commands(dir);
        assert.deepEqual(commands.slice(0, 2), [
            { command: path.join(bin, 'pylsp'), args: [] },
            { command: path.join(bin, 'python3'), args: ['-m', 'pylsp'] },
        ]);
        const settings = pylsp.settings!(dir) as { pylsp: { plugins: { jedi?: { environment: string } } } };
        assert.equal(settings.pylsp.plugins.jedi?.environment, path.join(bin, 'python3'));
        // Without one, Jedi uses pylsp's own environment.
        fs.rmSync(path.join(dir, '.venv'), { recursive: true });
        assert.equal((pylsp.settings!(dir) as typeof settings).pylsp.plugins.jedi, undefined);
    } finally {
        if (venv !== undefined) process.env.VIRTUAL_ENV = venv;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ----- Against a fake server --------------------------------------------------------------

/** A language server for `.rs` files: every `bad` is an error, the hover
 * shows the word under the cursor, definition finds the first `fn word`,
 * completion offers three items (the first adds an import once resolved),
 * signature help knows `helper(a, b)`, rename replaces every occurrence and
 * formatting removes trailing spaces. */
const FAKE_SERVER = String.raw`
let input = Buffer.alloc(0);
const docs = new Map();
function send(msg) {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }));
    process.stdout.write('Content-Length: ' + body.length + '\r\n\r\n');
    process.stdout.write(body);
}
// Positions are UTF-16, as in the protocol's default.
function lines(uri) { return docs.get(uri).split('\n'); }
function wordAt(uri, p) {
    const line = lines(uri)[p.line];
    let s = p.character, e = p.character;
    while (s > 0 && /\w/.test(line[s - 1])) s--;
    while (e < line.length && /\w/.test(line[e])) e++;
    return line.slice(s, e);
}
function occurrences(uri, word) {
    const out = [];
    lines(uri).forEach((line, i) => {
        const re = new RegExp('\\b' + word + '\\b', 'g');
        let m;
        while ((m = re.exec(line))) out.push({ start: { line: i, character: m.index }, end: { line: i, character: m.index + word.length } });
    });
    return out;
}
function publish(uri) {
    const diagnostics = occurrences(uri, 'bad').map((range) => ({ range, severity: 1, message: 'bad is bad', source: 'fake' }));
    send({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics } });
}
function handle(msg) {
    const p = msg.params;
    switch (msg.method) {
        case 'initialize':
            return { capabilities: {
                textDocumentSync: { openClose: true, change: 1, save: true },
                completionProvider: { triggerCharacters: ['.'], resolveProvider: true },
                hoverProvider: true, definitionProvider: true, renameProvider: true, documentFormattingProvider: true,
                signatureHelpProvider: { triggerCharacters: ['(', ','], retriggerCharacters: [')'] },
                semanticTokensProvider: { legend: { tokenTypes: ['variable', 'parameter'], tokenModifiers: [] }, full: true },
            } };
        case 'textDocument/didOpen': docs.set(p.textDocument.uri, p.textDocument.text); publish(p.textDocument.uri); return;
        case 'textDocument/didChange': docs.set(p.textDocument.uri, p.contentChanges[0].text); publish(p.textDocument.uri); return;
        case 'textDocument/hover':
            return { contents: { kind: 'markdown', value: '\x60\x60\x60rust\nfn ' + wordAt(p.textDocument.uri, p.position) + '()\n\x60\x60\x60\nDocs for **' + wordAt(p.textDocument.uri, p.position) + '**' } };
        case 'textDocument/definition': {
            const word = wordAt(p.textDocument.uri, p.position);
            const line = lines(p.textDocument.uri).findIndex((l) => l.includes('fn ' + word));
            const character = lines(p.textDocument.uri)[line].indexOf(word);
            return { uri: p.textDocument.uri, range: { start: { line, character }, end: { line, character } } };
        }
        case 'textDocument/completion':
            return { isIncomplete: false, items: [
                { label: 'foobar', kind: 3, sortText: '2' },
                { label: 'fooqux', kind: 5, sortText: '3' },
                { label: 'other', kind: 6, sortText: '1' },
            ] };
        case 'textDocument/signatureHelp': {
            // Inside an unclosed 'helper(', the parameter after as many commas.
            const before = lines(p.textDocument.uri)[p.position.line].slice(0, p.position.character);
            let depth = 0, commas = 0;
            for (let i = before.length - 1; i >= 0; i--) {
                const c = before[i];
                if (c === ')') depth++;
                else if (c === ',' && depth === 0) commas++;
                else if (c === '(' && depth > 0) depth--;
                else if (c === '(') {
                    if (!before.slice(0, i).endsWith('helper')) return null;
                    return { activeParameter: commas, signatures: [{ label: 'helper(a: i32, b: i32)',
                        parameters: [{ label: [7, 13] }, { label: 'b: i32', documentation: 'the second' }] }] };
                }
            }
            return null;
        }
        case 'textDocument/semanticTokens/full': {
            // Every 'arg' is a parameter and every 'v' a variable.
            const data = [];
            let prevLine = 0, prevStart = 0;
            lines(p.textDocument.uri).forEach((l, line) => {
                const re = /\b(arg|v)\b/g;
                let m;
                while ((m = re.exec(l))) {
                    data.push(line - prevLine, line === prevLine ? m.index - prevStart : m.index, m[1].length, m[1] === 'arg' ? 1 : 0, 0);
                    prevLine = line;
                    prevStart = m.index;
                }
            });
            return { data };
        }
        case 'completionItem/resolve':
            return p.label === 'foobar' ? { ...p, additionalTextEdits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'use foo;\n' }] } : p;
        case 'textDocument/rename': {
            const edits = occurrences(p.textDocument.uri, wordAt(p.textDocument.uri, p.position)).map((range) => ({ range, newText: p.newName }));
            return { changes: { [p.textDocument.uri]: edits } };
        }
        case 'textDocument/formatting':
            return lines(p.textDocument.uri).flatMap((l, i) => {
                const trimmed = l.replace(/ +$/, '');
                return trimmed.length === l.length ? [] : [{ range: { start: { line: i, character: trimmed.length }, end: { line: i, character: l.length } }, newText: '' }];
            });
        case 'shutdown': return null;
        case 'exit': process.exit(0);
    }
    return null;
}
process.stdin.on('data', (chunk) => {
    input = Buffer.concat([input, chunk]);
    for (;;) {
        const end = input.indexOf('\r\n\r\n');
        if (end < 0) return;
        const length = Number(/Content-Length: (\d+)/.exec(input.subarray(0, end).toString())[1]);
        if (input.length < end + 4 + length) return;
        const msg = JSON.parse(input.subarray(end + 4, end + 4 + length).toString());
        input = input.subarray(end + 4 + length);
        const result = handle(msg);
        if (msg.id !== undefined && msg.method) send({ id: msg.id, result: result === undefined ? null : result });
    }
});
`;

interface LspHarness {
    app: WimApp;
    file: string;
    type: (keys: string) => void;
    /** All text drawn in the last frame. */
    text: () => string;
    frame: () => DrawCmd[];
    until: (what: string, cond: () => boolean) => Promise<void>;
    done: () => void;
}

function lspHarness(content: string): LspHarness {
    const dir = tempDir('lsp');
    const script = path.join(dir, 'server.js');
    fs.writeFileSync(script, FAKE_SERVER);
    const file = path.join(dir, 'main.rs');
    fs.writeFileSync(file, content);
    const spec: ServerSpec = {
        name: 'fake-ls',
        languageId: (f) => (f.endsWith('.rs') ? 'rust' : undefined),
        commands: () => [{ command: process.execPath, args: [script] }],
        root: (f) => path.dirname(f),
    };
    let frame: DrawCmd[] = [];
    // Opening a file moves to its directory; `done` comes back.
    const cwd = process.cwd();
    const app = new WimApp({
        path: file,
        icons: false,
        clipboard: new MemoryClipboard(),
        servers: [spec],
        onFrame: (_t, _d, cmds) => {
            frame = cmds;
        },
        onQuit: () => {},
    });
    app.handleMessage({ t: 'resize', width: 1000, height: 600, charW: 10, lineH: 20 });
    const text = (): string =>
        frame
            .filter((c): c is Extract<DrawCmd, ['text', ...unknown[]]> => c[0] === 'text')
            .map((c) => c[3])
            .join('\n');
    return {
        app,
        file,
        type: (keys) => {
            for (const k of parseKeys(keys)) app.handleMessage({ t: 'key', key: k.key, ctrl: k.ctrl, alt: k.alt });
        },
        text,
        frame: () => frame,
        until: async (what, cond) => {
            const start = Date.now();
            while (!cond()) {
                if (Date.now() - start > 5000) throw new Error(`timed out waiting for ${what}\n${text()}`);
                await new Promise((r) => setTimeout(r, 10));
            }
        },
        done: () => {
            app.dispose();
            process.chdir(cwd);
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

test('diagnostics are shown and ]d jumps to them', async () => {
    const h = lspHarness('fn main() {\n    let 😀 = bad;\n}\n');
    try {
        await h.until('diagnostics', () => h.text().includes('■ bad is bad'));
        assert.match(h.text(), /\bE 1\b/, 'counted in the status line');
        h.type(']d');
        // The emoji is two UTF-16 units but one column.
        assert.deepEqual(h.app.editor.cursor, pos(1, 12));
        assert.match(h.text(), /bad is bad\n fake/, 'shown in a float');
        h.type('ciwgood<Esc>');
        await h.until('diagnostics to clear', () => !h.text().includes('bad is bad'));
    } finally {
        h.done();
    }
});

test('K shows hover documentation and gd goes to the definition', async () => {
    const h = lspHarness('fn helper() {}\n\nfn main() {\n    helper();\n}\n');
    try {
        h.type('4G^K');
        await h.until('hover', () => h.text().includes('Docs for helper'));
        h.type('j');
        await h.until('the hover to close', () => !h.text().includes('Docs for helper'));
        h.type('kgd');
        await h.until('the jump', () => h.app.editor.cursor.line === 0);
        assert.deepEqual(h.app.editor.cursor, pos(0, 3));
        // <C-o> goes back from the definition; <C-y> (the config's <C-i>)
        // forward again.
        h.type('<C-o>');
        assert.deepEqual(h.app.editor.cursor, pos(3, 4));
        h.type('<C-y>');
        assert.deepEqual(h.app.editor.cursor, pos(0, 3));
    } finally {
        h.done();
    }
});

test('completion pops up while typing and confirms with resolved edits', async () => {
    const h = lspHarness('fn main() {\n}\n');
    try {
        h.type('ofoo');
        await h.until('the menu', () => h.text().includes('fooqux'));
        assert.ok(!h.text().includes('other'), 'filtered by the typed word');
        // Fields sort first.
        assert.ok(h.text().indexOf('fooqux') < h.text().indexOf('foobar'));
        h.type('<Tab><Tab>');
        assert.equal(h.app.editor.buffer.line(1).join(''), '    foobar');
        h.type('<S-Tab><S-Tab>');
        assert.equal(h.app.editor.buffer.line(1).join(''), '    foo', 'back to the typed word');
        h.type('<Tab><Tab><C-l>');
        await h.until('the import', () => h.app.editor.buffer.text().startsWith('use foo;'));
        assert.equal(h.app.editor.buffer.text(), 'use foo;\nfn main() {\n    foobar()\n}', 'with parens, as for a function');
        h.type('<Esc>u');
        assert.equal(h.app.editor.buffer.text(), 'fn main() {\n}', 'one undo step');
    } finally {
        h.done();
    }
});

test('signature help follows the call being typed', async () => {
    const h = lspHarness('fn main() {\n}\n');
    try {
        await h.until('the server', () => h.app.lsp.info().includes('running'));
        // Autopairs closes the call; the first parameter is current.
        h.type('ohelper(');
        await h.until('the signature', () => h.text().includes('helper('));
        assert.match(h.text(), /helper\(\na: i32\n, b: i32\)/, 'the current parameter drawn apart');
        assert.doesNotMatch(h.text(), /the second/);
        // After a comma, the second parameter, with its documentation.
        h.type('1, 2');
        await h.until('the second parameter', () => h.text().includes('the second'));
        assert.match(h.text(), /helper\(a: i32, \nb: i32\n\)/);
        // Leaving the call closes it.
        h.type(')');
        await h.until('it to close', () => !h.text().includes('helper(a'));
        h.type('<Esc>');
        assert.equal(h.app.editor.buffer.line(1).join(''), '    helper(1, 2)');
    } finally {
        h.done();
    }
});

test('semantic tokens color what syntax alone cannot', async () => {
    const h = lspHarness('fn f(arg: i32) {\n    let v = arg;\n}\n');
    // The color of each drawn run of text with the word in it (a run is
    // text of one color).
    const colors = (word: string): string[] =>
        h.frame()
            .filter((c) => c[0] === 'text' && new RegExp(`\\b${word}\\b`).test(String(c[3])))
            .map((c) => String(c[4]));
    try {
        // In Nord, parameters are ice and variables keep their syntax color.
        h.type(',th');
        await h.until('semantic tokens', () => colors('arg').join() === '#88C0D0,#88C0D0');
        assert.deepEqual(colors('v'), ['#D8DEE9']);
        // Until new tokens come, a changed line has syntax colors only.
        h.type('2GAx<Esc>');
        assert.deepEqual(colors('arg'), ['#88C0D0', '#D8DEE9']);
        await h.until('new tokens', () => colors('arg').join() === '#88C0D0,#88C0D0');
    } finally {
        h.type(',th');
        h.done();
    }
});

test(',ra renames in a prompt', async () => {
    const h = lspHarness('fn old() {}\nfn main() { old(); }\n');
    try {
        await h.until('the server', () => h.app.lsp.info().includes('running'));
        h.type('w,ra');
        assert.match(h.text(), /New Name/);
        h.type('<C-u>fresh<CR>');
        await h.until('the rename', () => h.app.editor.buffer.text().includes('fresh'));
        assert.equal(h.app.editor.buffer.text(), 'fn fresh() {}\nfn main() { fresh(); }');
    } finally {
        h.done();
    }
});

test('saving formats the file and writes it again', async () => {
    const h = lspHarness('fn main() {   \n}\n');
    try {
        await h.until('the server', () => h.app.lsp.info().includes('running'));
        h.type(':w<CR>');
        await h.until('the formatted file', () => fs.readFileSync(h.file, 'utf8') === 'fn main() {\n}\n');
        assert.equal(h.app.editor.isModified(), false);
    } finally {
        h.done();
    }
});

test('every way a server failed to start is reported', async () => {
    const dir = tempDir('badls');
    const file = path.join(dir, 'x.rs');
    fs.writeFileSync(file, '');
    const app = new WimApp({
        path: file,
        icons: false,
        clipboard: new MemoryClipboard(),
        servers: [
            {
                name: 'bad',
                languageId: () => 'rust',
                commands: () => [
                    { command: path.join(dir, 'missing'), args: [] },
                    { command: process.execPath, args: ['-e', 'console.error("no module"); process.exit(1)'] },
                ],
                root: () => dir,
            },
        ],
        onFrame: () => {},
        onQuit: () => {},
    });
    app.handleMessage({ t: 'resize', width: 800, height: 600, charW: 10, lineH: 20 });
    const start = Date.now();
    while (!app.editor.message?.error && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 10));
    assert.match(app.editor.message?.text ?? '', /^bad failed to start: .*missing: spawn .*ENOENT; .* -e .*: no module$/);
    app.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing server is reported once', async () => {
    const dir = tempDir('nols');
    const file = path.join(dir, 'x.rs');
    fs.writeFileSync(file, '');
    const app = new WimApp({
        path: file,
        icons: false,
        clipboard: new MemoryClipboard(),
        servers: [{ name: 'nope', languageId: () => 'rust', commands: () => [], root: () => dir }],
        onFrame: () => {},
        onQuit: () => {},
    });
    app.handleMessage({ t: 'resize', width: 800, height: 600, charW: 10, lineH: 20 });
    await new Promise((r) => setTimeout(r, 50));
    assert.match(app.editor.message?.text ?? '', /nope was not found/);
    app.handleMessage({ t: 'key', key: 'K', ctrl: false, alt: false });
    assert.equal(app.editor.message?.text, 'The language server is not running');
    app.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
});
