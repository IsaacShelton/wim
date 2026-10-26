// The language server features behind the key mappings: going to
// definitions, references, hover, rename, code actions, symbols, formatting
// and diagnostics. Lists open in a picker, as Telescope does in Neovim.

import * as fs from 'node:fs';

import { Pos, posCmp, pos } from '../editor/buffer';
import { bufferState, findBuffer } from '../editor/buffers';
import type { Editor } from '../editor/editor';
import { isVisual } from '../editor/mode';
import { LspAction } from '../keymap';
import { displayName } from '../paths';
import { Float, Picker, PickerItem, Run } from '../popup';
import { theme } from '../theme';
import { LanguageClient } from './client';
import { BufferDiagnostic, LspManager } from './manager';
import { hoverMarkdown, markdownLines } from './markdown';
import { isStale } from './rpc';
import { Encoding, fromCharacter, fromPosition, fromRange, pathFromUri, toPosition, uriFromPath } from './text';
import {
    CodeAction,
    Command,
    DocumentHighlight,
    DocumentSymbol,
    Hover,
    Location,
    LocationLink,
    Range,
    SYMBOL_KINDS,
    Severity,
    SymbolInformation,
    TextEdit,
    WorkspaceEdit,
} from './types';

export interface FeatureHost {
    openPicker: (picker: Picker<never>) => void;
    showFloat: (float: Float) => void;
    refresh: () => void;
}

/** How long the cursor must rest before other uses of the symbol under it
 * are highlighted (the Neovim config's `updatetime`). */
const HIGHLIGHT_DELAY = 250;

const SEVERITY_NAMES = ['', 'Error', 'Warning', 'Info', 'Hint'];
const SEVERITY_LETTERS = ['', 'E', 'W', 'I', 'H'];

export function severityColor(severity: number): string {
    switch (severity) {
        case Severity.Error:
            return theme.DIAGNOSTIC_ERROR;
        case Severity.Warning:
            return theme.DIAGNOSTIC_WARN;
        case Severity.Information:
            return theme.DIAGNOSTIC_INFO;
        default:
            return theme.DIAGNOSTIC_HINT;
    }
}

/** Where a request is made from. */
interface Here {
    client: LanguageClient;
    file: string;
    uri: string;
    bufferId: number;
    version: number;
    cursor: Pos;
}

interface Target {
    uri: string;
    range: Range;
    encoding: Encoding;
}

/** Other uses of the symbol under the cursor, for the buffer version and
 * cursor they were found for. */
interface References {
    bufferId: number;
    version: number;
    cursor: Pos;
    ranges: [Pos, Pos][];
}

export class LspFeatures {
    private references: References | undefined;
    private highlightTimer: NodeJS.Timeout | undefined;

    constructor(
        private readonly ed: Editor,
        private readonly lsp: LspManager,
        private readonly host: FeatureHost,
    ) {}

    run(action: LspAction): void {
        switch (action.t) {
            case 'Goto':
                this.goto(action.method);
                break;
            case 'References':
                this.findReferences();
                break;
            case 'Hover':
                this.hover();
                break;
            case 'Rename':
                this.rename();
                break;
            case 'CodeAction':
                this.codeAction();
                break;
            case 'DocumentSymbols':
                this.documentSymbols();
                break;
            case 'WorkspaceSymbols':
                this.workspaceSymbols();
                break;
            case 'Format':
                this.format();
                break;
            case 'JumpDiagnostic':
                this.jumpDiagnostic(action.forward, action.severity);
                break;
            case 'ListDiagnostics':
                this.listDiagnostics(action.severity);
                break;
        }
    }

    /** The server and position for a request from the cursor, or undefined
     * (with a message) if there is no server. */
    private here(capability?: Parameters<LanguageClient['supports']>[0]): Here | undefined {
        const ed = this.ed;
        this.lsp.sync();
        const client = this.lsp.clientFor(ed.filePath);
        if (!client || ed.filePath === undefined) {
            ed.setError(this.lsp.handles(ed.filePath) ? 'The language server is not running' : 'No language server for this buffer');
            return undefined;
        }
        if (client.state === 'running' && capability && !client.supports(capability)) {
            ed.setError(`${client.name} does not support this`);
            return undefined;
        }
        return {
            client,
            file: ed.filePath,
            uri: uriFromPath(ed.filePath),
            bufferId: ed.bufferId(),
            version: ed.buffer.version(),
            cursor: ed.cursor,
        };
    }

    private position(h: Here): object {
        return { textDocument: { uri: h.uri }, position: toPosition(this.ed.buffer, h.cursor, h.client.encoding) };
    }

