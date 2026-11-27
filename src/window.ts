// Opens Wim's window without native code of our own.
//
// - macOS: `osascript` (JavaScript for Automation, part of macOS) creates a
//   Cocoa window holding a WebKit view.
// - Windows (and elsewhere): Microsoft Edge, which ships with Windows, or
//   another Chromium browser, opens the page as a standalone app window with
//   its own temporary profile, so the window is its own process.
// - Otherwise the page opens in the default browser.
// - Wim's native app (`native/`, through Tauri) starts Wim itself, with
//   `--window=host`, and shows the page in its own window.

import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';

export type WindowKind = 'auto' | 'webkit' | 'chromium' | 'browser' | 'host' | 'none';

export interface WindowHandle {
    /** What actually opened. */
    kind: Exclude<WindowKind, 'auto'>;
    /** Whether `onExit` fires when the window closes. Otherwise the window's
     * lifetime is only known from its connection. */
    tracksExit: boolean;

    onExit(callback: () => void): void;
    /** Called when the window's close button or Quit asks Node, rather than
     * the page, whether to close. */
    onCloseRequest(callback: () => void): void;
    /** Show the page's title on the window, where the window doesn't itself. */
    setTitle(title: string): void;
    /** Bring the window to the front, as after a file is dropped on it. */
    activate(): void;
    close(): void;
}

const WIDTH = 1000;
const HEIGHT = 720;

export function openWindow(url: string, kind: WindowKind): WindowHandle {
    if (kind === 'none') return untracked('none');
    if (kind === 'host') return openHost(url);
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
    return {
        kind,
        tracksExit: false,
        onExit: () => { },
        onCloseRequest: () => { },
        setTitle: () => { },
        activate: () => { },
        close: () => { },
    };
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
        onCloseRequest: () => { },
        setTitle: () => { },
        activate: () => { },
        close: () => {
            if (!exited) child.kill();
        },
    };
}

// ----- The native app's window -------------------------------------------------------

/** The native app started Wim and shows the page itself. They talk in lines
 * of JSON: Wim's stdout tells the app the page's address (`url`), the
 * window's `title` and when to `activate`; the app's `close` comes back on
 * stdin, from the window's close button or Quit. When stdin ends, the app,
 * and its window, are gone. */
function openHost(url: string): WindowHandle {
    const exitCallbacks: (() => void)[] = [];
    const closeCallbacks: (() => void)[] = [];
    let title = '';
    const tell = (msg: object): void => {
        process.stdout.write(JSON.stringify(msg) + '\n');
    };
    // Writing after the app has gone fails; stdin ending says so instead.
    process.stdout.on('error', () => { });
    const input = readline.createInterface({ input: process.stdin });
    input.on('line', (line) => {
        let msg: { t?: unknown };
        try {
            msg = JSON.parse(line) as { t?: unknown };
        } catch {
            return;
        }
        if (msg.t === 'close') for (const cb of closeCallbacks) cb();
    });
    input.on('close', () => {
        for (const cb of exitCallbacks) cb();
    });
    tell({ t: 'url', url });
    return {
        kind: 'host',
        tracksExit: true,
        onExit: (cb) => exitCallbacks.push(cb),
        onCloseRequest: (cb) => closeCallbacks.push(cb),
        setTitle: (t) => {
            if (t === title) return;
            title = t;
            tell({ t: 'title', title });
        },
        activate: () => tell({ t: 'activate' }),
        // Wim exits right after, which ends stdout and tells the app to quit.
        close: () => { },
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

    const requestClose = () => {
        // WebKit calls the handler even when we don't care about the result;
        // a null one makes JXA throw inside the run loop and crash the process.
        view.evaluateJavaScriptCompletionHandler($('window.wimRequestClose && window.wimRequestClose()'), () => {});
    };
    ObjC.registerSubclass({
        name: 'WimWindowDelegate',
        // WKScriptMessageHandler isn't in the runtime for JXA to look up
        // ("protocol does not exist"); WebKit only needs the method below.
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
            // A file dropped from another app leaves that app in front.
            'userContentController:didReceiveScriptMessage:': {
                types: ['void', ['id', 'id']],
                implementation: () => {
                    app.activateIgnoringOtherApps(true);
                    win.makeKeyAndOrderFront(null);
                    win.makeFirstResponder(view);
                },
            },
        },
    });
    const delegate = $.WimWindowDelegate.alloc.init;
    const config = $.WKWebViewConfiguration.alloc.init;
    // Sound starts from Node's message after a key press, not in the key's
    // own event (WKAudiovisualMediaTypeNone).
    config.mediaTypesRequiringUserActionForPlayback = 0;
    config.userContentController.addScriptMessageHandlerName(delegate, 'wimActivate');
    const view = $.WKWebView.alloc.initWithFrameConfiguration(frame, config);
    view.setValueForKey(false, 'drawsBackground');

    win.delegate = delegate;
    app.delegate = delegate;

    win.contentView = view;
    // Fill the screen apart from the menu bar and Dock, as a window rather
    // than in full screen mode.
    win.setFrameDisplay($.NSScreen.mainScreen.visibleFrame, true);
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
            '--start-maximized',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-extensions',
            '--disable-sync',
            '--disable-features=Translate',
            // Sound starts from Node's message after a key press, not in the
            // key's own event.
            '--autoplay-policy=no-user-gesture-required',
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

/** Open `url` in the default browser. */
export function openDefaultBrowser(url: string): void {
    const [cmd, args] =
        process.platform === 'darwin'
            ? ['open', [url]]
            : process.platform === 'win32'
                ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
                : ['xdg-open', [url]];
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => { }).unref();
}

