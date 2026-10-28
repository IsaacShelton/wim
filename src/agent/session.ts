// One Claude Code session: the conversation as the agent panel shows it, the
// process behind it, and the questions it is waiting on (permission to use a
// tool, or AskUserQuestion). The process starts with the first message, and
// starts again, resuming the session, if it has stopped.

import {
    AgentBackend,
    AgentQuery,
    CanUseTool,
    ContextUsage,
    EffortLevel,
    ModelInfo,
    PermissionMode,
    PermissionResult,
    PermissionUpdate,
    SDKMessage,
    SDKUserMessage,
    UsageInfo,
} from './backend';
import type { Preset, PresetName } from '../config';
import type { Attachment } from './attachment';

/** One item of the conversation. */
export type Entry =
    | { t: 'User'; text: string }
    /** The assistant's reply, in Markdown. */
    | { t: 'Text'; text: string }
    | { t: 'Thinking'; text: string }
    | { t: 'Tool'; id: string; name: string; input: Record<string, unknown>; result?: ToolResult }
    | { t: 'Notice'; text: string; error?: boolean };

export interface ToolResult {
    text: string;
    error: boolean;
}

export interface PermissionChoice {
    label: string;
    allow: boolean;
    /** Permission rules (or a mode change) to apply, so it isn't asked again. */
    updates?: PermissionUpdate[];
    /** Denies with what the user types next. */
    feedback?: boolean;
}

export interface Question {
    question: string;
    header: string;
    options: { label: string; description: string }[];
    multiSelect: boolean;
}

/** What the session is waiting for the user to decide. */
export type Prompt =
    | {
          t: 'Permission';
          tool: string;
          input: Record<string, unknown>;
          title: string;
          description?: string;
          choices: PermissionChoice[];
          /** Approving takes the arrows and Enter, not a single key. */
          defaultToNo: boolean;
          resolve: (result: PermissionResult) => void;
      }
    | {
          t: 'Question';
          input: Record<string, unknown>;
          questions: Question[];
          /** The question being asked. */
          current: number;
          answers: Record<string, string>;
          resolve: (result: PermissionResult) => void;
      };

/** Permission modes, in the order the picker lists them. */
export const MODES: { mode: PermissionMode; label: string; description: string }[] = [
    { mode: 'default', label: 'Default', description: 'Ask before edits and commands' },
    { mode: 'acceptEdits', label: 'Accept edits', description: 'Edit files without asking' },
    { mode: 'plan', label: 'Plan mode', description: 'Read and plan, change nothing' },
    { mode: 'auto', label: 'Auto', description: 'A classifier approves safe actions' },
    { mode: 'bypassPermissions', label: 'Bypass permissions', description: 'Never ask: everything is allowed' },
    { mode: 'dontAsk', label: "Don't ask", description: 'Deny anything not already allowed' },
];

export const EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function modeLabel(mode: PermissionMode | undefined): string {
    return MODES.find((m) => m.mode === mode)?.label ?? 'Default';
}

/** Tools that change the files they name, and Bash, which may change any. */
const FILE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

/** How much of Claude Code's error output to keep for messages. */
const STDERR_KEEP = 2000;

/** A content block from the Messages API, loosely. */
interface Block {
    type: string;
    text?: string;
    thinking?: string;
    id?: string;
    name?: string;
    input?: unknown;
    tool_use_id?: string;
    content?: unknown;
    is_error?: boolean;
}

/** Messages waiting to be read, for the SDK's streaming input. */
class Channel<T> implements AsyncIterable<T> {
    private readonly items: T[] = [];
    private waiting: ((r: IteratorResult<T>) => void) | undefined;
    private ended = false;

    push(item: T): void {
        if (this.ended) return;
        const waiting = this.waiting;
        this.waiting = undefined;
        if (waiting) waiting({ value: item, done: false });
        else this.items.push(item);
    }

    end(): void {
        this.ended = true;
        const waiting = this.waiting;
        this.waiting = undefined;
        waiting?.({ value: undefined, done: true });
    }

    [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
            next: () => {
                if (this.items.length > 0) return Promise.resolve({ value: this.items.shift()!, done: false });
                if (this.ended) return Promise.resolve({ value: undefined, done: true });
                return new Promise((resolve) => {
                    this.waiting = resolve;
                });
            },
            return: () => {
                this.end();
                return Promise.resolve({ value: undefined, done: true });
            },
        };
    }
}

