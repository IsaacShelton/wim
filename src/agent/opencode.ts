// OpenCode, through the OpenCode SDK's client. It talks to the local
// OpenCode service (starting one when needed), so a session is an OpenCode
// session with OpenCode's own tools, config and model providers. Its events
// are translated into the same messages the Claude Agent SDK sends, so the
// panel draws both the same way.

import { AccountBalance, AgentBackend, AgentQuery, ContextUsage, HistoryMessage, ModelInfo, PastSession, PermissionResult, StartOptions, UsageInfo } from './backend';

/** The parts of the OpenCode client backend.ts uses. They are kept loose so
 * the SDK stays an optional dependency, imported only when OpenCode is on. */
type Client = any;

// The SDK is an ES module and Wim is compiled to CommonJS, whose `import()`
// TypeScript would turn into `require()`; this keeps a real `import()`.
const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;

/** The console's balance is in micro-cents: 100,000,000 of them make $1. */
const MICRO_CENTS = 100_000_000;

/** How long a balance is trusted before asking the console again. */
const BALANCE_TTL = 30_000;

/** The console refuses requests that don't look like a browser's. */
const CONSOLE_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

/** One of the console's account routes, from the URL its credential names. */
function consoleUrl(server: unknown, route: string): string {
    const base = typeof server === 'string' && server !== '' ? server : 'https://opencode.ai/console';
    return `${base.replace(/\/+$/, '')}${route}`;
}

let loaded: Promise<{ client: Client; service: Client }> | undefined;

function load(): Promise<{ client: Client; service: Client }> {
    loaded ??= Promise.all([importModule('@opencode/client'), importModule('@opencode/client/service')]).then(([client, service]) => ({
        client: client as Client,
        service: service as Client,
    }));
    return loaded;
}

/** A model as OpenCode's prompt and session routes want it. */
interface ModelRef {
    providerID: string;
    id: string;
    variant?: string;
}

/** Split a model choice (`anthropic/claude-opus-5-5`) into the provider and
 * model OpenCode names separately. */
function parseModel(value: string | undefined): ModelRef | undefined {
    if (value === undefined) return undefined;
    const at = value.indexOf('/');
    if (at <= 0 || at === value.length - 1) return undefined;
    return { providerID: value.slice(0, at), id: value.slice(at + 1) };
}

function modelValue(m: { providerID?: string; modelID?: string; id?: string }): string {
    const model = m.modelID ?? m.id ?? '';
    return m.providerID ? `${m.providerID}/${model}` : model;
}

function contentText(content: any): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .map((c) => (c?.type === 'text' ? (c.text ?? '') : c?.type === 'file' ? `[${c.name ?? 'File'}]` : ''))
        .filter((s: string) => s !== '')
        .join('\n');
}

/** A user message's text and images, as the panel's channel carries them. */
function promptContent(content: any): { text: string; files: { data: string; mime: string; name?: string; source: { type: 'inline' } }[] } {
    if (typeof content === 'string') return { text: content, files: [] };
    if (!Array.isArray(content)) return { text: '', files: [] };
    const text: string[] = [];
    const files: { data: string; mime: string; name?: string; source: { type: 'inline' } }[] = [];
    for (const block of content) {
        if (block?.type === 'text') text.push(block.text ?? '');
        else if (block?.type === 'image' && block.source?.type === 'base64') {
            files.push({ data: block.source.data, mime: block.source.media_type, source: { type: 'inline' } });
        }
    }
    return { text: text.join('\n'), files };
}

/** OpenCode, through the OpenCode SDK. */
export class OpenCodeBackend implements AgentBackend {
    readonly id = 'opencode';
    readonly label = 'OpenCode';
    private hostPromise: Promise<Client> | undefined;
    private readonly modelsByDir = new Map<string, ModelInfo[]>();
    private balanceCache: { at: number; balance: AccountBalance } | undefined;

