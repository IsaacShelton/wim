// Tests for the integrated terminal, with a real shell.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { WimApp } from '../src/app';
import { MemoryClipboard } from '../src/clipboard';
import { defaultConfig } from '../src/config';
import { parseKeys } from '../src/editor/keys';
import { DrawCmd } from '../src/protocol';

const posix = process.platform !== 'win32';

function harness() {
    const frames: DrawCmd[][] = [];
    const config = defaultConfig();
    config.terminal.shell = 'sh';
    const app = new WimApp({ icons: false, clipboard: new MemoryClipboard(), servers: [], config, onFrame: (_t, _d, c) => frames.push(c), onQuit: () => {} });
    app.handleMessage({ t: 'resize', width: 1400, height: 800, charW: 10, lineH: 20 });
    return {
        app,
        type: (keys: string) => {
            for (const k of parseKeys(keys)) app.handleMessage({ t: 'key', key: k.key, ctrl: k.ctrl, alt: k.alt });
        },
        text: () =>
            frames[frames.length - 1]
                .filter((c) => c[0] === 'text')
                .map((c) => c[3])
                .join('\n'),
        /** Wait until no command is running. */
        async idle(): Promise<void> {
            for (let i = 0; i < 200 && /running…/.test(this.text()); i++) {
                await new Promise((r) => setTimeout(r, 25));
                app.handleMessage({ t: 'resize', width: 1400, height: 800, charW: 10, lineH: 20 });
            }
            assert.doesNotMatch(this.text(), /running…/);
        },
        /** Wait until the screen shows `pattern`. */
        async until(pattern: RegExp): Promise<void> {
            for (let i = 0; i < 200; i++) {
                if (pattern.test(this.text())) return;
                await new Promise((r) => setTimeout(r, 25));
                app.handleMessage({ t: 'resize', width: 1400, height: 800, charW: 10, lineH: 20 });
            }
            assert.match(this.text(), pattern);
        },
    };
}

test('the terminal shows under the editor, runs commands and keeps its directory', { skip: !posix }, async () => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wim-term-')));
    const h = harness();
    h.app.handleMessage({ t: 'command', name: 'terminal' });
    assert.match(h.text(), / TERMINAL /);
    assert.match(h.text(), / TERM /, 'the status line shows the terminal has the keys');
    h.type(`cd ${dir}<CR>`);
    await h.idle();
    h.type('echo "hello $((1+2))"; pwd<CR>');
    await h.until(new RegExp(`hello 3\\n${dir}`));
    assert.match(h.text(), /❯ echo "hello/);
    // A later command still runs in that directory, and failures are noted.
    h.type('false<CR>');
    await h.until(/\[exit 1\]/);
    await h.idle();
    h.type('pwd<CR>');
    await h.until(new RegExp(`${dir}\\n.*pwd[\\s\\S]*${dir}`));
    h.app.dispose();
});

test('Ctrl+c stops a running command, and the shell starts again where it was', { skip: !posix }, async () => {
    const h = harness();
    h.app.handleMessage({ t: 'command', name: 'terminal' });
    h.type('cd /tmp<CR>');
    await h.idle();
    h.type('sleep 30<CR>');
    await h.until(/running…/);
    h.type('<C-c>');
    await h.until(/\^C/);
    assert.doesNotMatch(h.text(), /running…/);
    h.type('echo back<CR>');
    await h.until(/\nback/);
    h.app.dispose();
});

test('Ctrl+k and Ctrl+j move between the editor and the terminal; Cmd+J hides it', { skip: !posix }, () => {
    const h = harness();
    h.app.handleMessage({ t: 'command', name: 'terminal' });
    h.type('half<Esc>');
    assert.match(h.text(), / TERM /, 'Esc clears what is typed first');
    assert.doesNotMatch(h.text(), /half/);
    h.type('<C-k>');
    assert.match(h.text(), /NORMAL/);
    h.type('<C-j>');
    assert.match(h.text(), / TERM /);
    h.app.handleMessage({ t: 'command', name: 'terminal' });
    assert.doesNotMatch(h.text(), / TERMINAL /);
    h.app.dispose();
});
