// One running language server: starts it, initializes it, keeps its view of
// open documents up to date and answers the requests it sends back.

import { ChildProcess, spawn } from 'node:child_process';
import * as path from 'node:path';

import { displayName } from '../paths';
import { ResponseError, RpcConnection } from './rpc';
import { ServerCommand, ServerSpec } from './servers';
import { Encoding, uriFromPath } from './text';
import type { Diagnostic, ProgressValue, ServerCapabilities, WorkspaceEdit } from './types';

export interface ClientEvents {
    onDiagnostics: (client: LanguageClient, uri: string, diagnostics: Diagnostic[]) => void;
    /** Applies an edit the server asked for; returns whether it worked. */
    onApplyEdit: (client: LanguageClient, edit: WorkspaceEdit) => boolean;
    /** A message for the user, such as the server failing to start. */
    onMessage: (text: string, error: boolean) => void;
    /** The server's state or progress changed. */
    onChange: () => void;
}

export type ClientState = 'starting' | 'running' | 'failed' | 'stopped';

/** How much of the server's standard error to keep for error messages. */
const STDERR_TAIL = 2000;

export class LanguageClient {
    state: ClientState = 'starting';
    capabilities: ServerCapabilities = {};
    encoding: Encoding = 'utf-16';
    private proc: ChildProcess | undefined;
    private rpc: RpcConnection | undefined;
    /** Resolves once the server is initialized (true) or has failed (false). */
    private readonly ready: Promise<boolean>;
    private readonly progress = new Map<string | number, ProgressValue>();
    private readonly settings: Record<string, unknown> | undefined;

    constructor(
        readonly spec: ServerSpec,
        readonly root: string,
        private readonly events: ClientEvents,
    ) {
        this.settings = spec.settings?.(root);
        this.ready = this.start();
    }

    get name(): string {
        return this.spec.name;
    }

    /** Whether this server's project contains `file`. */
    contains(file: string): boolean {
        const rel = path.relative(this.root, file);
        return !rel.startsWith('..') && !path.isAbsolute(rel);
    }

    supports(capability: keyof ServerCapabilities): boolean {
        return Boolean(this.capabilities[capability]);
    }

    /** Ongoing work, such as indexing, for the status line. */
    progressText(): string | undefined {
        let last: ProgressValue | undefined;
        for (const p of this.progress.values()) last = p;
        if (!last) return undefined;
        const pct = last.percentage !== undefined ? ` ${Math.round(last.percentage)}%` : '';
        const message = last.message ? ` ${last.message}` : '';
        return `${last.title ?? ''}${message}${pct}`.trim();
    }

    // ----- Starting and stopping ---------------------------------------------------

    private async start(): Promise<boolean> {
        const commands = this.spec.commands(this.root);
        const failures: string[] = [];
        for (const command of commands) {
            const failure = await this.tryStart(command);
            if (failure === undefined) {
                this.state = 'running';
                this.events.onChange();
                return true;
            }
            failures.push(`${displayName([command.command, ...command.args].join(' '))}: ${failure}`);
        }
        this.state = 'failed';
        this.events.onMessage(
            failures.length === 0
                ? `${this.name} was not found (install it, for example with Mason in Neovim)`
                : `${this.name} failed to start: ${failures.join('; ')}`,
            true,
        );
        this.events.onChange();
        return false;
    }

