// The system clipboard, through the tools each OS ships with (no native
// modules): pbcopy/pbpaste on macOS, PowerShell on Windows, and wl-clipboard,
// xclip or xsel elsewhere.

import { spawn, spawnSync } from 'node:child_process';

export interface Clipboard {
    getText(): string | undefined;
    setText(text: string): void;
}

interface Tool {
    cmd: string;
    args: string[];
}

const UTF8_ENV = { ...process.env, LANG: 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8' };

function tools(): { get: Tool[]; set: Tool[] } {
    if (process.platform === 'darwin') {
        return { get: [{ cmd: 'pbpaste', args: [] }], set: [{ cmd: 'pbcopy', args: [] }] };
    }
    if (process.platform === 'win32') {
        const ps = (script: string): Tool => ({
            cmd: 'powershell.exe',
            args: ['-NoProfile', '-NonInteractive', '-Command', script],
        });
        return {
            get: [ps('[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw')],
            set: [
                ps(
                    '[Console]::InputEncoding=[Text.Encoding]::UTF8; ' +
                        'Set-Clipboard -Value ([Console]::In.ReadToEnd())',
                ),
            ],
        };
    }
    return {
        get: [
            { cmd: 'wl-paste', args: ['--no-newline'] },
            { cmd: 'xclip', args: ['-selection', 'clipboard', '-o'] },
            { cmd: 'xsel', args: ['--clipboard', '--output'] },
        ],
        set: [
            { cmd: 'wl-copy', args: [] },
            { cmd: 'xclip', args: ['-selection', 'clipboard'] },
            { cmd: 'xsel', args: ['--clipboard', '--input'] },
        ],
    };
}

export class SystemClipboard implements Clipboard {
    private readonly tools = tools();

    getText(): string | undefined {
        for (const t of this.tools.get) {
            const r = spawnSync(t.cmd, t.args, { encoding: 'utf8', env: UTF8_ENV, windowsHide: true });
            if (r.status === 0) {
                // PowerShell's `-Raw` output gains a trailing CRLF.
                return process.platform === 'win32' ? r.stdout.replace(/\r\n$/, '') : r.stdout;
            }
        }
        return undefined;
    }

    setText(text: string): void {
        this.trySet(0, text);
    }

    private trySet(i: number, text: string): void {
        const t = this.tools.set[i];
        if (!t) return;
        const child = spawn(t.cmd, t.args, { env: UTF8_ENV, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
        child.on('error', () => this.trySet(i + 1, text));
        child.stdin.on('error', () => {});
        child.stdin.end(text);
    }
}

/** A clipboard that lives only in memory, for tests. */
export class MemoryClipboard implements Clipboard {
    text: string | undefined;

    getText(): string | undefined {
        return this.text;
    }

    setText(text: string): void {
        this.text = text;
    }
}
