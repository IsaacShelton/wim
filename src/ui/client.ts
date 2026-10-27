// The window: draws the frames Node sends on a canvas, and forwards keys,
// mouse and resizes to Node. All editor logic lives in Node.

import type { AudioCommand, ClientMessage, DrawCmd, ServerMessage } from '../protocol';

const BASE_FONT_SIZE = 15;
const LINE_SPACING = 1.3;
const ZOOM_STEP = 1.1;
const canvas = document.getElementById('wim') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const hasIcons = canvas.dataset.icons === '1';
const isMac = /Mac/.test(navigator.platform);
/** This session's token, which the server wants for the WebSocket and images. */
const token = new URLSearchParams(location.search).get('t') ?? '';

let zoom = 1;
let charW = 9;
let lineH = 23;
let frame: Extract<ServerMessage, { t: 'frame' }> | undefined;
let drawQueued = false;
let quitting = false;
let socket: WebSocket | undefined;
let pressed = false;

function fontSize(): number {
    return Math.round(BASE_FONT_SIZE * zoom * 10) / 10;
}

function font(): string {
    const icons = hasIcons ? 'WimIcons, ' : '';
    return `${fontSize()}px Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", ${icons}monospace`;
}

function send(msg: ClientMessage): void {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

// ----- Size and metrics ------------------------------------------------------------

function measure(): void {
    ctx.font = font();
    charW = ctx.measureText('M').width;
    lineH = Math.round(fontSize() * 1.2 * LINE_SPACING);
}

function resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const width = window.innerWidth;
    const height = window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    measure();
    send({ t: 'resize', width, height, charW, lineH });
    queueDraw();
}

window.addEventListener('resize', resize);

// ----- Drawing -----------------------------------------------------------------------

function queueDraw(): void {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => {
        drawQueued = false;
        draw();
    });
}

function draw(): void {
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = font();
    ctx.textBaseline = 'middle';
    if (!frame) {
        ctx.fillStyle = '#282c34';
        ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
        return;
    }
    let clips = 0;
    for (const cmd of frame.cmds) {
        switch (cmd[0]) {
            case 'rect':
                drawRect(cmd);
                break;
            case 'stroke': {
                const [, x, y, w, h, color] = cmd;
                ctx.strokeStyle = color;
                ctx.lineWidth = 1;
                ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
                break;
            }
            case 'text':
                if (cmd[5]) ctx.font = `${cmd[5]} ${font()}`;
                drawText(cmd[1], cmd[2], cmd[3], cmd[4]);
                if (cmd[5]) ctx.font = font();
                break;
            case 'image':
                drawImage(cmd);
                break;
            case 'poly': {
                const [, points, color] = cmd;
                ctx.beginPath();
                ctx.moveTo(points[0], points[1]);
                for (let i = 2; i < points.length; i += 2) ctx.lineTo(points[i], points[i + 1]);
                ctx.closePath();
                ctx.fillStyle = color;
                ctx.fill();
                break;
            }
            case 'clip': {
                const [, x, y, w, h] = cmd;
                ctx.save();
                clips++;
                ctx.beginPath();
                ctx.rect(x, y, w, h);
                ctx.clip();
                break;
            }
            case 'unclip':
                if (clips > 0) {
                    ctx.restore();
                    clips--;
                    ctx.textBaseline = 'middle';
                }
                break;
        }
    }
    while (clips-- > 0) ctx.restore();
    if (!socket || socket.readyState !== WebSocket.OPEN) drawDisconnected();
}

function drawRect(cmd: Extract<DrawCmd, ['rect', ...unknown[]]>): void {
    const [, x, y, w, h, color, radius] = cmd;
    ctx.fillStyle = color;
    if (radius && ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, radius);
        ctx.fill();
    } else {
        ctx.fillRect(x, y, w, h);
    }
}

/** Draw text on the character grid. ASCII runs are drawn whole; other
 * characters (icons, symbols, wide glyphs from fallback fonts) one cell at a
 * time so they can't push the rest of the line out of its columns. */
function drawText(x: number, y: number, text: string, color: string): void {
    ctx.fillStyle = color;
    const mid = y + lineH / 2;
    let col = 0;
    let run = '';
    let runCol = 0;
    for (const c of text) {
        if (c.charCodeAt(0) < 0x80) {
            if (run === '') runCol = col;
            run += c;
        } else {
            if (run !== '') {
                ctx.fillText(run, x + runCol * charW, mid);
                run = '';
            }
            ctx.fillText(c, x + col * charW, mid);
        }
        col++;
    }
    if (run !== '') ctx.fillText(run, x + runCol * charW, mid);
}

