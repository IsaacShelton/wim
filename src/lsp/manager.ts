// Connects the editor's buffers to language servers: starts a server for
// each project as its files are opened, keeps the servers' copies of open
// files up to date, collects diagnostics and applies the servers' edits.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { Buffer, Pos, posCmp } from '../editor/buffer';
import {
    backgroundBuffer,
    bufferState,
    bufferStates,
    editBuffer,
    findBuffer,
    writeBuffer,
} from '../editor/buffers';
import type { Editor } from '../editor/editor';
import { Span, Token } from '../highlight';
import { displayName } from '../paths';
import { LanguageClient } from './client';
import { isStale } from './rpc';
import { ServerSpec } from './servers';
import { Encoding, applyTextEdits, fromCharacter, fromRange, pathFromUri, uriFromPath } from './text';
import { CreateFile, DeleteFile, Diagnostic, RenameFile, Severity, TextEdit, WorkspaceEdit } from './types';

export interface LspHost {
    /** Repaint after something changed outside of input handling. */
    refresh: () => void;
}

/** A diagnostic in buffer positions. */
export interface BufferDiagnostic {
    start: Pos;
    end: Pos;
    severity: Severity;
    message: string;
    source?: string;
}

interface Doc {
    path: string;
    uri: string;
    client: LanguageClient;
    /** The version last sent to the server. */
    version: number;
    /** The buffer content last sent, to notice changes. */
    buffer: Buffer;
    bufferVersion: number;
}

interface FileDiagnostics {
    client: LanguageClient;
    diagnostics: Diagnostic[];
    /** Converted for a buffer's content. */
    cache?: { buffer: Buffer; version: number; list: BufferDiagnostic[] };
}

export class LspManager {
    private clients: LanguageClient[] = [];
    private readonly docs = new Map<string, Doc>();
    /** By file path. */
    private readonly diagnostics = new Map<string, FileDiagnostics>();
    /** Files written since the last sync. */
    private readonly saved = new Set<string>();
    /** Semantic token spans by file, then by line, with the line's text they
     * are for. */
    private readonly semantic = new Map<string, Map<number, { text: string; spans: Span[] }>>();
    private readonly semanticTimers = new Map<string, NodeJS.Timeout>();
    /** Files Wim is writing again after formatting them, which shouldn't be
     * formatted again. */
    private readonly formatWrites = new Set<string>();
    /** Format files with their server when they are written (conform.nvim's
     * `format_on_save` with `lsp_fallback`). */
    formatOnSave = true;

    constructor(
        private readonly ed: Editor,
        private readonly specs: readonly ServerSpec[],
        private readonly host: LspHost,
    ) {
        ed.onWrite = (p) => {
            this.saved.add(p);
        };
    }

    // ----- Servers --------------------------------------------------------------------

    private specFor(file: string): [ServerSpec, string] | undefined {
        for (const spec of this.specs) {
            const languageId = spec.languageId(file);
            if (languageId !== undefined) return [spec, languageId];
        }
        return undefined;
    }

    /** The server for `file`, started if needed. */
    private clientForFile(spec: ServerSpec, file: string): LanguageClient {
        // A server already running for a project that contains the file is
        // reused, so a workspace gets one server.
        const running = this.clients
            .filter((c) => c.spec === spec && c.state !== 'stopped' && c.contains(file))
            .sort((a, b) => b.root.length - a.root.length)[0];
        if (running) return running;
        const client = new LanguageClient(spec, spec.root(file), {
            onDiagnostics: (c, uri, diagnostics) => this.setDiagnostics(c, uri, diagnostics),
            onApplyEdit: (c, edit) => this.applyWorkspaceEdit(c, edit),
            onMessage: (text, error) => this.message(text, error),
            onChange: () => this.host.refresh(),
            onSemanticRefresh: (c) => {
                for (const doc of this.docs.values()) if (doc.client === c) this.scheduleSemantic(doc);
            },
        });
        this.clients.push(client);
        return client;
    }

    /** The running (or starting) server for a buffer's file. */
    clientFor(file: string | undefined): LanguageClient | undefined {
        if (file === undefined) return undefined;
        const doc = this.docs.get(file);
        return doc && doc.client.state !== 'failed' && doc.client.state !== 'stopped' ? doc.client : undefined;
    }

    /** Whether a buffer's file is handled by a language server. */
    handles(file: string | undefined): boolean {
        return file !== undefined && this.specFor(file) !== undefined;
    }

