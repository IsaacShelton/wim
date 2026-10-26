// Unit tests for the editor's building blocks: the buffer, key notation,
// the command parser and search.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Buffer, pos } from '../src/editor/buffer';
import { parse } from '../src/editor/command';
import { alt, ch, ctrl, parseKeys, plain } from '../src/editor/keys';
import { compile, find, lineMatches, substituteLine, translate } from '../src/editor/search';

test('buffer insert and delete round trip', () => {
    const b = Buffer.fromText('hello\nworld\n');
    const end = b.insertText(pos(0, 2), 'XX\nYY');
    assert.deepEqual(end, pos(1, 2));
    assert.equal(b.text(), 'heXX\nYYllo\nworld');
    assert.equal(b.deleteRange(pos(0, 2), end), 'XX\nYY');
    assert.equal(b.text(), 'hello\nworld');
});

test('buffer deletes across a line break', () => {
    const b = Buffer.fromText('ab\ncd');
    b.deleteRange(pos(0, 2), pos(1, 0));
    assert.equal(b.text(), 'abcd');
});

test('buffer columns count code points', () => {
    const b = Buffer.fromText('a😀b\r\n');
    assert.equal(b.lineLen(0), 3);
    assert.equal(b.charAt(pos(0, 2)), 'b');
});

test('parses key notation', () => {
    assert.deepEqual(parseKeys('d<C-r><Esc>a<lt><x>'), [
        ch('d'),
        ctrl('r'),
        plain('Esc'),
        ch('a'),
        ch('<'),
        ch('<'),
        ch('x'),
        ch('>'),
    ]);
    assert.deepEqual(parseKeys('<M-BS><C-[>'), [alt('Backspace'), plain('Esc')]);
});

function done(s: string) {
    const r = parse(parseKeys(s), false);
    if (typeof r !== 'object') assert.fail(`${s}: ${r}`);
    return r.done;
}

test('counts multiply', () => {
    const c = done('2d3w');
    assert.equal(c.count, 6);
    assert.deepEqual(c.action, {
        t: 'Operate',
        op: 'Delete',
        target: { t: 'Motion', m: { t: 'WordForward', big: false } },
    });
});

test('registers and text objects', () => {
    const c = done('"ayi(');
    assert.equal(c.register, 'a');
    assert.deepEqual(c.action, {
        t: 'Operate',
        op: 'Yank',
        target: { t: 'Object', obj: { t: 'Pair', open: '(', close: ')' }, around: false },
    });
});

test('incomplete and invalid commands', () => {
    assert.equal(parse(parseKeys('d'), false), 'Incomplete');
    assert.equal(parse(parseKeys('2'), false), 'Incomplete');
    assert.equal(parse(parseKeys('g'), false), 'Incomplete');
    assert.equal(parse(parseKeys('dQ'), false), 'Invalid');
});

test('g operators double', () => {
    assert.deepEqual(done('gUU').action, { t: 'Operate', op: 'Uppercase', target: { t: 'Line' } });
    assert.deepEqual(done('gUgU').action, { t: 'Operate', op: 'Uppercase', target: { t: 'Line' } });
    assert.deepEqual(done('gUgg').action, {
        t: 'Operate',
        op: 'Uppercase',
        target: { t: 'Motion', m: { t: 'FileStart' } },
    });
});

test('translates magic patterns', () => {
    assert.equal(translate('\\(a\\|b\\)+')[0], '(a|b)\\+');
    assert.equal(translate('a\\{2,3}')[0], 'a{2,3}');
    assert.equal(translate('\\v(a|b)+')[0], '(a|b)+');
    assert.equal(translate('foo\\c')[1], true);
    const re = compile('\\<foo\\>', false, false);
    assert.deepEqual(lineMatches(re, Array.from('foo foobar éfoo foo')), [
        [0, 3],
        [16, 19],
    ]);
});

test('smartcase', () => {
    assert.ok(compile('foo', true, true).flags.includes('i'));
    assert.ok(!compile('Foo', true, true).flags.includes('i'));
    assert.ok(!compile('Foo\\C', true, false).flags.includes('i'));
});

test('finds with wrap', () => {
    const buf = Buffer.fromText('foo\nbar\nfoo');
    const re = compile('foo', false, false);
    assert.deepEqual(find(buf, re, pos(0, 0), true), [pos(2, 0), false]);
    assert.deepEqual(find(buf, re, pos(2, 0), true), [pos(0, 0), true]);
    assert.deepEqual(find(buf, re, pos(2, 0), false), [pos(0, 0), false]);
    assert.deepEqual(find(buf, re, pos(0, 0), false), [pos(2, 0), true]);
});

test('match columns are code points', () => {
    const re = compile('b', false, false);
    assert.deepEqual(lineMatches(re, Array.from('😀ab')), [[2, 3]]);
});

test('substitution replacements', () => {
    const re = compile('\\(a\\)\\(b\\)', false, false);
    assert.deepEqual(substituteLine(re, 'xab ab', '<\\2\\1>&$', false), ['x<ba>ab$ ab', 1]);
    assert.deepEqual(substituteLine(re, 'xab ab', '-', true), ['x- -', 2]);
    assert.deepEqual(substituteLine(compile('$', false, false), 'a', '!', true), ['a!', 1]);
});
