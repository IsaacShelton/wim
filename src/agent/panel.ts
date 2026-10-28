// The agent panel, on the right of the window: Claude Code sessions, each a
// conversation to read and continue, with its model, permission mode,
// effort and context use. Like the file tree, it has its own keys: Normal
// mode reads the conversation (`j`/`k`, `G`, Ctrl+d...) and switches
// sessions and settings; `i` moves to the prompt at the bottom to type.

import * as path from 'node:path';
import { Clipboard } from '../clipboard';
import { KeyInput, charOf } from '../editor/keys';
import { PRESET_NAMES, Preset, PresetName } from '../config';
import { findFiles } from '../finder';
import { formatBytes } from '../image';
import { Box, Picker, PickerItem, Run } from '../popup';
import { DrawCmd } from '../protocol';
import { theme } from '../theme';
import { Attachment, imageAttachment, readAttachment } from './attachment';
import { AgentBackend, ContextUsage, ModelInfo, PermissionMode, UsageInfo } from './backend';
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
    | { t: 'Preset' }
    | { t: 'Context' }
    | { t: 'Usage' }
    | { t: 'Choice'; index: number }
    | { t: 'Input' }
    /** An attached image's ✕. */
    | { t: 'Detach'; index: number }
    | { t: 'Transcript' };

type SessionChoice = { t: 'New' } | { t: 'Open'; index: number } | { t: 'Resume'; id: string; title: string };

const NONE: PanelAction = { t: 'None' };
/** Rows the prompt grows to before it scrolls. */
const INPUT_ROWS = 8;
/** How often the spinner turns while a session works, in ms. */
const SPIN = 120;
/** How often the cache countdown is redrawn, in ms. */
const CACHE_TICK = 15000;
/** Columns of the context and usage meters. */
const METER_COLS = 8;
/** Widest a session's tab gets, in columns. */
const TAB_COLS = 24;

/** Files the image picker lists: the types Claude takes. */
const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i;

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
    if (!m) return /^[a-z]+$/.test(id) ? id[0].toUpperCase() + id.slice(1) : id;
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

/** The preset's color: the cooler, the lighter the task. */
function presetColor(name: PresetName | undefined): string {
    switch (name) {
        case 'low':
            return theme.FUNCTION;
        case 'medium':
            return theme.TYPE;
        case 'high':
            return theme.MODE_AGENT;
        default:
            return theme.COMMENT;
    }
}

/** How long until `time` (ms), briefly. */
function until(time: number, now: number): string {
    const mins = Math.ceil((time - now) / 60000);
    if (mins >= 1440) return `${Math.round(mins / 1440)}d`;
    if (mins >= 60) return `${Math.floor(mins / 60)}h${mins % 60 > 0 ? ` ${mins % 60}m` : ''}`;
    return `${Math.max(mins, 1)}m`;
}

function contextColor(percent: number): string {
    return percent >= 80 ? theme.ERROR : percent >= 50 ? theme.DIAGNOSTIC_WARN : theme.STRING;
}

const HELP: [string, string][] = [
    ['i  a  Enter', 'Type a message'],
    ['S', 'Clear the prompt and type a new message'],
    ['Esc  Ctrl+c', 'Back to reading (from the prompt); to the editor'],
    ['Enter', 'Send (\\ or ⌥ before it: a new line)'],
    ['↑ ↓', 'Earlier messages, in the prompt'],
    ['Ctrl+x', 'Interrupt the agent'],
    ['f', 'Attach an image (or drop one on the panel)'],
    ['Backspace', 'Remove the last image, in an empty prompt'],
    ['/clear', 'A new session in place of this one, with its settings'],
    ['j k  Ctrl+d Ctrl+u', 'Scroll the conversation'],
    ['gg  G', 'Go to the top / the end'],
    ['Tab Shift+Tab  ]  [  1-9', 'Next / previous / Nth session'],
    ['n', 'New session'],
    ['s', 'Sessions: switch, or resume a saved one'],
    ['x', 'Close the session (it can be resumed)'],
    ['m', 'Model'],
    ['p', 'Permission mode'],
    ['e', 'Effort'],
    ['L  M  H', 'Preset for a low / medium / high complexity task'],
    ['P', 'Presets: pick one'],
    ['c', 'Context use, by kind'],
    ['u', 'Plan usage limits'],
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
    /** The model and effort for low, medium and high complexity tasks. */
    presets: Record<PresetName, Preset>;
    /** The preset new sessions start with. */
    defaultPreset?: PresetName;
    /** How long the prompt cache lasts after a request, in minutes. */
    cacheMinutes: number;
}