    private message(text: string, error: boolean): void {
        if (error) this.ed.setError(text);
        else this.ed.setMessage(text);
        this.host.refresh();
    }

    /** `:LspInfo`. */
    info(): string {
        if (this.clients.length === 0) return 'No language servers are running';
        return this.clients
            .filter((c) => c.state !== 'stopped' || this.clients.length === 1)
            .map((c) => `${c.name} (${c.state}, ${displayName(c.root) || '.'}, ${c.encoding})`)
            .join('   ');
    }

    /** `:LspRestart`: stop every server; they start again for open files. */
    restart(): void {
        for (const c of this.clients) c.stop();
        this.clients = [];
        this.docs.clear();
        this.diagnostics.clear();
        this.semantic.clear();
        this.sync();
    }

    dispose(): void {
        for (const timer of this.semanticTimers.values()) clearTimeout(timer);
        this.semanticTimers.clear();
        for (const c of this.clients) c.kill();
        this.clients = [];
    }

    /** Ongoing server work, for the status line. */
    progressText(): string | undefined {
        for (const c of this.clients) {
            const text = c.progressText();
            if (text) return `${c.name}: ${text}`;
        }
        return undefined;
    }

    // ----- Documents ---------------------------------------------------------------------

    /** Bring the servers' copies of open files up to date. Called before every
     * frame and every request. */
    sync(): void {
        const open = new Set<string>();
        for (const [id, st] of bufferStates(this.ed)) {
            const file = st.filePath;
            if (file === undefined || open.has(file)) continue;
            const found = this.specFor(file);
            if (!found) continue;
            open.add(file);
            const [spec, languageId] = found;
            // A server that stopped stays stopped until `:LspRestart`.
            let doc = this.docs.get(file);
            if (!doc) {
                const client = this.clientForFile(spec, file);
                doc = { path: file, uri: uriFromPath(file), client, version: 0, buffer: st.buffer, bufferVersion: st.buffer.version() };
                this.docs.set(file, doc);
                client.didOpen(doc.uri, languageId, doc.version, st.buffer.toFileText());
                this.scheduleSemantic(doc);
            } else if (doc.buffer !== st.buffer || doc.bufferVersion !== st.buffer.version()) {
                doc.buffer = st.buffer;
                doc.bufferVersion = st.buffer.version();
                doc.version += 1;
                doc.client.didChange(doc.uri, doc.version, st.buffer.toFileText());
                this.scheduleSemantic(doc);
            }
            if (this.saved.has(file)) {
                this.saved.delete(file);
                doc.client.didSave(doc.uri, st.buffer.toFileText());
                if (this.formatWrites.has(file)) this.formatWrites.delete(file);
                else if (this.formatOnSave) this.formatAfterSave(id, doc);
            }
        }
        this.saved.clear();
        for (const [file, doc] of this.docs) {
            if (open.has(file)) continue;
            doc.client.didClose(doc.uri);
            this.docs.delete(file);
            this.semantic.delete(file);
            const timer = this.semanticTimers.get(file);
            if (timer) clearTimeout(timer);
            this.semanticTimers.delete(file);
        }
    }

    // ----- Semantic tokens --------------------------------------------------------------

    /** Ask for a file's semantic tokens once typing pauses. */
    private scheduleSemantic(doc: Doc): void {
        const old = this.semanticTimers.get(doc.path);
        if (old) clearTimeout(old);
        this.semanticTimers.set(
            doc.path,
            setTimeout(() => {
                this.semanticTimers.delete(doc.path);
                const client = doc.client;
                if (this.docs.get(doc.path) !== doc) return;
                // Still starting: try again when it is likely ready.
                if (client.state === 'starting') {
                    this.scheduleSemantic(doc);
                    return;
                }
                const provider = client.capabilities.semanticTokensProvider;
                if (client.state !== 'running' || !provider?.full) return;
                // The tokens are for the text as it is now; keep a copy to
                // read their columns against.
                const lines = doc.buffer.snapshot().lines;
                client
                    .request<{ data: number[] } | null>('textDocument/semanticTokens/full', { textDocument: { uri: doc.uri } })
                    .then((result) => {
                        if (!result || this.docs.get(doc.path) !== doc) return;
                        this.semantic.set(doc.path, decodeSemantic(result.data, provider.legend.tokenTypes, lines, client.encoding));
                        this.host.refresh();
                    })
                    .catch(() => {});
            }, SEMANTIC_DELAY),
        );
    }

