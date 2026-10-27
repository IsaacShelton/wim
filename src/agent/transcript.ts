// A session's conversation as rows of colored text for the agent panel, laid
// out like Claude Code's terminal: the user's messages on a band, replies as
// Markdown, tool calls with a line or two of their results, and the prompt
// that is waiting for an answer.

import * as path from 'node:path';

import { markdownLines } from '../lsp/markdown';
import { Run, wrapRuns } from '../popup';
import { theme, themeName } from '../theme';
import { AgentSession, Entry, Prompt } from './session';

/** One row of the transcript. */
export interface Row {
    runs: Run[];
    /** A band behind the row (the user's messages). */
    bg?: string;
    /** Clicking the row picks this choice of the prompt. */
    choice?: number;
}

/** Result lines shown under a tool call. */
const RESULT_LINES = 3;
/** Lines of a diff or file shown under an edit, or in a permission prompt. */
const PREVIEW_LINES = 10;

const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];

function cut(s: string, cols: number): string {
    const chars = Array.from(s);
    return chars.length <= cols ? s : chars.slice(0, Math.max(cols - 1, 0)).join('') + '…';
}

/** Wrap `runs` to `cols`, with `first` before the first row and as many
 * spaces before the others. */
function hanging(first: Run, runs: Run[], cols: number, bg?: string): Row[] {
    const indent = Array.from(first[0]).length;
    return wrapRuns(runs, Math.max(cols - indent, 1)).map((line, i) => ({
        runs: [i === 0 ? first : [' '.repeat(indent), theme.FG], ...line],
        bg,
    }));
}

function plainRows(text: string, color: string, cols: number, prefix = '  '): Row[] {
    return text.split('\n').flatMap((line) => hanging([prefix, color], [[line, color]], cols));
}

/** A path as short as it can be: relative to the session's directory. */
function shortPath(file: unknown, cwd: string): string {
    if (typeof file !== 'string') return '';
    const rel = path.relative(cwd, file);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file;
}

/** A tool's name as shown: MCP tools without their prefix. */
function toolName(name: string): string {
    const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
    return mcp ? `${mcp[1]} · ${mcp[2]}` : name;
}

/** What a tool call is about, for its header: the command, file, pattern... */
export function toolSummary(name: string, input: Record<string, unknown>, cwd: string): string {
    const s = (v: unknown): string => (typeof v === 'string' ? v.split('\n')[0] : '');
    switch (name) {
        case 'Bash':
            return s(input.command);
        case 'Read':
        case 'Write':
        case 'Edit':
        case 'MultiEdit':
            return shortPath(input.file_path, cwd);
        case 'NotebookEdit':
            return shortPath(input.notebook_path, cwd);
        case 'Glob':
        case 'Grep': {
            const where = typeof input.path === 'string' ? ` in ${shortPath(input.path, cwd)}` : '';
            return `${s(input.pattern)}${where}`;
        }
        case 'WebFetch':
            return s(input.url);
        case 'WebSearch':
            return s(input.query);
        case 'Task':
        case 'Agent':
            return s(input.description);
        case 'TodoWrite':
            return '';
        default: {
            const first = Object.values(input).find((v) => typeof v === 'string');
            return s(first);
        }
    }
}

/** Removed and added lines between two texts, without the lines they share
 * at either end. */
function diffRows(before: string, after: string, cols: number, max: number): Row[] {
    const a = before.split('\n');
    const b = after.split('\n');
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let end = 0;
    while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
    const lines: Run[] = [
        ...a.slice(start, a.length - end).map((l): Run => [`- ${l}`, theme.ERROR]),
        ...b.slice(start, b.length - end).map((l): Run => [`+ ${l}`, theme.STRING]),
    ];
    const rows = lines.slice(0, max).map((r): Row => ({ runs: [['    ', theme.FG], [cut(r[0], cols - 4), r[1]]] }));
    if (lines.length > max) rows.push({ runs: [[`    … +${lines.length - max} lines`, theme.COMMENT]] });
    return rows;
}

