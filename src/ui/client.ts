// The window: draws the frames Node sends on a canvas, and forwards keys,
// mouse and resizes to Node. All editor logic lives in Node.

import type { AudioCommand, Caret, ClientMessage, DrawCmd, ServerMessage } from '../protocol';
import { charWidth } from '../textwidth.js';

const BASE_FONT_SIZE = 15;
const LINE_SPACING = 1.3;
const ZOOM_STEP = 1.1;
const canvas = document.getElementById('wim') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const hasIcons = canvas.dataset.icons === '1';
const isMac = /Mac/.test(navigator.platform);
/**
 * A visually hidden text field. The editor draws on a canvas, which can't
 * receive text input, so macOS (and other systems) only shows the system
 * input method (IME, e.g. Pinyin) composing into an editable element. It is
 * focused while text is being entered and blurred otherwise, so that in
 * Normal mode the input method leaves keys alone. Printable keys are still
 * forwarded as keys; this field exists so the IME can run, and the text it
 * inserts or commits is read from it (see the composition and input handlers).
 */
const ime = document.getElementById('ime') as HTMLTextAreaElement | null;
/** This session's token, which the server wants for the WebSocket and images. */
const token = new URLSearchParams(location.search).get('t') ?? '';

let zoom = 1;
let charW = 9;
let lineH = 23;
let frame: Extract<ServerMessage, { t: 'frame' }> | undefined;
let drawQueued = false;
/** Whether the window has asked for the frame after the one it has. */
let tickSent = false;
let quitting = false;
let socket: WebSocket | undefined;
let pressed = false;
/** Whether an IME composition (e.g. Pinyin picking a candidate) is active. */
let composing = false;
/** When a composition last committed, to ignore a key WebKit re-sends after it. */
let lastCompositionEnd = -Infinity;
/** Text a composition just committed, and when, so its `input` event can be
 * told from punctuation the input method inserts without composing. */
let committed: { text: string; at: number } | undefined;
/** Whether keys go through the system input method (text entry) or straight
 * to the editor as Vim commands. Node says which for each frame. */
let imeWanted = false;

/** Focus the hidden field, so the system input method can compose into it. */
function focusIme(): void {
    if (!ime || !imeWanted) return;
    // Focusing while the field holds text would disturb a composition.
    if (document.activeElement !== ime) ime.focus();
}

/** Turn the input method on (for Insert mode, the agent prompt, the terminal)
 * or off, so that in Normal mode its keys reach the editor as they are
 * instead of being composed by the input method. */
function setIme(wanted: boolean): void {
    if (wanted === imeWanted) return;
    imeWanted = wanted;
    if (wanted) focusIme();
    else if (document.activeElement === ime) ime?.blur();
}

/** Drop any raw letters the browser left in the hidden field. */
function clearIme(): void {
    if (ime && !composing) ime.value = '';
}

/** Send text the input method delivered, one character at a time, as if it
 * had been typed. */
function sendText(text: string): void {
    for (const c of text) send({ t: 'key', key: c, ctrl: false, alt: false });
}

/** Where the caret is, in CSS pixels; the input method's window goes here. */
let caret: Caret | undefined;
/** Where the hidden field was last put, so frames don't reflow it for
 * nothing (and don't disturb a composition). */
let placed: Caret | undefined;

/** Put the hidden field at the caret, so the system input method shows its
 * candidates beside the cursor rather than in the window's top left. */
function placeIme(): void {
    if (!ime || !caret) return;
    if (placed && placed.x === caret.x && placed.y === caret.y && placed.w === caret.w && placed.h === caret.h) return;
    placed = { ...caret };
    ime.style.left = `${caret.x}px`;
    ime.style.top = `${caret.y}px`;
    ime.style.width = `${Math.max(caret.w, 1)}px`;
    ime.style.height = `${Math.max(caret.h, 1)}px`;
}

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
        // Ask for a glide's next frame as soon as this one is up, so the
        // frames come in step with the display.
        if (frame?.animating && !tickSent) {
            tickSent = true;
            send({ t: 'tick' });
        }
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
            case 'diagram':
                drawDiagram(cmd);
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
        fillSnapped(x, y, x + w, y + h);
    }
}

/** Round a position to the nearest device pixel. Cells are a fraction of a
 * pixel wide, and shapes ending between pixels blend with what is behind
 * them, leaving faint lines between cells that should touch. */