    /** Start and initialize the server with `command`; returns why it
     * failed. */
    private tryStart(command: ServerCommand): Promise<string | undefined> {
        return new Promise((resolve) => {
            let settled = false;
            let stderr = '';
            const finish = (failure: string | undefined): void => {
                if (settled) return;
                settled = true;
                resolve(failure);
            };
            // Windows runs .cmd and .bat files through the shell.
            const shell = /\.(cmd|bat)$/i.test(command.command);
            let proc: ChildProcess;
            try {
                proc = spawn(shell ? `"${command.command}"` : command.command, command.args, {
                    cwd: this.root,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    shell,
                    windowsHide: true,
                });
            } catch (e) {
                finish(spawnError(e as NodeJS.ErrnoException));
                return;
            }
            proc.stderr!.setEncoding('utf8');
            proc.stderr!.on('data', (chunk: string) => {
                stderr = (stderr + chunk).slice(-STDERR_TAIL);
            });
            proc.on('error', (e: NodeJS.ErrnoException) => finish(spawnError(e)));
            proc.on('exit', (code, signal) => {
                const why = stderr.trim().split('\n').pop() || `exit ${signal ?? code}`;
                if (!settled) {
                    finish(why);
                    return;
                }
                if (this.proc !== proc) return;
                this.rpc?.close();
                if (this.state === 'running') {
                    this.state = 'stopped';
                    this.events.onMessage(`${this.name} exited: ${why}`, true);
                }
                this.progress.clear();
                this.events.onChange();
            });

            const rpc = new RpcConnection(proc.stdout!, proc.stdin!);
            rpc.onNotification = (method, params) => this.notification(method, params);
            rpc.onRequest = (method, params) => this.serverRequest(method, params);
            rpc.request<{ capabilities: ServerCapabilities }>('initialize', this.initializeParams()).then(
                (result) => {
                    if (settled) return;
                    this.proc = proc;
                    this.rpc = rpc;
                    this.capabilities = result.capabilities ?? {};
                    const enc = this.capabilities.positionEncoding;
                    this.encoding = enc === 'utf-8' || enc === 'utf-32' ? enc : 'utf-16';
                    rpc.notify('initialized', {});
                    if (this.settings) rpc.notify('workspace/didChangeConfiguration', { settings: this.settings });
                    finish(undefined);
                },
                (e: Error) => {
                    // A server that exited is reported (with its own error
                    // output) when the exit comes in.
                    if (!(e instanceof ResponseError)) return;
                    proc.kill();
                    finish(`initialize failed: ${e.message}`);
                },
            );
        });
    }

    /** Ask the server to exit, and make sure it does. */
    stop(): void {
        const proc = this.proc;
        const rpc = this.rpc;
        this.state = 'stopped';
        this.progress.clear();
        if (!proc || !rpc) return;
        const kill = setTimeout(() => proc.kill(), 2000);
        kill.unref();
        rpc.request('shutdown', null)
            .then(() => rpc.notify('exit', null))
            .catch(() => proc.kill());
    }

    /** Stop the server right away (Wim is exiting). */
    kill(): void {
        this.state = 'stopped';
        this.proc?.kill();
    }

    private initializeParams(): object {
        const linkSupport = { linkSupport: true };
        return {
            processId: process.pid,
            clientInfo: { name: 'Wim' },
            rootUri: uriFromPath(this.root),
            rootPath: this.root,
            workspaceFolders: [{ uri: uriFromPath(this.root), name: path.basename(this.root) }],
            initializationOptions: this.spec.initializationOptions,
            capabilities: {
                general: { positionEncodings: ['utf-32', 'utf-16'] },
                window: { workDoneProgress: true, showMessage: {} },
                workspace: {
                    applyEdit: true,
                    workspaceEdit: { documentChanges: true, resourceOperations: ['create', 'rename', 'delete'] },
                    configuration: true,
                    workspaceFolders: true,
                    didChangeConfiguration: {},
                    symbol: {},
                    executeCommand: {},
                },
                textDocument: {
                    synchronization: { didSave: true },
                    publishDiagnostics: { versionSupport: false },
                    hover: { contentFormat: ['markdown', 'plaintext'] },
                    completion: {
                        contextSupport: true,
                        completionItem: {
                            // Without tab stops to jump between, snippets
                            // would leave placeholder text behind.
                            snippetSupport: false,
                            labelDetailsSupport: true,
                            documentationFormat: ['markdown', 'plaintext'],
                            resolveSupport: { properties: ['additionalTextEdits', 'detail', 'documentation'] },
                        },
                    },
                    definition: linkSupport,
                    declaration: linkSupport,
                    typeDefinition: linkSupport,
                    implementation: linkSupport,
                    references: {},
                    documentHighlight: {},
                    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
                    codeAction: {
                        dataSupport: true,
                        resolveSupport: { properties: ['edit'] },
                        codeActionLiteralSupport: {
                            codeActionKind: {
                                valueSet: [
                                    '', 'quickfix', 'refactor', 'refactor.extract', 'refactor.inline',
                                    'refactor.rewrite', 'source', 'source.organizeImports',
                                ],
                            },
                        },
                    },
                    formatting: {},
                    rename: {},
                },
            },
        };
    }