    /** Whether the editor is still where `h` was made. */
    private still(h: Here): boolean {
        return this.ed.bufferId() === h.bufferId && this.ed.buffer.version() === h.version && posCmp(this.ed.cursor, h.cursor) === 0;
    }

    private failed(client: LanguageClient, what: string): (e: unknown) => void {
        return (e) => {
            if (isStale(e)) return;
            this.ed.setError(`${client.name}: ${what} failed: ${(e as Error).message}`);
            this.host.refresh();
        };
    }

    // ----- Jumping ------------------------------------------------------------------------

    /** Open a location's file and put the cursor at its start. */
    private jump(target: Target): void {
        const ed = this.ed;
        const file = pathFromUri(target.uri);
        if (file === undefined) {
            ed.setError(`Can't open ${target.uri}`);
            return;
        }
        if (isVisual(ed.mode)) ed.exitVisual();
        ed.marks.set("'", ed.cursor);
        if (file !== ed.filePath) ed.openFile(file);
        if (ed.filePath !== file) return;
        ed.cursor = fromPosition(ed.buffer, target.range.start, target.encoding);
        ed.clampCursor();
        ed.updateWantCol();
    }

    /** Jump straight to a single location, or pick one of several. */
    private jumpOrPick(title: string, targets: Target[]): void {
        if (targets.length === 0) {
            this.ed.setMessage(`No ${title.toLowerCase()} found`);
        } else if (targets.length === 1) {
            this.jump(targets[0]);
        } else {
            const lines = new FileLines(this.ed);
            const items = targets.map((t): PickerItem<Target> => {
                const file = pathFromUri(t.uri) ?? t.uri;
                const line = lines.get(file, t.range.start.line);
                const col = fromCharacter(Array.from(line), t.range.start.character, t.encoding);
                return { label: `${displayName(file)}:${t.range.start.line + 1}:${col + 1}`, detail: line.trim(), preview: previewOf(t), value: t };
            });
            this.pick(new Picker(title, (t) => this.jump(t), { items, preview: true }));
        }
        this.host.refresh();
    }

    private pick<T>(picker: Picker<T>): void {
        this.host.openPicker(picker as unknown as Picker<never>);
    }

    private goto(method: 'definition' | 'declaration' | 'implementation' | 'typeDefinition'): void {
        const capability = `${method}Provider` as const;
        const h = this.here(capability);
        if (!h) return;
        const titles = { definition: 'Definitions', declaration: 'Declarations', implementation: 'Implementations', typeDefinition: 'Type Definitions' };
        h.client
            .request<Location | Location[] | LocationLink[] | null>(`textDocument/${method}`, this.position(h))
            .then((result) => {
                if (this.ed.bufferId() !== h.bufferId) return;
                this.jumpOrPick(titles[method], targets(result, h.client.encoding));
            })
            .catch(this.failed(h.client, method));
    }

    private findReferences(): void {
        const h = this.here('referencesProvider');
        if (!h) return;
        h.client
            .request<Location[] | null>('textDocument/references', { ...this.position(h), context: { includeDeclaration: true } })
            .then((result) => {
                if (this.ed.bufferId() !== h.bufferId) return;
                this.jumpOrPick('References', targets(result, h.client.encoding));
            })
            .catch(this.failed(h.client, 'references'));
    }

    // ----- Hover ---------------------------------------------------------------------------

    private hover(): void {
        const h = this.here('hoverProvider');
        if (!h) return;
        h.client
            .request<Hover | null>('textDocument/hover', this.position(h))
            .then((result) => {
                if (!this.still(h)) return;
                const lines = markdownLines(hoverMarkdown(result));
                if (lines.length === 0) this.ed.setMessage('No information available');
                else this.host.showFloat(new Float(lines, h.cursor, h.bufferId));
                this.host.refresh();
            })
            .catch(this.failed(h.client, 'hover'));
    }

    // ----- Rename -------------------------------------------------------------------------------

    private rename(): void {
        const h = this.here('renameProvider');
        if (!h) return;
        const line = this.ed.buffer.line(h.cursor.line);
        const isWord = (c: string | undefined): boolean => c !== undefined && /^[\p{L}\p{N}_$]$/u.test(c);
        let start = h.cursor.col;
        let end = h.cursor.col;
        while (start > 0 && isWord(line[start - 1])) start--;
        while (isWord(line[end])) end++;
        const word = line.slice(start, end).join('');
        const picker = new Picker<never>('New Name', () => {}, {
            initialQuery: word,
            onInput: (newName) => {
                if (newName === '' || newName === word) return;
                h.client
                    .request<WorkspaceEdit | null>('textDocument/rename', { ...this.position(h), newName })
                    .then((edit) => {
                        if (edit) this.lsp.applyWorkspaceEdit(h.client, edit);
                        else this.ed.setError(`Can't rename ${word}`);
                        this.host.refresh();
                    })
                    .catch(this.failed(h.client, 'rename'));
            },
        });
        this.pick(picker);
    }

