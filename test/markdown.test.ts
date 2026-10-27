// Unit tests for Markdown's rendered view: laying out blocks as rows, and
// scrolling.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Buffer } from '../src/editor/buffer';
import { MarkdownView, MdRow, renderMarkdown } from '../src/markdown';
import { theme } from '../src/theme';

/** Each row as text: indented, quotes as `>`, rules as `---`. */
function shown(rows: readonly MdRow[]): string[] {
    return rows.map((r) => {
        const text = r.kind === 'rule' ? '---' : r.runs.map(([s]) => s).join('');
        return ('> '.repeat(r.quote) + ' '.repeat(r.indent) + text).trimEnd();
    });
}

test('rendered Markdown drops markup and joins paragraph lines', () => {
    const rows = renderMarkdown(
        [
            '# Head `code`',
            '',
            'one **two**',
            'three [link](http://x.io) ![pic](p.png)',
            '',
            '***',
            '',
            '<!-- hidden',
            'still -->',
            'after\\',
            'break',
            '',
            '[ref]: http://x.io',
        ],
        80,
    );
    assert.deepEqual(shown(rows), ['Head code', '---', '', 'one two three link ▣ pic', '', '---', '', 'after', 'break']);
    const two = rows[3].runs.find(([s]) => s === 'two');
    assert.deepEqual(two?.slice(2), ['bold']);
});

test('rendered Markdown keeps source lines for each row', () => {
    const rows = renderMarkdown(['a', 'b', '', '## c', 'd'], 80);
    assert.deepEqual(
        rows.map((r) => r.source),
        [0, 2, 3, 3, 4],
    );
});

test('paragraphs and list items wrap, items hanging under their bullets', () => {
    const rows = renderMarkdown(['- first item that is long enough to wrap', '  - nested', '1. one', '- [x] done', '', 'text'], 20);
    assert.deepEqual(shown(rows), ['• first item that is', '  long enough to', '  wrap', '  ◦ nested', '1. one', '☑ done', '', 'text']);
});

test('setext headings and block quotes', () => {
    const rows = renderMarkdown(['Title', '=====', '', '> quoted', '> more', '>', '> > deeper', '', 'out'], 80);
    assert.deepEqual(shown(rows), ['Title', '---', '', '> quoted more', '>', '> > deeper', '', 'out']);
});

test('code blocks keep their text and are highlighted', () => {
    const rows = renderMarkdown(['```rust', 'fn main() {', '    x', '```', 'after', '', '    indented'], 80);
    assert.deepEqual(shown(rows), ['fn main() {', '    x', 'after', '', 'indented']);
    assert.deepEqual(
        rows.map((r) => [r.kind, r.source]),
        [
            ['code', 1],
            ['code', 2],
            [undefined, 4],
            [undefined, 5],
            ['code', 6],
        ],
    );
    assert.deepEqual(rows[0].runs[0], ['fn', theme.KEYWORD]);
});

test('tables are aligned, and wrap to fit', () => {
    assert.deepEqual(shown(renderMarkdown(['| a | bb |', '|:-|-:|', '| `ccc` | d |'], 80)), [
        '┌─────┬────┐',
        '│ a   │ bb │',
        '├─────┼────┤',
        '│ ccc │  d │',
        '└─────┴────┘',
    ]);
    const narrow = shown(renderMarkdown(['| k | v |', '|---|---|', '| key | a long value that wraps |'], 22));
    assert.deepEqual(narrow, [
        '┌─────┬──────────────┐',
        '│ k   │ v            │',
        '├─────┼──────────────┤',
        '│ key │ a long value │',
        '│     │ that wraps   │',
        '└─────┴──────────────┘',
    ]);
});

test('the view scrolls in rows and finds its source line', () => {
    const buffer = Buffer.fromText(Array.from({ length: 30 }, (_, i) => `# Heading ${i}`).join('\n'));
    const view = new MarkdownView();
    const rows = view.rows(buffer, 40);
    assert.equal(view.rows(buffer, 40), rows, 'laid out once per version');
    view.showSource(rows, 10, 7);
    assert.equal(view.sourceAtTop(rows), 7);
    view.scrollBy(rows, 10, 1000);
    assert.equal(view.top, rows.length - 10, 'stops with a screen full');
    view.scrollBy(rows, 10, -1000);
    assert.equal(view.top, 0);
});