function snap(v: number): number {
    const dpr = window.devicePixelRatio || 1;
    return Math.round(v * dpr) / dpr;
}

function fillSnapped(left: number, top: number, right: number, bottom: number): void {
    const x = snap(left);
    const y = snap(top);
    ctx.fillRect(x, y, snap(right) - x, snap(bottom) - y);
}

/** Draw text on the character grid. ASCII runs are drawn whole; other
 * characters (icons, symbols, wide glyphs from fallback fonts) one at a time
 * so they can't push the rest of the line out of its columns. A wide
 * character (a Chinese character, an emoji) takes two cells, as it does in
 * the editor's layout. */
function drawText(x: number, y: number, text: string, color: string): void {
    ctx.fillStyle = color;
    const mid = y + lineH / 2;
    let col = 0;
    let run = '';
    let runCol = 0;
    for (const c of text) {
        const width = charWidth(c);
        if (c.charCodeAt(0) < 0x80) {
            if (run === '') runCol = col;
            run += c;
        } else {
            if (run !== '') {
                ctx.fillText(run, x + runCol * charW, mid);
                run = '';
            }
            const cx = x + col * charW;
            if (!drawPowerline(c, cx, y) && !drawBlock(c, cx, y)) ctx.fillText(c, cx, mid);
        }
        col += width;
    }
    if (run !== '') ctx.fillText(run, x + runCol * charW, mid);
}

/** Draw a Powerline separator (U+E0B0 to U+E0BF) as a shape filling its
 * cell, as the font's glyph is shorter than our lines and leaves gaps.
 * Returns false for other characters. */
function drawPowerline(c: string, left: number, top: number): boolean {
    const code = c.codePointAt(0)!;
    if (code < 0xe0b0 || code > 0xe0bf) return false;
    // On the same pixels as the cell backgrounds beside it.
    const x = snap(left);
    const y = snap(top);
    const r = snap(left + charW);
    const b = snap(top + lineH);
    const w = r - x;
    const h = b - y;
    ctx.beginPath();
    switch (code) {
        case 0xe0b0: // Right-pointing triangle.
        case 0xe0b1:
            ctx.moveTo(x, y);
            ctx.lineTo(r, y + h / 2);
            ctx.lineTo(x, b);
            break;
        case 0xe0b2: // Left-pointing triangle.
        case 0xe0b3:
            ctx.moveTo(r, y);
            ctx.lineTo(x, y + h / 2);
            ctx.lineTo(r, b);
            break;
        case 0xe0b4: // Right half circle.
        case 0xe0b5:
            ctx.moveTo(x, y);
            ctx.ellipse(x, y + h / 2, w, h / 2, 0, -Math.PI / 2, Math.PI / 2);
            break;
        case 0xe0b6: // Left half circle.
        case 0xe0b7:
            ctx.moveTo(r, b);
            ctx.ellipse(r, y + h / 2, w, h / 2, 0, Math.PI / 2, (3 * Math.PI) / 2);
            break;
        case 0xe0b8: // Lower left triangle.
            ctx.moveTo(x, y);
            ctx.lineTo(r, b);
            ctx.lineTo(x, b);
            break;
        case 0xe0ba: // Lower right triangle.
            ctx.moveTo(r, y);
            ctx.lineTo(r, b);
            ctx.lineTo(x, b);
            break;
        case 0xe0bc: // Upper left triangle.
            ctx.moveTo(x, y);
            ctx.lineTo(r, y);
            ctx.lineTo(x, b);
            break;
        case 0xe0be: // Upper right triangle.
            ctx.moveTo(x, y);
            ctx.lineTo(r, y);
            ctx.lineTo(r, b);
            break;
        case 0xe0b9: // Backslash.
        case 0xe0bf:
            ctx.moveTo(x, y);
            ctx.lineTo(r, b);
            break;
        case 0xe0bb: // Forward slash.
        case 0xe0bd:
            ctx.moveTo(x, b);
            ctx.lineTo(r, y);
            break;
    }
    // The odd ones are outlines; the rest are filled.
    if (code & 1) {
        ctx.strokeStyle = ctx.fillStyle;
        ctx.lineWidth = 1;
        ctx.stroke();
    } else {
        ctx.closePath();
        ctx.fill();
    }
    return true;
}

