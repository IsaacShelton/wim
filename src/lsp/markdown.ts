// Hover documentation as colored lines: code blocks are syntax highlighted
// and Markdown markup is dropped.

import * as highlight from '../highlight';
import { Run } from '../popup';
import { theme, tokenColor } from '../theme';
import { Hover, MarkedString, MarkupContent } from './types';

/** File extensions for code block languages, to find a highlighter. */
const FENCE_EXTENSIONS: Record<string, string> = {
    rust: 'rs',
    typescript: 'ts',
    javascript: 'js',
    typescriptreact: 'tsx',
    javascriptreact: 'jsx',
    python: 'py',
    shell: 'sh',
    bash: 'sh',
    console: 'sh',
    cpp: 'cpp',
};

function fenceLanguage(name: string): highlight.Language | undefined {
    if (name === '') return undefined;
    return highlight.detect(`x.${FENCE_EXTENSIONS[name] ?? name}`);
}

/** The text of a hover as Markdown. */
export function hoverMarkdown(hover: Hover | null): string {
    if (!hover) return '';
    const part = (c: MarkupContent | MarkedString): string => {
        if (typeof c === 'string') return c;
        if ('kind' in c) return c.kind === 'markdown' ? c.value : c.value.replace(/[\\`*_[\]#]/g, '\\$&');
        return '```' + c.language + '\n' + c.value + '\n```';
    };
    const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents];
    return contents.map(part).join('\n\n');
}

function codeLine(lang: highlight.Language | undefined, line: string, state: highlight.State): [Run[], highlight.State] {
    if (!lang) return [[[line, theme.FG]], state];
    const chars = Array.from(line);
    const [spans, next] = highlight.highlightLine(lang, chars, state);
    const runs: Run[] = [];
    let at = 0;
    for (const [start, end, token] of spans) {
        if (start > at) runs.push([chars.slice(at, start).join(''), theme.FG]);
        runs.push([chars.slice(start, end).join(''), tokenColor(token)]);
        at = end;
    }
    if (at < chars.length) runs.push([chars.slice(at).join(''), theme.FG]);
    return [runs, next];
}

/** A line of Markdown prose without its markup; inline code is colored. */
function proseLine(line: string, color: string): Run[] {
    const runs: Run[] = [];
    const parts = line
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
        .split('`');
    parts.forEach((part, i) => {
        if (part === '') return;
        if (i % 2 === 1 && i < parts.length - 1) {
            runs.push([part, theme.MACRO]);
            return;
        }
        const text = part
            .replace(/(\*\*|__)(.+?)\1/g, '$2')
            .replace(/(^|\W)\*(\S.*?)\*/g, '$1$2')
            .replace(/\\([\\`*_{}[\]()#+\-.!|<>])/g, '$1');
        runs.push([text, color]);
    });
    return runs;
}

export function markdownLines(md: string): Run[][] {
    const out: Run[][] = [];
    let fence: { lang: highlight.Language | undefined; state: highlight.State } | undefined;
    for (const raw of md.replace(/\r\n?/g, '\n').split('\n')) {
        const line = raw.replace(/\s+$/, '');
        const marker = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
        if (marker) {
            fence = fence ? undefined : { lang: fenceLanguage(marker[2].toLowerCase()), state: highlight.NORMAL };
            continue;
        }
        if (fence) {
            const [runs, state] = codeLine(fence.lang, line, fence.state);
            fence.state = state;
            out.push(runs);
            continue;
        }
        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
            out.push([]);
            continue;
        }
        const heading = /^#{1,6}\s+(.*)$/.exec(line);
        if (heading) {
            out.push(proseLine(heading[1], theme.FUNCTION));
            continue;
        }
        out.push(proseLine(line, theme.FG));
    }
    // Drop blank lines at the ends and runs of them in between.
    const lines = out.filter((l, i) => l.length > 0 || (i > 0 && out[i - 1].length > 0));
    while (lines.length > 0 && lines[0].length === 0) lines.shift();
    while (lines.length > 0 && lines[lines.length - 1].length === 0) lines.pop();
    return lines;
}
