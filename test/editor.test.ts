import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { MemoryClipboard } from '../src/clipboard';
import { pos } from '../src/editor/buffer';
import { Editor } from '../src/editor/editor';
import { parseKeys } from '../src/editor/keys';

/** Build an editor from text where `|` marks the cursor. */
function editor(text: string): Editor {
    const idx = text.indexOf('|');
    assert.ok(idx >= 0, 'cursor marker');
    const before = text.slice(0, idx);
    const line = before.split('\n').length - 1;
    const col = Array.from(before.split('\n').pop()!).length;
    const ed = Editor.fromText(text.replace('|', ''), new MemoryClipboard());
    ed.cursor = pos(line, col);
    ed.updateWantCol();
    return ed;
}

function state(ed: Editor): string {
    const lines: string[] = [];
    for (let l = 0; l < ed.buffer.lineCount(); l++) lines.push(ed.buffer.lineString(l));
    const c = ed.cursor;
    const cs = Array.from(lines[c.line]);
    cs.splice(Math.min(c.col, cs.length), 0, '|');
    lines[c.line] = cs.join('');
    return lines.join('\n');
}

function check(before: string, keys: string, after: string): void {
    const ed = editor(before);
    ed.handleKeys(parseKeys(keys));
    assert.equal(state(ed), after, `keys: ${keys}`);
}

function tempDir(name: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `wim-${name}-`));
}

test('basic motions', () => {
    check('|foo bar baz', 'w', 'foo |bar baz');
    check('|foo bar baz', '2w', 'foo bar |baz');
    check('foo bar |baz', 'b', 'foo |bar baz');
    check('|foo bar', 'e', 'fo|o bar');
    check('foo |bar', 'ge', 'fo|o bar');
    check('|foo.bar baz', 'W', 'foo.bar |baz');
    check('|foo\n\nbar', 'w', 'foo\n|\nbar');
    check('  |foo', '0', '|  foo');
    check('|  foo', '^', '  |foo');
    check('|foo', '$', 'fo|o');
    check('a\nb\n|c', 'gg', '|a\nb\nc');
    check('|a\nb\nc', 'G', 'a\nb\n|c');
    check('|a\nb\nc', '2G', 'a\n|b\nc');
    check('|a\nb\nc', ':3<CR>', 'a\nb\n|c');
});

test('vertical motion keeps column', () => {
    check('abc|def\nx\nabcdef', 'jj', 'abcdef\nx\nabc|def');
    check('ab|c\nabcdef', '$j', 'abc\nabcde|f');
});

test('find and repeat', () => {
    check('|a,b,c,d', 'f,;', 'a,b|,c,d');
    check('|a,b,c,d', 'f,;,', 'a|,b,c,d');
    check('|a,b,c,d', 't,;', 'a,|b,c,d');
    check('a,b,c,|d', 'F,', 'a,b,c|,d');
    check('|a,b,c,d', 'dt,', '|,b,c,d');
    check('|a,b,c,d', 'df,', '|b,c,d');
});

test('match pair and paragraphs', () => {
    check('|(a [b])', '%', '(a [b]|)');
    check('(a [b]|)', '%', '|(a [b])');
    check('|a\nb\n\nc', '}', 'a\nb\n|\nc');
    check('|a\nb\n\nc', 'd}', '|\nc');
    check('|a\n\nb', '}', 'a\n|\nb');
    check('|a\n\nb\n\nc', '2}', 'a\n\nb\n|\nc');
    check('a\n\n|b', '{', 'a\n|\nb');
    check('a\n|\nb', '{', '|a\n\nb');
});

test('delete and change', () => {
    check('|foo bar baz', 'dw', '|bar baz');
    check('foo |bar\nbaz', 'dw', 'foo| \nbaz');
    check('|foo bar', 'cwxyz<Esc>', 'xy|z bar');
    check('fo|o bar', 'cwX<Esc>', 'fo|X bar');
    check('|abc', '3x', '|');
    check('ab|c', 'x', 'a|b');
    check('|abc', 'D', '|');
    check('a|bc', 'C!<Esc>', 'a|!');
    check('|a\nb\nc', 'dj', '|c');
    check('|a\nb\nc', '2dd', '|c');
    check('a\n|b', 'dd', '|a');
    check('|one two three', 'd2w', '|three');
    check('    |foo\nbar', 'ccx<Esc>', '    |x\nbar');
    check('|foo', 'sX<Esc>', '|Xoo');
    check('|abc', '3rx', 'xx|x');
});

