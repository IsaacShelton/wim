// The text buffer: a list of lines, each stored as an array of characters
// (Unicode code points) so that columns can be indexed directly.

export type Line = string[];

export interface Pos {
    readonly line: number;
    readonly col: number;
}

export function pos(line: number, col: number): Pos {
    return { line, col };
}

export function posEq(a: Pos, b: Pos): boolean {
    return a.line === b.line && a.col === b.col;
}

export function posCmp(a: Pos, b: Pos): number {
    return a.line !== b.line ? a.line - b.line : a.col - b.col;
}

export function order(a: Pos, b: Pos): [Pos, Pos] {
    return posCmp(a, b) <= 0 ? [a, b] : [b, a];
}

export function posMax(a: Pos, b: Pos): Pos {
    return posCmp(a, b) >= 0 ? a : b;
}

export function chars(s: string): Line {
    return Array.from(s);
}

export function isWhitespace(c: string): boolean {
    return /^\s$/u.test(c);
}

export class Buffer {
    private lines: Line[];
    /** Identifies the current content. Every mutation takes a fresh id from
     * `nextVersion`; restoring a snapshot restores its id, so "is this the
     * saved content?" can be answered by comparing ids. */
    private ver = 0;
    private nextVersion = 1;

    constructor(lines: Line[] = [[]]) {
        this.lines = lines;
    }

    static fromText(text: string): Buffer {
        const body = text.endsWith('\n') ? text.slice(0, -1) : text;
        return new Buffer(body.split('\n').map((l) => chars(l.endsWith('\r') ? l.slice(0, -1) : l)));
    }

    /** The buffer contents as a file would store them (with a final newline). */
    toFileText(): string {
        return this.text() + '\n';
    }

    text(): string {
        return this.lines.map((l) => l.join('')).join('\n');
    }

    version(): number {
        return this.ver;
    }

    private touch(): void {
        this.ver = this.nextVersion;
        this.nextVersion += 1;
    }

    snapshot(): { lines: Line[]; version: number } {
        return { lines: this.lines.map((l) => l.slice()), version: this.ver };
    }

    restore(lines: Line[], version: number): void {
        this.lines = lines;
        this.ver = version;
    }

    lineCount(): number {
        return this.lines.length;
    }

    lastLine(): number {
        return this.lines.length - 1;
    }

    line(i: number): readonly string[] {
        return this.lines[i];
    }

    lineLen(i: number): number {
        return this.lines[i].length;
    }

    lineString(i: number): string {
        return this.lines[i].join('');
    }

    charAt(p: Pos): string | undefined {
        return this.lines[p.line]?.[p.col];
    }

    isBlankLine(i: number): boolean {
        return this.lines[i].every(isWhitespace);
    }

    firstNonBlank(i: number): number {
        const line = this.lines[i];
        const idx = line.findIndex((c) => !isWhitespace(c));
        return idx >= 0 ? idx : Math.max(line.length - 1, 0);
    }

    indentOf(i: number): Line {
        const out: Line = [];
        for (const c of this.lines[i]) {
            if (c !== ' ' && c !== '\t') break;
            out.push(c);
        }
        return out;
    }

    /** The position just past the last character of the buffer. */
    endPos(): Pos {
        return pos(this.lastLine(), this.lineLen(this.lastLine()));
    }

    private clamp(p: Pos): Pos {
        if (p.line >= this.lines.length) return this.endPos();
        return pos(p.line, Math.min(p.col, this.lines[p.line].length));
    }

    /** Text between `start` (inclusive) and `end` (exclusive). A column equal
     * to the line length addresses the line break. */
    textRange(start: Pos, end: Pos): string {
        start = this.clamp(start);
        end = this.clamp(end);
        if (posCmp(start, end) >= 0) return '';
        if (start.line === end.line) return this.lines[start.line].slice(start.col, end.col).join('');
        let s = this.lines[start.line].slice(start.col).join('');
        for (let l = start.line + 1; l < end.line; l++) s += '\n' + this.lines[l].join('');
        return s + '\n' + this.lines[end.line].slice(0, end.col).join('');
    }

    deleteRange(start: Pos, end: Pos): string {
        start = this.clamp(start);
        end = this.clamp(end);
        const text = this.textRange(start, end);
        if (posCmp(start, end) >= 0) return text;
        const tail = this.lines[end.line].slice(end.col);
        this.lines[start.line] = this.lines[start.line].slice(0, start.col).concat(tail);
        this.lines.splice(start.line + 1, end.line - start.line);
        this.touch();
        return text;
    }

    /** Insert `text` at `p`, returning the position just after it. */
    insertText(p: Pos, text: string): Pos {
        p = this.clamp(p);
        if (text === '') return p;
        const line = this.lines[p.line];
        const tail = line.slice(p.col);
        const parts = text.split('\n');
        this.lines[p.line] = line.slice(0, p.col).concat(chars(parts[0]));
        const newLines = parts.slice(1).map(chars);
        this.lines.splice(p.line + 1, 0, ...newLines);
        const endLine = p.line + newLines.length;
        const end = pos(endLine, this.lines[endLine].length);
        this.lines[endLine] = this.lines[endLine].concat(tail);
        this.touch();
        return end;
    }

    insertChar(p: Pos, c: string): void {
        p = this.clamp(p);
        this.lines[p.line].splice(p.col, 0, c);
        this.touch();
    }

    setChar(p: Pos, c: string): void {
        if (this.lines[p.line][p.col] !== c) {
            this.lines[p.line][p.col] = c;
            this.touch();
        }
    }

    insertLines(at: number, lines: Line[]): void {
        at = Math.min(at, this.lines.length);
        this.lines.splice(at, 0, ...lines);
        this.touch();
    }

    /** Remove lines `first..=last`. The buffer always keeps at least one line. */
    removeLines(first: number, last: number): Line[] {
        last = Math.min(last, this.lastLine());
        const removed = this.lines.splice(first, last - first + 1);
        if (this.lines.length === 0) this.lines.push([]);
        this.touch();
        return removed;
    }

    replaceLine(i: number, line: Line): void {
        const old = this.lines[i];
        if (old.length !== line.length || old.some((c, j) => c !== line[j])) {
            this.lines[i] = line;
            this.touch();
        }
    }
}