/** Images by address, loaded once; drawing waits for them to arrive. */
const images = new Map<string, HTMLImageElement>();

function drawImage(cmd: Extract<DrawCmd, ['image', ...unknown[]]>): void {
    const [, x, y, w, h, src, fit] = cmd;
    let img = images.get(src);
    if (!img) {
        img = new Image();
        img.addEventListener('load', queueDraw);
        img.addEventListener('error', queueDraw);
        img.src = `${src}&t=${encodeURIComponent(token)}`;
        images.set(src, img);
    }
    if (!img.complete) return;
    if (img.naturalWidth === 0) {
        drawText(x + charW, y + charW, "Can't show this image", '#e06c75');
        return;
    }
    if (fit) {
        // Shrink to fit, keeping the aspect ratio; small images keep their size.
        const scale = Math.min(1, w / img.naturalWidth, h / img.naturalHeight);
        const dw = img.naturalWidth * scale;
        const dh = img.naturalHeight * scale;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
        return;
    }
    // Enlarged a lot, show the pixels rather than blur them.
    ctx.imageSmoothingEnabled = w < img.naturalWidth * 2;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, x, y, w, h);
}

function drawDisconnected(): void {
    const text = quitting ? '' : 'Wim has stopped running.';
    if (text === '') return;
    ctx.fillStyle = 'rgba(40, 44, 52, 0.85)';
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
    ctx.fillStyle = '#e06c75';
    ctx.fillText(text, 20, 30);
}

// ----- Keyboard ------------------------------------------------------------------------

const NAMED: Record<string, string> = {
    Escape: 'Esc',
    Enter: 'Enter',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Tab: 'Tab',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
};

/** Cmd shortcuts on macOS; Ctrl+Shift on Windows and Linux, where Ctrl alone
 * belongs to Vim. Returns whether the event was one. */
function shortcut(e: KeyboardEvent): boolean {
    const command = isMac ? e.metaKey : e.ctrlKey && e.shiftKey;
    if (!command) return false;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    switch (key) {
        case 's':
            send({ t: 'command', name: 'save' });
            break;
        case 'c':
            send({ t: 'command', name: 'copy' });
            break;
        case 'x':
            send({ t: 'command', name: 'cut' });
            break;
        case 'v':
            send({ t: 'command', name: 'paste' });
            break;
        case 'l':
            send({ t: 'command', name: 'agents' });
            break;
        case 'j':
            send({ t: 'command', name: 'terminal' });
            break;
        case 'q':
        case 'w':
            send({ t: 'close' });
            break;
        case '=':
        case '+':
            setZoom(zoom * ZOOM_STEP);
            break;
        case '-':
        case '_':
            setZoom(zoom / ZOOM_STEP);
            break;
        case '0':
        case ')':
            setZoom(1);
            break;
        default:
            // Leave other shortcuts (such as the browser's own) alone.
            return isMac;
    }
    return true;
}

function setZoom(z: number): void {
    zoom = Math.min(Math.max(z, 0.5), 3);
    resize();
}

window.addEventListener('keydown', (e) => {
    if (e.isComposing || quitting) return;
    if (shortcut(e)) {
        e.preventDefault();
        return;
    }
    if (isMac && e.metaKey) return;
    const named = NAMED[e.key];
    if (named) {
        // Option on the editing keys gives macOS word movement/deletion.
        const key = named === 'Tab' && e.shiftKey ? 'BackTab' : named;
        send({ t: 'key', key, ctrl: false, alt: e.altKey });
        e.preventDefault();
        return;
    }
    if ([...e.key].length !== 1) return; // Dead keys, modifiers, F-keys...
    const altGraph = e.getModifierState('AltGraph');
    if (e.ctrlKey && !altGraph) {
        send({ t: 'key', key: e.key.toLowerCase(), ctrl: true, alt: false });
    } else if (e.altKey && !altGraph && !isMac) {
        send({ t: 'key', key: e.key, ctrl: false, alt: true });
    } else {
        // Option/AltGr combinations arrive as the characters they type (`ç`).
        send({ t: 'key', key: e.key, ctrl: false, alt: false });
    }
    e.preventDefault();
});

