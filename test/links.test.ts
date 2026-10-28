// Unit tests for links between Markdown files (what they point at, and
// which file and line that is), and for links, images and diagrams in the
// rendered view.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { anchorLine, linkAt, parseHref, resolveLink } from '../src/links';
import { MdRow, MediaHost, diagramId, renderMarkdown } from '../src/markdown';
import { theme } from '../src/theme';

const chars = (s: string): string[] => Array.from(s);

function text(row: MdRow): string {
    return row.runs.map(([s]) => s).join('');
}

/** Each of a row's links as the text it covers, and where it goes. */
function links(row: MdRow): [string, string][] {
    const t = chars(text(row));
    return (row.links ?? []).map((l) => [t.slice(l.from, l.to).join(''), l.href]);
}

test('wikilinks show their note, heading or alias, and keep where they go', () => {
    const rows = renderMarkdown(['See [[Other Note]], [[b/Note#Part|alias]], [[#Head]] and [[N#H#Sub]].'], 80);
    assert.equal(text(rows[0]), 'See Other Note, alias, Head and N > H > Sub.');
    assert.deepEqual(links(rows[0]), [
        ['Other Note', '[[Other Note]]'],
        ['alias', '[[b/Note#Part]]'],
        ['Head', '[[#Head]]'],
        ['N > H > Sub', '[[N#H#Sub]]'],
    ]);
});

test('links keep their place in wrapped, listed and table rows', () => {
    const rows = renderMarkdown(['- some words then [a link](other%20file.md#x "title") and <https://x.io>'], 23);
    assert.deepEqual(rows.map(text), ['• some words then a', 'link and https://x.io']);
    assert.deepEqual(links(rows[0]), [['a', 'other%20file.md#x']]);
    assert.deepEqual(links(rows[1]), [
        ['link', 'other%20file.md#x'],
        ['https://x.io', 'https://x.io'],
    ]);
    const table = renderMarkdown(['| k | value |', '|---|:-:|', '| [[a\\|A]] | [b](b.md) |'], 80);
    assert.equal(text(table[3]), '│ A │   b   │');
    assert.deepEqual(links(table[3]), [
        ['A', '[[a]]'],
        ['b', 'b.md'],
    ]);
});

test('the link under a column of a source line', () => {
    const line = chars('a [[Note#Head|x]] b [c](d.md) https://e.io');
    assert.equal(linkAt(line, 0), undefined);
    assert.deepEqual(linkAt(line, 2), { t: 'File', path: 'Note', anchor: 'Head', wiki: true });
    assert.deepEqual(linkAt(line, 15), { t: 'File', path: 'Note', anchor: 'Head', wiki: true });
    assert.deepEqual(linkAt(line, 21), { t: 'File', path: 'd.md', wiki: false });
    assert.deepEqual(linkAt(line, 32), { t: 'Url', url: 'https://e.io' });
    assert.equal(linkAt(chars('`[[not]]`'), 3), undefined, 'not in code');
    assert.deepEqual(parseHref('my%20note.md'), { t: 'File', path: 'my note.md', wiki: false });
    assert.deepEqual(parseHref('#^block'), { t: 'File', path: '', anchor: '^block', wiki: false });
    assert.deepEqual(parseHref('mailto:a@b.c'), { t: 'Url', url: 'mailto:a@b.c' });
});

test('links resolve beside the note, from the vault top, then by name nearest first', () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wim-links-')));
    try {
        for (const f of ['a/here.md', 'a/b/deep.md', 'top.md', 'x/y/deep.md', 'a/dup.md', 'z/dup.md', 'img/pic.png']) {
            fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
            fs.writeFileSync(path.join(root, f), '');
        }
        const from = path.join(root, 'a', 'here.md');
        const at = (target: string) => resolveLink(target, from, root);
        assert.deepEqual(at('here'), { file: path.join(root, 'a/here.md'), exists: true });
        assert.deepEqual(at('top'), { file: path.join(root, 'top.md'), exists: true });
        assert.deepEqual(at('deep'), { file: path.join(root, 'a/b/deep.md'), exists: true }, 'the nearest');
        assert.deepEqual(at('y/deep'), { file: path.join(root, 'x/y/deep.md'), exists: true });
        assert.deepEqual(at('dup'), { file: path.join(root, 'a/dup.md'), exists: true });
        assert.deepEqual(at('pic.png'), { file: path.join(root, 'img/pic.png'), exists: true });
        assert.deepEqual(at('../top.md'), { file: path.join(root, 'top.md'), exists: true });
        assert.deepEqual(at('New Note'), { file: path.join(root, 'a/New Note.md'), exists: false });
    } finally {
        fs.rmSync(root, { recursive: true });
    }
});