export class AgentPanel {
    readonly sessions: AgentSession[] = [];
    current = 0;
    focus: PanelFocus = 'Input';
    readonly input = new TextInput();
    /** Images to send with the next message. */
    readonly attachments: Attachment[] = [];
    /** Where an answer, or what to do instead of a denied tool, is typed. */
    private readonly answer = new TextInput();
    private readonly views = new WeakMap<AgentSession, { scroll: number; follow: boolean }>();
    /** The prompt `promptView` is for, and which of its questions. */
    private promptFor: [Prompt, number] | undefined;
    private readonly promptView = { selected: 0, checked: new Set<number>(), typing: false };
    showContext = false;
    showUsage = false;
    showHelp = false;
    private cacheTimer: NodeJS.Timeout | undefined;
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
        const s = this.createSession(resume);
        this.sessions.push(s);
        this.current = this.sessions.length - 1;
        if (!resume && this.opts.defaultPreset) this.usePreset(s, this.opts.defaultPreset);
        return s;
    }

    private createSession(resume?: { id: string; title: string }): AgentSession {
        return new AgentSession({
            backend: this.opts.backend,
            cwd: this.opts.cwd(),
            resume,
            onChange: () => this.changed(),
            onFiles: this.opts.onFiles,
        });
    }

    /** `/clear`: close the session and start a new one in its tab, with the
     * same model, permission mode and effort. */
    private clearSession(s: AgentSession): void {
        const fresh = this.createSession();
        fresh.model = s.model;
        fresh.activeModel = s.activeModel;
        fresh.mode = s.mode;
        fresh.effort = s.effort;
        fresh.preset = s.preset;
        // The plan's limits are the same for every session.
        fresh.usage = s.usage;
        s.close();
        this.sessions[this.sessions.indexOf(s)] = fresh;
        this.message = s.id === undefined ? 'Cleared' : `Cleared "${cut(s.title, 30)}" (s to resume it)`;
    }

    /** Switch a session to a preset's model and effort. */
    usePreset(s: AgentSession, name: PresetName): void {
        const preset = this.opts.presets[name];
        s.applyPreset(name, preset, this.presetLabel(preset));
    }

    private presetLabel(p: Preset): string {
        return p.model === undefined ? 'default model' : this.modelName(p.model);
    }

    /** When the session's prompt cache runs out, if it has one. */
    private cacheExpiry(s: AgentSession): number | undefined {
        return s.lastReply === undefined ? undefined : s.lastReply + this.opts.cacheMinutes * 60000;
    }

    private changed(): void {
        // Redraw the cache countdown while some session's cache is warm.
        const now = Date.now();
        const warm = this.sessions.some((s) => (this.cacheExpiry(s) ?? 0) > now);
        if (warm && !this.cacheTimer) {
            this.cacheTimer = setInterval(() => {
                this.opts.refresh();
                if (!this.sessions.some((s) => (this.cacheExpiry(s) ?? 0) > Date.now())) this.stopCacheTimer();
            }, CACHE_TICK);
            this.cacheTimer.unref();
        }
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
        // Ctrl+x interrupts Claude from either mode (Ctrl+c is Esc, as in
        // the editor).
        if (key.ctrl && key.key === 'x') {
            if (s.running) s.interrupt();
            else this.message = "The agent isn't working on anything";
            return NONE;
        }
        // Ctrl+h goes to the editor from either mode, the prompt too (the
        // panel is the rightmost window, so Ctrl+l stays).
        if (key.ctrl && key.key === 'h') return { t: 'FocusEditor' };
        if (key.ctrl && key.key === 'l') return NONE;
        // Ctrl+e hides the panel again, as it shows it.
        if (key.ctrl && key.key === 'e') return { t: 'Hide' };
        if (s.prompt) {
            const action = this.promptKey(s, s.prompt, key);
            if (action) return action;
        } else if (this.focus === 'Input') {
            return this.inputKey(s, key);
        }
        return this.normalKey(s, key, g);
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

    /** An image dropped on the panel: its bytes in base64, or why the window
     * couldn't read it. */
    drop(name: string, data: string | undefined, error?: string): void {
        const a = data !== undefined ? imageAttachment(name, Buffer.from(data, 'base64')) : (error ?? `Can't read ${name}`);
        if (this.session?.prompt) {
            this.message = typeof a === 'string' ? a : 'Answer the prompt first, then drop the image again';
            return;
        }
        this.focus = 'Input';
        this.attach(a);
    }

    private attach(a: Attachment | string): void {
        if (typeof a === 'string') {
            this.message = a;
            return;
        }
        this.attachments.push(a);
        this.message = `Attached ${a.name} (${formatBytes(a.bytes)})`;
    }

    private inputKey(s: AgentSession, key: KeyInput): PanelAction {
        if (key.key === 'Esc') {
            this.focus = 'Transcript';
        } else if (key.key === 'Tab' || key.key === 'BackTab') {
            // Sessions switch from the prompt too, so Tab isn't typed into it.
            this.cycle(key.key === 'Tab' ? 1 : -1);
        } else if (key.key === 'Backspace' && !key.alt && this.input.text === '' && this.attachments.length > 0) {
            const a = this.attachments.pop();
            this.message = `Removed ${a?.name}`;
        } else if (this.input.key(key) === 'Send') {
            const text = this.input.text;
            const images = this.attachments.splice(0);
            if (text.trim() === '' && images.length === 0) return NONE;
            if (images.length === 0 && /^\/clear\s*$/.test(text.trim())) this.clearSession(s);
            else s.send(text, images);
            if (text.trim() !== '') this.input.remember(text);
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
                this.cycle(-1);
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
            case '/':
                // Starts a slash command, as in the prompt's own typing.
                if (!s.prompt) {
                    this.focus = 'Input';
                    this.input.insert('/');
                }
                break;
            case 'S':
                // As in Vim: start the prompt afresh.
                if (!s.prompt) {
                    this.input.clear();
                    this.focus = 'Input';
                }
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
            case 'f':
                if (s.prompt) break;
                return this.imagePicker();
            case 'x':
                this.closeSession(s);
                break;
            case 'm':
                return this.modelPicker(s);
            case 'p':
                return this.modePicker(s);
            case 'e':
                return this.effortPicker(s);
            case 'L':
                this.usePreset(s, 'low');
                break;
            case 'M':
                this.usePreset(s, 'medium');
                break;
            case 'H':
                this.usePreset(s, 'high');
                break;
            case 'P':
                return this.presetPicker(s);
            case 'c':
                this.showContext = !this.showContext;
                break;
            case 'u':
                this.toggleUsage(s);
                break;
            case '?':
                this.showHelp = !this.showHelp;
                break;
            case 'y':
                this.yankReply(s);
                break;
            case 'q':
                if (this.showHelp) {
                    this.showHelp = false;
                    return NONE;
                }
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
            this.message = 'The agent is working: x again stops it and closes the session';
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

    /** `f`: an image file under the working directory to attach. */
    private imagePicker(): PanelAction {
        const root = this.opts.cwd();
        const items: PickerItem<string>[] = [];
        const picker = new Picker<string>(
            'Attach an Image',
            (file) => {
                this.attach(readAttachment(path.join(root, file)));
                this.focus = 'Input';
            },
            { preview: true, message: 'No images', onClose: () => search.cancel() },
        );
        picker.busy = true;
        const search = findFiles(
            root,
            (files) => {
                for (const file of files) {
                    if (IMAGE_FILE.test(file)) items.push({ label: file, truncateStart: true, preview: { file: path.join(root, file) }, value: file });
                }
                picker.setItems(items, 'No images', true);
                this.opts.refresh();
            },
            (error) => {
                picker.busy = false;
                picker.setItems(items, error ?? 'No images', true);
                this.opts.refresh();
            },
        );
        return { t: 'Picker', picker: picker as unknown as Picker<never> };
    }

    private sessionPicker(): PanelAction {
        const items: PickerItem<SessionChoice>[] = [{ label: '+ New session', value: { t: 'New' } }];
        this.sessions.forEach((s, index) => {
            items.push({ label: s.title, detail: s.running ? 'open · working' : 'open', value: { t: 'Open', index } });
        });
        const picker = new Picker<SessionChoice>(
            'Agent Sessions',
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

    private modelName(id: string): string {
        return this.models?.find((m) => m.value === id || m.resolvedModel === id)?.displayName ?? prettyModel(id);
    }

    private modelLabel(s: AgentSession): string {
        if (s.model !== undefined) return this.modelName(s.model);
        if (s.activeModel !== undefined) return this.modelName(s.activeModel);
        return 'Default model';
    }

    private toggleUsage(s: AgentSession): void {
        this.showUsage = !this.showUsage;
        if (this.showUsage) void s.refreshUsage();
    }

    private presetPicker(s: AgentSession): PanelAction {
        const items = PRESET_NAMES.map((name) => {
            const p = this.opts.presets[name];
            const what = [this.presetLabel(p), p.effort ? `${p.effort} effort` : undefined].filter(Boolean).join(', ');
            return { label: name, detail: `${name === s.preset ? '(current) ' : ''}${what}`, value: name };
        });
        return { t: 'Picker', picker: new Picker<PresetName>('Preset', (name) => this.usePreset(s, name), { items }) as unknown as Picker<never> };
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
            case 'Preset':
                return this.presetPicker(s);
            case 'Context':
                this.showContext = !this.showContext;
                break;
            case 'Usage':
                this.toggleUsage(s);
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
            case 'Detach':
                this.attachments.splice(hit.index, 1);
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
        if (this.needsAttention) return { text: ' ✻ Agents need you ', color: theme.BG, bg: theme.MODE_AGENT };
        if (this.sessions.some((s) => s.running)) {
            return { text: ` ${SPINNER[Math.floor(now / SPIN) % SPINNER.length]} Agents `, color: theme.MODE_AGENT, bg: theme.STATUS_BG };
        }
        return { text: ' ✻ Agents ', color: theme.COMMENT, bg: theme.STATUS_BG };
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
            y = this.paintSettings(cv, s, x, y, cols, now);
            if (this.showContext) y = this.paintContext(cv, s.context, x, y, cols);
            if (this.showUsage) y = this.paintUsage(cv, s.usage, x, y, cols, now);
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

    /** Two rows, each part clickable where it can be changed: the session's
     * preset, model, permission mode and effort; then its context use, plan
     * usage, prompt cache and cost. */
    private paintSettings(cv: Canvas, s: AgentSession, x: number, y: number, cols: number, now: number): number {
        const { cw, lh } = cv;
        const row = (rowY: number) => {
            let col = 0;
            /** A part, after a separator; `gauge` draws a meter before it. */
            const part = (text: string, color: string, hit?: Hit, gauge?: number): void => {
                const meter = gauge === undefined ? 0 : METER_COLS + 1;
                if (col > 0) {
                    cv.text(x + col * cw, rowY, ' · ', theme.TILDE);
                    col += 3;
                }
                const left = x + col * cw;
                if (gauge !== undefined) {
                    this.meter(cv, left, rowY, gauge, color);
                    col += meter;
                }
                const shown = cut(text, Math.max(cols - col, 0));
                cv.text(x + col * cw, rowY, shown, color);
                col += width(shown);
                if (hit) this.hits.push([{ left, top: rowY, right: x + col * cw, bottom: rowY + lh }, hit]);
            };
            return { part, room: () => cols - col };
        };

        const top = row(y);
        top.part(s.preset ?? 'no preset', presetColor(s.preset), { t: 'Preset' });
        top.part(this.modelLabel(s), theme.FG, { t: 'Model' });
        top.part(modeLabel(s.mode), modeColor(s.mode), { t: 'Mode' });
        top.part(s.effort ?? 'effort', s.effort ? theme.FG : theme.COMMENT, { t: 'Effort' });

        const bottom = row(y + lh);
        const ctx = s.context;
        if (ctx) {
            const percent = Math.round(ctx.percentage);
            bottom.part(`${percent}% context`, contextColor(percent), { t: 'Context' }, percent);
        } else {
            bottom.part('context', theme.COMMENT, { t: 'Context' });
        }
        const limit = this.worstLimit(s.usage);
        if (limit && bottom.room() > METER_COLS + 12) {
            const percent = Math.round(limit.utilization);
            bottom.part(`${percent}% ${limit.label}`, contextColor(percent), { t: 'Usage' }, percent);
        }
        const expiry = this.cacheExpiry(s);
        if (expiry !== undefined && bottom.room() > 12) {
            const left = expiry - now;
            if (left <= 0) bottom.part('cache cold', theme.ERROR);
            else bottom.part(`cache ${left < 60000 ? '<1m' : until(expiry, now)}`, left < 60000 ? theme.DIAGNOSTIC_WARN : theme.STRING);
        }
        if (s.cost > 0 && bottom.room() > 9) bottom.part(`$${s.cost.toFixed(2)}`, theme.COMMENT);
        return y + 2 * lh;
    }

    /** A small bar for a percentage (0-100). */
    private meter(cv: Canvas, left: number, y: number, percent: number, color: string, cols = METER_COLS): void {
        const { cw, lh } = cv;
        const w = cols * cw;
        const box = { left, top: y + lh * 0.32, right: left + w, bottom: y + lh * 0.68 };
        cv.rect(box, theme.TILDE, 2);
        cv.rect({ ...box, right: left + (w * Math.min(Math.max(percent, 0), 100)) / 100 }, color, 2);
    }

    /** The plan limit closest to running out: 5-hour or weekly. */
    private worstLimit(usage: UsageInfo | undefined): { label: string; utilization: number } | undefined {
        const limits = usage?.rate_limits;
        if (!limits) return undefined;
        const found = [
            { label: '5h', utilization: limits.five_hour?.utilization },
            { label: '7d', utilization: limits.seven_day?.utilization },
        ].filter((l): l is { label: string; utilization: number } => typeof l.utilization === 'number');
        return found.sort((a, b) => b.utilization - a.utilization)[0];
    }

    /** The plan's usage limits, as `/usage` shows them. */
    private paintUsage(cv: Canvas, usage: UsageInfo | undefined, x: number, y: number, cols: number, now: number): number {
        const { cw, lh } = cv;
        if (!usage) {
            cv.text(x, y, cut('Usage limits show once the agent has replied', cols), theme.COMMENT);
            return y + lh;
        }
        const limits = usage.rate_limits;
        if (!usage.rate_limits_available || !limits) {
            cv.text(x, y, cut("Plan limits don't apply to this login (they are for Claude subscriptions)", cols), theme.COMMENT);
            return y + lh;
        }
        const windows: { label: string; utilization: number | null; resets: string | null }[] = [
            { label: '5-hour', utilization: limits.five_hour?.utilization ?? null, resets: limits.five_hour?.resets_at ?? null },
            { label: 'Weekly', utilization: limits.seven_day?.utilization ?? null, resets: limits.seven_day?.resets_at ?? null },
            { label: 'Weekly Opus', utilization: limits.seven_day_opus?.utilization ?? null, resets: limits.seven_day_opus?.resets_at ?? null },
            { label: 'Weekly Sonnet', utilization: limits.seven_day_sonnet?.utilization ?? null, resets: limits.seven_day_sonnet?.resets_at ?? null },
            ...(limits.model_scoped ?? []).map((m) => ({ label: `Weekly ${m.display_name}`, utilization: m.utilization, resets: m.resets_at })),
        ].filter((w) => w.utilization !== null);
        const plan = usage.subscription_type ? ` (${usage.subscription_type})` : '';
        cv.text(x, y, cut(`Plan usage limits${plan}`, cols), theme.FG);
        y += lh;
        const labelCols = Math.min(Math.max(...windows.map((w) => width(w.label)), 0) + 1, Math.floor(cols / 3));
        for (const w of windows) {
            const percent = Math.round(w.utilization ?? 0);
            const resets = w.resets ? Date.parse(w.resets) : NaN;
            const reset = Number.isFinite(resets) ? (resets > now ? `resets in ${until(resets, now)}` : 'reset') : '';
            const label = cut(w.label, labelCols - 1);
            cv.text(x, y, label, theme.FG);
            const barCols = Math.min(METER_COLS, Math.max(cols - labelCols - 5, 0));
            this.meter(cv, x + labelCols * cw, y, percent, contextColor(percent), barCols);
            const rest = `${String(percent).padStart(3)}%  ${reset}`;
            cv.text(x + (labelCols + barCols + 1) * cw, y, cut(rest, Math.max(cols - labelCols - barCols - 1, 0)), theme.COMMENT);
            y += lh;
        }
        if (windows.length === 0) {
            cv.text(x, y, 'No limits reported', theme.COMMENT);
            y += lh;
        }
        const extra = limits.extra_usage;
        if (extra?.is_enabled) {
            const used = extra.utilization !== null ? `${Math.round(extra.utilization)}% of the monthly limit used` : 'on';
            cv.text(x, y, cut(`Extra usage: ${used}`, cols), theme.COMMENT);
            y += lh;
        }
        return y;
    }

    /** Context use by kind, as `/context` shows it. */
    private paintContext(cv: Canvas, ctx: ContextUsage | undefined, x: number, y: number, cols: number): number {
        const { cw, lh } = cv;
        if (!ctx) {
            cv.text(x, y, cut('Context use shows once the agent has replied', cols), theme.COMMENT);
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
        // Images to send with the message, above it, each with a ✕.
        const shelf = !typing && this.attachments.length > 0 ? lh + 4 : 0;
        cv.rect({ left: r.left + 1, top: top - shelf - 1, right: r.right, bottom: top - shelf }, active ? theme.MODE_AGENT : theme.TILDE);
        if (shelf > 0) this.paintAttachments(cv, top - shelf + 2, x, cols);
        this.hits.push([{ left: r.left + 1, top: top - shelf, right: r.right, bottom: hintY }, { t: 'Input' }]);
        const ty = top + 2;
        cv.text(x, ty, '❯', active ? theme.MODE_AGENT : theme.COMMENT);
        if (input.text === '') {
            let placeholder: string;
            if (typing) placeholder = p?.t === 'Question' ? 'Type your answer' : 'Tell the agent what to do instead';
            else if (p) placeholder = 'Answer the prompt above';
            else if (active) placeholder = 'Ask the agent…  (Enter sends, \\ or ⌥ Enter for a new line)';
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
        else if (s.mode && s.mode !== 'default') hint = [`⏵⏵ ${modeLabel(s.mode).toLowerCase()} on (p to change)`, modeColor(s.mode)];
        else hint = [this.focus === 'Input' && !p ? 'Esc for Normal mode · ? for keys' : 'i to type · ? for keys', theme.COMMENT];
        cv.text(x, hintY, cut(hint[0], cols), hint[1]);
        return top - shelf;
    }

    /** The attached images, in a row: `▣ name ✕`. */
    private paintAttachments(cv: Canvas, y: number, x: number, cols: number): void {
        const { cw, lh } = cv;
        let col = 0;
        this.attachments.forEach((a, index) => {
            const label = cut(a.name, 24);
            const w = width(label) + 6;
            if (col + w > cols) return;
            const left = x + col * cw;
            cv.rect({ left, top: y, right: left + (w - 1) * cw, bottom: y + lh }, theme.CURSOR_LINE, 3);
            cv.text(left + cw / 2, y, '▣', theme.MODE_AGENT);
            cv.text(left + cw * 2, y, label, theme.FG);
            const close = left + (w - 3) * cw;
            cv.text(close, y, '✕', theme.COMMENT);
            this.hits.push([{ left: close - cw / 2, top: y, right: close + cw * 1.5, bottom: y + lh }, { t: 'Detach', index }]);
            col += w;
        });
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

    private stopCacheTimer(): void {
        if (this.cacheTimer) clearInterval(this.cacheTimer);
        this.cacheTimer = undefined;
    }

    /** Stop every session's process (Wim is exiting). */
    dispose(): void {
        if (this.spinner) clearInterval(this.spinner);
        this.spinner = undefined;
        this.stopCacheTimer();
        for (const s of this.sessions) s.close();
    }
}

function welcomeRows(s: AgentSession, cols: number): Row[] {
    const dim = (text: string): Row => ({ runs: [[cut(text, cols), theme.COMMENT]] });
    return [
        { runs: [['✻ ', theme.MODE_AGENT], ['Agents', theme.FG]] },
        { runs: [] },
        dim('Ask the agent to explain, change or plan your code.'),
        dim(`Working in ${s.cwd}`),
        { runs: [] },
        dim('i to type · s to resume a session · m model · p mode · ? keys'),
    ];
}

function helpRows(cols: number): Row[] {
    const keyCols = Math.max(...HELP.map(([k]) => width(k))) + 2;
    return [
        { runs: [['Keys in the agents panel', theme.FG]] },
        { runs: [] },
        ...HELP.map(([keys, what]): Row => ({ runs: [[keys.padEnd(keyCols), theme.MODE_AGENT], [cut(what, Math.max(cols - keyCols, 4)), theme.FG]] })),
        { runs: [] },
        { runs: [[cut('? again to go back', cols), theme.COMMENT]] },
    ];
}
