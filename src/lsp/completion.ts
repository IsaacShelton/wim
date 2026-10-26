// Completion as you type in Insert mode, set up like the Neovim config's
// nvim-cmp: no item is preselected, <Tab>/<S-Tab> select (putting the item's
// word in the text), <C-l> or <C-Space> confirm, <C-e> closes. Fields sort
// first and snippets last.

import { Pos, pos } from '../editor/buffer';
import type { Editor } from '../editor/editor';
import { KeyInput, charOf } from '../editor/keys';
import { fuzzyScore } from '../fuzzy';
import { CompletionMenu, MenuEntry, scrollMenu } from '../popup';
import { LanguageClient } from './client';
import { LspManager } from './manager';
import { isStale } from './rpc';
import { fromPosition, snippetText, toPosition, uriFromPath } from './text';
import {
    COMPLETION_KINDS,
    CompletionItem,
    CompletionItemKind,
    CompletionList,
    InsertTextFormat,
    TextEdit,
} from './types';

/** How long typing must pause before asking the server, in ms. */
const DEBOUNCE = 30;

interface Candidate {
    item: CompletionItem;
    /** Where the text this item replaces starts. Most items replace the word
     * at the cursor, but some replace more (`.x` with `[Symbol.x]`). */
    start: number;
}

interface Entry extends MenuEntry, Candidate {
    score: number;
}

/** Where completion is happening. */
interface Session {
    client: LanguageClient;
    bufferId: number;
    line: number;
    /** Where the word being completed starts. */
    startCol: number;
    candidates: Candidate[];
    /** The server needs asking again as the word changes. */
    incomplete: boolean;
}

/** What the editor looked like before a key, to see what the key did. */
export interface Before {
    bufferId: number;
    version: number;
    mode: string;
}

function isWordChar(c: string | undefined): boolean {
    return c !== undefined && /^[\p{L}\p{N}_$]$/u.test(c);
}

export class Completion implements CompletionMenu {
    items: Entry[] = [];
    selected = -1;
    scroll = 0;
    private session: Session | undefined;
    /** The line as typed and the cursor's column in it, while selecting puts
     * items' words in it. */
    private typed: { line: string[]; col: number } | undefined;
    private timer: NodeJS.Timeout | undefined;
    /** Identifies the latest request; older answers are dropped. */
    private seq = 0;

    constructor(
        private readonly ed: Editor,
        private readonly lsp: LspManager,
        private readonly refresh: () => void,
    ) {}

    get visible(): boolean {
        return this.items.length > 0 && this.ed.mode === 'Insert';
    }

    /** Where the menu goes: the start of the word being completed. */
    anchor(): Pos | undefined {
        return this.session && pos(this.session.line, this.session.startCol);
    }

    close(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        this.seq++;
        this.session = undefined;
        this.items = [];
        this.selected = -1;
        this.scroll = 0;
        this.typed = undefined;
    }

    snapshot(): Before {
        return { bufferId: this.ed.bufferId(), version: this.ed.buffer.version(), mode: this.ed.mode };
    }

    /** Keys for the menu, before the editor sees them. Returns whether the
     * key was used. */
    key(key: KeyInput): boolean {
        if (this.ed.mode !== 'Insert') return false;
        if (key.ctrl && key.key === ' ' && !this.visible) {
            this.request(undefined);
            return true;
        }
        if (!this.visible) return false;
        if (key.key === 'Tab' || (key.ctrl && key.key === 'n')) this.select(1);
        else if (key.key === 'BackTab' || (key.ctrl && key.key === 'p')) this.select(-1);
        else if (key.ctrl && (key.key === 'l' || key.key === ' ')) this.confirm();
        else if (key.ctrl && key.key === 'e') this.close();
        else return false;
        return true;
    }

