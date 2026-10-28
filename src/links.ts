// Links between Markdown files, as Obsidian follows them: `[[note]]`,
// `[[note#heading|shown]]`, `[text](other.md#heading)`, and URLs. The
// working directory is the vault: a wikilink names a note anywhere in it.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { markdownInline } from './highlight';

export type Link =
    /** A web page (or `mailto:` and the like), for the system to open. */
    | { t: 'Url'; url: string }
    /** A file, or a place in this one when `path` is empty: a heading, or a
     * block (`^id`). */
    | { t: 'File'; path: string; anchor?: string; wiki: boolean };

/** What a link's target (an `href` from `highlight.markdownInline`) is. */
export function parseHref(href: string): Link | undefined {
    const wiki = href.startsWith('[[') && href.endsWith(']]');
    let target = wiki ? href.slice(2, -2).trim() : href;
    // A scheme (`https:`, `mailto:`), but not a Windows drive (`C:`).
    if (!wiki && /^[a-z][a-z\d+.-]+:/i.test(target)) return { t: 'Url', url: target };
    if (!wiki) {
        try {
            target = decodeURI(target);
        } catch {
            // A stray `%`: take the link as written.
        }
    }
    const at = target.indexOf('#');
    const file = (at === -1 ? target : target.slice(0, at)).trim();
    const anchor = at === -1 ? undefined : target.slice(at + 1).trim();
    if (file === '' && !anchor) return undefined;
    return anchor ? { t: 'File', path: file, anchor, wiki } : { t: 'File', path: file, wiki };
}

/** The link at character `col` of a Markdown line, if any. */
export function linkAt(line: readonly string[], col: number): Link | undefined {
    const span = markdownInline(line).find((s) => s.href !== undefined && s.start <= col && col < s.end);
    return span?.href === undefined ? undefined : parseHref(span.href);
}

/** Where a link to `target` from the file `from` goes, in the vault `root`:
 * the file it names, or where a new note of that name would go (beside
 * `from`), with whether it exists. A name without an extension is a note
 * (`.md`). Like Obsidian, a name is looked for beside `from`, then from the
 * vault's top, then anywhere in the vault, nearest `from` first. */
export function resolveLink(target: string, from: string | undefined, root: string, files = () => vaultFiles(root)): { file: string; exists: boolean } {
    const dir = from === undefined ? root : path.dirname(from);
    const names = path.extname(target) === '' ? [`${target}.md`] : [target, `${target}.md`];
    const bases = target.startsWith('/') ? [root] : [dir, root];
    for (const base of bases) {
        for (const name of names) {
            const file = path.join(base, name);
            if (isFile(file)) return { file, exists: true };
        }
    }
    // Anywhere in the vault: files whose path ends with the name.
    const wanted = names.map((n) => path.normalize(n).replace(/^[/\\]+/, '').toLowerCase());
    const found = files().filter((f) => {
        const rel = path.relative(root, f).toLowerCase();
        return wanted.some((w) => rel === w || rel.endsWith(path.sep + w));
    });
    if (found.length > 0) {
        const distance = (f: string): number => path.relative(dir, f).split(path.sep).length;
        found.sort((a, b) => distance(a) - distance(b) || a.length - b.length || a.localeCompare(b));
        return { file: found[0], exists: true };
    }
    return { file: path.join(target.startsWith('/') ? root : dir, names[names.length - 1]), exists: false };
}

/** Files under `root`, leaving out hidden ones and `node_modules`; at most
 * `limit` of them. */
export function vaultFiles(root: string, limit = 20000): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            if (out.length >= limit) return;
            if (e.name.startsWith('.') || e.name === 'node_modules') continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.isFile()) out.push(p);
        }
    };
    walk(root);
    return out;
}

function isFile(p: string): boolean {
    try {
        return fs.statSync(p).isFile();
    } catch {
        return false;
    }
}

/** The line an anchor names in Markdown `lines`: a block's (`^id`, which
 * ends its line), or a heading's. A heading matches by its text, ignoring
 * case and markup, or by its slug (`#my-heading`, as other Markdown links
 * have it); in `a#b`, the last heading is the one. */
export function anchorLine(lines: readonly string[], anchor: string): number | undefined {
    const parts = anchor.split('#').filter((s) => s.trim() !== '');
    const last = parts[parts.length - 1]?.trim();
    if (last === undefined) return undefined;
    if (last.startsWith('^')) {
        const block = new RegExp(`(^|\\s)${last.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\s*$`);
        const at = lines.findIndex((l) => block.test(l));
        return at === -1 ? undefined : at;
    }
    const want = headingText(last);
    const slug = slugify(last);
    let fence: string | undefined;
    for (let i = 0; i < lines.length; i++) {
        const f = /^\s*(`{3,}|~{3,})/.exec(lines[i]);
        if (f && (fence === undefined || f[1][0] === fence[0])) {
            fence = fence === undefined ? f[1] : undefined;
            continue;
        }
        if (fence !== undefined) continue;
        const h = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(lines[i]);
        const setext = i + 1 < lines.length && /^ {0,3}(=+|-+)\s*$/.test(lines[i + 1]) && lines[i].trim() !== '' ? lines[i] : undefined;
        const text = h?.[1] ?? setext;
        if (text !== undefined && (headingText(text) === want || slugify(text) === slug)) return i;
    }
    return undefined;
}

/** A heading's words: markup and case dropped, spaces collapsed. */
function headingText(s: string): string {
    const chars = Array.from(s);
    const shown = markdownInline(chars)
        .map((span) => span.shown ?? chars.slice(span.start, span.end).join(''))
        .join('');
    return shown.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** A heading's anchor as GitHub makes it: lower case, punctuation dropped,
 * spaces as `-`. */
function slugify(s: string): string {
    return headingText(s)
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .replace(/\s/g, '-');
}