/** The quadrants lit by U+2596 to U+259F: 1 upper left, 2 upper right,
 * 4 lower left, 8 lower right. */
const QUADRANTS = [4, 8, 1, 13, 9, 7, 11, 2, 6, 14];

/** Draw a block element (U+2580 to U+259F) as rectangles filling its cell,
 * as the font's glyph is shorter than our lines and leaves gaps. Returns
 * false for other characters. */
function drawBlock(c: string, x: number, y: number): boolean {
    const code = c.codePointAt(0)!;
    if (code < 0x2580 || code > 0x259f) return false;
    // A part of the cell, in fractions of its width and height.
    const part = (l: number, t: number, r: number, b: number): void =>
        fillSnapped(x + l * charW, y + t * lineH, x + r * charW, y + b * lineH);
    if (code === 0x2580) {
        part(0, 0, 1, 0.5); // Upper half.
    } else if (code <= 0x2588) {
        part(0, 1 - (code - 0x2580) / 8, 1, 1); // Lower eighths, to full.
    } else if (code <= 0x258f) {
        part(0, 0, (0x2590 - code) / 8, 1); // Left eighths.
    } else if (code === 0x2590) {
        part(0.5, 0, 1, 1); // Right half.
    } else if (code <= 0x2593) {
        // Light, medium and dark shades.
        ctx.globalAlpha = (code - 0x2590) / 4;
        part(0, 0, 1, 1);
        ctx.globalAlpha = 1;
    } else if (code === 0x2594) {
        part(0, 0, 1, 1 / 8); // Upper eighth.
    } else if (code === 0x2595) {
        part(7 / 8, 0, 1, 1); // Right eighth.
    } else {
        const lit = QUADRANTS[code - 0x2596];
        if (lit & 1) part(0, 0, 0.5, 0.5);
        if (lit & 2) part(0.5, 0, 1, 0.5);
        if (lit & 4) part(0, 0.5, 0.5, 1);
        if (lit & 8) part(0.5, 0.5, 1, 1);
    }
    return true;
}

/** Images by address, loaded once; drawing waits for them to arrive. */
const images = new Map<string, HTMLImageElement>();
/** Images decoded once and for all. WebKit lets go of a large image's
 * decoded pixels and decodes it again when it is next drawn, which stalls
 * scrolling for a moment each time one comes into view. */
const bitmaps = new WeakMap<HTMLImageElement, ImageBitmap>();

/** Decode `img` into a bitmap to draw instead, once it can be. */
function keepDecoded(img: HTMLImageElement): void {
    createImageBitmap(img).then(
        (bitmap) => {
            bitmaps.set(img, bitmap);
            queueDraw();
        },
        // The image itself is drawn instead.
        () => {},
    );
}

function drawImage(cmd: Extract<DrawCmd, ['image', ...unknown[]]>): void {
    const [, x, y, w, h, src, fit] = cmd;
    let img = images.get(src);
    if (!img) {
        img = new Image();
        const loaded = img;
        img.addEventListener('load', () => {
            keepDecoded(loaded);
            queueDraw();
        });
        img.addEventListener('error', queueDraw);
        img.src = `${src}&t=${encodeURIComponent(token)}`;
        images.set(src, img);
    }
    if (!img.complete) return;
    if (img.naturalWidth === 0) {
        drawText(x + charW, y + charW, "Can't show this image", '#e06c75');
        return;
    }
    const source = bitmaps.get(img) ?? img;
    if (fit) {
        // Shrink to fit, keeping the aspect ratio; small images keep their size.
        const scale = Math.min(1, w / img.naturalWidth, h / img.naturalHeight);
        const dw = img.naturalWidth * scale;
        const dh = img.naturalHeight * scale;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(source, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
        return;
    }
    // Enlarged a lot, show the pixels rather than blur them.
    ctx.imageSmoothingEnabled = w < img.naturalWidth * 2;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, x, y, w, h);
}

// ----- Diagrams -----------------------------------------------------------------------

interface Mermaid {
    initialize(config: object): void;
    render(id: string, source: string): Promise<{ svg: string }>;
}

/** Mermaid's script, loaded from Wim's server the first time a diagram is
 * shown. */
let mermaid: Promise<Mermaid> | undefined;