    // ----- Code actions ------------------------------------------------------------------------

    private codeAction(): void {
        const ed = this.ed;
        const h = this.here('codeActionProvider');
        if (!h) return;
        const enc = h.client.encoding;
        let range: Range;
        const sel = ed.selection();
        if (sel) {
            const endLine = sel.end.line;
            const end = sel.linewise ? pos(endLine, ed.buffer.lineLen(endLine)) : pos(endLine, sel.end.col + 1);
            const start = sel.linewise ? pos(sel.start.line, 0) : sel.start;
            range = { start: toPosition(ed.buffer, start, enc), end: toPosition(ed.buffer, end, enc) };
            ed.exitVisual();
        } else {
            const p = toPosition(ed.buffer, h.cursor, enc);
            range = { start: p, end: p };
        }
        const diagnostics = this.lsp.rawDiagnostics(h.file).filter((d) => overlaps(d.range, range));
        h.client
            .request<(Command | CodeAction)[] | null>('textDocument/codeAction', {
                textDocument: { uri: h.uri },
                range,
                context: { diagnostics, triggerKind: 1 },
            })
            .then((result) => {
                const actions = (result ?? []).filter((a) => !('disabled' in a && a.disabled));
                if (actions.length === 0) {
                    this.ed.setMessage('No code actions available');
                } else {
                    const items = actions.map((a): PickerItem<Command | CodeAction> => ({
                        label: a.title,
                        detail: 'kind' in a && a.kind ? a.kind : undefined,
                        value: a,
                    }));
                    this.pick(new Picker('Code Actions', (a: Command | CodeAction) => this.runCodeAction(h.client, a), { items }));
                }
                this.host.refresh();
            })
            .catch(this.failed(h.client, 'code actions'));
    }

    private runCodeAction(client: LanguageClient, action: Command | CodeAction): void {
        if (typeof action.command === 'string') {
            this.executeCommand(client, action as Command);
            return;
        }
        const ca = action as CodeAction;
        const resolvable = typeof client.capabilities.codeActionProvider === 'object' && client.capabilities.codeActionProvider.resolveProvider;
        const apply = (a: CodeAction): void => {
            if (a.edit) this.lsp.applyWorkspaceEdit(client, a.edit);
            if (a.command) this.executeCommand(client, a.command);
            this.host.refresh();
        };
        if (!ca.edit && resolvable) {
            client.request<CodeAction>('codeAction/resolve', ca).then(apply).catch(this.failed(client, 'code action'));
        } else {
            apply(ca);
        }
    }

    private executeCommand(client: LanguageClient, command: Command): void {
        // Commands meant for an editor's own UI (`editor.action.*`,
        // `rust-analyzer.*` client commands) can't be run by the server.
        const known = client.capabilities.executeCommandProvider?.commands ?? [];
        if (!known.includes(command.command)) return;
        client
            .request('workspace/executeCommand', { command: command.command, arguments: command.arguments })
            .then(() => this.host.refresh())
            .catch(this.failed(client, command.title || command.command));
    }

    // ----- Symbols -------------------------------------------------------------------------------

    private documentSymbols(): void {
        const h = this.here('documentSymbolProvider');
        if (!h) return;
        const enc = h.client.encoding;
        h.client
            .request<DocumentSymbol[] | SymbolInformation[] | null>('textDocument/documentSymbol', { textDocument: { uri: h.uri } })
            .then((result) => {
                const items: PickerItem<Target>[] = [];
                const add = (s: DocumentSymbol, depth: number): void => {
                    items.push({
                        label: '  '.repeat(depth) + s.name,
                        detail: `[${SYMBOL_KINDS[s.kind] ?? '?'}] ${s.detail ?? ''}`.trim(),
                        preview: { file: h.file, line: s.selectionRange.start.line },
                        value: { uri: h.uri, range: s.selectionRange, encoding: enc },
                    });
                    for (const child of s.children ?? []) add(child, depth + 1);
                };
                for (const s of result ?? []) {
                    if ('location' in s) {
                        if ('range' in s.location) items.push(symbolItem(s, s.location, enc, false));
                    } else {
                        add(s, 0);
                    }
                }
                this.pick(new Picker('Document Symbols', (t: Target) => this.jump(t), { items, message: 'No symbols', preview: true }));
                this.host.refresh();
            })
            .catch(this.failed(h.client, 'document symbols'));
    }

