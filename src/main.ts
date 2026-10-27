// Entry point: `node wim.js [file or directory]`. Starts the editor, serves
// its window's page on localhost and opens the window. Wim exits when the
// window closes.

import { WimApp } from './app';
import { loadConfig } from './config';
import { findNerdFont } from './fonts';
import { ClientMessage, ServerMessage } from './protocol';
import { WebSocketConnection, startServer } from './server';
import { WindowHandle, WindowKind, openWindow } from './window';

const USAGE = `Usage: wim [options] [file or directory]

Options:
  --window=KIND  How to show Wim: auto (default), webkit (macOS), chromium
                 (an Edge/Chrome app window), browser (the default browser),
                 or none (print the address to open yourself)
  -h, --help     Show this help
`;

/** How long a browser tab may stay disconnected (e.g. reloading) before Wim
 * exits, when the window's own process can't be watched. */
const RECONNECT_GRACE = 5000;

function parseArgs(argv: string[]): { path?: string; window: WindowKind } {
    let file: string | undefined;
    let window: WindowKind = 'auto';
    let options = true;
    for (const arg of argv) {
        if (options && arg === '--') {
            options = false;
        } else if (options && (arg === '-h' || arg === '--help')) {
            process.stdout.write(USAGE);
            process.exit(0);
        } else if (options && arg.startsWith('--window=')) {
            const kind = arg.slice('--window='.length);
            if (!['auto', 'webkit', 'chromium', 'browser', 'none'].includes(kind)) usageError(`unknown window kind: ${kind}`);
            window = kind as WindowKind;
        } else if (options && arg.startsWith('-') && arg !== '-') {
            usageError(`unknown option: ${arg}`);
        } else if (file === undefined) {
            file = arg;
        } else {
            usageError('only one file can be opened at startup (use :e for more)');
        }
    }
    return { path: file, window };
}

function usageError(message: string): never {
    process.stderr.write(`wim: ${message}\n\n${USAGE}`);
    process.exit(2);
}

function send(conn: WebSocketConnection | undefined, msg: ServerMessage): void {
    conn?.send(JSON.stringify(msg));
}

export async function main(argv: string[]): Promise<void> {
    const args = parseArgs(argv);
    const fontPath = findNerdFont();
    const { config, warnings } = loadConfig();
    let client: WebSocketConnection | undefined;
    let window: WindowHandle | undefined;
    let exitTimer: NodeJS.Timeout | undefined;
    let shuttingDown = false;

    const shutdown = (): void => {
        if (shuttingDown) return;
        shuttingDown = true;
        send(client, { t: 'quit' });
        // Give the page a moment to receive the message and close itself.
        setTimeout(() => {
            window?.close();
            server.close();
            process.exit(0);
        }, 100);
    };

    const app = new WimApp({
        path: args.path,
        icons: fontPath !== undefined,
        config,
        configWarnings: warnings,
        onFrame: (title, dirty, cmds) => send(client, { t: 'frame', title, dirty, cmds }),
        onAudio: (cmd) => send(client, { t: 'audio', cmd }),
        onQuit: shutdown,
    });

    const server = await startServer({
        fontPath,
        onConnection: (conn) => {
            if (exitTimer) clearTimeout(exitTimer);
            client?.close();
            client = conn;
            conn.on('message', (text: string) => {
                let msg: ClientMessage;
                try {
                    msg = JSON.parse(text) as ClientMessage;
                } catch {
                    return;
                }
                try {
                    app.handleMessage(msg);
                } catch (e) {
                    // Keep the editor (and any unsaved work) alive.
                    process.stderr.write(`wim: internal error: ${(e as Error).stack ?? String(e)}\n`);
                    app.editor.setError(`Internal error: ${(e as Error).message}`);
                    app.render();
                }
            });
            conn.on('close', () => {
                if (client !== conn) return;
                client = undefined;
                if (window && !window.tracksExit && !shuttingDown) {
                    exitTimer = setTimeout(() => {
                        app.dispose();
                        process.exit(0);
                    }, RECONNECT_GRACE);
                }
            });
        },
    });

    window = openWindow(server.url, args.window);
    window.onExit(() => {
        app.dispose();
        server.close();
        process.exit(0);
    });
    if (window.kind === 'none' || window.kind === 'browser') process.stdout.write(`Wim is running at ${server.url}\n`);

    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
        process.on(signal, () => {
            app.dispose();
            window?.close();
            server.close();
            process.exit(0);
        });
    }
}