export interface SessionOptions {
    backend: AgentBackend;
    cwd: string;
    /** A saved session to continue, with its title. */
    resume?: { id: string; title: string };
    /** Called whenever anything shown changes. */
    onChange: () => void;
    /** A tool changed files: these, or (undefined) perhaps any. */
    onFiles: (paths: string[] | undefined) => void;
}

export class AgentSession {
    readonly cwd: string;
    /** Claude Code's id for the session, once known. */
    id: string | undefined;
    title: string;
    entries: Entry[] = [];
    /** The reply (or thinking) as it streams in, until the whole of it
     * arrives. */
    live: { t: 'Text' | 'Thinking'; text: string } | undefined;
    /** A turn is in progress. */
    running = false;
    /** When the turn started, and roughly how many tokens have come back. */
    turnStart = 0;
    turnTokens = 0;
    /** What Claude Code is doing besides answering (compacting, retrying). */
    status: string | undefined;
    /** The saved conversation is being read. */
    loading = false;
    /** The model asked for (`opus`, or a model id); undefined for Claude
     * Code's default. */
    model: string | undefined;
    /** The model the session reported using. */
    activeModel: string | undefined;
    mode: PermissionMode | undefined;
    effort: EffortLevel | undefined;
    /** The preset the model and effort were last set from, until either is
     * changed on its own. */
    preset: PresetName | undefined;
    context: ContextUsage | undefined;
    /** The plan's usage limits, as last asked. */
    usage: UsageInfo | undefined;
    /** When the API last answered, which is when the prompt cache was last
     * refreshed (undefined before the first reply). */
    lastReply: number | undefined;
    /** What this session has cost since Wim started it, in US dollars. */
    cost = 0;
    /** Questions waiting for the user, the first one shown. */
    prompts: Prompt[] = [];
    /** Changes with anything shown, so layouts can be cached. */
    version = 0;
    private query: AgentQuery | undefined;
    private input: Channel<SDKUserMessage> | undefined;
    private starting: Promise<AgentQuery | undefined> | undefined;
    private readonly tools = new Map<string, Extract<Entry, { t: 'Tool' }>>();
    private stderr = '';
    /** Interrupted, until the turn's result comes; and whether the
     * conversation says so yet. */
    private interrupting = false;
    private interruptNoted = false;
    private closed = false;

    constructor(private readonly opts: SessionOptions) {
        this.cwd = opts.cwd;
        this.id = opts.resume?.id;
        this.title = opts.resume?.title ?? 'New session';
        if (opts.resume) void this.loadHistory(opts.resume.id);
    }

    get prompt(): Prompt | undefined {
        return this.prompts[0];
    }

    /** The process is running (between turns too). */
    get started(): boolean {
        return this.query !== undefined;
    }

    private changed(): void {
        this.version++;
        this.opts.onChange();
    }

    private notice(text: string, error = false): void {
        this.entries.push({ t: 'Notice', text, error });
        this.changed();
    }

    private async loadHistory(id: string): Promise<void> {
        this.loading = true;
        this.changed();
        try {
            const messages = await this.opts.backend.history(id, this.cwd);
            const entries = this.entries;
            this.entries = [];
            for (const m of messages) {
                if (m.parentToolUseId !== null || m.type === 'system') continue;
                const content = (m.message as { content?: unknown } | undefined)?.content;
                this.addContent(m.type, content, false);
            }
            // Anything sent while it was loading comes after.
            this.entries.push(...entries);
        } catch (e) {
            this.entries.unshift({ t: 'Notice', text: `Can't read the session: ${(e as Error).message}`, error: true });
        }
        this.loading = false;
        this.changed();
    }