    private host(): Promise<Client> {
        this.hostPromise ??= load()
            .then(async ({ client, service }) => {
                // The client talks to a local OpenCode service, starting one
                // when none is running. It is shared with the opencode CLI.
                const endpoint = await service.Service.ensure();
                return client.OpenCode.make({ baseUrl: endpoint.url, headers: service.Service.headers(endpoint) });
            })
            .catch((e: Error) => {
                this.hostPromise = undefined;
                throw new Error(`OpenCode isn't available: ${e.message} (install @opencode/client and the opencode CLI, or turn opencode.enabled off)`);
            });
        return this.hostPromise;
    }

    async models(dir: string): Promise<ModelInfo[]> {
        const cached = this.modelsByDir.get(dir);
        if (cached) return cached;
        const host = await this.host();
        const result = await host.model.list({ location: { directory: dir }, types: ['chat'] });
        const models: ModelInfo[] = (result?.data ?? [])
            .filter((m: any) => m.enabled !== false)
            .map((m: any) => ({
                value: modelValue(m),
                resolvedModel: m.modelID,
                displayName: m.name ?? m.modelID,
                description: `${m.providerID ?? 'unknown provider'} · ${m.modelID ?? ''}${m.status && m.status !== 'active' ? ` · ${m.status}` : ''}`,
            }));
        this.modelsByDir.set(dir, models);
        return models;
    }

    /** What is left of the signed-in Console workspace's balance. OpenCode's
     * API has no balance route yet, so this asks the console's billing route
     * with the credential OpenCode saved, as its billing page does. */
    async balance(dir: string): Promise<AccountBalance | undefined> {
        const now = Date.now();
        if (this.balanceCache && now - this.balanceCache.at < BALANCE_TTL) return this.balanceCache.balance;
        const balance = await this.consoleBalance(dir);
        // A failed read isn't kept, so the next ask can try again.
        if (balance) this.balanceCache = { at: now, balance };
        return balance;
    }

    private async consoleBalance(dir: string): Promise<AccountBalance | undefined> {
        try {
            const host = await this.host();
            const credentials = await host.credential.list();
            const credential = (credentials ?? []).find(
                (c: any) => c?.active !== false && c?.integrationID === 'opencode' && typeof c?.value?.access === 'string' && c.value.access !== '',
            );
            if (!credential) return undefined;
            const value = credential.value;
            const metadata = value.metadata ?? {};
            let org = typeof metadata.orgID === 'string' ? metadata.orgID : undefined;
            if (!org) {
                const limits = await host.experimental.usage.limits({ location: { directory: dir } }).catch(() => undefined);
                org = limits?.data?.workspace?.id;
            }
            if (!org) return undefined;
            const response = await fetch(consoleUrl(metadata.server, '/api/billing/status'), {
                headers: {
                    authorization: `Bearer ${value.access}`,
                    'x-org-id': org,
                    accept: 'application/json',
                    'user-agent': CONSOLE_USER_AGENT,
                },
            });
            if (!response.ok) return undefined;
            const info = (await response.json()) as { availableMicroCents?: string | number; balanceMicroCents?: string | number };
            const micro = Number(info.availableMicroCents ?? info.balanceMicroCents);
            if (!Number.isFinite(micro)) return undefined;
            return { available: micro / MICRO_CENTS, currency: 'USD' };
        } catch {
            // No console sign-in (or no balance route): there is nothing to show.
            return undefined;
        }
    }

    private async ref(dir: string, value: string | undefined): Promise<ModelRef | undefined> {
        const parsed = parseModel(value);
        if (parsed) return parsed;
        if (value === undefined) return undefined;
        // A bare id (an OpenCode name, or a preset's Claude alias): find the
        // model it names.
        const models = await this.models(dir);
        const match = models.find((m) => m.value === value || m.resolvedModel === value || m.value.endsWith(`/${value}`));
        return match ? parseModel(match.value) : undefined;
    }

    async start(opts: StartOptions): Promise<AgentQuery> {
        const host = await this.host();
        let id = opts.resume;
        let model = await this.ref(opts.cwd, opts.model);
        if (id === undefined) {
            const session = await host.session.create({
                location: { directory: opts.cwd },
                model,
            });
            id = session.id;
            if (model === undefined && session.model) model = { providerID: session.model.providerID, id: session.model.id };
        } else if (model === undefined) {
            const session = await host.session.get({ sessionID: id }).catch(() => undefined);
            if (session?.model) model = { providerID: session.model.providerID, id: session.model.id };
        }
        const sessionID = id;
        if (sessionID === undefined) throw new Error("OpenCode didn't make a session");
        const query = new OpenCodeQuery(host, sessionID, opts);
        query.begin(model);
        return query;
    }

