// Tests for how wide characters are on the character grid.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { wrapRuns } from '../src/popup';
import { charWidth, cutText, cutTextStart, textWidth } from '../src/textwidth';

test('Chinese and other wide characters take two cells', () => {
    assert.equal(charWidth('a'), 1);
    assert.equal(charWidth('中'), 2);
    assert.equal(charWidth('，'), 2);
    assert.equal(charWidth('あ'), 2);
    assert.equal(charWidth('한'), 2);
    assert.equal(charWidth('😀'), 2);
    assert.equal(charWidth('\ue0b0'), 1, 'Nerd Font icons keep one cell');
    assert.equal(textWidth('a中b'), 4);
});

test('text is cut by cells, not characters, and marked with an ellipsis', () => {
    assert.equal(cutText('abcdef', 4), 'abc…');
    assert.equal(cutText('中文测试', 5), '中文…');
    assert.equal(cutText('中文', 4), '中文');
    assert.equal(cutTextStart('abcdef', 4), '…def');
    assert.equal(cutTextStart('中文测试', 5), '…测试');
});

test('runs wrap by cells, so Chinese text is not crowded', () => {
    const rows = wrapRuns([['中文中文', 'x']], 5);
    assert.deepEqual(
        rows.map((r) => r[0][0]),
        ['中文', '中文'],
    );
});