    private workspaceSymbols(): void {
        const h = this.here('workspaceSymbolProvider');
        if (!h) return;
        const enc = h.client.encoding;
        let seq = 0;
        const picker: Picker<Target> = new Picker('Workspace Symbols', (t: Target) => this.jump(t), {
            preview: true,
            message: 'Type to search',
            onQuery: (query) => {
                const mine = ++seq;
                h.client
                    .request<SymbolInformation[] | null>('workspace/symbol', { query })
                    .then((result) => {
                        if (mine !== seq) return;
                        const items = (result ?? []).map((s) => symbolItem(s, 'range' in s.location ? s.location : { uri: s.location.uri, range: ZERO_RANGE }, enc, true));
                        picker.setItems(items, 'No symbols found');
                        this.host.refresh();
                    })
                    .catch(this.failed(h.client, 'workspace symbols'));
            },
        });
        this.pick(picker);
    }

    // ----- Formatting ----------------------------------------------------------------------------

    private format(): void {
        const h = this.here('documentFormattingProvider');
        if (!h) return;
        if (isVisual(this.ed.mode)) this.ed.exitVisual();
        h.client
            .request<TextEdit[] | null>('textDocument/formatting', { textDocument: { uri: h.uri }, options: this.lsp.formattingOptions() })
            .then((edits) => {
                const st = bufferState(this.ed, h.bufferId);
                if (!edits || !st || st.buffer.version() !== h.version) return;
                this.lsp.applyEdits(h.client, h.bufferId, edits);
                this.host.refresh();
            })
            .catch(this.failed(h.client, 'formatting'));
    }

    // ----- Diagnostics ------------------------------------------------------------------------------

    /** Diagnostics of the active buffer. */
    diagnostics(): BufferDiagnostic[] {
        return this.lsp.diagnosticsFor(this.ed.filePath, this.ed.buffer);
    }

    private jumpDiagnostic(forward: boolean, severity: number | undefined): void {
        const ed = this.ed;
        const list = this.diagnostics().filter((d) => severity === undefined || d.severity === severity);
        if (list.length === 0) {
            ed.setMessage('No more valid diagnostics to move to');
            return;
        }
        const cur = ed.cursor;
        const target = forward
            ? (list.find((d) => posCmp(d.start, cur) > 0) ?? list[0])
            : ([...list].reverse().find((d) => posCmp(d.start, cur) < 0) ?? list[list.length - 1]);
        ed.cursor = target.start;
        ed.clampCursor();
        ed.updateWantCol();
        // As Neovim 0.10 does, show the diagnostics there.
        this.showDiagnosticsAtCursor();
    }

    private showDiagnosticsAtCursor(): void {
        const cur = this.ed.cursor;
        const here = this.diagnostics().filter((d) => posCmp(d.start, cur) <= 0 && posCmp(cur, d.end) <= 0);
        const shown = here.length > 0 ? here : this.diagnostics().filter((d) => d.start.line === cur.line);
        if (shown.length === 0) return;
        const lines: Run[][] = [];
        for (const d of shown) {
            const source = d.source ? ` ${d.source}` : '';
            d.message.split('\n').forEach((text, i, all) => {
                const runs: Run[] = [[text, severityColor(d.severity)]];
                if (i === all.length - 1 && source) runs.push([source, theme.COMMENT]);
                lines.push(runs);
            });
        }
        this.host.showFloat(new Float(lines, cur, this.ed.bufferId()));
    }

    private listDiagnostics(severity: number | undefined): void {
        const lines = new FileLines(this.ed);
        const items: PickerItem<Target>[] = [];
        for (const { file, diagnostic: d, encoding } of this.lsp.allDiagnostics()) {
            const sev = d.severity ?? Severity.Error;
            if (severity !== undefined && sev !== severity) continue;
            const col = fromCharacter(Array.from(lines.get(file, d.range.start.line)), d.range.start.character, encoding);
            items.push({
                label: `${SEVERITY_LETTERS[sev]} ${d.message.split('\n')[0]}`,
                detail: `${displayName(file)}:${d.range.start.line + 1}:${col + 1}`,
                color: severityColor(sev),
                preview: { file, line: d.range.start.line },
                value: { uri: uriFromPath(file), range: d.range, encoding },
            });
        }
        const title = severity === undefined ? 'Diagnostics' : `${SEVERITY_NAMES[severity]}s`;
        this.pick(new Picker(title, (t: Target) => this.jump(t), { items, message: 'No diagnostics', preview: true }));
    }