    async listSessions(dir: string): Promise<PastSession[]> {
        const host = await this.host();
        const result = await host.session.list({ directory: dir, limit: 100 });
        return (result?.data ?? [])
            .filter((s: any) => !s.parentID)
            .map((s: any) => ({
                id: s.id,
                title: s.title ?? s.id,
                modified: s.time?.updated ?? s.time?.created ?? 0,
            }));
    }

    async history(id: string): Promise<HistoryMessage[]> {
        const host = await this.host();
        const result = await host.message.list({ sessionID: id });
        const messages: HistoryMessage[] = [];
        for (const m of result?.data ?? []) {
            if (m.type === 'user') {
                const content: any[] = [{ type: 'text', text: m.text ?? '' }];
                for (let i = 0; i < (m.files?.length ?? 0); i++) content.push({ type: 'image' });
                messages.push({ type: 'user', message: { role: 'user', content }, parentToolUseId: null });
            } else if (m.type === 'assistant') {
                const content: any[] = [];
                const results: any[] = [];
                for (const c of m.content ?? []) {
                    if (c.type === 'text' && (c.text ?? '').trim() !== '') content.push({ type: 'text', text: c.text });
                    else if (c.type === 'reasoning' && (c.text ?? '').trim() !== '') content.push({ type: 'thinking', thinking: c.text });
                    else if (c.type === 'tool') {
                        const state = c.state ?? {};
                        const input = typeof state.input === 'object' && state.input !== null ? state.input : {};
                        content.push({ type: 'tool_use', id: c.id, name: c.name ?? 'tool', input });
                        if (state.status === 'completed' || state.status === 'error') {
                            results.push({
                                type: 'tool_result',
                                tool_use_id: c.id,
                                content: contentText(state.content),
                                is_error: state.status === 'error',
                            });
                        }
                    }
                }
                if (content.length > 0) messages.push({ type: 'assistant', message: { role: 'assistant', content }, parentToolUseId: null });
                if (results.length > 0) messages.push({ type: 'user', message: { role: 'user', content: results }, parentToolUseId: null });
            }
        }
        return messages;
    }

    async title(id: string): Promise<string | undefined> {
        const host = await this.host();
        const session = await host.session.get({ sessionID: id });
        return session?.title;
    }
}

/** One OpenCode session, as the panel's query. OpenCode's events become the
 * Claude Agent SDK's messages, and its permission requests become the
 * panel's prompts. */
class OpenCodeQuery implements AgentQuery {
    private readonly queue: any[] = [];
    private waiting: ((r: IteratorResult<any>) => void) | undefined;
    private ended = false;
    private closed = false;
    private readonly abort = new AbortController();
    private readonly toolNames = new Map<string, string>();
    private events: AsyncIterator<any> | undefined;
    private cost = 0;
    /** A message is being worked on, until execution ends. */
    private turnOpen = false;

    constructor(
        private readonly host: Client,
        private readonly sessionID: string,
        private readonly opts: StartOptions,
    ) {}

    /** Start listening, and start sending what the panel sends. */
    begin(model: ModelRef | undefined): void {
        this.emit({ type: 'system', subtype: 'init', session_id: this.sessionID, model: model ? `${model.providerID}/${model.id}` : '', permissionMode: this.opts.permissionMode ?? 'default' });
        void this.pump();
        void this.subscribe();
    }

    private emit(message: any): void {
        if (this.closed) return;
        const waiting = this.waiting;
        this.waiting = undefined;
        if (waiting) waiting({ value: message, done: false });
        else this.queue.push(message);
    }