function loadMermaid(): Promise<Mermaid> {
    mermaid ??= new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = '/mermaid.js';
        script.addEventListener('load', () => resolve((globalThis as unknown as { mermaid: Mermaid }).mermaid));
        script.addEventListener('error', () => reject(new Error("Can't load Mermaid")));
        document.head.appendChild(script);
    });
    return mermaid;
}

/** Diagrams drawn as images, by id and theme. */
const diagrams = new Map<string, HTMLImageElement | 'pending' | 'failed'>();
/** Mermaid draws one diagram at a time. */
let diagramQueue: Promise<void> = Promise.resolve();
let diagramCount = 0;

function drawDiagram(cmd: Extract<DrawCmd, ['diagram', ...unknown[]]>): void {
    const [, x, y, w, h, id, source, theme] = cmd;
    const key = `${id}:${JSON.stringify(theme)}`;
    const img = diagrams.get(key);
    if (img === undefined) {
        diagrams.set(key, 'pending');
        diagramQueue = diagramQueue.then(() => renderDiagram(key, id, source, theme));
        return;
    }
    if (typeof img === 'string' || !img.complete || w <= 0) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmaps.get(img) ?? img, x, y, w, h);
}

async function renderDiagram(key: string, id: string, source: string, theme: Record<string, string>): Promise<void> {
    try {
        const m = await loadMermaid();
        m.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            suppressErrorRendering: true,
            theme: 'base',
            themeVariables: theme,
            fontFamily: theme.fontFamily,
            // Labels as SVG text: HTML in an SVG drawn as an image doesn't show
            // everywhere.
            htmlLabels: false,
            flowchart: { htmlLabels: false },
        });
        const { svg } = await m.render(`wim-diagram-${diagramCount++}`, source);
        const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
        const root = doc.documentElement as unknown as SVGSVGElement;
        const box = root.viewBox.baseVal;
        const width = box && box.width > 0 ? box.width : Number.parseFloat(root.getAttribute('width') ?? '') || 400;
        const height = box && box.height > 0 ? box.height : Number.parseFloat(root.getAttribute('height') ?? '') || 300;
        // Drawn at twice the size (or the screen's), so it stays sharp.
        const scale = Math.max(2, window.devicePixelRatio || 1);
        root.setAttribute('width', String(width * scale));
        root.setAttribute('height', String(height * scale));
        root.removeAttribute('style');
        const img = new Image();
        img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`;
        await img.decode();
        keepDecoded(img);
        diagrams.set(key, img);
        send({ t: 'diagram', id, width, height });
    } catch (e) {
        diagrams.set(key, 'failed');
        const message = (e as Error)?.message ?? String(e);
        // Mermaid's message has the line, and a caret under it, which can't
        // line up here.
        const lines = message.split('\n').filter((l) => l.trim() !== '' && !/^[-\s]*\^\s*$/.test(l));
        send({ t: 'diagram', id, width: 0, height: 0, error: lines.join(' ').slice(0, 500) });
    }
    queueDraw();
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
        case 'a':
            send({ t: 'command', name: 'selectAll' });
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
    // While an IME composition is active, keys belong to the input method:
    // don't forward them or stop it. `keyCode === 229` (`VKEY_PROCESSKEY`,
    // `key === 'Process'`) marks a key the IME is consuming; committed text
    // arrives separately on `compositionend`.
    if (e.isComposing || composing || e.keyCode === 229 || e.key === 'Process' || quitting) return;
    if (shortcut(e)) {
        e.preventDefault();
        return;
    }
    if (isMac && e.metaKey) return;
    // WebKit can re-dispatch the key that committed a composition (Enter for
    // Pinyin) right after `compositionend`; don't act on it twice.
    if (e.key === 'Enter' && e.timeStamp - lastCompositionEnd < 50) return;
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

// ----- Input method (IME) ---------------------------------------------------------------------
//
// macOS Pinyin and other system input methods compose into the hidden field;
// the letters of the composition aren't sent as ordinary keys. When a
// candidate is chosen (or composition otherwise commits), `compositionend`
// carries the resulting text, which we insert one character at a time, the
// same as typing it. Cancelling a composition sends nothing.
//
// The field is focused only while text is being entered (Insert mode, the
// agent prompt, the terminal: see the frame's `ime`). In Normal and other
// modes it is blurred, so the input method doesn't take the keys for a
// composition; otherwise `d`, `gg`, `,` and the other commands would never
// reach the editor while Pinyin is selected.
if (ime) {
    ime.addEventListener('compositionstart', () => {
        composing = true;
        committed = undefined;
        ime.value = '';
        // The candidate window follows the field's caret.
        placeIme();
    });
    ime.addEventListener('compositionend', (e) => {
        composing = false;
        lastCompositionEnd = e.timeStamp;
        const data = e.data ?? '';
        ime.value = '';
        // `compositionend` can fire with the field still holding composition
        // text; clear again after the browser settles it.
        queueMicrotask(clearIme);
        // The browser fires an `input` event for this text too; don't insert
        // it twice (see the `input` handler).
        committed = { text: data, at: e.timeStamp };
        // A composition cancelled by leaving text entry (a blur) still ends
        // here; its text doesn't belong in Normal mode.
        if (imeWanted) sendText(data);
        focusIme();
    });
    // `input` also fires for raw keys and for composition updates. Raw keys
    // are handled on `keydown` and never reach the field, but an input method
    // can insert punctuation (e.g. `，` from Pinyin) without composing: that
    // text arrives here, and nothing else would forward it.
    ime.addEventListener('input', (e) => {
        const ev = e as InputEvent;
        if (ev.isComposing || composing) return;
        // Some browsers leave `data` empty and only fill the field.
        const data = ev.data ?? ime.value;
        clearIme();
        if (data === '') return;
        // Only text entry takes what an input method inserts (an IME blurs
        // the field in Normal mode, but a stray event shouldn't type there).
        if (!imeWanted) return;
        // Text a composition committed was already sent by `compositionend`;
        // the browser's `input` event for it is a duplicate.
        if (ev.inputType === 'insertCompositionText') return;
        if (committed && data === committed.text && ev.timeStamp - committed.at < 100) {
            committed = undefined;
            return;
        }
        sendText(data);
        focusIme();
    });
    // Keep the input method active while text is being entered: take focus
    // back unless composing or Node has said keys belong to the editor.
    ime.addEventListener('blur', () => {
        // Losing focus ends any composition (some platforms don't fire
        // `compositionend` for it); don't leave keys stuck with the input
        // method.
        composing = false;
        clearIme();
        if (imeWanted) queueMicrotask(focusIme);
    });
}

// ----- Mouse ---------------------------------------------------------------------------------

canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    pressed = true;
    send({ t: 'mouse', kind: 'down', x: e.clientX, y: e.clientY, mod: isMac ? e.metaKey : e.ctrlKey });
    e.preventDefault();
    // Text entry takes the focus back for the input method; otherwise leave
    // it off so the key goes to the editor.
    if (imeWanted) focusIme();
    else ime?.blur();
});

window.addEventListener('mousemove', (e) => {
    if (pressed || frame?.tracking) send({ t: 'mouse', kind: 'move', x: e.clientX, y: e.clientY });
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

canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    send({ t: 'context', x: e.clientX, y: e.clientY });
});

// ----- Dropping files ------------------------------------------------------------------------

/** The largest file sent to Node (Claude takes images up to 5 MB). */
const MAX_DROP_BYTES = 5 * 1024 * 1024;

// Without this, dropping a file would open it in place of Wim.
window.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('drop', (e) => {
    e.preventDefault();
    // In the macOS window, take focus from the app the file came from.
    (window as unknown as { webkit?: { messageHandlers?: { wimActivate?: { postMessage(m: unknown): void } } } }).webkit
        ?.messageHandlers?.wimActivate?.postMessage(1);
    window.focus();
    const x = e.clientX;
    const y = e.clientY;
    for (const file of Array.from(e.dataTransfer?.files ?? [])) {
        const name = file.name;
        if (file.size > MAX_DROP_BYTES) {
            send({ t: 'drop', x, y, name, error: `${name} is too large (at most 5 MB)` });
            continue;
        }
        const reader = new FileReader();
        reader.onload = () => {
            const url = String(reader.result);
            send({ t: 'drop', x, y, name, data: url.slice(url.indexOf(',') + 1) });
        };
        reader.onerror = () => send({ t: 'drop', x, y, name, error: `Can't read ${name}` });
        reader.readAsDataURL(file);
    }
});

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
            tickSent = false;
            if (document.title !== msg.title) document.title = msg.title;
            setIme(msg.ime === true);
            if (msg.caret) {
                caret = msg.caret;
                placeIme();
            }
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
}

void start();