    /** Send a message (or a slash command), with any images, starting
     * Claude Code if needed. */
    send(text: string, images: readonly Attachment[] = []): void {
        if (this.closed || (text.trim() === '' && images.length === 0)) return;
        const shown = images.map((i) => `[Image: ${i.name}]`).join(' ');
        this.entries.push({ t: 'User', text: shown === '' ? text : text.trim() === '' ? shown : `${shown}\n${text}` });
        if (this.title === 'New session') this.title = (text.trim() === '' ? shown : text).split('\n')[0].slice(0, 60);
        if (!this.running) {
            this.turnStart = Date.now();
            this.turnTokens = 0;
        }
        this.running = true;
        this.changed();
        void this.ensureStarted().then((q) => {
            if (!q) {
                this.running = false;
                this.changed();
                return;
            }
            const content: SDKUserMessage['message']['content'] =
                images.length === 0
                    ? text
                    : [
                          ...images.map((i) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mime, data: i.data } })),
                          ...(text.trim() === '' ? [] : [{ type: 'text' as const, text }]),
                      ];
            this.input?.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });
        });
    }

    /** Start Claude Code (resuming the session, if it has an id). */
    ensureStarted(): Promise<AgentQuery | undefined> {
        if (this.query) return Promise.resolve(this.query);
        if (this.closed) return Promise.resolve(undefined);
        this.starting ??= this.start().finally(() => {
            this.starting = undefined;
        });
        return this.starting;
    }

    private async start(): Promise<AgentQuery | undefined> {
        const input = new Channel<SDKUserMessage>();
        this.stderr = '';
        let query: AgentQuery;
        try {
            query = await this.opts.backend.start({
                cwd: this.cwd,
                prompt: input,
                resume: this.id,
                model: this.model,
                permissionMode: this.mode,
                effort: this.effort,
                canUseTool: this.canUseTool,
                stderr: (data) => {
                    this.stderr = (this.stderr + data).slice(-STDERR_KEEP);
                },
            });
        } catch (e) {
            this.notice(`Can't start the agent: ${(e as Error).message}`, true);
            return undefined;
        }
        if (this.closed) {
            query.close();
            return undefined;
        }
        this.query = query;
        this.input = input;
        void this.read(query, input);
        return query;
    }

    /** Take in the session's messages until its process ends. */
    private async read(query: AgentQuery, input: Channel<SDKUserMessage>): Promise<void> {
        try {
            for await (const m of query) {
                if (this.closed) break;
                this.handle(m);
            }
        } catch (e) {
            if (!this.closed) {
                const detail = this.stderr.trim().split('\n').slice(-3).join(' ');
                this.notice(`The agent stopped: ${(e as Error).message}${detail ? ` (${detail})` : ''}`, true);
            }
        }
        input.end();
        if (this.query === query) {
            this.query = undefined;
            this.input = undefined;
        }
        this.running = false;
        this.live = undefined;
        this.status = undefined;
        this.dropPrompts();
        this.changed();
    }

    private handle(m: SDKMessage): void {
        switch (m.type) {
            case 'system':
                this.system(m);
                break;
            case 'stream_event':
                if (m.parent_tool_use_id === null) this.stream(m.event as unknown as StreamEvent);
                break;
            case 'assistant':
                if (m.parent_tool_use_id !== null) break;
                // What was said before an interrupt still comes, after it.
                if (!this.interrupting) this.running = true;
                this.live = undefined;
                this.lastReply = Date.now();
                this.addContent('assistant', m.message.content, true);
                if (m.error && m.error !== 'max_output_tokens') this.notice(`API error: ${m.error}`, true);
                break;
            case 'user':
                if (m.parent_tool_use_id === null) this.addContent('user', m.message.content, true);
                break;
            case 'result':
                this.result(m);
                break;
            default:
                return;
        }
        this.changed();
    }

    private system(m: Extract<SDKMessage, { type: 'system' }>): void {
        switch (m.subtype) {
            case 'init':
                this.id = m.session_id;
                this.activeModel = m.model;
                this.mode = m.permissionMode;
                void this.refreshContext();
                void this.refreshUsage();
                break;
            case 'status':
                if (m.permissionMode) this.mode = m.permissionMode;
                this.status = m.status === 'compacting' ? 'Compacting' : undefined;
                break;
            case 'compact_boundary':
                this.entries.push({ t: 'Notice', text: 'Conversation compacted' });
                break;
            case 'local_command_output':
                if (m.content.trim() !== '') this.entries.push({ t: 'Notice', text: m.content.trim() });
                break;
            case 'informational':
                this.entries.push({ t: 'Notice', text: m.content, error: m.level === 'warning' });
                break;
            case 'api_retry':
                this.status = `Retrying (${m.attempt}/${m.max_retries})`;
                break;
        }
    }

    private stream(event: StreamEvent): void {
        switch (event.type) {
            case 'message_start':
                this.lastReply = Date.now();
                this.live = undefined;
                this.status = undefined;
                break;
            case 'content_block_start': {
                const type = event.content_block?.type;
                this.live = type === 'text' ? { t: 'Text', text: '' } : type === 'thinking' ? { t: 'Thinking', text: '' } : undefined;
                break;
            }
            case 'content_block_delta': {
                const d = event.delta;
                const text = d?.type === 'text_delta' ? d.text : d?.type === 'thinking_delta' ? d.thinking : d?.type === 'input_json_delta' ? d.partial_json : undefined;
                if (text === undefined) break;
                this.turnTokens += text.length / 4;
                if (this.live && d?.type !== 'input_json_delta') this.live.text += text;
                break;
            }
        }
    }

    private result(m: Extract<SDKMessage, { type: 'result' }>): void {
        this.running = false;
        this.live = undefined;
        this.status = undefined;
        if (typeof m.total_cost_usd === 'number') this.cost = m.total_cost_usd;
        if (this.interrupting) {
            this.noteInterrupted();
            this.interrupting = false;
        } else if (m.subtype !== 'success') {
            const why: Record<string, string> = {
                error_max_turns: 'Stopped: too many turns',
                error_max_budget_usd: 'Stopped: over budget',
                error_during_execution: 'Stopped by an error',
            };
            this.entries.push({ t: 'Notice', text: why[m.subtype] ?? `Stopped: ${m.subtype}`, error: true });
        } else if (m.is_error) {
            this.entries.push({ t: 'Notice', text: m.result || 'Error', error: true });
        }
        void this.refreshContext();
        void this.refreshUsage();
        const id = this.id;
        if (id !== undefined) {
            this.opts.backend.title(id, this.cwd).then(
                (title) => {
                    if (title && title !== this.title) {
                        this.title = title;
                        this.changed();
                    }
                },
                () => {},
            );
        }
    }

    private async refreshContext(): Promise<void> {
        const q = this.query;
        if (!q) return;
        try {
            this.context = await q.getContextUsage({ detail: 'summary' });
            this.changed();
        } catch {
            // Older versions of Claude Code can't say.
        }
    }

    /** Ask for the plan's usage limits. */
    async refreshUsage(): Promise<void> {
        const q = this.query;
        if (!q?.getUsage) return;
        try {
            this.usage = await q.getUsage();
            this.changed();
        } catch {
            // Not available (an API key has no plan limits).
        }
    }

    /** Add a message's content blocks to the conversation. `live` messages
     * (not history) may have changed files. */
    private addContent(role: 'user' | 'assistant', content: unknown, live: boolean): void {
        if (typeof content === 'string') {
            if (role === 'user') this.userText(content);
            else if (content.trim() !== '') this.entries.push({ t: 'Text', text: content });
            return;
        }
        if (!Array.isArray(content)) return;
        for (const block of content as Block[]) {
            switch (block.type) {
                case 'text':
                    if (role === 'user') this.userText(block.text ?? '');
                    else if ((block.text ?? '').trim() !== '') this.entries.push({ t: 'Text', text: block.text ?? '' });
                    break;
                case 'thinking':
                    if ((block.thinking ?? '').trim() !== '') this.entries.push({ t: 'Thinking', text: block.thinking ?? '' });
                    break;
                case 'tool_use': {
                    const input = block.input && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : {};
                    const entry: Extract<Entry, { t: 'Tool' }> = { t: 'Tool', id: block.id ?? '', name: block.name ?? '?', input };
                    this.tools.set(entry.id, entry);
                    this.entries.push(entry);
                    break;
                }
                case 'tool_result': {
                    const tool = this.tools.get(block.tool_use_id ?? '');
                    if (!tool) break;
                    tool.result = { text: resultText(block.content), error: Boolean(block.is_error) };
                    if (live && !tool.result.error) this.toolDone(tool);
                    break;
                }
                case 'image':
                    if (role === 'user') this.entries.push({ t: 'User', text: '[Image]' });
                    break;
            }
        }
    }

    private toolDone(tool: Extract<Entry, { t: 'Tool' }>): void {
        if (tool.name === 'Bash') {
            this.opts.onFiles(undefined);
            return;
        }
        if (!FILE_TOOLS.includes(tool.name)) return;
        const file = tool.input.file_path ?? tool.input.notebook_path;
        if (typeof file === 'string') this.opts.onFiles([file]);
    }

    /** A user message from a transcript: slash commands as typed, their
     * output as notices, and what Claude Code adds for the model left out. */
    private userText(raw: string): void {
        const command = /<command-name>([^<]*)<\/command-name>/.exec(raw);
        if (command) {
            const args = /<command-args>([^<]*)<\/command-args>/.exec(raw)?.[1].trim();
            this.entries.push({ t: 'User', text: `${command[1].trim()}${args ? ' ' + args : ''}` });
            return;
        }
        const output = /<local-command-std(?:out|err)>([\s\S]*?)<\/local-command-std(?:out|err)>/.exec(raw);
        if (output) {
            if (output[1].trim() !== '') this.entries.push({ t: 'Notice', text: output[1].trim() });
            return;
        }
        const text = raw
            .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
            .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
            .trim();
        if (text === '') return;
        if (/^\[Request interrupted by user[^\]]*\]$/.test(text)) {
            this.noteInterrupted();
            return;
        }
        this.entries.push({ t: 'User', text });
    }

    // ----- Permission and questions -------------------------------------------------

    private readonly canUseTool: CanUseTool = (toolName, input, options) =>
        new Promise<PermissionResult>((resolve) => {
            let done = false;
            const finish = (result: PermissionResult): void => {
                if (done) return;
                done = true;
                this.prompts = this.prompts.filter((p) => p !== prompt);
                resolve(result);
                this.changed();
            };
            let prompt: Prompt;
            if (toolName === 'AskUserQuestion' && Array.isArray(input.questions)) {
                prompt = { t: 'Question', input, questions: input.questions as Question[], current: 0, answers: {}, resolve: finish };
            } else {
                const choices: PermissionChoice[] = [{ label: 'Yes', allow: true }];
                const suggestions = options.suggestions ?? [];
                if (suggestions.length > 0 && !options.suppressAlwaysAllowRule) {
                    choices.push({ label: `Yes, and ${describeUpdates(suggestions)}`, allow: true, updates: suggestions });
                }
                choices.push({ label: 'No', allow: false });
                choices.push({ label: 'No, and tell the agent what to do instead', allow: false, feedback: true });
                prompt = {
                    t: 'Permission',
                    tool: toolName,
                    input,
                    title: options.title ?? `The agent wants to use ${options.displayName ?? toolName}`,
                    description: options.description ?? options.decisionReason,
                    choices,
                    defaultToNo: Boolean(options.defaultToNo),
                    resolve: finish,
                };
            }
            options.signal.addEventListener('abort', () => finish({ behavior: 'deny', message: 'Interrupted' }));
            this.prompts.push(prompt);
            this.changed();
        });

    /** Answer the permission prompt with one of its choices (and, for a
     * `feedback` choice, what the user typed). */
    choose(choice: PermissionChoice, feedback = ''): void {
        const p = this.prompt;
        if (p?.t !== 'Permission') return;
        if (choice.allow) {
            p.resolve({ behavior: 'allow', updatedInput: p.input, updatedPermissions: choice.updates });
        } else if (choice.feedback && feedback.trim() !== '') {
            p.resolve({ behavior: 'deny', message: `The user doesn't want to proceed with this tool use. They said: ${feedback.trim()}` });
        } else {
            // As in the terminal, a plain "no" stops the turn for new
            // instructions.
            p.resolve({ behavior: 'deny', message: "The user doesn't want to proceed with this tool use.", interrupt: true });
            this.entries.push({ t: 'Notice', text: `Denied ${p.tool}` });
        }
    }

    /** Answer the current question of an AskUserQuestion prompt; after the
     * last one, the answers go back to Claude. */
    answer(text: string): void {
        const p = this.prompt;
        if (p?.t !== 'Question') return;
        const q = p.questions[p.current];
        p.answers[q.question] = text;
        p.current++;
        if (p.current < p.questions.length) {
            this.changed();
            return;
        }
        p.resolve({ behavior: 'allow', updatedInput: { ...p.input, answers: p.answers } });
    }

    /** Decline the prompt shown (Esc). */
    dismiss(): void {
        const p = this.prompt;
        if (p?.t === 'Permission') this.choose({ label: 'No', allow: false });
        else p?.resolve({ behavior: 'deny', message: 'The user declined to answer.' });
    }

    private dropPrompts(): void {
        for (const p of [...this.prompts]) p.resolve({ behavior: 'deny', message: 'The session ended' });
    }

    // ----- Controls ------------------------------------------------------------------

    /** Say the turn was interrupted, once: Claude Code says so in the
     * conversation, after what was said before it, and if it doesn't, the
     * turn's result does. */
    private noteInterrupted(): void {
        if (this.interrupting && this.interruptNoted) return;
        this.interruptNoted = this.interrupting;
        this.entries.push({ t: 'Notice', text: 'Interrupted' });
    }

    interrupt(): void {
        if (!this.running) return;
        this.dropPrompts();
        this.running = false;
        this.live = undefined;
        const q = this.query;
        if (!q) {
            this.notice('Interrupted');
            return;
        }
        this.interrupting = true;
        this.interruptNoted = false;
        this.changed();
        q.interrupt().catch((e: Error) => this.notice(`Can't interrupt: ${e.message}`, true));
    }

    /** Use another model from the next reply on. */
    setModel(model: string | undefined, label: string): void {
        this.model = model;
        this.preset = undefined;
        this.changed();
        this.query?.setModel(model).then(
            () => this.notice(`Model set to ${label}`),
            (e: Error) => this.notice(`Can't change the model: ${e.message}`, true),
        );
    }

    setMode(mode: PermissionMode): void {
        const before = this.mode;
        this.mode = mode;
        this.changed();
        this.query?.setPermissionMode(mode).catch((e: Error) => {
            this.mode = before;
            this.notice(`Can't switch to ${modeLabel(mode)}: ${e.message}`, true);
        });
    }

    setEffort(effort: EffortLevel | undefined): void {
        this.effort = effort;
        this.preset = undefined;
        this.changed();
        this.query?.applyFlagSettings({ effortLevel: effort ?? null }).catch((e: Error) => this.notice(`Can't change the effort: ${e.message}`, true));
    }

    /** Use a preset's model and effort, for this and later turns. */
    applyPreset(name: PresetName, preset: Preset, label: string): void {
        this.model = preset.model;
        this.effort = preset.effort;
        this.preset = name;
        this.changed();
        const q = this.query;
        if (!q) return;
        Promise.all([q.setModel(preset.model), q.applyFlagSettings({ effortLevel: preset.effort ?? null })]).then(
            () => this.notice(`Preset ${name}: ${label}${preset.effort ? `, ${preset.effort} effort` : ''}`),
            (e: Error) => this.notice(`Can't apply the ${name} preset: ${e.message}`, true),
        );
    }

    /** The models Claude Code offers (starting it, to ask). */
    async models(): Promise<ModelInfo[]> {
        const q = await this.ensureStarted();
        return q ? q.supportedModels() : [];
    }

    /** Stop the session's process. It stays on disk, to resume later. */
    close(): void {
        this.closed = true;
        this.dropPrompts();
        this.input?.end();
        this.query?.close();
        this.query = undefined;
        this.running = false;
    }
}

/** The parts of a streaming event Wim reads. */
interface StreamEvent {
    type: string;
    content_block?: { type: string };
    delta?: { type: string; text?: string; thinking?: string; partial_json?: string };
}

/** A tool result's text. */
function resultText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return (content as Block[])
        .map((b) => (b.type === 'text' ? (b.text ?? '') : b.type === 'image' ? '[Image]' : ''))
        .filter((s) => s !== '')
        .join('\n');
}

/** What applying permission suggestions does, to finish "Yes, and …". */
export function describeUpdates(updates: readonly PermissionUpdate[]): string {
    const where: Record<string, string> = {
        session: ' for this session',
        localSettings: ' in this project',
        projectSettings: ' in this project (shared settings)',
        userSettings: ' in every project',
    };
    return updates
        .map((u) => {
            switch (u.type) {
                case 'addRules':
                case 'replaceRules': {
                    const rules = u.rules.map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName)).join(', ');
                    return `don't ask again for ${rules}${where[u.destination] ?? ''}`;
                }
                case 'setMode':
                    return `switch to ${modeLabel(u.mode)}`;
                case 'addDirectories':
                    return `allow access to ${u.directories.join(', ')}`;
                default:
                    return 'update permissions';
            }
        })
        .join('; ');
}