test('anchors find headings by text or slug, and blocks by id', () => {
    const lines = ['# Top', '```', '## Fake', '```', '## The **Big** Part', 'text ^abc-1', 'Setext', '---'];
    assert.equal(anchorLine(lines, 'Top'), 0);
    assert.equal(anchorLine(lines, 'the big part'), 4);
    assert.equal(anchorLine(lines, 'the-big-part'), 4);
    assert.equal(anchorLine(lines, 'Top#The Big Part'), 4);
    assert.equal(anchorLine(lines, 'Fake'), undefined, 'not in code');
    assert.equal(anchorLine(lines, '^abc-1'), 5);
    assert.equal(anchorLine(lines, 'Setext'), 6);
});

/** A host with one 400×100 image, `pic.png`, and the given diagram sizes. */
function host(diagrams: Record<string, { width: number; height: number } | { error: string }> = {}): MediaHost {
    return {
        key: '',
        charW: 10,
        lineH: 20,
        maxHeight: 1000,
        image: (href) => (href === 'pic.png' || href === '[[pic.png]]' ? { file: '/v/pic.png', src: '/media?p=pic', width: 400, height: 100 } : undefined),
        diagram: (id) => diagrams[id],
    };
}

test('a line of images shows them, sized to fit', () => {
    const lines = ['before', '![a](pic.png) ![[pic.png|200]]', 'after ![a](pic.png)', '![a](missing.png)'];
    assert.deepEqual(renderMarkdown(lines, 80).map(text), ['before ▣ a ▣ pic.png after ▣ a ▣ a'], 'without a host, as names');
    const rows = renderMarkdown(lines, 30, host());
    assert.deepEqual(
        rows.map((r) => [r.kind, r.media?.width, r.media?.height]),
        [
            [undefined, undefined, undefined],
            // 400 wide in 300 pixels: shrunk to 300×75, four rows.
            ['media', 300, 75],
            ['media', undefined, undefined],
            ['media', undefined, undefined],
            ['media', undefined, undefined],
            // 200 wide, as asked: 200×50, three rows.
            ['media', 200, 50],
            ['media', undefined, undefined],
            ['media', undefined, undefined],
            [undefined, undefined, undefined],
        ],
    );
    assert.equal(rows[1].media?.t === 'Image' && rows[1].media.file, '/v/pic.png');
    assert.deepEqual(rows.slice(-1).map(text), ['after ▣ a ▣ a'], 'images in text, or missing, stay names');
});

test('Mermaid blocks become diagrams once the window has sized them', () => {
    const lines = ['```mermaid', 'graph TD', '  A --> B', '```'];
    const id = diagramId('graph TD\n  A --> B');
    assert.deepEqual(renderMarkdown(lines, 80).map((r) => r.kind), ['code', 'code'], 'without a host, as code');
    const waiting = renderMarkdown(lines, 80, host());
    assert.deepEqual(waiting.map(text), ['Drawing the diagram…']);
    assert.deepEqual(waiting[0].media, { t: 'Diagram', id, source: 'graph TD\n  A --> B', width: 0, height: 0 });
    const drawn = renderMarkdown(lines, 80, host({ [id]: { width: 1600, height: 400 } }));
    assert.equal(drawn.length, 10, '800×200 in 80 columns: ten rows');
    assert.deepEqual([drawn[0].media?.width, drawn[0].media?.height], [800, 200]);
    const failed = renderMarkdown(lines, 80, host({ [id]: { error: 'Parse error' } }));
    assert.deepEqual(failed.map(text), ['Mermaid: Parse error', 'graph TD', '  A --> B']);
    assert.equal(failed[0].runs[0][1], theme.ERROR);
});