function lineCount(text: string): number {
    return text === '' ? 0 : text.replace(/\n$/, '').split('\n').length;
}

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** The rows for a tool call: a header, then its result. */
function toolRows(e: Extract<Entry, { t: 'Tool' }>, cwd: string, cols: number): Row[] {
    const r = e.result;
    const bullet: Run = ['● ', r ? (r.error ? theme.ERROR : theme.STRING) : theme.COMMENT];
    const summary = toolSummary(e.name, e.input, cwd);
    const name = toolName(e.name);
    const header: Run[] = [[name, theme.FG]];
    if (summary !== '') header.push([`(${cut(summary, Math.max(cols - Array.from(name).length - 4, 8))})`, theme.COMMENT]);
    const rows: Row[] = [{ runs: [bullet, ...header] }];
    const under = (text: string, color: string = theme.COMMENT): Row => ({ runs: [['  └ ', theme.COMMENT], [cut(text, cols - 4), color]] });
    if (e.name === 'TodoWrite' && Array.isArray(e.input.todos)) {
        for (const todo of e.input.todos as { content?: string; status?: string }[]) {
            const done = todo.status === 'completed';
            const mark = done ? '☒ ' : todo.status === 'in_progress' ? '◼ ' : '☐ ';
            const color = done ? theme.COMMENT : todo.status === 'in_progress' ? theme.FUNCTION : theme.FG;
            rows.push({ runs: [['    ', theme.FG], [mark, color], [cut(todo.content ?? '', cols - 6), color]] });
        }
        return rows;
    }
    if (!r) return rows;
    if (r.error) {
        const lines = r.text.split('\n');
        rows.push(under(lines[0] ?? 'Error', theme.ERROR));
        for (const l of lines.slice(1, RESULT_LINES)) rows.push({ runs: [['    ', theme.FG], [cut(l, cols - 4), theme.ERROR]] });
        return rows;
    }
    switch (e.name) {
        case 'Read':
            rows.push(under(`Read ${plural(lineCount(r.text), 'line')}`));
            return rows;
        case 'Write':
            rows.push(under(`Wrote ${plural(lineCount(String(e.input.content ?? '')), 'line')}`));
            return rows;
        case 'Edit':
            rows.push(under('Updated'));
            rows.push(...diffRows(String(e.input.old_string ?? ''), String(e.input.new_string ?? ''), cols, PREVIEW_LINES));
            return rows;
        case 'Glob':
        case 'Grep':
            rows.push(under(`Found ${plural(lineCount(r.text), 'result')}`));
            return rows;
    }
    const lines = r.text.replace(/\n+$/, '').split('\n');
    if (lines.length === 1 && lines[0] === '') {
        rows.push(under('(no output)'));
        return rows;
    }
    rows.push(under(lines[0]));
    for (const l of lines.slice(1, RESULT_LINES)) rows.push({ runs: [['    ', theme.FG], [cut(l, cols - 4), theme.COMMENT]] });
    if (lines.length > RESULT_LINES) rows.push({ runs: [[`    … +${lines.length - RESULT_LINES} lines`, theme.COMMENT]] });
    return rows;
}

function entryRows(e: Entry, cwd: string, cols: number): Row[] {
    switch (e.t) {
        case 'User':
            return e.text.split('\n').flatMap((line, i) => hanging([i === 0 ? '❯ ' : '  ', theme.COMMENT], [[line, theme.FG]], cols, theme.CURSOR_LINE));
        case 'Text':
            return markdownLines(e.text).flatMap((line, i) => hanging([i === 0 ? '● ' : '  ', theme.FG], line, cols));
        case 'Thinking': {
            const rows = plainRows(e.text, theme.COMMENT, cols);
            const shown = rows.slice(0, RESULT_LINES);
            if (rows.length > RESULT_LINES) shown.push({ runs: [['  …', theme.COMMENT]] });
            return [{ runs: [['✻ ', theme.COMMENT], ['Thinking', theme.COMMENT]] }, ...shown];
        }
        case 'Tool':
            return toolRows(e, cwd, cols);
        case 'Notice':
            return plainRows(e.text, e.error ? theme.ERROR : theme.COMMENT, cols, e.error ? '✗ ' : '  ');
    }
}

