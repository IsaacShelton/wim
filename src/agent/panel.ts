// The agent panel, on the right of the window: Claude Code sessions, each a
// conversation to read and continue, with its model, permission mode,
// effort and context use. Like the file tree, it has its own keys: Normal
// mode reads the conversation (`j`/`k`, `G`, Ctrl+d...) and switches
// sessions and settings; `i` moves to the prompt at the bottom to type.

import { Clipboard } from '../clipboard';
import { KeyInput, charOf } from '../editor/keys';
import { Box, Picker, PickerItem, Run } from '../popup';
import { DrawCmd } from '../protocol';
import { theme } from '../theme';
import { AgentBackend, ContextUsage, ModelInfo, PermissionMode } from './backend';
import { TextInput } from './input';
import { AgentSession, EFFORTS, MODES, Prompt, modeLabel } from './session';
import { PromptView, Row, transcriptRows } from './transcript';

export type PanelFocus = 'Input' | 'Transcript';

/** What the window should do after a key or click in the panel. */
export type PanelAction =
    | { t: 'None' }
    | { t: 'FocusEditor' }
    | { t: 'Hide' }
    | { t: 'ToggleTree' }
    /** `:` was typed: start a command line in the editor. */
    | { t: 'Cmdline' }
    | { t: 'Picker'; picker: Picker<never> };

/** Something clickable in the last frame. */
type Hit =
    | { t: 'Session'; index: number }
    | { t: 'New' }
    | { t: 'Model' }
    | { t: 'Mode' }
    | { t: 'Effort' }
    | { t: 'Context' }
    | { t: 'Choice'; index: number }
    | { t: 'Input' }
    | { t: 'Transcript' };

type SessionChoice = { t: 'New' } | { t: 'Open'; index: number } | { t: 'Resume'; id: string; title: string };

const NONE: PanelAction = { t: 'None' };
/** Rows the prompt grows to before it scrolls. */
const INPUT_ROWS = 8;
/** How often the spinner turns while a session works, in ms. */
const SPIN = 120;
/** Widest a session's tab gets, in columns. */
const TAB_COLS = 24;

const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];

function contains(b: Box, x: number, y: number): boolean {
    return x >= b.left && x < b.right && y >= b.top && y < b.bottom;
}

function width(s: string): number {
    return Array.from(s).length;
}

function cut(s: string, cols: number): string {
    const chars = Array.from(s);
    return chars.length <= cols ? s : chars.slice(0, Math.max(cols - 1, 0)).join('') + '…';
}