    /** Semantic token spans for a line of a file, if they are for this text
     * (until fresh ones come, a changed line uses syntax highlighting only). */
    semanticFor(file: string | undefined, line: number, chars: readonly string[]): Span[] | undefined {
        const entry = file === undefined ? undefined : this.semantic.get(file)?.get(line);
        if (!entry || entry.text !== chars.join('')) return undefined;
        return entry.spans;
    }

    /** Format a file that was just written and write it again, if it hasn't
     * changed in the meantime. */
    private formatAfterSave(id: number, doc: Doc): void {
        const client = doc.client;
        if (!client.supports('documentFormattingProvider')) return;
        const { buffer, bufferVersion } = doc;
        client
            .request<TextEdit[] | null>('textDocument/formatting', {
                textDocument: { uri: doc.uri },
                options: this.formattingOptions(),
            })
            .then((edits) => {
                const st = bufferState(this.ed, id);
                if (!edits || edits.length === 0 || !st || st.buffer !== buffer || buffer.version() !== bufferVersion) {
                    return;
                }
                this.applyEdits(client, id, edits);
                if (bufferState(this.ed, id)?.buffer.version() === bufferVersion) return;
                this.formatWrites.add(doc.path);
                writeBuffer(this.ed, id);
                this.host.refresh();
            })
            .catch((e: unknown) => {
                if (!isStale(e)) this.message(`${client.name}: formatting failed: ${(e as Error).message}`, true);
            });
    }

    formattingOptions(): { tabSize: number; insertSpaces: boolean } {
        return { tabSize: this.ed.options.shiftwidth, insertSpaces: this.ed.options.expandtab };
    }

    // ----- Diagnostics --------------------------------------------------------------------

    private setDiagnostics(client: LanguageClient, uri: string, diagnostics: Diagnostic[]): void {
        const file = pathFromUri(uri);
        if (file === undefined) return;
        if (diagnostics.length === 0) this.diagnostics.delete(file);
        else this.diagnostics.set(file, { client, diagnostics });
        this.host.refresh();
    }

    /** Diagnostics for a file, in the positions of `buffer` (its buffer), sorted
     * by position. */
    diagnosticsFor(file: string | undefined, buffer: Buffer): BufferDiagnostic[] {
        const entry = file === undefined ? undefined : this.diagnostics.get(file);
        if (!entry) return [];
        const c = entry.cache;
        if (c && c.buffer === buffer && c.version === buffer.version()) return c.list;
        const list = entry.diagnostics.map((d): BufferDiagnostic => {
            const [start, end] = fromRange(buffer, d.range, entry.client.encoding);
            return { start, end, severity: d.severity ?? Severity.Error, message: d.message, source: d.source };
        });
        list.sort((a, b) => posCmp(a.start, b.start) || a.severity - b.severity);
        entry.cache = { buffer, version: buffer.version(), list };
        return list;
    }

    /** The raw diagnostics touching a range of a file, for code actions. */
    rawDiagnostics(file: string): Diagnostic[] {
        return this.diagnostics.get(file)?.diagnostics ?? [];
    }

    /** Every file's diagnostics, by file and position. */
    allDiagnostics(): { file: string; diagnostic: Diagnostic; encoding: Encoding }[] {
        const out: { file: string; diagnostic: Diagnostic; encoding: Encoding }[] = [];
        for (const file of [...this.diagnostics.keys()].sort()) {
            const { client, diagnostics } = this.diagnostics.get(file)!;
            const sorted = [...diagnostics].sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
            for (const diagnostic of sorted) out.push({ file, diagnostic, encoding: client.encoding });
        }
        return out;
    }

    /** Counts by severity (index 1 to 4) for a file. */
    counts(file: string | undefined): number[] {
        const counts = [0, 0, 0, 0, 0];
        const entry = file === undefined ? undefined : this.diagnostics.get(file);
        for (const d of entry?.diagnostics ?? []) counts[d.severity ?? Severity.Error] += 1;
        return counts;
    }

    // ----- Edits ----------------------------------------------------------------------------

    /** Apply a server's edits to buffer `id`, keeping its cursor on its text. */
    applyEdits(client: LanguageClient, id: number, edits: readonly TextEdit[]): void {
        editBuffer(this.ed, id, (st) => {
            st.cursor = applyTextEdits(st.buffer, edits, client.encoding, st.cursor);
        });
    }