test('text objects', () => {
    check('foo b|ar baz', 'diw', 'foo | baz');
    check('foo b|ar baz', 'daw', 'foo |baz');
    check('say "hel|lo" now', 'di"', 'say "|" now');
    check('say "hel|lo" now', 'da"', 'say |now');
    check('f(|a, b)', 'ci(x<Esc>', 'f(|x)');
    check('f(a, (b|), c)', 'd2i(', 'f(|)');
    check('f(a, (b|), c)', 'da(', 'f(a, |, c)');
    check('fn x() {\n    |a;\n}', 'ci{z<Esc>', 'fn x() {\n    |z\n}');
    check('fn x() {\n    |a;\n}', 'di{', 'fn x() {\n|}');
    check('|a\nb\n\nc', 'dap', '|c');
    check('|a\nb\n\nc', 'yipP', '|a\nb\na\nb\n\nc');
});

test('yank and put', () => {
    check('|a\nb\nc', 'ddp', 'b\n|a\nc');
    check('|a\nb', 'yyP', '|a\na\nb');
    check('|foo bar', 'yiwP', 'fo|ofoo bar');
    check('|foo bar', 'yiw$p', 'foo barfo|o');
    check('|a\nb', '"ayyj"ap', 'a\nb\n|a');
    check('|a\nb', '"ayyj"Ayy"ap', 'a\nb\n|a\nb');
    check('|foo bar', 'yiwwviwp', 'foo fo|o');
    check('|a\nb', 'yy3p', 'a\n|a\na\na\nb');
});

test('insert mode', () => {
    check('|', 'ihello<Esc>', 'hell|o');
    check('|a\nb', 'Ax<Esc>', 'a|x\nb');
    check('  |a', 'Ix<Esc>', '  |xa');
    check('|', '3ia<Esc>', 'aa|a');
    check('    |foo', 'obar<Esc>', '    foo\n    ba|r');
    check('|foo', 'Obar<Esc>', 'ba|r\nfoo');
    check('|a', '3ox<Esc>', 'a\nx\nx\n|x');
    check('|fn x() {', 'A<CR>a<Esc>', 'fn x() {\n    |a');
    check('|fn x() {}', 'f}i<CR>a<Esc>', 'fn x() {\n    |a\n}');
    check('    |', 'A<CR><Esc>', '    \n|');
    check('|ab', 'A<BS><BS>c<Esc>', '|c');
    check('a\n|b', 'i<BS><Esc>', '|ab');
    check('|foo bar', 'A<C-w>x<Esc>', 'foo |x');
    check('|', 'i<Tab>x<Esc>', '    |x');
    check('    |', 'A}<Esc>', '|}');
    check('|abc', 'Rxy<Esc>', 'x|yc');
});

test('autopairs', () => {
    // Opening brackets and quotes bring their closers; typing a closer steps
    // over it, and <BS> between an empty pair deletes both.
    check('|', 'if(x<Esc>', 'f(|x)');
    check('|', 'if(x)y<Esc>', 'f(x)|y');
    check('|', 'i[{"<Esc>', '[{|""}]');
    check('|', 'i(<BS>x<Esc>', '|x');
    check('|', 'ia = `b`;<Esc>', 'a = `b`|;');
    // Enter between a pair opens a block.
    check('|', 'ifn x() {<CR>a<Esc>', 'fn x() {\n    |a\n}');
    // No pair before a word character, after one (for quotes), or to close
    // a string; and none for an opener whose closer is already on the line.
    check('|foo', 'i(<Esc>', '|(foo');
    check('|', 'ix"<Esc>', 'x|"');
    check('"ab|', 'a"<Esc>', '"ab|"');
    check('|)', 'i(<Esc>', '|()');
    // `'` is left alone, as in the Neovim config.
    check('|', "i'<Esc>", "|'");
    // Dot repeat types the same.
    check('|\n-', 'if(x)<Esc>j0.', 'f(x)\nf(x|)-');
    // Replace mode doesn't pair.
    check('|ab', 'R(<Esc>', '|(b');
    // :set noautopairs turns it off.
    check('|', ':set noautopairs<CR>i(<Esc>', '|(');
});