/** Ask the system for a folder: macOS's folder chooser, Windows's
 * `FolderBrowserDialog`, or zenity/kdialog on Linux. Resolves to `undefined`
 * when the chooser is canceled, and rejects when it can't be opened (Linux
 * without zenity or kdialog, say). */
export function pickFolder(start: string): Promise<string | undefined> {
    if (process.platform === 'darwin') {
        const script = [
            'on run argv',
            'set startFolder to POSIX file (item 1 of argv)',
            'set chosenFolder to choose folder with prompt "Open Project Folder" default location (startFolder as alias)',
            'return POSIX path of chosenFolder',
            'end run',
        ].join('\n');
        return runPicker('osascript', ['-e', script, start]);
    }
    if (process.platform === 'win32') {
        const script = [
            'Add-Type -AssemblyName System.Windows.Forms',
            '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
            "$dialog.Description = 'Open Project Folder'",
            '$dialog.SelectedPath = $env:WIM_START',
            'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::WriteLine($dialog.SelectedPath) }',
        ].join('; ');
        return runPicker('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { ...process.env, WIM_START: start });
    }
    const dir = start.endsWith(path.sep) ? start : start + path.sep;
    if (onPath('zenity')) {
        return runPicker('zenity', ['--file-selection', '--directory', '--title=Open Project Folder', `--filename=${dir}`]);
    }
    if (onPath('kdialog')) {
        return runPicker('kdialog', ['--getexistingdirectory', start, '--title', 'Open Project Folder']);
    }
    return Promise.reject(new Error('No native folder picker found (install zenity or kdialog)'));
}

/** Run a native folder chooser, with its choice on stdout. */
function runPicker(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let out = '';
        child.stdout?.on('data', (chunk: Buffer) => (out += chunk));
        // A chooser that was canceled exits nonzero, with nothing on stdout.
        child.stderr?.on('data', () => { });
        child.on('error', reject);
        child.on('close', (code) => resolve(code === 0 ? out.trim() || undefined : undefined));
    });
}

/** Whether `name` is a program on the PATH. */
function onPath(name: string): boolean {
    const found = spawnSync('which', [name], { encoding: 'utf8' });
    return found.status === 0 && found.stdout.trim() !== '';
}

/** Show `p` in the system file manager: Finder's "Reveal in Finder", or
 * Explorer with the item selected. On Linux, where there is no common way to
 * select an item, the containing folder is opened instead. */
export function revealInFolder(p: string): void {
    const [cmd, args] =
        process.platform === 'darwin'
            ? ['open', ['-R', p]]
            : process.platform === 'win32'
                ? ['explorer.exe', [`/select,${p}`]]
                : ['xdg-open', [path.dirname(p)]];
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => { }).unref();
}
