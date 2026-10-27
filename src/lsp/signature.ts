// Signature help while typing a call's arguments in Insert mode: the
// function's signature above the cursor, the current parameter picked out,
// with its documentation. It opens on the server's trigger characters (`(`
// and `,` usually) and follows the typing until the call is closed.

import type { Editor } from '../editor/editor';
import { KeyInput, charOf } from '../editor/keys';
import { Float, Run } from '../popup';
import { theme } from '../theme';
import { LanguageClient } from './client';
import type { Before } from './completion';
import { LspManager } from './manager';
import { markdownLines } from './markdown';
import { isStale } from './rpc';
import { toPosition, uriFromPath } from './text';
import { MarkupContent, SignatureHelp as Help } from './types';

/** How long typing must pause before asking the server, in ms. */
const DEBOUNCE = 30;
/** Lines of parameter documentation shown. */
const DOC_LINES = 4;

export class SignatureHelp {
    /** What to show, while a call's signature is known. */
    float: Float | undefined;
    /** The last answer, which the server may want back to stay on the same
     * signature. */
    private help: Help | undefined;
    private line = 0;
    private timer: NodeJS.Timeout | undefined;
    /** Identifies the latest request; older answers are dropped. */
    private seq = 0;

    constructor(
        private readonly ed: Editor,
        private readonly lsp: LspManager,
        private readonly refresh: () => void,
    ) {}

    close(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        this.seq++;
        this.float = undefined;
        this.help = undefined;
    }

    private client(): LanguageClient | undefined {
        const client = this.lsp.clientFor(this.ed.filePath);
        return client?.capabilities.signatureHelpProvider ? client : undefined;
    }

    /** After the editor handled a key in Insert mode: open on a trigger
     * character, and follow the typing while open. */
    afterKey(key: KeyInput, before: Before): void {
        const ed = this.ed;
        if (ed.mode !== 'Insert' || ed.bufferId() !== before.bufferId) {
            this.close();
            return;
        }
        const client = this.client();
        if (!client) return;
        if (this.help && ed.cursor.line !== this.line) this.close();
        const provider = client.capabilities.signatureHelpProvider!;
        const typed = key.ctrl || key.alt ? undefined : charOf(key);
        const open = this.help !== undefined;
        if (typed !== undefined && (provider.triggerCharacters ?? []).includes(typed)) {
            this.request(client, typed);
        } else if (open && typed !== undefined && (provider.retriggerCharacters ?? []).includes(typed)) {
            this.request(client, typed);
        } else if (open) {
            this.request(client, undefined);
        }
    }

    /** Ask now, as if `character` had been typed (after completion adds
     * `()`). */
    trigger(character: string): void {
        const client = this.client();
        if (client && this.ed.mode === 'Insert') this.request(client, character);
    }

    private request(client: LanguageClient, character: string | undefined): void {
        const ed = this.ed;
        const file = ed.filePath;
        if (file === undefined) return;
        if (this.timer) clearTimeout(this.timer);
        const seq = ++this.seq;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.lsp.sync();
            const bufferId = ed.bufferId();
            const line = ed.cursor.line;
            const retrigger = this.help !== undefined;
            // Typing may have gone on past the trigger character, which servers
            // then ignore: ask as if invoked instead.
            const typed = character !== undefined && ed.buffer.charAt({ line, col: ed.cursor.col - 1 }) === character;
            const context = typed
                ? { triggerKind: 2, triggerCharacter: character, isRetrigger: retrigger, activeSignatureHelp: this.help }
                : { triggerKind: retrigger ? 3 : 1, isRetrigger: retrigger, activeSignatureHelp: this.help };
            client
                .request<Help | null>('textDocument/signatureHelp', {
                    textDocument: { uri: uriFromPath(file) },
                    position: toPosition(ed.buffer, ed.cursor, client.encoding),
                    context,
                })
                .then((help) => {
                    if (seq !== this.seq || ed.mode !== 'Insert' || ed.bufferId() !== bufferId || ed.cursor.line !== line) return;
                    if (!help || help.signatures.length === 0) {
                        this.close();
                    } else {
                        this.help = help;
                        this.line = line;
                        this.float = new Float(signatureLines(help), ed.cursor, bufferId);
                        this.float.above = true;
                    }
                    this.refresh();
                })
                .catch((e: unknown) => {
                    if (!isStale(e)) process.stderr.write(`wim: signature help: ${(e as Error).message}\n`);
                });
        }, DEBOUNCE);
    }
}

/** Documentation as Markdown (plain text has its markup characters
 * escaped). */
function documentation(doc: string | MarkupContent | undefined): string {
    if (doc === undefined) return '';
    if (typeof doc !== 'string' && doc.kind === 'markdown') return doc.value;
    return (typeof doc === 'string' ? doc : doc.value).replace(/[\\`*_[\]#]/g, '\\$&');
}

/** The active signature with its active parameter highlighted, then that
 * parameter's documentation. */
export function signatureLines(help: Help): Run[][] {
    const index = Math.min(Math.max(help.activeSignature ?? 0, 0), help.signatures.length - 1);
    const sig = help.signatures[index];
    const label = sig.label;
    const active = sig.activeParameter ?? help.activeParameter ?? 0;
    const param = sig.parameters?.[active];
    let start = -1;
    let end = -1;
    if (param) {
        if (typeof param.label === 'string') {
            start = label.indexOf(param.label);
            end = start < 0 ? -1 : start + param.label.length;
        } else {
            [start, end] = param.label;
        }
    }
    const first: Run[] =
        start >= 0 && end > start
            ? [
                  [label.slice(0, start), theme.FG],
                  [label.slice(start, end), theme.TYPE],
                  [label.slice(end), theme.FG],
              ]
            : [[label, theme.FG]];
    if (help.signatures.length > 1) first.push([`  (${index + 1}/${help.signatures.length})`, theme.COMMENT]);
    const lines: Run[][] = [first.filter(([s]) => s !== '')];
    const doc = markdownLines(documentation(param?.documentation)).slice(0, DOC_LINES);
    if (doc.length > 0) lines.push(...doc.map((l) => l.map(([s]): Run => [s, theme.COMMENT])));
    return lines;
}