    /** After the editor handled a key: follow the typing. */
    afterKey(key: KeyInput, before: Before): void {
        const ed = this.ed;
        if (ed.mode !== 'Insert' || before.mode !== 'Insert' || ed.bufferId() !== before.bufferId) {
            this.close();
            return;
        }
        const s = this.session;
        if (s && (ed.cursor.line !== s.line || ed.cursor.col < s.startCol)) this.close();
        if (ed.buffer.version() === before.version) {
            // The cursor moved without typing.
            if (key.key !== 'Esc') this.close();
            return;
        }
        this.typed = undefined;
        this.selected = -1;
        const typed = key.ctrl || key.alt ? undefined : charOf(key);
        const client = this.lsp.clientFor(ed.filePath);
        const triggers = client?.capabilities.completionProvider?.triggerCharacters ?? [];
        if (typed !== undefined && triggers.includes(typed)) {
            this.close();
            this.request(typed);
        } else if (typed !== undefined && isWordChar(typed)) {
            if (this.session && !this.session.incomplete) this.filter();
            else this.request(undefined);
        } else if (key.key === 'Backspace' && this.session) {
            if (this.session.incomplete) this.request(undefined);
            else this.filter();
        } else {
            this.close();
        }
    }

    private wordStart(): number {
        const line = this.ed.buffer.line(this.ed.cursor.line);
        let col = this.ed.cursor.col;
        while (col > 0 && isWordChar(line[col - 1])) col--;
        return col;
    }