test('autopairs make triple quotes in Python', () => {
    const py = editor('|');
    py.filePath = '/x/a.py';
    py.handleKeys(parseKeys('i"""<Esc>'));
    assert.equal(state(py), '""|""""');
    const js = editor('|');
    js.filePath = '/x/a.js';
    js.handleKeys(parseKeys('i"""<Esc>'));
    assert.equal(state(js), '""|""');
});

test('undo and redo', () => {
    check('|abc', 'xu', '|abc');
    check('|abc', 'xu<C-r>', '|bc');
    check('|abc', 'ifoo<Esc>u', '|abc');
    check('|abc', 'xxuu', '|abc');
    check('|abc', 'uu', '|abc');
});

test('modified tracks undo', () => {
    const ed = editor('|abc');
    assert.ok(!ed.isModified());
    ed.handleKeys(parseKeys('x'));
    assert.ok(ed.isModified());
    ed.handleKeys(parseKeys('u'));
    assert.ok(!ed.isModified());
});

test('dot repeat', () => {
    check('|one two three', 'dw.', '|three');
    check('|a\nb', 'Ax<Esc>j.', 'ax\nb|x');
    check('|a b c d e', 'dw3.', '|e');
    check('|foo foo', 'cwbar<Esc>w.', 'bar ba|r');
    check('|a\nb\nc', 'dd.', '|c');
});

test('visual mode', () => {
    check('|hello world', 'veU', '|HELLO world');
    check('|hello world', 'vwd', '|orld');
    check('|a\nb', 'Vj>', '    |a\n    b');
    check('|a\nb\nc', 'Vjd', '|c');
    check('|abc', 'vlyP', 'a|babc');
    check('|a b c', 'v$rx', '|xxxxx');
    check('|a\nb\nc', 'VjJ', 'a| b\nc');
    check('|abc', 'vlo', '|abc');
    check('foo (b|ar) baz', 'vi(d', 'foo (|) baz');
});

test('join lines', () => {
    check('|a\n   b', 'J', 'a| b');
    check('|a\nb\nc', '3J', 'a b| c');
    check('|a\n  b', 'gJ', 'a|  b');
});

test('search', () => {
    check('foo\n|bar\nfoo', '/foo<CR>', 'foo\nbar\n|foo');
    check('foo\n|bar\nfoo', '/foo<CR>n', '|foo\nbar\nfoo');
    check('foo\n|bar\nfoo', '?foo<CR>', '|foo\nbar\nfoo');
    check('foo\n|bar\nfoo', '/foo<CR>N', '|foo\nbar\nfoo');
    check('|foo bar foo', '*', 'foo bar |foo');
    check('|foo foobar foo', '*', 'foo foobar |foo');
    check('|a\nfoo1\nfoo2', '/foo\\d<CR>n', 'a\nfoo1\n|foo2');
    check('|abc', '/zzz<CR>', '|abc');
    check('|a b', '/b<Esc>', '|a b');
});

test('star search matches whole non-ASCII words', () => {
    check('|café cafés café', '*', 'café cafés |café');
});

test('ex commands', () => {
    check('|a a\na', ':%s/a/b/g<CR>', 'b b\n|b');
    check('|a a\na', ':s/a/b/<CR>', '|b a\na');
    check('|foo bar', ':s/\\(foo\\) \\(bar\\)/\\2 \\1/<CR>', '|bar foo');
    check('|a\nb\nc', ':2,3d<CR>', '|a');
    check('|c\na\nb', ':sort<CR>', '|a\nb\nc');
    check('|a\nb\nc', ':1m$<CR>', 'b\nc\n|a');
    check('|a\nb', ':t.<CR>', 'a\n|a\nb');
    check('|a\nb\nc', 'Vj:s/$/!/<CR>', 'a!\n|b!\nc');
});

test('ex set options', () => {
    const ed = editor('|x');
    ed.handleKeys(parseKeys(':set nonu ts=8 ic<CR>'));
    assert.ok(!ed.options.number);
    assert.equal(ed.options.tabstop, 8);
    assert.ok(ed.options.ignorecase);
    ed.handleKeys(parseKeys(':set nu!<CR>'));
    assert.ok(ed.options.number);
    ed.handleKeys(parseKeys(':set bogus<CR>'));
    assert.ok(ed.message!.error);
});

