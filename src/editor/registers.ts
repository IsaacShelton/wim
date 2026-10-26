// Vim registers, including the system clipboard (`"+` and `"*`).

import { Clipboard, SystemClipboard } from '../clipboard';

export interface Register {
    /** For linewise registers this holds the lines joined by `\n`, without a
     * trailing newline. */
    text: string;
    linewise: boolean;
}

export type RegisterOp = 'Yank' | 'Delete';

export function isValidName(c: string): boolean {
    return /^[A-Za-z0-9"+*_-]$/.test(c);
}

export class Registers {
    private map = new Map<string, Register>();
    private clipboardImpl: Clipboard | undefined;
    /** Mirror the unnamed register to the system clipboard (`clipboard=unnamed`). */
    useSystemClipboard = false;

    constructor(clipboard?: Clipboard) {
        this.clipboardImpl = clipboard;
    }

    get(name?: string): Register | undefined {
        const n = name ?? '"';
        if (n === '+' || n === '*' || (n === '"' && this.useSystemClipboard)) {
            const reg = this.readClipboard();
            if (reg) return reg;
        }
        const reg = this.map.get(/^[A-Z]$/.test(n) ? n.toLowerCase() : n);
        return reg && { ...reg };
    }

    set(name: string | undefined, reg: Register, op: RegisterOp): void {
        if (name === '_') return;
        if (name === '+' || name === '*') {
            this.writeClipboard(reg);
        } else if (name !== undefined && /^[A-Z]$/.test(name)) {
            const lower = name.toLowerCase();
            const old = this.map.get(lower);
            let merged = reg;
            if (old) {
                merged = {
                    text: old.text + (old.linewise || reg.linewise ? '\n' : '') + reg.text,
                    linewise: old.linewise || reg.linewise,
                };
            }
            this.map.set(lower, merged);
            this.map.set('"', { ...merged });
            return;
        } else if (name !== undefined && name !== '"') {
            this.map.set(name, { ...reg });
        } else {
            if (op === 'Yank') {
                this.map.set('0', { ...reg });
            } else if (reg.linewise || reg.text.includes('\n')) {
                for (let i = 8; i >= 1; i--) {
                    const r = this.map.get(String(i));
                    if (r) {
                        this.map.delete(String(i));
                        this.map.set(String(i + 1), r);
                    }
                }
                this.map.set('1', { ...reg });
            } else {
                this.map.set('-', { ...reg });
            }
            if (this.useSystemClipboard) this.writeClipboard(reg);
        }
        this.map.set('"', { ...reg });
    }

    private clipboard(): Clipboard {
        this.clipboardImpl ??= new SystemClipboard();
        return this.clipboardImpl;
    }

    private readClipboard(): Register | undefined {
        const raw = this.clipboard().getText();
        if (raw === undefined) return undefined;
        const text = raw.replace(/\r\n/g, '\n');
        return text.endsWith('\n') ? { text: text.slice(0, -1), linewise: true } : { text, linewise: false };
    }

    private writeClipboard(reg: Register): void {
        this.clipboard().setText(reg.linewise ? reg.text + '\n' : reg.text);
    }
}