    /** End a turn, as the panel's result message does. OpenCode says a turn
     * is over with `session.execution.succeeded` (or failed/interrupted),
     * not `session.idle`, so both are accepted but only one counts. */
    private finishTurn(failure?: string): void {
        if (!this.turnOpen) return;
        this.turnOpen = false;
        this.emit({
            type: 'result',
            subtype: failure ? 'error_during_execution' : 'success',
            is_error: false,
            result: failure ?? '',
            total_cost_usd: this.cost,
        });
    }

    private finish(): void {
        if (this.ended) return;
        this.ended = true;
        const waiting = this.waiting;
        this.waiting = undefined;
        waiting?.({ value: undefined, done: true });
    }

    [Symbol.asyncIterator](): AsyncIterator<any> {
        return {
            next: () => {
                if (this.queue.length > 0) return Promise.resolve({ value: this.queue.shift()!, done: false });
                if (this.ended) return Promise.resolve({ value: undefined, done: true });
                return new Promise((resolve) => {
                    this.waiting = resolve;
                });
            },
            return: () => {
                this.finish();
                return Promise.resolve({ value: undefined, done: true });
            },
        };
    }

    /** Send the panel's messages to OpenCode. */
    private async pump(): Promise<void> {
        try {
            for await (const message of this.opts.prompt) {
                if (this.closed) break;
                const { text, files } = promptContent(message.message?.content);
                this.turnOpen = true;
                await this.host.session.prompt({
                    sessionID: this.sessionID,
                    text,
                    files: files.length > 0 ? files : undefined,
                });
            }
        } catch (e) {
            if (!this.closed) {
                const why = `OpenCode couldn't take the message: ${(e as Error).message}`;
                this.emit({ type: 'system', subtype: 'informational', content: why, level: 'error' });
                this.finishTurn(why);
            }
        }
    }

    /** Read OpenCode's events for this session. */
    private async subscribe(): Promise<void> {
        try {
            const events = this.host.event.subscribe();
            const iterator = events[Symbol.asyncIterator]() as AsyncIterator<any>;
            this.events = iterator;
            while (!this.closed) {
                const next = await iterator.next();
                if (next.done) break;
                this.handle(next.value);
            }
        } catch (e) {
            if (!this.closed) {
                this.finishTurn((e as Error).message);
                this.finish();
            }
        }
    }

    private forSession(event: any): boolean {
        const data = event?.data;
        return data?.sessionID === this.sessionID || data?.form?.sessionID === this.sessionID;
    }