test('quit guards unsaved changes', () => {
    const ed = editor('|x');
    ed.handleKeys(parseKeys('dd:q<CR>'));
    assert.ok(!ed.quitRequested);
    ed.handleKeys(parseKeys(':q!<CR>'));
    assert.ok(ed.quitRequested);
});

test('counts, case and increment', () => {
    check('|abc', '2~', 'AB|c');
    check('|abc def', 'gUiw', '|ABC def');
    check('|ABC', 'guu', '|abc');
    check('x = |9', '<C-a>', 'x = 1|0');
    check('x = |5', '3<C-x>', 'x = |2');
    check('|x = -1', '<C-a>', 'x = |0');
});

test('marks', () => {
    check('|a\nb\nc', "majj'a", '|a\nb\nc');
    check('a|bc\nb', "majd'a", '|');
    check('|a\nb\nc', "Gx''", '|a\nb\n');
});

test('write and reload a file', () => {
    const dir = tempDir('write');
    const file = path.join(dir, 't.txt');
    const ed = new Editor(new MemoryClipboard());
    ed.openFile(file);
    ed.handleKeys(parseKeys('ihello<Esc>'));
    assert.ok(ed.isModified());
    ed.handleKeys(parseKeys(':w<CR>'));
    assert.ok(!ed.isModified());
    assert.equal(fs.readFileSync(file, 'utf8'), 'hello\n');
    const ed2 = new Editor(new MemoryClipboard());
    ed2.openFile(file);
    assert.equal(ed2.buffer.text(), 'hello');
    fs.rmSync(dir, { recursive: true });
});

test('dot repeats twice', () => {
    check('|a\nb\nc\nd', 'dd..', '|d');
    check('|a\nb\nc\nd', 'dd.', '|c\nd');
});

test('dot ignores undo', () => {
    check('|a\nb\nc', 'ddu.', '|b\nc');
});

test('Option word editing in Insert mode', () => {
    check('|', 'ifoo bar.baz<M-Left>X<Esc>', 'foo bar.|Xbaz');
    check('|', 'ifoo bar<M-Left><M-Left>X<Esc>', '|Xfoo bar');
    check('|foo bar', 'i<M-Right>X<Esc>', 'foo|X bar');
    check('|foo bar', 'i<M-Right><M-Right>X<Esc>', 'foo bar|X');
    check('|', 'ifoo bar<M-BS>X<Esc>', 'foo |X');
    check('|', 'ifoo bar  <M-BS>X<Esc>', 'foo |X');
    check('|foo bar', 'i<M-Del>X<Esc>', '|X bar');
    check('a\n|b', 'i<M-BS>X<Esc>', '|Xb');
    check('|foo bar', '<M-Right>x', 'foo |ar');
});

test('Option+Backspace on the command line', () => {
    const ed = editor('|x');
    ed.handleKeys(parseKeys(':set number<M-BS>'));
    assert.equal(ed.cmdlineText(), ':set ');
});

test('yank reports the flash region', () => {
    const ed = editor('foo |bar');
    ed.handleKeys(parseKeys('yiw'));
    const r = ed.takeYankFlash()!;
    assert.deepEqual([r.start, r.end, r.linewise], [pos(0, 4), pos(0, 7), false]);
    assert.equal(ed.takeYankFlash(), undefined);
});

test('multiple buffers', () => {
    const dir = tempDir('bufs');
    const a = path.join(dir, 'a.txt');
    const b = path.join(dir, 'b.txt');
    fs.writeFileSync(a, 'alpha\n');
    fs.writeFileSync(b, 'beta\n');

    const ed = new Editor(new MemoryClipboard());
    ed.openFile(a);
    assert.equal(ed.bufferList().length, 1, 'empty start buffer is replaced');
    ed.handleKeys(parseKeys('x'));
    ed.openFile(b);
    assert.equal(ed.buffer.text(), 'beta');
    assert.equal(ed.bufferList().length, 2);

    // Each buffer keeps its own text, cursor and undo history.
    ed.handleKeys(parseKeys('<C-^>'));
    assert.equal(ed.buffer.text(), 'lpha');
    ed.handleKeys(parseKeys('u'));
    assert.equal(ed.buffer.text(), 'alpha');
    ed.handleKeys(parseKeys(':bn<CR>'));
    assert.equal(ed.buffer.text(), 'beta');
    ed.openFile(a);
    assert.equal(ed.bufferList().length, 2, 'reopening reuses the buffer');

    // Quitting everything is refused while another buffer has changes.
    ed.handleKeys(parseKeys(':bn<CR>dd:bn<CR>:qa<CR>'));
    assert.ok(!ed.quitRequested);
    assert.ok(ed.message!.text.includes('E162'));
    // `:q` closes just the (unmodified) active buffer `a`, leaving the modified `b`.
    ed.handleKeys(parseKeys(':q<CR>'));
    assert.ok(!ed.quitRequested);
    assert.equal(ed.bufferList().length, 1);
    assert.equal(ed.buffer.text(), '');
    assert.ok(ed.isModified());
    // The last buffer still guards its changes before quitting.
    ed.handleKeys(parseKeys(':q<CR>'));
    assert.ok(!ed.quitRequested);
    assert.ok(ed.message!.text.includes('E37'));
    fs.rmSync(dir, { recursive: true });
});