    // ----- Messages from the server ----------------------------------------------------

    private notification(method: string, params: unknown): void {
        switch (method) {
            case 'textDocument/publishDiagnostics': {
                const p = params as { uri: string; diagnostics: Diagnostic[] };
                this.events.onDiagnostics(this, p.uri, p.diagnostics ?? []);
                break;
            }
            case '$/progress': {
                const p = params as { token: string | number; value: ProgressValue };
                if (!p.value || typeof p.value !== 'object' || !('kind' in p.value)) break;
                if (p.value.kind === 'end') this.progress.delete(p.token);
                else this.progress.set(p.token, { ...this.progress.get(p.token), ...p.value });
                this.events.onChange();
                break;
            }
            case 'window/showMessage': {
                const p = params as { type: number; message: string };
                // Errors and warnings only; information is mostly chatter.
                // The message line has room for one line.
                const text = p.message.trim().replace(/\s*\n\s*/g, ' ');
                if (p.type <= 2) this.events.onMessage(`${this.name}: ${text}`, p.type === 1);
                break;
            }
        }
    }

    private serverRequest(method: string, params: unknown): unknown {
        switch (method) {
            case 'workspace/configuration': {
                const p = params as { items: { section?: string }[] };
                return p.items.map((item) => lookup(this.settings, item.section));
            }
            case 'workspace/applyEdit': {
                const p = params as { edit: WorkspaceEdit };
                return { applied: this.events.onApplyEdit(this, p.edit) };
            }
            case 'workspace/workspaceFolders':
                return [{ uri: uriFromPath(this.root), name: path.basename(this.root) }];
            case 'window/workDoneProgress/create':
            case 'client/registerCapability':
            case 'client/unregisterCapability':
            case 'window/showMessageRequest':
            case 'workspace/codeLens/refresh':
            case 'workspace/semanticTokens/refresh':
            case 'workspace/inlayHint/refresh':
            case 'workspace/diagnostic/refresh':
                return null;
            default:
                throw new ResponseError(-32601, `Unhandled method ${method}`);
        }
    }

    // ----- Messages to the server --------------------------------------------------------

    /** Send a notification once the server is ready (in order). */
    notify(method: string, params: unknown): void {
        void this.ready.then((ok) => {
            if (ok) this.rpc?.notify(method, params);
        });
    }

    request<T>(method: string, params: unknown): Promise<T> {
        return this.ready.then((ok) => {
            if (!ok || !this.rpc || this.state !== 'running') throw new Error(`${this.name} is not running`);
            return this.rpc.request<T>(method, params);
        });
    }

    didOpen(uri: string, languageId: string, version: number, text: string): void {
        this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version, text } });
    }

    didChange(uri: string, version: number, text: string): void {
        this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
    }

    didSave(uri: string, text: string): void {
        const sync = this.capabilities.textDocumentSync;
        const save = typeof sync === 'object' ? sync.save : undefined;
        const includeText = typeof save === 'object' && save.includeText;
        this.notify('textDocument/didSave', { textDocument: { uri }, ...(includeText ? { text } : {}) });
    }

    didClose(uri: string): void {
        this.notify('textDocument/didClose', { textDocument: { uri } });
    }
}

/** Why a server couldn't be started. */
function spawnError(e: NodeJS.ErrnoException): string {
    // macOS's EBADARCH, which Node doesn't name.
    return e.errno === -86 ? 'built for another CPU architecture' : e.message;
}

/** A dotted section of the settings, or null. */
function lookup(settings: Record<string, unknown> | undefined, section: string | undefined): unknown {
    let value: unknown = settings;
    for (const key of section ? section.split('.') : []) {
        if (value === null || typeof value !== 'object') return null;
        value = (value as Record<string, unknown>)[key];
    }
    return value ?? null;
}
