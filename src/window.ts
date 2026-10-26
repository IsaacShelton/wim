// Opens Wim's window without native code of our own.
//
// - macOS: `osascript` (JavaScript for Automation, part of macOS) creates a
//   Cocoa window holding a WebKit view.
// - Windows (and elsewhere): Microsoft Edge, which ships with Windows, or
//   another Chromium browser, opens the page as a standalone app window with
//   its own temporary profile, so the window is its own process.
// - Otherwise the page opens in the default browser.

import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type WindowKind = 'auto' | 'webkit' | 'chromium' | 'browser' | 'none';

export interface WindowHandle {
    /** What actually opened. */
    kind: Exclude<WindowKind, 'auto'>;
    /** Whether `onExit` fires when the window closes. Otherwise the window's
     * lifetime is only known from its connection. */
    tracksExit: boolean;

    onExit(callback: () => void): void;
    close(): void;
}

const WIDTH = 1000;
const HEIGHT = 720;

export function openWindow(url: string, kind: WindowKind): WindowHandle {
    if (kind === 'none') return untracked('none');
    if ((kind === 'auto' && process.platform === 'darwin') || kind === 'webkit') return openWebKit(url);
    if (kind === 'auto' || kind === 'chromium') {
        const browser = findChromium();
        if (browser) return openChromium(browser, url);
        if (kind === 'chromium') {
            throw new Error('No Chromium browser (Edge, Chrome, Chromium or Brave) found; set WIM_BROWSER to one.');
        }
    }
    openDefaultBrowser(url);
    return untracked('browser');
}

function untracked(kind: 'browser' | 'none'): WindowHandle {
    return { kind, tracksExit: false, onExit: () => { }, close: () => { } };
}

function childHandle(kind: 'webkit' | 'chromium', child: ChildProcess, cleanup = (): void => { }): WindowHandle {
    let exited = false;
    const callbacks: (() => void)[] = [];
    child.on('exit', () => {
        exited = true;
        cleanup();
        for (const cb of callbacks) cb();
    });
    child.on('error', (e) => {
        process.stderr.write(`wim: could not open the window: ${e.message}\n`);
        exited = true;
        cleanup();
        for (const cb of callbacks) cb();
    });
    return {
        kind,
        tracksExit: true,
        onExit: (cb) => callbacks.push(cb),
        close: () => {
            if (!exited) child.kill();
        },
    };
}

// ----- macOS: a Cocoa window with a WebKit view, through JXA -------------------

/** Runs in `osascript -l JavaScript`. The window's close button and the app's
 * Quit command don't close anything themselves: they ask the page, which asks
 * Node, which decides (and warns about unsaved changes first). */
const JXA_SCRIPT = `
function run(argv) {
    ObjC.import('Cocoa');
    ObjC.import('WebKit');
    const [url, width, height] = [argv[0], Number(argv[1]), Number(argv[2])];
    const app = $.NSApplication.sharedApplication;
    app.setActivationPolicy($.NSApplicationActivationPolicyRegular);

    const frame = $.NSMakeRect(0, 0, width, height);
    const style = $.NSWindowStyleMaskTitled | $.NSWindowStyleMaskClosable |
        $.NSWindowStyleMaskMiniaturizable | $.NSWindowStyleMaskResizable;
    const win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(frame, style, $.NSBackingStoreBuffered, false);
    win.title = 'Wim';
    win.minSize = $.NSMakeSize(320, 200);
    win.releasedWhenClosed = false;

    const config = $.WKWebViewConfiguration.alloc.init;
    const view = $.WKWebView.alloc.initWithFrameConfiguration(frame, config);
    view.setValueForKey(false, 'drawsBackground');

    const requestClose = () => {
        view.evaluateJavaScriptCompletionHandler($('window.wimRequestClose && window.wimRequestClose()'), null);
    };
    ObjC.registerSubclass({
        name: 'WimWindowDelegate',
        protocols: ['NSWindowDelegate', 'NSApplicationDelegate'],
        methods: {
            'windowShouldClose:': {
                types: ['bool', ['id']],
                implementation: () => {
                    requestClose();
                    return false;
                },
            },
            'applicationShouldTerminate:': {
                types: ['unsigned long', ['id']],
                implementation: () => {
                    requestClose();
                    return 0;
                },
            },
        },
    });
    const delegate = $.WimWindowDelegate.alloc.init;
    win.delegate = delegate;
    app.delegate = delegate;

    win.contentView = view;
    win.center;
    view.loadRequest($.NSURLRequest.requestWithURL($.NSURL.URLWithString($(url))));
    win.makeKeyAndOrderFront(null);
    win.makeFirstResponder(view);
    app.activateIgnoringOtherApps(true);

    // The page sets its title; mirror it on the window.
    $.NSTimer.scheduledTimerWithTimeIntervalRepeatsBlock(0.2, true, () => {
        const title = view.title;
        if (title && title.length > 0 && !title.isEqualToString(win.title)) win.title = title;
    });
    app.run;
}
`;

function openWebKit(url: string): WindowHandle {
    const child = spawn('osascript', ['-l', 'JavaScript', '-e', JXA_SCRIPT, url, String(WIDTH), String(HEIGHT)], {
        stdio: ['ignore', 'ignore', 'inherit'],
    });
    return childHandle('webkit', child);
}

// ----- Windows and Linux: a Chromium app window -----------------------------------

function findChromium(): string | undefined {
    const fromEnv = process.env.WIM_BROWSER;
    if (fromEnv) return fromEnv;
    const candidates: string[] = [];
    if (process.platform === 'win32') {
        const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA];
        for (const app of ['Microsoft\\Edge\\Application\\msedge.exe', 'Google\\Chrome\\Application\\chrome.exe']) {
            for (const root of roots) if (root) candidates.push(path.join(root, app));
        }
    } else if (process.platform === 'darwin') {
        for (const app of ['Microsoft Edge', 'Google Chrome', 'Chromium', 'Brave Browser']) {
            candidates.push(`/Applications/${app}.app/Contents/MacOS/${app}`);
            candidates.push(path.join(os.homedir(), `Applications/${app}.app/Contents/MacOS/${app}`));
        }
    } else {
        for (const name of [
            'microsoft-edge',
            'google-chrome',
            'google-chrome-stable',
            'chromium',
            'chromium-browser',
            'brave-browser',
        ]) {
            const found = spawnSync('which', [name], { encoding: 'utf8' });
            if (found.status === 0 && found.stdout.trim() !== '') candidates.push(found.stdout.trim());
        }
    }
    return candidates.find((p) => fs.existsSync(p));
}

function openChromium(browser: string, url: string): WindowHandle {
    // A fresh profile makes the window its own browser process, so it exits
    // when the window closes even if the browser is already running.
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wim-window-'));
    const child = spawn(
        browser,
        [
            `--app=${url}`,
            `--user-data-dir=${profile}`,
            `--window-size=${WIDTH},${HEIGHT}`,
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-extensions',
            '--disable-sync',
            '--disable-features=Translate',
        ],
        { stdio: 'ignore', windowsHide: false },
    );
    const cleanup = (): void => {
        try {
            fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
        } catch {
            // A leftover temporary profile is harmless.
        }
    };
    return childHandle('chromium', child, cleanup);
}

function openDefaultBrowser(url: string): void {
    const [cmd, args] =
        process.platform === 'darwin'
            ? ['open', [url]]
            : process.platform === 'win32'
                ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
                : ['xdg-open', [url]];
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => { }).unref();
}