test('unmatched bracket motions', () => {
    check('fn f() {\n    if x {\n        |a;\n    }\n}', '[{', 'fn f() {\n    if x |{\n        a;\n    }\n}');
    check('fn f() {\n    if x {\n        |a;\n    }\n}', '2[{', 'fn f() |{\n    if x {\n        a;\n    }\n}');
    check('fn f() {\n    if x {\n        |a;\n    }\n}', ']}', 'fn f() {\n    if x {\n        a;\n    |}\n}');
    check('f(a, (|b), c)', '[(', 'f(a, |(b), c)');
    check('f(a, (b), |c)', 'd])', 'f(a, (b), |)');
    // `[f` in the user's config: as many `[{` as possible, then stop.
    check('a {\n b {\n  |c\n }\n}', '[{[{[{[{', 'a |{\n b {\n  c\n }\n}');
});

test('moving lines keeps the visual selection', () => {
    check('|a\nb\nc\nd', "Vj:m '>+1<CR>gv", 'c\na\n|b\nd');
    check('a\nb\n|c\nd', "V:m '<-2<CR>gv", 'a\n|c\nb\nd');
    check('|a\nb', "V:m '<-2<CR>", '|a\nb');
});

test('Esc clears search highlighting', () => {
    const ed = editor('|foo foo');
    ed.handleKeys(parseKeys('/foo<CR>'));
    assert.ok(ed.highlightRegex());
    ed.handleKeys(parseKeys('<Esc>'));
    assert.equal(ed.highlightRegex(), undefined);
});

test('global marks and closing buffers', () => {
    const dir = tempDir('marks');
    const [a, b, c] = ['a.txt', 'b.txt', 'c.txt'].map((f) => path.join(dir, f));
    fs.writeFileSync(a, 'one\ntwo\nthree\n');
    fs.writeFileSync(b, 'beta\n');
    fs.writeFileSync(c, 'gamma\n');

    const ed = new Editor(new MemoryClipboard());
    ed.openFile(a);
    ed.handleKeys(parseKeys('jjmA'));
    ed.openFile(b);
    ed.handleKeys(parseKeys("'A"));
    assert.equal(ed.filePath, fs.realpathSync.native(a));
    assert.equal(ed.cursor.line, 2);

    // A mark whose buffer was closed reopens its file.
    ed.handleKeys(parseKeys(':bd<CR>'));
    assert.equal(ed.buffer.text(), 'beta');
    ed.handleKeys(parseKeys("'A"));
    assert.equal(ed.buffer.text(), 'one\ntwo\nthree');

    ed.openFile(c);
    assert.equal(ed.bufferList().length, 3);
    ed.handleKeys(parseKeys(':bonly<CR>'));
    assert.equal(ed.bufferList().length, 1);
    assert.equal(ed.buffer.text(), 'gamma');
    ed.openFile(a);
    ed.handleKeys(parseKeys(':%bd<CR>'));
    assert.equal(ed.bufferList().length, 1);
    assert.equal(ed.filePath, undefined);
    fs.rmSync(dir, { recursive: true });
});

test('clipboard registers use the system clipboard', () => {
    const clipboard = new MemoryClipboard();
    const ed = Editor.fromText('foo bar', clipboard);
    ed.handleKeys(parseKeys('"+yiw'));
    assert.equal(clipboard.text, 'foo');
    clipboard.text = 'line\n';
    ed.handleKeys(parseKeys('"+p'));
    assert.equal(ed.buffer.text(), 'foo bar\nline');
});