    // ----- Highlighting references -------------------------------------------------------------

    /** Ranges to highlight in the active buffer as it is now. */
    highlights(): [Pos, Pos][] {
        const r = this.references;
        const ed = this.ed;
        if (!r || r.bufferId !== ed.bufferId() || r.version !== ed.buffer.version() || posCmp(r.cursor, ed.cursor) !== 0) return [];
        return r.ranges;
    }

    /** After every frame: once the cursor rests in Normal mode, highlight the
     * other uses of the symbol under it (as the Neovim config does on
     * `CursorHold`). */
    cursorMoved(): void {
        const ed = this.ed;
        const r = this.references;
        const same = r && r.bufferId === ed.bufferId() && r.version === ed.buffer.version() && posCmp(r.cursor, ed.cursor) === 0;
        if (same) return;
        this.references = { bufferId: ed.bufferId(), version: ed.buffer.version(), cursor: ed.cursor, ranges: [] };
        if (this.highlightTimer) clearTimeout(this.highlightTimer);
        this.highlightTimer = undefined;
        if (ed.mode !== 'Normal') return;
        const client = this.lsp.clientFor(ed.filePath);
        if (!client || client.state !== 'running' || !client.supports('documentHighlightProvider')) return;
        const want = this.references;
        this.highlightTimer = setTimeout(() => {
            this.highlightTimer = undefined;
            if (this.references !== want || ed.mode !== 'Normal' || ed.filePath === undefined) return;
            this.lsp.sync();
            client
                .request<DocumentHighlight[] | null>('textDocument/documentHighlight', {
                    textDocument: { uri: uriFromPath(ed.filePath) },
                    position: toPosition(ed.buffer, ed.cursor, client.encoding),
                })
                .then((result) => {
                    if (this.references !== want || this.highlights() !== want.ranges) return;
                    want.ranges = (result ?? []).map((d) => fromRange(ed.buffer, d.range, client.encoding));
                    if (want.ranges.length > 0) this.host.refresh();
                })
                .catch(() => {});
        }, HIGHLIGHT_DELAY);
    }

    dispose(): void {
        if (this.highlightTimer) clearTimeout(this.highlightTimer);
    }
}

function previewOf(t: Target): PickerItem<Target>['preview'] {
    const file = pathFromUri(t.uri);
    return file === undefined ? undefined : { file, line: t.range.start.line };
}

const ZERO_RANGE: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

function symbolItem(s: SymbolInformation, location: Location, encoding: Encoding, withFile: boolean): PickerItem<Target> {
    const file = pathFromUri(location.uri);
    const where = withFile && file ? ` ${displayName(file)}:${location.range.start.line + 1}` : '';
    const container = s.containerName ? ` ${s.containerName}` : '';
    return {
        label: s.name,
        detail: `[${SYMBOL_KINDS[s.kind] ?? '?'}]${container}${where}`,
        preview: file ? { file, line: location.range.start.line } : undefined,
        value: { uri: location.uri, range: location.range, encoding },
    };
}

/** Locations from a go-to request. */
function targets(result: Location | Location[] | LocationLink[] | null, encoding: Encoding): Target[] {
    if (!result) return [];
    const list = Array.isArray(result) ? result : [result];
    return list.map((l) =>
        'targetUri' in l ? { uri: l.targetUri, range: l.targetSelectionRange, encoding } : { uri: l.uri, range: l.range, encoding },
    );
}

function overlaps(a: Range, b: Range): boolean {
    const before = (p: { line: number; character: number }, q: { line: number; character: number }): boolean =>
        p.line < q.line || (p.line === q.line && p.character < q.character);
    return !before(a.end, b.start) && !before(b.end, a.start);
}

/** Lines of files for showing locations, from open buffers or the disk. */
class FileLines {
    private readonly files = new Map<string, string[]>();

    constructor(private readonly ed: Editor) {}

    get(file: string, line: number): string {
        let lines = this.files.get(file);
        if (!lines) {
            const id = findBuffer(this.ed, file);
            const st = id === undefined ? undefined : bufferState(this.ed, id);
            if (st) {
                lines = st.buffer.text().split('\n');
            } else {
                try {
                    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
                } catch {
                    lines = [];
                }
            }
            this.files.set(file, lines);
        }
        return lines[line] ?? '';
    }
}