    /** Apply a workspace edit (rename, code action). Files that aren't open are
     * loaded into background buffers, left unsaved as Neovim does. */
    applyWorkspaceEdit(client: LanguageClient, edit: WorkspaceEdit): boolean {
        try {
            const changes: [string, TextEdit[]][] = [];
            if (edit.documentChanges) {
                for (const change of edit.documentChanges) {
                    if (!('kind' in change)) {
                        changes.push([change.textDocument.uri, change.edits]);
                        continue;
                    }
                    this.flushChanges(client, changes);
                    this.resourceOperation(change);
                }
            } else {
                for (const [uri, edits] of Object.entries(edit.changes ?? {})) changes.push([uri, edits]);
            }
            const touched = this.flushChanges(client, changes);
            const others = touched.filter((f) => f !== this.ed.filePath).length;
            if (others > 0) this.ed.setMessage(`Changed ${others} other file${others === 1 ? '' : 's'} (:wa to save)`);
            this.host.refresh();
            return true;
        } catch (e) {
            this.message(`Can't apply the edit: ${(e as Error).message}`, true);
            return false;
        }
    }

    /** Apply the queued text edits; returns the files changed. */
    private flushChanges(client: LanguageClient, changes: [string, TextEdit[]][]): string[] {
        const files: string[] = [];
        for (const [uri, edits] of changes.splice(0)) {
            const file = pathFromUri(uri);
            if (file === undefined || edits.length === 0) continue;
            this.applyEdits(client, backgroundBuffer(this.ed, file), edits);
            files.push(file);
        }
        return files;
    }

    private resourceOperation(op: CreateFile | RenameFile | DeleteFile): void {
        switch (op.kind) {
            case 'create': {
                const file = pathFromUri(op.uri);
                if (file === undefined) return;
                if (fs.existsSync(file) && !op.options?.overwrite) return;
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, '');
                break;
            }
            case 'rename': {
                const from = pathFromUri(op.oldUri);
                const to = pathFromUri(op.newUri);
                if (from === undefined || to === undefined) return;
                if (fs.existsSync(to) && !op.options?.overwrite) {
                    if (op.options?.ignoreIfExists) return;
                    throw new Error(`${displayName(to)} already exists`);
                }
                fs.mkdirSync(path.dirname(to), { recursive: true });
                fs.renameSync(from, to);
                const id = findBuffer(this.ed, from);
                const st = id === undefined ? undefined : bufferState(this.ed, id);
                if (st) st.filePath = to;
                break;
            }
            case 'delete': {
                const file = pathFromUri(op.uri);
                if (file === undefined) return;
                fs.rmSync(file, { recursive: op.options?.recursive ?? false, force: op.options?.ignoreIfNotExists ?? false });
                break;
            }
        }
    }
}

/** How long after a change to ask for semantic tokens, in ms. */
const SEMANTIC_DELAY = 150;

/** The highlighting token for a semantic token type, as nord.nvim (and
 * Neovim's defaults) color `@lsp.type.*`: types it leaves alone (variables,
 * structs, constants, rust-analyzer's own kinds) keep their syntax color. */
const SEMANTIC_TOKENS: Readonly<Record<string, Token>> = {
    namespace: 'Module',
    type: 'Type',
    class: 'Type',
    enum: 'Type',
    interface: 'Type',
    typeAlias: 'Type',
    union: 'Type',
    builtinType: 'BuiltinType',
    typeParameter: 'Parameter',
    parameter: 'Parameter',
    function: 'Function',
    method: 'Function',
    member: 'Function',
    macro: 'Macro',
    property: 'Property',
    enumMember: 'Constant',
    keyword: 'Keyword',
    comment: 'Comment',
    string: 'String',
    number: 'Number',
    regexp: 'String',
    operator: 'Operator',
    decorator: 'Attribute',
};

/** Semantic tokens (in the protocol's relative form) as spans by line. */
function decodeSemantic(data: readonly number[], types: readonly string[], lines: readonly (readonly string[])[], enc: Encoding): Map<number, { text: string; spans: Span[] }> {
    const out = new Map<number, { text: string; spans: Span[] }>();
    let line = 0;
    let start = 0;
    for (let i = 0; i + 4 < data.length; i += 5) {
        line += data[i];
        start = data[i] === 0 ? start + data[i + 1] : data[i + 1];
        const token = SEMANTIC_TOKENS[types[data[i + 3]] ?? ''];
        const chars = lines[line];
        if (!token || !chars) continue;
        let entry = out.get(line);
        if (!entry) {
            entry = { text: chars.join(''), spans: [] };
            out.set(line, entry);
        }
        entry.spans.push([fromCharacter(chars, start, enc), fromCharacter(chars, start + data[i + 2], enc), token]);
    }
    return out;
}