/** Laid-out entries, kept until the width, the colors or the entry change. */
const cache = new WeakMap<Entry, { key: string; rows: Row[] }>();

function cachedRows(e: Entry, cwd: string, cols: number): Row[] {
    const key = `${cols}|${themeName()}|${e.t === 'Tool' ? (e.result ? 'done' : '') : ''}`;
    const hit = cache.get(e);
    if (hit?.key === key) return hit.rows;
    const rows = entryRows(e, cwd, cols);
    cache.set(e, { key, rows });
    return rows;
}

/** The selection in the prompt shown, kept by the panel. */
export interface PromptView {
    selected: number;
    /** Options ticked in a multiple-choice question. */
    checked: ReadonlySet<number>;
    /** The user is typing an answer, or feedback for a "no". */
    typing: boolean;
}

/** What the permission prompt shows of the tool call. */
function permissionPreview(p: Extract<Prompt, { t: 'Permission' }>, cwd: string, cols: number): Row[] {
    const input = p.input;
    const indent = (rows: Row[]): Row[] => rows.map((r) => ({ runs: [['  ', theme.FG], ...r.runs] }));
    const lines = (text: string, color: string): Row[] => {
        const all = text.split('\n');
        const rows = all.slice(0, PREVIEW_LINES).map((l): Row => ({ runs: [['    ', theme.FG], [cut(l, cols - 4), color]] }));
        if (all.length > PREVIEW_LINES) rows.push({ runs: [[`    … +${all.length - PREVIEW_LINES} lines`, theme.COMMENT]] });
        return rows;
    };
    switch (p.tool) {
        case 'Bash': {
            const rows = lines(String(input.command ?? ''), theme.FUNCTION);
            if (typeof input.description === 'string') rows.push({ runs: [['    ', theme.FG], [cut(input.description, cols - 4), theme.COMMENT]] });
            return rows;
        }
        case 'Edit':
            return [
                { runs: [['  ', theme.FG], [shortPath(input.file_path, cwd), theme.FG]] },
                ...diffRows(String(input.old_string ?? ''), String(input.new_string ?? ''), cols, PREVIEW_LINES),
            ];
        case 'Write':
            return [{ runs: [['  ', theme.FG], [shortPath(input.file_path, cwd), theme.FG]] }, ...lines(String(input.content ?? ''), theme.STRING)];
        case 'ExitPlanMode':
            return typeof input.plan === 'string' ? indent(markdownLines(input.plan).flatMap((l) => hanging(['  ', theme.FG], l, cols - 2))) : [];
        default: {
            const summary = toolSummary(p.tool, input, cwd);
            if (summary !== '') return lines(summary, theme.FG);
            return lines(JSON.stringify(input, undefined, 2), theme.COMMENT);
        }
    }
}

/** A numbered choice, marked when selected. */
function choiceRows(i: number, label: string, view: PromptView, cols: number, color: string = theme.FG): Row[] {
    const here = i === view.selected && !view.typing;
    const number = `${i + 1}. `;
    return hanging([number, here ? theme.MODE_AGENT : color], [[label, here ? theme.MODE_AGENT : color]], cols - 2).map((row, j) => ({
        runs: [[here && j === 0 ? '❯ ' : '  ', theme.MODE_AGENT], ...row.runs],
        choice: i,
    }));
}