    private handle(event: any): void {
        if (!this.forSession(event)) return;
        const data = event.data;
        switch (event.type) {
            case 'session.execution.started':
                break;
            case 'session.execution.succeeded':
                this.finishTurn();
                break;
            case 'session.execution.failed': {
                const why = data.error?.message ?? 'OpenCode stopped by an error';
                this.emit({ type: 'system', subtype: 'informational', content: why, level: 'error' });
                this.finishTurn(why);
                break;
            }
            case 'session.execution.interrupted':
                this.finishTurn();
                break;
            case 'session.retry.scheduled':
                this.emit({ type: 'system', subtype: 'api_retry', attempt: data.attempt, max_retries: 99 });
                break;
            case 'session.status':
                if (data.status?.type === 'retry') this.emit({ type: 'system', subtype: 'api_retry', attempt: data.status.attempt, max_retries: 99 });
                break;
            case 'session.step.started':
                // The model was set when the session started (or switched).
                break;
            case 'session.text.started':
                this.emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } });
                this.emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', content_block: { type: 'text' } } });
                break;
            case 'session.text.delta':
                this.emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: data.delta } } });
                break;
            case 'session.text.ended':
                if ((data.text ?? '').trim() !== '') this.emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: data.text }] } });
                break;
            case 'session.reasoning.started':
                this.emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } });
                this.emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', content_block: { type: 'thinking' } } });
                break;
            case 'session.reasoning.delta':
                this.emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: data.delta } } });
                break;
            case 'session.reasoning.ended':
                if ((data.text ?? '').trim() !== '') this.emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'thinking', thinking: data.text }] } });
                break;
            case 'session.tool.input.started':
                this.toolNames.set(data.id, data.name);
                break;
            case 'session.tool.called': {
                const name = data.name ?? this.toolNames.get(data.id) ?? 'tool';
                this.toolNames.set(data.id, name);
                this.emit({
                    type: 'assistant',
                    parent_tool_use_id: null,
                    message: { content: [{ type: 'tool_use', id: data.id, name, input: data.input ?? {} }] },
                });
                break;
            }
            case 'session.tool.success':
                this.emit({
                    type: 'user',
                    parent_tool_use_id: null,
                    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: data.id, content: contentText(data.content), is_error: false }] },
                });
                break;
            case 'session.tool.failed':
                this.emit({
                    type: 'user',
                    parent_tool_use_id: null,
                    message: {
                        role: 'user',
                        content: [{ type: 'tool_result', tool_use_id: data.id, content: data.error?.message ?? contentText(data.content), is_error: true }],
                    },
                });
                break;
            case 'session.usage.updated':
                if (typeof data.cost === 'number') this.cost = data.cost;
                break;
            case 'session.compaction.started':
                this.emit({ type: 'system', subtype: 'status', status: 'compacting' });
                break;
            case 'session.compaction.ended':
                this.emit({ type: 'system', subtype: 'compact_boundary' });
                break;
            case 'session.compaction.failed':
                this.emit({ type: 'system', subtype: 'status', status: null });
                this.emit({ type: 'system', subtype: 'informational', content: `Compaction failed: ${data.error?.message ?? ''}`, level: 'warning' });
                break;
            case 'permission.asked':
                void this.askPermission(data);
                break;
            case 'form.created':
                void this.askForm(data.form);
                break;
            case 'session.idle':
                this.finishTurn();
                break;
        }
    }

    /** Ask the panel for permission, then tell OpenCode. */
    private async askPermission(data: any): Promise<void> {
        const resources = Array.isArray(data.resources) ? data.resources : [];
        const input = { ...(data.metadata ?? {}), resources };
        let result: PermissionResult | null | undefined;
        try {
            result = await this.opts.canUseTool(data.action, input, {
                signal: this.abort.signal,
                toolUseID: data.id,
                requestId: data.id,
                title: `The agent wants to use ${data.action}`,
                description: [resources.join(', '), data.message].filter(Boolean).join(' — '),
                displayName: data.action,
            });
        } catch {
            return;
        }
        if (!result) return;
        try {
            if (result.behavior === 'allow') {
                await this.host.permission.reply({
                    sessionID: this.sessionID,
                    requestID: data.id,
                    decision: result.updatedPermissions && result.updatedPermissions.length > 0 ? 'always' : 'once',
                });
            } else {
                await this.host.permission.reply({
                    sessionID: this.sessionID,
                    requestID: data.id,
                    decision: 'reject',
                    message: result.message,
                });
            }
        } catch {
            // The request was withdrawn (interrupted, say).
        }
    }

    /** OpenCode's forms are questions: ask them through the panel's prompt. */
    private async askForm(form: any): Promise<void> {
        const fields = (form?.fields ?? []).filter((f: any) => !f.hidden && f.type !== 'external');
        if (fields.length === 0) return;
        const questions = fields.map((f: any) => ({
            question: f.title ?? f.key,
            header: (f.title ?? f.key).slice(0, 24),
            options: (f.options ?? []).map((o: any) => ({ label: o.label ?? o.value, description: o.description ?? '' })),
            multiSelect: f.type === 'multiselect',
        }));
        let result: PermissionResult | null | undefined;
        try {
            result = await this.opts.canUseTool('AskUserQuestion', { questions, formID: form.id }, { signal: this.abort.signal, toolUseID: form.id, requestId: form.id });
        } catch {
            return;
        }
        if (!result) return;
        if (result.behavior !== 'allow') {
            await this.host.session.form.cancel({ sessionID: this.sessionID, formID: form.id }).catch(() => {});
            return;
        }
        const answers = (result.updatedInput?.answers ?? {}) as Record<string, string>;
        const answer: Record<string, string | string[]> = {};
        for (const f of fields) {
            const value = answers[f.title ?? f.key];
            if (value === undefined) continue;
            const options = f.options ?? [];
            if (f.type === 'multiselect') {
                answer[f.key] = value
                    .split(',')
                    .map((s) => s.trim())
                    .map((label) => options.find((o: any) => (o.label ?? o.value) === label)?.value ?? label);
            } else {
                answer[f.key] = options.find((o: any) => (o.label ?? o.value) === value)?.value ?? value;
            }
        }
        await this.host.session.form.reply({ sessionID: this.sessionID, formID: form.id, answer }).catch(() => {});
    }

    interrupt(): Promise<unknown> {
        return this.host.session.interrupt({ sessionID: this.sessionID });
    }

    async setModel(model?: string): Promise<void> {
        const ref = model === undefined ? undefined : await this.modelRef(model);
        if (!ref) return;
        await this.host.session.switchModel({ sessionID: this.sessionID, model: ref });
    }

    private async modelRef(value: string): Promise<ModelRef | undefined> {
        const parsed = parseModel(value);
        if (parsed) return parsed;
        const result = await this.host.model.list({ location: { directory: this.opts.cwd } });
        const match = (result?.data ?? []).find((m: any) => m.modelID === value || m.name === value || `${m.providerID}/${m.modelID}`.endsWith(`/${value}`));
        return match ? { providerID: match.providerID, id: match.modelID } : undefined;
    }

    async setPermissionMode(): Promise<void> {
        // OpenCode decides its own permissions; its requests come to the
        // panel as prompts.
    }

    async applyFlagSettings(): Promise<void> {
        // OpenCode has no effort setting of its own.
    }

    async supportedModels(): Promise<ModelInfo[]> {
        const result = await this.host.model.list({ location: { directory: this.opts.cwd }, types: ['chat'] });
        return (result?.data ?? []).map((m: any) => ({
            value: modelValue(m),
            resolvedModel: m.modelID,
            displayName: m.name ?? m.modelID,
            description: `${m.providerID ?? ''} · ${m.modelID ?? ''}`,
        }));
    }

    async getContextUsage(): Promise<ContextUsage> {
        const session = await this.host.session.get({ sessionID: this.sessionID });
        const ref = session?.model;
        const models = await this.host.model.list({ location: { directory: this.opts.cwd } });
        const model = (models?.data ?? []).find((m: any) => (!ref || (m.providerID === ref.providerID && m.modelID === ref.id))) ?? models?.data?.[0];
        const usage = session?.tokens ?? {};
        const tokens = (usage.input ?? 0) + (usage.output ?? 0) + (usage.reasoning ?? 0) + (usage.cache?.read ?? 0) + (usage.cache?.write ?? 0);
        const maxTokens = model?.limit?.context ?? 200000;
        return {
            categories: [
                { id: 'messages', name: 'Messages', tokens, color: '', kind: 'used' },
                { id: 'free_space', name: 'Free space', tokens: Math.max(maxTokens - tokens, 0), color: '', kind: 'free' },
            ],
            totalTokens: tokens,
            maxTokens,
            percentage: (tokens / Math.max(maxTokens, 1)) * 100,
        } as unknown as ContextUsage;
    }

    async getUsage(): Promise<UsageInfo> {
        const result = await this.host.experimental.usage.limits({ location: { directory: this.opts.cwd } });
        const info = result?.data;
        if (!info) throw new Error('No usage limits');
        const meter = (m: any) => (m ? { utilization: m.percent, resets_at: new Date(m.resetsAt).toISOString() } : null);
        return {
            session: {},
            subscription_type: info.workspace?.name ?? 'opencode',
            rate_limits_available: Boolean(info.go),
            rate_limits: info.go
                ? {
                      five_hour: meter(info.go.rolling),
                      seven_day: meter(info.go.weekly),
                      seven_day_opus: null,
                      seven_day_sonnet: null,
                      model_scoped: [],
                  }
                : null,
            behaviors: null,
        } as unknown as UsageInfo;
    }

    close(): void {
        this.closed = true;
        this.abort.abort();
        void this.events?.return?.({ value: undefined, done: true });
        this.events = undefined;
        this.finish();
    }
}