// ----- Mouse ---------------------------------------------------------------------------------

canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    pressed = true;
    send({ t: 'mouse', kind: 'down', x: e.clientX, y: e.clientY });
    e.preventDefault();
});

window.addEventListener('mousemove', (e) => {
    if (pressed) send({ t: 'mouse', kind: 'move', x: e.clientX, y: e.clientY });
});

window.addEventListener('mouseup', (e) => {
    if (!pressed) return;
    pressed = false;
    send({ t: 'mouse', kind: 'up', x: e.clientX, y: e.clientY });
});

canvas.addEventListener(
    'wheel',
    (e) => {
        e.preventDefault();
        // A trackpad pinch arrives as Ctrl with the wheel.
        const zoom = e.ctrlKey || e.metaKey;
        send({ t: 'wheel', x: e.clientX, y: e.clientY, delta: e.deltaY, dx: e.deltaX, mode: e.deltaMode, zoom });
    },
    { passive: false },
);

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// ----- Closing -------------------------------------------------------------------------------

/** Called by the macOS window's close button and Quit command. */
(window as unknown as { wimRequestClose: () => void }).wimRequestClose = () => send({ t: 'close' });

window.addEventListener('beforeunload', (e) => {
    // In a browser window, the browser's own prompt guards unsaved changes.
    if (frame?.dirty && !quitting && socket?.readyState === WebSocket.OPEN) e.preventDefault();
});

// ----- Sound -------------------------------------------------------------------------------------

/** The sound player. Node decides what it does and draws its controls; this
 * only plays and reports back. */
const audio = new Audio();
audio.preload = 'auto';
/** The address Node knows the playing file by (without the token). */
let audioSrc = '';
let lastReport = 0;

function reportAudio(error?: string): void {
    if (audioSrc === '') return;
    lastReport = performance.now();
    send({
        t: 'audio',
        src: audioSrc,
        time: audio.currentTime,
        duration: Number.isFinite(audio.duration) ? audio.duration : 0,
        paused: audio.paused,
        volume: audio.volume,
        error: error ?? (audio.error ? "Can't play this file" : undefined),
    });
}

for (const event of ['loadedmetadata', 'durationchange', 'play', 'pause', 'ended', 'seeked', 'volumechange', 'error']) {
    audio.addEventListener(event, () => reportAudio());
}
// Playing, a few times a second is enough for the time and the scrubber.
audio.addEventListener('timeupdate', () => {
    if (performance.now() - lastReport > 250) reportAudio();
});

function audioCommand(cmd: AudioCommand): void {
    switch (cmd.op) {
        case 'load':
            audioSrc = cmd.src;
            audio.src = `${cmd.src}&t=${encodeURIComponent(token)}`;
            audio.load();
            break;
        case 'play':
            audio.play().catch((e: Error) =>
                reportAudio(e.name === 'NotAllowedError' ? 'The window blocked playing sound: click play' : e.message),
            );
            break;
        case 'pause':
            audio.pause();
            break;
        case 'seek':
            audio.currentTime = cmd.time;
            break;
        case 'volume':
            audio.volume = cmd.volume;
            break;
        case 'stop':
            audio.pause();
            audioSrc = '';
            audio.removeAttribute('src');
            audio.load();
            break;
    }
}

// ----- Connection ------------------------------------------------------------------------------

function connect(): void {
    const ws = new WebSocket(`ws://${location.host}/ws?t=${encodeURIComponent(token)}`);
    socket = ws;
    ws.addEventListener('open', () => resize());
    ws.addEventListener('message', (e) => {
        const msg = JSON.parse(String(e.data)) as ServerMessage;
        if (msg.t === 'frame') {
            frame = msg;
            if (document.title !== msg.title) document.title = msg.title;
            queueDraw();
        } else if (msg.t === 'quit') {
            quitting = true;
            window.close();
        } else if (msg.t === 'audio') {
            audioCommand(msg.cmd);
        }
    });
    ws.addEventListener('close', () => queueDraw());
}

async function start(): Promise<void> {
    // Measure only once the fonts are in, or the grid would be off.
    try {
        await document.fonts.load(font());
        if (hasIcons) await document.fonts.load(`${fontSize()}px WimIcons`);
    } catch {
        // Fall back to whatever fonts are available.
    }
    measure();
    draw();
    connect();
    canvas.focus();
}

void start();