/** The rows for the prompt waiting for an answer. */
export function promptRows(p: Prompt, view: PromptView, cwd: string, cols: number): Row[] {
    const rule: Row = { runs: [['─'.repeat(Math.max(cols, 1)), theme.MODE_AGENT]] };
    if (p.t === 'Permission') {
        const rows: Row[] = [rule, ...hanging(['', theme.FG], [[p.title, theme.FG]], cols)];
        if (p.description) rows.push(...hanging(['', theme.COMMENT], [[p.description, theme.COMMENT]], cols));
        rows.push(...permissionPreview(p, cwd, cols));
        rows.push({ runs: [] });
        rows.push({ runs: [['Do you want to proceed?', theme.FG]] });
        p.choices.forEach((c, i) => rows.push(...choiceRows(i, c.label, view, cols)));
        const hint = view.typing ? 'Type what the agent should do instead, then Enter · Esc to go back' : 'Enter to choose · Esc to deny';
        rows.push({ runs: [[cut(hint, cols), theme.COMMENT]] });
        return rows;
    }
    const q = p.questions[p.current];
    const count = p.questions.length > 1 ? ` (${p.current + 1}/${p.questions.length})` : '';
    const rows: Row[] = [rule, { runs: [[q.header, theme.MODE_AGENT], [count, theme.COMMENT]] }];
    rows.push(...hanging(['', theme.FG], [[q.question, theme.FG]], cols));
    q.options.forEach((o, i) => {
        const box = q.multiSelect ? (view.checked.has(i) ? '[x] ' : '[ ] ') : '';
        rows.push(...choiceRows(i, `${box}${o.label}`, view, cols));
        if (o.description) rows.push(...hanging(['     ', theme.COMMENT], [[o.description, theme.COMMENT]], cols));
    });
    rows.push(...choiceRows(q.options.length, 'Type something else…', view, cols, theme.COMMENT));
    const hint = view.typing
        ? 'Type an answer, then Enter · Esc to go back'
        : q.multiSelect
          ? 'Space to tick · Enter to answer · Esc to decline'
          : 'Enter to answer · Esc to decline';
    rows.push({ runs: [[cut(hint, cols), theme.COMMENT]] });
    return rows;
}

function formatTokens(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}

/** The "working" row while a turn runs, with a spinner frame for `now`. */
function statusRow(s: AgentSession, now: number, cols: number): Row {
    const frame = SPINNER[Math.floor(now / 120) % SPINNER.length];
    const verb = s.status ?? (s.live?.t === 'Thinking' ? 'Thinking' : 'Working');
    const secs = Math.max(Math.floor((now - s.turnStart) / 1000), 0);
    const tokens = s.turnTokens >= 1 ? ` · ↓ ${formatTokens(s.turnTokens)} tokens` : '';
    return { runs: [[`${frame} `, theme.MODE_AGENT], [`${verb}…`, theme.MODE_AGENT], [cut(` (${secs}s${tokens} · ctrl+x to interrupt)`, cols - verb.length - 3), theme.COMMENT]] };
}

/** The whole transcript: the entries, what is streaming in, the prompt
 * waiting for an answer and the "working" row. */
export function transcriptRows(s: AgentSession, view: PromptView, cols: number, now: number): Row[] {
    const rows: Row[] = [];
    const add = (more: Row[]): void => {
        if (rows.length > 0 && more.length > 0) rows.push({ runs: [] });
        rows.push(...more);
    };
    if (s.loading) add([{ runs: [['Loading the conversation…', theme.COMMENT]] }]);
    for (const e of s.entries) add(cachedRows(e, s.cwd, cols));
    if (s.live && s.live.text.trim() !== '') add(entryRows({ t: s.live.t, text: s.live.text }, s.cwd, cols));
    const prompt = s.prompt;
    if (prompt) add(promptRows(prompt, view, s.cwd, cols));
    else if (s.running) add([statusRow(s, now, cols)]);
    return rows;
}