    /** Ask the server for completions at the cursor (soon). */
    private request(triggerCharacter: string | undefined): void {
        const ed = this.ed;
        const client = this.lsp.clientFor(ed.filePath);
        // A server still starting is asked once it is ready.
        if (!client || (client.state === 'running' && !client.supports('completionProvider')) || ed.filePath === undefined) {
            return;
        }
        if (this.timer) clearTimeout(this.timer);
        const seq = ++this.seq;
        const file = ed.filePath;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.lsp.sync();
            const bufferId = ed.bufferId();
            const line = ed.cursor.line;
            const context = triggerCharacter !== undefined ? { triggerKind: 2, triggerCharacter } : { triggerKind: 1 };
            client
                .request<CompletionList | CompletionItem[] | null>('textDocument/completion', {
                    textDocument: { uri: uriFromPath(file) },
                    position: toPosition(ed.buffer, ed.cursor, client.encoding),
                    context,
                })
                .then((result) => {
                    if (seq !== this.seq || ed.mode !== 'Insert' || ed.bufferId() !== bufferId || ed.cursor.line !== line) return;
                    const items = Array.isArray(result) ? result : (result?.items ?? []);
                    const incomplete = !Array.isArray(result) && Boolean(result?.isIncomplete);
                    const startCol = this.wordStart();
                    const candidates = items.map((item) => ({ item, start: this.itemStart(client, item, startCol) }));
                    this.session = { client, bufferId, line, startCol, candidates, incomplete };
                    this.filter();
                    this.refresh();
                })
                .catch((e: unknown) => {
                    if (!isStale(e) && client.supports('completionProvider')) process.stderr.write(`wim: completion: ${(e as Error).message}\n`);
                });
        }, DEBOUNCE);
    }

    /** Where the text an item replaces starts: where its edit says, or the
     * start of the word. */
    private itemStart(client: LanguageClient, item: CompletionItem, wordStart: number): number {
        const edit = item.textEdit;
        const range = edit && ('range' in edit ? edit.range : edit.insert);
        if (range && range.start.line === this.ed.cursor.line) {
            const col = fromPosition(this.ed.buffer, range.start, client.encoding).col;
            if (col <= this.ed.cursor.col) return col;
        }
        return wordStart;
    }

    private filter(): void {
        const s = this.session;
        if (!s) return;
        const line = this.ed.buffer.line(s.line);
        const entries: Entry[] = [];
        for (const c of s.candidates) {
            const word = line.slice(c.start, this.ed.cursor.col).join('');
            const score = fuzzyScore(word, c.item.filterText ?? c.item.label);
            if (score === undefined) continue;
            const detail = c.item.labelDetails?.detail ?? '';
            entries.push({ ...c, score, label: c.item.label + detail, kind: COMPLETION_KINDS[c.item.kind ?? 1] ?? 'Text' });
        }
        const word = line.slice(s.startCol, this.ed.cursor.col).join('');
        const rank = (e: Entry): number =>
            e.item.kind === CompletionItemKind.Field ? 0 : e.item.kind === CompletionItemKind.Snippet ? 2 : 1;
        entries.sort((a, b) => {
            const r = rank(a) - rank(b);
            if (r !== 0) return r;
            if (word !== '' && a.score !== b.score) return b.score - a.score;
            const ka = a.item.sortText ?? a.item.label;
            const kb = b.item.sortText ?? b.item.label;
            return ka < kb ? -1 : ka > kb ? 1 : 0;
        });
        this.items = entries;
        this.selected = -1;
        this.scroll = 0;
    }

    /** The text an item puts in place of the word. */
    private static insertion(item: CompletionItem): { text: string; cursor: number } {
        const text = item.textEdit?.newText ?? item.insertText ?? item.label;
        if (item.insertTextFormat === InsertTextFormat.Snippet) return snippetText(text);
        return { text, cursor: Array.from(text).length };
    }

    /** Replace the text from `start` to the cursor with `text`, leaving the
     * cursor `cursor` code points into it. */
    private replaceWord(start: number, text: string, cursor: number): void {
        const ed = this.ed;
        const line = ed.cursor.line;
        ed.buffer.deleteRange(pos(line, start), ed.cursor);
        ed.buffer.insertText(pos(line, start), text);
        const before = Array.from(text).slice(0, cursor).join('').split('\n');
        const last = Array.from(before[before.length - 1]).length;
        ed.cursor = before.length === 1 ? pos(line, start + last) : pos(line + before.length - 1, last);
        ed.updateWantCol();
    }

    /** Put the line back as it was typed, before selecting changed it. */
    private restoreTyped(): void {
        const t = this.typed;
        if (!t) return;
        this.ed.buffer.replaceLine(this.session!.line, t.line.slice());
        this.ed.cursor = pos(this.session!.line, t.col);
    }

    /** Move the selection, putting the selected item's word in the text (or
     * the typed word back, past either end). */
    private select(delta: number): void {
        const n = this.items.length;
        this.typed ??= { line: this.ed.buffer.line(this.session!.line).slice(), col: this.ed.cursor.col };
        // -1 is "nothing selected", between the last item and the first.
        this.selected = ((((this.selected + 1 + delta) % (n + 1)) + n + 1) % (n + 1)) - 1;
        scrollMenu(this);
        this.restoreTyped();
        const entry = this.items[this.selected];
        if (entry) {
            const word = Completion.insertion(entry.item).text.split('\n')[0];
            this.replaceWord(entry.start, word, Array.from(word).length);
        }
        this.ed.updateWantCol();
    }

    /** Accept the selected item, or the first. */
    private confirm(): void {
        const s = this.session!;
        const entry = this.items[Math.max(this.selected, 0)];
        this.restoreTyped();
        this.close();
        if (!entry) return;
        const item = entry.item;
        const { text, cursor } = Completion.insertion(item);
        this.replaceWord(entry.start, text, cursor);
        this.addParens(item, text);
        // Auto-imports and the like, often only known once resolved.
        const resolve = s.client.capabilities.completionProvider?.resolveProvider;
        if (item.additionalTextEdits?.length || !resolve) {
            this.applyAdditional(s, item.additionalTextEdits);
            return;
        }
        s.client
            .request<CompletionItem>('completionItem/resolve', item)
            .then((resolved) => {
                this.applyAdditional(s, resolved.additionalTextEdits);
                this.refresh();
            })
            .catch(() => {});
    }

    /** After a function or method, add `()` with the cursor inside, as
     * nvim-autopairs does on nvim-cmp's `confirm_done`. */
    private addParens(item: CompletionItem, text: string): void {
        const ed = this.ed;
        const kind = item.kind;
        if (!ed.options.autopairs || (kind !== CompletionItemKind.Function && kind !== CompletionItemKind.Method)) return;
        if (text.includes('(') || ed.buffer.charAt(ed.cursor) === '(') return;
        ed.buffer.insertText(ed.cursor, '()');
        ed.cursor = pos(ed.cursor.line, ed.cursor.col + 1);
        ed.updateWantCol();
    }

    private applyAdditional(s: Session, edits: TextEdit[] | undefined): void {
        if (edits?.length) this.lsp.applyEdits(s.client, s.bufferId, edits);
    }
}
