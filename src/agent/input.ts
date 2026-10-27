// The agent panel's prompt: text over one or more lines with a cursor,
// edited with a text field's keys (and Ctrl+j/k, as in Wim's Insert mode),
// with earlier prompts on Up and Down. Ctrl+h and Ctrl+l are the panel's, to
// move between windows.

import { KeyInput, isCharKey } from '../editor/keys';

function isWordChar(c: string | undefined): boolean {
    return c !== undefined && /[\p{L}\p{N}_]/u.test(c);
}

export class TextInput {
    private chars: string[] = [];
    /** Where the cursor is, from 0 to the text's length in characters. */
    cursor = 0;
    private readonly history: string[] = [];
    /** Which earlier prompt is shown, while going through them. */
    private historyAt: number | undefined;
    /** What was being typed before going back through the history. */
    private draft = '';

    get text(): string {
        return this.chars.join('');
    }

    set(text: string): void {
        this.chars = Array.from(text);
        this.cursor = this.chars.length;
    }

    clear(): void {
        this.set('');
        this.historyAt = undefined;
    }

    /** Remember a sent prompt for Up. */
    remember(text: string): void {
        if (this.history[this.history.length - 1] !== text) this.history.push(text);
        this.historyAt = undefined;
    }

    insert(s: string): void {
        const add = Array.from(s.replace(/\r\n?/g, '\n'));
        this.chars.splice(this.cursor, 0, ...add);
        this.cursor += add.length;
    }

    /** The text's lines, and the cursor's line and column. */
    lines(): { lines: string[][]; line: number; col: number } {
        const lines: string[][] = [[]];
        let line = 0;
        let col = 0;
        this.chars.forEach((c, i) => {
            if (i === this.cursor) [line, col] = [lines.length - 1, lines[lines.length - 1].length];
            if (c === '\n') lines.push([]);
            else lines[lines.length - 1].push(c);
        });
        if (this.cursor >= this.chars.length) [line, col] = [lines.length - 1, lines[lines.length - 1].length];
        return { lines, line, col };
    }

    private lineStart(at = this.cursor): number {
        let i = at;
        while (i > 0 && this.chars[i - 1] !== '\n') i--;
        return i;
    }

    private lineEnd(at = this.cursor): number {
        let i = at;
        while (i < this.chars.length && this.chars[i] !== '\n') i++;
        return i;
    }

    private wordBefore(): number {
        let i = this.cursor;
        while (i > 0 && !isWordChar(this.chars[i - 1])) i--;
        while (i > 0 && isWordChar(this.chars[i - 1])) i--;
        return i;
    }

    private wordAfter(): number {
        let i = this.cursor;
        while (i < this.chars.length && !isWordChar(this.chars[i])) i++;
        while (i < this.chars.length && isWordChar(this.chars[i])) i++;
        return i;
    }

    private deleteTo(at: number): void {
        const [from, to] = at < this.cursor ? [at, this.cursor] : [this.cursor, at];
        this.chars.splice(from, to - from);
        this.cursor = from;
    }

    /** Up or down a line, keeping the column; past the first or last line,
     * through the earlier prompts. */
    private vertical(delta: number): void {
        const start = this.lineStart();
        const col = this.cursor - start;
        if (delta < 0) {
            if (start === 0) {
                this.recall(-1);
                return;
            }
            const prev = this.lineStart(start - 1);
            this.cursor = Math.min(prev + col, start - 1);
        } else {
            const end = this.lineEnd();
            if (end === this.chars.length) {
                this.recall(1);
                return;
            }
            this.cursor = Math.min(end + 1 + col, this.lineEnd(end + 1));
        }
    }

    private recall(delta: number): void {
        if (this.history.length === 0) return;
        if (this.historyAt === undefined) {
            if (delta > 0) return;
            this.draft = this.text;
            this.historyAt = this.history.length;
        }
        const at = this.historyAt + delta;
        if (at < 0) return;
        if (at >= this.history.length) {
            this.historyAt = undefined;
            this.set(this.draft);
            return;
        }
        this.historyAt = at;
        this.set(this.history[at]);
    }

    /** Edit with a key. Returns 'Send' for Enter, and whether the key was
     * one for the prompt. A `\` before Enter, or Option/Alt with it, makes a
     * new line instead. */
    key(key: KeyInput): 'Send' | boolean {
        const c = key.ctrl ? key.key : undefined;
        switch (key.key) {
            case 'Enter':
                if (key.alt) {
                    this.insert('\n');
                } else if (this.chars[this.cursor - 1] === '\\') {
                    this.chars[this.cursor - 1] = '\n';
                } else {
                    return 'Send';
                }
                return true;
            case 'Backspace':
                if (key.alt) this.deleteTo(this.wordBefore());
                else if (this.cursor > 0) this.deleteTo(this.cursor - 1);
                return true;
            case 'Delete':
                if (key.alt) this.deleteTo(this.wordAfter());
                else if (this.cursor < this.chars.length) this.deleteTo(this.cursor + 1);
                return true;
            case 'Left':
                this.cursor = key.alt ? this.wordBefore() : Math.max(this.cursor - 1, 0);
                return true;
            case 'Right':
                this.cursor = key.alt ? this.wordAfter() : Math.min(this.cursor + 1, this.chars.length);
                return true;
            case 'Up':
                this.vertical(-1);
                return true;
            case 'Down':
                this.vertical(1);
                return true;
            case 'Home':
                this.cursor = this.lineStart();
                return true;
            case 'End':
                this.cursor = this.lineEnd();
                return true;
        }
        switch (c) {
            case 'a':
                this.cursor = this.lineStart();
                return true;
            case 'e':
                this.cursor = this.lineEnd();
                return true;
            case 'k':
                this.vertical(-1);
                return true;
            case 'j':
                this.vertical(1);
                return true;
            case 'w':
                this.deleteTo(this.wordBefore());
                return true;
            case 'u':
                this.deleteTo(this.lineStart());
                return true;
        }
        if (!key.ctrl && !key.alt && isCharKey(key)) {
            this.insert(key.key);
            return true;
        }
        return false;
    }
}