/** How long ago a time was, briefly. */
export function ago(time: number, now = Date.now()): string {
    const mins = Math.floor((now - time) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

/** A model id as a name: `claude-opus-5-5` is Opus 5.5. */
function prettyModel(id: string): string {
    const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
    if (!m) return id;
    return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}`;
}

function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function modeColor(mode: PermissionMode | undefined): string {
    switch (mode) {
        case 'acceptEdits':
            return theme.KEYWORD;
        case 'plan':
            return theme.MACRO;
        case 'auto':
            return theme.DIAGNOSTIC_WARN;
        case 'bypassPermissions':
            return theme.ERROR;
        default:
            return theme.COMMENT;
    }
}

/** The color of a kind of context use, as `/context` sorts it. */
function categoryColor(id: string | undefined): string {
    switch (id) {
        case 'system_prompt':
            return theme.COMMENT;
        case 'system_tools':
        case 'system_tools_deferred':
            return theme.FUNCTION;
        case 'mcp_tools':
        case 'mcp_tools_deferred':
        case 'mcp_instructions':
            return theme.MACRO;
        case 'memory_files':
            return theme.TYPE;
        case 'skills':
            return theme.KEYWORD;
        case 'custom_agents':
            return theme.NUMBER;
        case 'messages':
            return theme.MODE_AGENT;
        default:
            return theme.GUTTER;
    }
}

function contextColor(percent: number): string {
    return percent >= 80 ? theme.ERROR : percent >= 50 ? theme.DIAGNOSTIC_WARN : theme.STRING;
}

const HELP: [string, string][] = [
    ['i  a  Enter', 'Type a message'],
    ['Esc', 'Back to reading (from the prompt); to the editor'],
    ['Enter', 'Send (\\ or ⌥ before it: a new line)'],
    ['↑ ↓', 'Earlier messages, in the prompt'],
    ['Ctrl+c', 'Interrupt Claude (or clear the prompt)'],
    ['j k  Ctrl+d Ctrl+u', 'Scroll the conversation'],
    ['gg  G', 'Go to the top / the end'],
    ['Tab  ]  [  1-9', 'Next / previous / Nth session'],
    ['n', 'New session'],
    ['s', 'Sessions: switch, or resume a saved one'],
    ['x', 'Close the session (it can be resumed)'],
    ['m', 'Model'],
    ['p  Shift+Tab', 'Permission mode: pick / cycle'],
    ['e', 'Effort'],
    ['c', 'Context use, by kind'],
    ['y', 'Copy the last reply'],
    ['q', 'Hide the panel (Cmd+L shows it)'],
    ['Ctrl+h', 'To the editor (Ctrl+l comes back)'],
];

/** Draws on the character grid, as the popups do. */
class Canvas {
    constructor(
        readonly cmds: DrawCmd[],
        readonly cw: number,
        readonly lh: number,
    ) {}

    rect(b: Box, color: string, radius = 0): void {
        if (b.right > b.left && b.bottom > b.top) this.cmds.push(['rect', b.left, b.top, b.right - b.left, b.bottom - b.top, color, radius]);
    }

    text(x: number, y: number, s: string, color: string): void {
        if (s !== '') this.cmds.push(['text', x, y, s, color]);
    }

    /** Runs of text from `x`, at most `cols` wide. Returns the columns used. */
    runs(x: number, y: number, runs: readonly Run[], cols: number): number {
        let col = 0;
        for (const [s, color] of runs) {
            const room = cols - col;
            if (room <= 0) break;
            const chars = Array.from(s).slice(0, room);
            this.text(x + col * this.cw, y, chars.join(''), color);
            col += chars.length;
        }
        return col;
    }
}

export interface PanelOptions {
    backend: AgentBackend;
    clipboard: Clipboard;
    /** The working directory, where new sessions start. */
    cwd: () => string;
    /** Repaint soon. */
    refresh: () => void;
    /** A tool changed files: these, or (undefined) perhaps any. */
    onFiles: (paths: string[] | undefined) => void;
}

export class AgentPanel {
    readonly sessions: AgentSession[] = [];
    current = 0;
    focus: PanelFocus = 'Input';
    readonly input = new TextInput();
    /** Where an answer, or what to do instead of a denied tool, is typed. */
    private readonly answer = new TextInput();
    private readonly views = new WeakMap<AgentSession, { scroll: number; follow: boolean }>();
    /** The prompt `promptView` is for, and which of its questions. */
    private promptFor: [Prompt, number] | undefined;
    private readonly promptView = { selected: 0, checked: new Set<number>(), typing: false };
    showContext = false;
    showHelp = false;
    /** The models Claude Code offers, once asked. */
    private models: ModelInfo[] | undefined;
    /** `g` was typed, for `gg`, `gt` and `gT`. */
    private pendingG = false;
    private closeWarned = false;
    /** Shown in place of the hints, until the next key. */
    private message: string | undefined;
    private spinner: NodeJS.Timeout | undefined;
    private hits: [Box, Hit][] = [];
    /** Rows of the conversation shown in the last frame, and in all. */
    private transcriptRows = 10;
    private transcriptTotal = 0;

    constructor(private readonly opts: PanelOptions) {}

    get session(): AgentSession | undefined {
        return this.sessions[this.current];
    }

    /** Some session is waiting for the user to answer a prompt. */
    get needsAttention(): boolean {
        return this.sessions.some((s) => s.prompt !== undefined);
    }

    /** The panel is being shown: have a session to type into. */
    open(): void {
        if (this.sessions.length === 0) this.newSession();
        this.focus = 'Input';
    }

    newSession(resume?: { id: string; title: string }): AgentSession {
        const s = new AgentSession({
            backend: this.opts.backend,
            cwd: this.opts.cwd(),
            resume,
            onChange: () => this.changed(),
            onFiles: this.opts.onFiles,
        });
        this.sessions.push(s);
        this.current = this.sessions.length - 1;
        return s;
    }

    private changed(): void {
        const busy = this.sessions.some((s) => s.running);
        if (busy && !this.spinner) {
            this.spinner = setInterval(() => this.opts.refresh(), SPIN);
            this.spinner.unref();
        } else if (!busy && this.spinner) {
            clearInterval(this.spinner);
            this.spinner = undefined;
        }
        this.opts.refresh();
    }

    private view(s: AgentSession): { scroll: number; follow: boolean } {
        let v = this.views.get(s);
        if (!v) {
            v = { scroll: 0, follow: true };
            this.views.set(s, v);
        }
        return v;
    }

    /** Start the prompt's selection afresh when another prompt (or question)
     * comes up, and bring it into view. */
    private syncPrompt(): void {
        const s = this.session;
        const p = s?.prompt;
        const key: [Prompt, number] | undefined = p && [p, p.t === 'Question' ? p.current : 0];
        if (key?.[0] === this.promptFor?.[0] && key?.[1] === this.promptFor?.[1]) return;
        this.promptFor = key;
        const v = this.promptView;
        v.checked = new Set();
        v.typing = false;
        this.answer.clear();
        v.selected = p?.t === 'Permission' && p.defaultToNo ? Math.max(p.choices.findIndex((c) => !c.allow), 0) : 0;
        if (s && p) this.view(s).follow = true;
    }

    // ----- Keys ----------------------------------------------------------------------

    key(key: KeyInput): PanelAction {
        const s = this.session ?? this.newSession();
        this.syncPrompt();
        this.message = undefined;
        const g = this.pendingG;
        this.pendingG = false;
        if (key.key !== 'x' || key.ctrl) this.closeWarned = false;
        if (s.prompt) {
            const action = this.promptKey(s, s.prompt, key);
            if (action) return action;
        } else if (this.focus === 'Input') {
            return this.inputKey(s, key);
        }
        return this.normalKey(s, key, g);
    }

    /** Ctrl+c: interrupt Claude, or else clear the prompt. */
    interrupt(): void {
        const s = this.session;
        if (s?.running) s.interrupt();
        else if (this.promptView.typing) this.answer.clear();
        else this.input.clear();
    }

    /** Cmd+V. */
    paste(text: string): void {
        if (this.session?.prompt) {
            if (this.promptView.typing) this.answer.insert(text);
            return;
        }
        this.focus = 'Input';
        this.input.insert(text);
    }

    private inputKey(s: AgentSession, key: KeyInput): PanelAction {
        if (key.key === 'Esc') {
            this.focus = 'Transcript';
        } else if (key.key === 'BackTab') {
            s.setMode(s.nextMode());
        } else if (this.input.key(key) === 'Send') {
            const text = this.input.text;
            if (text.trim() === '') return NONE;
            s.send(text);
            this.input.remember(text);
            this.input.clear();
            this.view(s).follow = true;
            this.showHelp = false;
        }
        return NONE;
    }

    /** Keys for a prompt: the arrows (or `j`/`k`) and Enter, or a choice's
     * number. Returns undefined for keys it leaves to Normal mode
     * (scrolling, switching sessions). */
    private promptKey(s: AgentSession, p: Prompt, key: KeyInput): PanelAction | undefined {
        const v = this.promptView;
        if (v.typing) {
            if (key.key === 'Esc') v.typing = false;
            else if (this.answer.key(key) === 'Send') this.submitAnswer(s, p);
            return NONE;
        }
        const count = p.t === 'Permission' ? p.choices.length : p.questions[p.current].options.length + 1;
        const multi = p.t === 'Question' && p.questions[p.current].multiSelect;
        const c = charOf(key);
        const ctrl = key.ctrl ? key.key : undefined;
        if (key.key === 'Esc') {
            s.dismiss();
        } else if (c === 'j' || key.key === 'Down' || ctrl === 'n') {
            v.selected = (v.selected + 1) % count;
        } else if (c === 'k' || key.key === 'Up' || ctrl === 'p') {
            v.selected = (v.selected - 1 + count) % count;
        } else if (key.key === 'Enter') {
            this.pick(s, p, v.selected);
        } else if (c === ' ' && multi) {
            this.toggleChecked(v.selected, count);
        } else if (c !== undefined && /^[1-9]$/.test(c) && Number(c) <= count) {
            const i = Number(c) - 1;
            v.selected = i;
            // A prompt that must not be approved by one stray key only moves
            // to its approving choices.
            if (multi) this.toggleChecked(i, count);
            else if (!(p.t === 'Permission' && p.defaultToNo && p.choices[i].allow)) this.pick(s, p, i);
        } else {
            return undefined;
        }
        return NONE;
    }

    private toggleChecked(i: number, count: number): void {
        const checked = this.promptView.checked;
        // The last choice is typing an answer, which isn't ticked.
        if (i === count - 1) return;
        if (checked.has(i)) checked.delete(i);
        else checked.add(i);
    }

    /** Choose choice `i` of the prompt. */
    private pick(s: AgentSession, p: Prompt, i: number): void {
        const v = this.promptView;
        if (p.t === 'Permission') {
            const choice = p.choices[i];
            if (!choice) return;
            if (choice.feedback) {
                v.typing = true;
                this.answer.clear();
            } else {
                s.choose(choice);
            }
            return;
        }
        const q = p.questions[p.current];
        if (i === q.options.length) {
            v.typing = true;
            this.answer.clear();
            return;
        }
        const picked = q.multiSelect ? [...v.checked].sort((a, b) => a - b) : [];
        s.answer((picked.length > 0 ? picked : [i]).map((j) => q.options[j].label).join(', '));
    }

    private submitAnswer(s: AgentSession, p: Prompt): void {
        const text = this.answer.text;
        if (p.t === 'Permission') {
            const choice = p.choices.find((c) => c.feedback);
            if (choice) s.choose(choice, text);
        } else if (text.trim() !== '') {
            s.answer(text.trim());
        }
    }

    private normalKey(s: AgentSession, key: KeyInput, g: boolean): PanelAction {
        const c = charOf(key);
        const ctrl = key.ctrl ? key.key : undefined;
        const half = Math.max(Math.floor(this.transcriptRows / 2), 1);
        const page = Math.max(this.transcriptRows - 2, 1);
        if (g) {
            if (c === 'g') this.scrollTo(s, 0);
            else if (c === 't') this.cycle(1);
            else if (c === 'T') this.cycle(-1);
            return NONE;
        }
        if (ctrl !== undefined) {
            switch (ctrl) {
                case 'e':
                    this.scrollBy(1);
                    break;
                case 'y':
                    this.scrollBy(-1);
                    break;
                case 'd':
                    this.scrollBy(half);
                    break;
                case 'u':
                    this.scrollBy(-half);
                    break;
                case 'f':
                    this.scrollBy(page);
                    break;
                case 'b':
                    this.scrollBy(-page);
                    break;
                case 'h':
                    return { t: 'FocusEditor' };
                case 'n':
                    return { t: 'ToggleTree' };
            }
            return NONE;
        }
        switch (key.key) {
            case 'Esc':
                return { t: 'FocusEditor' };
            case 'Enter':
                if (!s.prompt) this.focus = 'Input';
                return NONE;
            case 'Down':
                this.scrollBy(1);
                return NONE;
            case 'Up':
                this.scrollBy(-1);
                return NONE;
            case 'PageDown':
                this.scrollBy(page);
                return NONE;
            case 'PageUp':
                this.scrollBy(-page);
                return NONE;
            case 'Tab':
                this.cycle(1);
                return NONE;
            case 'BackTab':
                s.setMode(s.nextMode());
                return NONE;
        }
        if (c !== undefined && /^[1-9]$/.test(c)) {
            if (Number(c) <= this.sessions.length) this.current = Number(c) - 1;
            return NONE;
        }
        switch (c) {
            case 'i':
            case 'a':
            case 'I':
            case 'A':
            case 'o':
                if (!s.prompt) this.focus = 'Input';
                break;
            case 'j':
                this.scrollBy(1);
                break;
            case 'k':
                this.scrollBy(-1);
                break;
            case 'g':
                this.pendingG = true;
                break;
            case 'G':
                this.scrollTo(s, Infinity);
                break;
            case ']':
                this.cycle(1);
                break;
            case '[':
                this.cycle(-1);
                break;
            case 'n':
                this.newSession();
                this.focus = 'Input';
                break;
            case 's':
                return this.sessionPicker();
            case 'x':
                this.closeSession(s);
                break;
            case 'm':
                return this.modelPicker(s);
            case 'p':
                return this.modePicker(s);
            case 'e':
                return this.effortPicker(s);
            case 'c':
                this.showContext = !this.showContext;
                break;
            case '?':
                this.showHelp = !this.showHelp;
                break;
            case 'y':
                this.yankReply(s);
                break;
            case 'q':
                return { t: 'Hide' };
            case ':':
                return { t: 'Cmdline' };
        }
        return NONE;
    }

    private cycle(delta: number): void {
        const n = this.sessions.length;
        if (n > 0) this.current = (((this.current + delta) % n) + n) % n;
    }

    private scrollBy(rows: number): void {
        const s = this.session;
        if (!s) return;
        const v = this.view(s);
        const max = Math.max(this.transcriptTotal - this.transcriptRows, 0);
        if (v.follow) v.scroll = max;
        v.scroll = Math.min(Math.max(v.scroll + rows, 0), max);
        v.follow = v.scroll >= max;
    }

    private scrollTo(s: AgentSession, row: number): void {
        const v = this.view(s);
        v.follow = row === Infinity;
        v.scroll = row === Infinity ? Math.max(this.transcriptTotal - this.transcriptRows, 0) : row;
    }

    /** The mouse wheel over the panel. */
    wheel(rows: number): void {
        this.scrollBy(rows);
    }

    /** `x`: stop and close a session; a working one only on a second `x`. */
    private closeSession(s: AgentSession): void {
        if (s.running && !this.closeWarned) {
            this.closeWarned = true;
            this.message = 'Claude is working: x again stops it and closes the session';
            return;
        }
        this.closeWarned = false;
        s.close();
        this.sessions.splice(this.sessions.indexOf(s), 1);
        if (this.sessions.length === 0) this.newSession();
        this.current = Math.min(this.current, this.sessions.length - 1);
        this.message = `Closed "${cut(s.title, 30)}" (s to resume it)`;
    }

    private yankReply(s: AgentSession): void {
        const reply = [...s.entries].reverse().find((e) => e.t === 'Text');
        if (reply?.t !== 'Text') {
            this.message = 'No reply to copy yet';
            return;
        }
        this.opts.clipboard.setText(reply.text);
        this.message = 'Copied the last reply';
    }

    // ----- Pickers -------------------------------------------------------------------

    private sessionPicker(): PanelAction {
        const items: PickerItem<SessionChoice>[] = [{ label: '+ New session', value: { t: 'New' } }];
        this.sessions.forEach((s, index) => {
            items.push({ label: s.title, detail: s.running ? 'open · working' : 'open', value: { t: 'Open', index } });
        });
        const picker = new Picker<SessionChoice>(
            'Claude Sessions',
            (choice) => {
                if (choice.t === 'New') this.newSession();
                else if (choice.t === 'Open') this.current = choice.index;
                else this.resume(choice.id, choice.title);
                this.focus = 'Input';
            },
            { items, message: 'No sessions' },
        );
        picker.busy = true;
        const open = new Set(this.sessions.map((s) => s.id));
        this.opts.backend.listSessions(this.opts.cwd()).then(
            (past) => {
                for (const p of past) {
                    if (open.has(p.id)) continue;
                    const detail = `${ago(p.modified)}${p.branch ? ` · ${p.branch}` : ''}`;
                    items.push({ label: p.title, detail, value: { t: 'Resume', id: p.id, title: p.title } });
                }
                picker.busy = false;
                picker.setItems(items, 'No sessions', true);
                this.opts.refresh();
            },
            (e: Error) => {
                picker.busy = false;
                picker.setItems(items, `Can't list sessions: ${e.message}`, true);
                this.opts.refresh();
            },
        );
        return { t: 'Picker', picker: picker as unknown as Picker<never> };
    }

    /** Continue a saved session (or switch to it, if it is open). */
    resume(id: string, title: string): void {
        const open = this.sessions.findIndex((s) => s.id === id);
        if (open >= 0) this.current = open;
        else this.newSession({ id, title });
    }

    private modelLabel(s: AgentSession): string {
        const find = (id: string): ModelInfo | undefined => this.models?.find((m) => m.value === id || m.resolvedModel === id);
        if (s.model !== undefined) return find(s.model)?.displayName ?? prettyModel(s.model);
        if (s.activeModel !== undefined) return find(s.activeModel)?.displayName ?? prettyModel(s.activeModel);
        return 'Default model';
    }

    private modelPicker(s: AgentSession): PanelAction {
        const picker = new Picker<ModelInfo>(
            'Model',
            (m) => s.setModel(m.value === 'default' ? undefined : m.value, m.displayName),
            { message: 'Loading models…' },
        );
        const fill = (models: ModelInfo[]): void => {
            const current = s.model ?? 'default';
            picker.setItems(
                models.map((m) => ({ label: m.displayName, detail: `${m.value === current ? '(current) ' : ''}${m.description}`, value: m })),
                'No models',
            );
        };
        if (this.models) {
            fill(this.models);
        } else {
            picker.busy = true;
            s.models().then(
                (models) => {
                    this.models = models;
                    picker.busy = false;
                    fill(models);
                    this.opts.refresh();
                },
                (e: Error) => {
                    picker.busy = false;
                    picker.setItems([], `Can't list models: ${e.message}`);
                    this.opts.refresh();
                },
            );
        }
        return { t: 'Picker', picker: picker as unknown as Picker<never> };
    }

    private modePicker(s: AgentSession): PanelAction {
        const current = s.mode ?? 'default';
        const items = MODES.map((m) => ({
            label: m.label,
            detail: `${m.mode === current ? '(current) ' : ''}${m.description}`,
            value: m.mode,
        }));
        return { t: 'Picker', picker: new Picker<PermissionMode>('Permission Mode', (mode) => s.setMode(mode), { items }) as unknown as Picker<never> };
    }

    private effortPicker(s: AgentSession): PanelAction {
        const levels = [undefined, ...EFFORTS];
        const items = levels.map((e) => ({
            label: e ?? 'default',
            detail: e === s.effort ? '(current)' : e === undefined ? "The model's own" : '',
            value: e,
        }));
        return { t: 'Picker', picker: new Picker('Effort', (e) => s.setEffort(e), { items }) as unknown as Picker<never> };
    }

    // ----- Mouse ---------------------------------------------------------------------

    mouse(x: number, y: number): PanelAction {
        const hit = this.hits.find(([b]) => contains(b, x, y))?.[1];
        const s = this.session;
        this.message = undefined;
        if (!s || !hit) return NONE;
        switch (hit.t) {
            case 'Session':
                this.current = hit.index;
                break;
            case 'New':
                this.newSession();
                this.focus = 'Input';
                break;
            case 'Model':
                return this.modelPicker(s);
            case 'Mode':
                return this.modePicker(s);
            case 'Effort':
                return this.effortPicker(s);
            case 'Context':
                this.showContext = !this.showContext;
                break;
            case 'Choice':
                this.syncPrompt();
                if (s.prompt) {
                    this.promptView.selected = hit.index;
                    this.pick(s, s.prompt, hit.index);
                }
                break;
            case 'Input':
                this.focus = 'Input';
                break;
            case 'Transcript':
                this.focus = 'Transcript';
                break;
        }
        return NONE;
    }

    // ----- Painting ------------------------------------------------------------------

    /** The status line's reminder of the panel, which also shows and hides
     * it: whether Claude is working or waiting for an answer. */
    badge(now: number): { text: string; color: string; bg: string } {
        if (this.needsAttention) return { text: ' ✻ Claude needs you ', color: theme.BG, bg: theme.MODE_AGENT };
        if (this.sessions.some((s) => s.running)) {
            return { text: ` ${SPINNER[Math.floor(now / SPIN) % SPINNER.length]} Claude `, color: theme.MODE_AGENT, bg: theme.STATUS_BG };
        }
        return { text: ' ✻ Claude ', color: theme.COMMENT, bg: theme.STATUS_BG };
    }

    /** Draw the panel in `r`. `focused`: it has the keyboard. */
    paint(cmds: DrawCmd[], r: Box, cw: number, lh: number, focused: boolean, now: number): void {
        const s = this.session;
        this.syncPrompt();
        this.hits = [];
        const cv = new Canvas(cmds, cw, lh);
        cv.rect(r, theme.BG);
        cv.rect({ left: r.left, top: r.top, right: r.left + 1, bottom: r.bottom }, theme.TILDE);
        cmds.push(['clip', r.left, r.top, r.right - r.left, r.bottom - r.top]);
        const x = r.left + cw;
        const cols = Math.max(Math.floor((r.right - x) / cw) - 1, 4);
        let y = this.paintTabs(cv, r, now);
        if (s) {
            y = this.paintSettings(cv, s, x, y, cols);
            if (this.showContext) y = this.paintContext(cv, s.context, x, y, cols);
            cv.rect({ left: r.left + 1, top: y, right: r.right, bottom: y + 1 }, theme.TILDE);
            const inputTop = this.paintInput(cv, s, r, x, cols, focused);
            this.paintTranscript(cv, s, { left: r.left + 1, top: y + 4, right: r.right, bottom: inputTop - 4 }, x, cols, now);
        }
        cmds.push(['unclip']);
    }

    /** One tab per session along the top, and `+` for a new one. Returns
     * where the next row goes. */
    private paintTabs(cv: Canvas, r: Box, now: number): number {
        const { cw, lh } = cv;
        const bar = { left: r.left + 1, top: r.top, right: r.right, bottom: r.top + lh };
        cv.rect(bar, theme.STATUS_BG);
        const room = Math.floor((bar.right - bar.left) / cw) - 3;
        const n = this.sessions.length;
        const titleCols = Math.min(Math.max(Math.floor(room / Math.max(n, 1)) - 4, 6), TAB_COLS);
        const tabCols = (s: AgentSession): number => Math.min(width(s.title), titleCols) + 4;
        // Leave out tabs on the left until the current one fits.
        let first = 0;
        const total = (from: number): number => this.sessions.slice(from, this.current + 1).reduce((sum, s) => sum + tabCols(s), 0);
        while (first < this.current && total(first) > room) first++;
        let tx = bar.left;
        for (let i = first; i < n; i++) {
            const s = this.sessions[i];
            const w = tabCols(s) * cw;
            if (tx + w > bar.left + room * cw && i > this.current) break;
            const tab = { left: tx, top: bar.top, right: tx + w, bottom: bar.bottom };
            const active = i === this.current;
            if (active) {
                cv.rect(tab, theme.BG);
                cv.rect({ ...tab, bottom: tab.top + 2 }, theme.MODE_AGENT);
            }
            let glyph = '•';
            let color: string = theme.COMMENT;
            if (s.prompt) {
                glyph = '!';
                color = theme.DIAGNOSTIC_WARN;
            } else if (s.running) {
                glyph = SPINNER[Math.floor(now / SPIN) % SPINNER.length];
                color = theme.MODE_AGENT;
            }
            cv.text(tx + cw, bar.top, glyph, color);
            cv.text(tx + 3 * cw, bar.top, cut(s.title, titleCols), active ? theme.FG : theme.COMMENT);
            this.hits.push([tab, { t: 'Session', index: i }]);
            tx += w;
        }
        const plus = { left: tx, top: bar.top, right: tx + 3 * cw, bottom: bar.bottom };
        cv.text(tx + cw, bar.top, '+', theme.COMMENT);
        this.hits.push([plus, { t: 'New' }]);
        return bar.bottom;
    }

    /** The session's model, permission mode, effort, context use and cost,
     * each clickable. */
    private paintSettings(cv: Canvas, s: AgentSession, x: number, y: number, cols: number): number {
        const { cw, lh } = cv;
        let col = 0;
        const part = (text: string, color: string, hit?: Hit): void => {
            if (col > 0) {
                cv.text(x + col * cw, y, ' · ', theme.TILDE);
                col += 3;
            }
            const shown = cut(text, Math.max(cols - col, 0));
            cv.text(x + col * cw, y, shown, color);
            if (hit) this.hits.push([{ left: x + col * cw, top: y, right: x + (col + width(shown)) * cw, bottom: y + lh }, hit]);
            col += width(shown);
        };
        part(this.modelLabel(s), theme.FG, { t: 'Model' });
        part(modeLabel(s.mode), modeColor(s.mode), { t: 'Mode' });
        part(s.effort ?? 'effort', s.effort ? theme.FG : theme.COMMENT, { t: 'Effort' });
        const ctx = s.context;
        if (ctx && col + 14 < cols) {
            const percent = Math.round(ctx.percentage);
            part(`${percent}% context`, contextColor(percent), { t: 'Context' });
        } else if (col + 10 < cols) {
            part('context', theme.COMMENT, { t: 'Context' });
        }
        if (s.cost > 0 && col + 9 < cols) part(`$${s.cost.toFixed(2)}`, theme.COMMENT);
        return y + lh;
    }

    /** Context use by kind, as `/context` shows it. */
    private paintContext(cv: Canvas, ctx: ContextUsage | undefined, x: number, y: number, cols: number): number {
        const { cw, lh } = cv;
        if (!ctx) {
            cv.text(x, y, cut('Context use shows once Claude has replied', cols), theme.COMMENT);
            return y + lh;
        }
        // A bar of the whole window, filled by kind.
        const barW = cols * cw;
        let bx = x;
        for (const c of ctx.categories) {
            if (c.kind === 'free' || c.tokens <= 0) continue;
            const w = (c.tokens / Math.max(ctx.maxTokens, 1)) * barW;
            cv.rect({ left: bx, top: y + lh * 0.3, right: bx + w, bottom: y + lh * 0.7 }, categoryColor(c.id));
            bx += w;
        }
        cv.rect({ left: bx, top: y + lh * 0.3, right: x + barW, bottom: y + lh * 0.7 }, theme.TILDE);
        y += lh;
        const total = `${formatTokens(ctx.totalTokens)} / ${formatTokens(ctx.maxTokens)} tokens (${Math.round(ctx.percentage)}%)`;
        cv.text(x, y, cut(total, cols), theme.FG);
        y += lh;
        for (const c of ctx.categories) {
            if (c.tokens <= 0) continue;
            const amount = `${formatTokens(c.tokens)}  ${((c.tokens / Math.max(ctx.maxTokens, 1)) * 100).toFixed(1)}%`;
            cv.text(x, y, '■', c.kind === 'free' ? theme.TILDE : categoryColor(c.id));
            cv.text(x + 2 * cw, y, cut(c.name, Math.max(cols - width(amount) - 3, 4)), c.kind === 'deferred' ? theme.COMMENT : theme.FG);
            cv.text(x + (cols - width(amount)) * cw, y, amount, theme.COMMENT);
            y += lh;
        }
        return y;
    }

    /** The prompt at the bottom and the hints under it. Returns its top. */
    private paintInput(cv: Canvas, s: AgentSession, r: Box, x: number, cols: number, focused: boolean): number {
        const { cw, lh } = cv;
        const p = s.prompt;
        const typing = p !== undefined && this.promptView.typing;
        const input = typing ? this.answer : this.input;
        const active = focused && (typing || (this.focus === 'Input' && !p));
        const textCols = Math.max(cols - 2, 1);
        // Wrap the lines, and find the cursor's row and column among them.
        const { lines, line: cursorLine, col: cursorCol } = input.lines();
        const rows: string[][] = [];
        let cursorRow = 0;
        let cursorX = 0;
        lines.forEach((chars, i) => {
            const start = rows.length;
            for (let at = 0; at === 0 || at < chars.length; at += textCols) rows.push(chars.slice(at, at + textCols));
            if (i === cursorLine) {
                cursorRow = start + Math.floor(cursorCol / textCols);
                cursorX = cursorCol % textCols;
                if (cursorRow >= rows.length) rows.push([]);
            }
        });
        const shownRows = Math.min(rows.length, INPUT_ROWS);
        const first = Math.min(Math.max(cursorRow - shownRows + 1, 0), rows.length - shownRows);
        const hintY = r.bottom - lh;
        const top = hintY - shownRows * lh - 4;
        cv.rect({ left: r.left + 1, top: top - 1, right: r.right, bottom: top }, active ? theme.MODE_AGENT : theme.TILDE);
        this.hits.push([{ left: r.left + 1, top, right: r.right, bottom: hintY }, { t: 'Input' }]);
        const ty = top + 2;
        cv.text(x, ty, '❯', active ? theme.MODE_AGENT : theme.COMMENT);
        if (input.text === '') {
            let placeholder: string;
            if (typing) placeholder = p?.t === 'Question' ? 'Type your answer' : 'Tell Claude what to do instead';
            else if (p) placeholder = 'Answer the prompt above';
            else if (active) placeholder = 'Ask Claude…  (Enter sends, \\ or ⌥ Enter for a new line)';
            else placeholder = 'Press i to type a message';
            cv.text(x + 2 * cw, ty, cut(placeholder, textCols), theme.COMMENT);
        }
        for (let i = 0; i < shownRows; i++) cv.text(x + 2 * cw, ty + i * lh, rows[first + i].join(''), theme.FG);
        if (active) {
            const cx = x + (2 + cursorX) * cw;
            const cy = ty + (cursorRow - first) * lh;
            cv.rect({ left: cx, top: cy, right: cx + 2, bottom: cy + lh }, theme.CURSOR);
        }
        // Under it: a message, the permission mode if it isn't the default,
        // or the keys.
        let hint: Run;
        if (this.message) hint = [this.message, theme.FG];
        else if (s.mode && s.mode !== 'default') hint = [`⏵⏵ ${modeLabel(s.mode).toLowerCase()} on (shift+tab to cycle)`, modeColor(s.mode)];
        else hint = [this.focus === 'Input' && !p ? 'Esc for Normal mode · ? for keys' : 'i to type · ? for keys', theme.COMMENT];
        cv.text(x, hintY, cut(hint[0], cols), hint[1]);
        return top;
    }

    private paintTranscript(cv: Canvas, s: AgentSession, area: Box, x: number, cols: number, now: number): void {
        const { lh } = cv;
        let rows: Row[];
        if (this.showHelp) rows = helpRows(cols);
        else if (s.entries.length === 0 && !s.live && !s.prompt && !s.loading && !s.running) rows = welcomeRows(s, cols);
        else rows = transcriptRows(s, this.promptView as PromptView, cols, now);
        const visible = Math.max(Math.floor((area.bottom - area.top) / lh), 1);
        const max = Math.max(rows.length - visible, 0);
        const v = this.view(s);
        if (v.follow || this.showHelp) v.scroll = this.showHelp ? 0 : max;
        v.scroll = Math.min(v.scroll, max);
        this.transcriptRows = visible;
        this.transcriptTotal = rows.length;
        cv.cmds.push(['clip', area.left, area.top, area.right - area.left, area.bottom - area.top]);
        for (let i = 0; i < visible && v.scroll + i < rows.length; i++) {
            const row = rows[v.scroll + i];
            const y = area.top + i * lh;
            if (row.bg) cv.rect({ left: area.left, top: y, right: area.right, bottom: y + lh }, row.bg);
            cv.runs(x, y, row.runs, cols);
            if (row.choice !== undefined) this.hits.push([{ left: area.left, top: y, right: area.right, bottom: y + lh }, { t: 'Choice', index: row.choice }]);
        }
        // Where the view is in the conversation.
        if (rows.length > visible) {
            const h = area.bottom - area.top;
            const thumb = Math.max((visible / rows.length) * h, lh / 2);
            const top = area.top + (v.scroll / Math.max(max, 1)) * (h - thumb);
            cv.rect({ left: area.right - 4, top, right: area.right - 1, bottom: top + thumb }, theme.GUTTER, 1);
        }
        cv.cmds.push(['unclip']);
        this.hits.push([area, { t: 'Transcript' }]);
    }

    /** Stop every session's process (Wim is exiting). */
    dispose(): void {
        if (this.spinner) clearInterval(this.spinner);
        this.spinner = undefined;
        for (const s of this.sessions) s.close();
    }
}

function welcomeRows(s: AgentSession, cols: number): Row[] {
    const dim = (text: string): Row => ({ runs: [[cut(text, cols), theme.COMMENT]] });
    return [
        { runs: [['✻ ', theme.MODE_AGENT], ['Claude Code', theme.FG]] },
        { runs: [] },
        dim('Ask Claude to explain, change or plan your code.'),
        dim(`Working in ${s.cwd}`),
        { runs: [] },
        dim('i to type · s to resume a session · m model · p mode · ? keys'),
    ];
}

function helpRows(cols: number): Row[] {
    const keyCols = Math.max(...HELP.map(([k]) => width(k))) + 2;
    return [
        { runs: [['Keys in the Claude panel', theme.FG]] },
        { runs: [] },
        ...HELP.map(([keys, what]): Row => ({ runs: [[keys.padEnd(keyCols), theme.MODE_AGENT], [cut(what, Math.max(cols - keyCols, 4)), theme.FG]] })),
        { runs: [] },
        { runs: [[cut('? again to go back', cols), theme.COMMENT]] },
    ];
}
