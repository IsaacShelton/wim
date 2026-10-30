// Messages between Node (which runs the editor) and the window (which only
// draws and forwards input). Both sides import these types.

/** Messages from the window to Node. */
export type ClientMessage =
    /** The window's size and font metrics, in CSS pixels. */
    | { t: 'resize'; width: number; height: number; charW: number; lineH: number }
    /** A key: a named key (`Esc`, `Left`, ...) or one typed character. */
    | { t: 'key'; key: string; ctrl: boolean; alt: boolean }
    /** Cmd shortcuts (Ctrl+Shift on Windows and Linux). `agents` (Cmd+L)
     * shows or hides the Claude Code panel, and `terminal` (Cmd+J) the shell. */
    | { t: 'command'; name: 'save' | 'copy' | 'cut' | 'paste' | 'agents' | 'terminal' }
    /** The right button went down at a point (the window's context menu
     * event). */
    | { t: 'context'; x: number; y: number }
    /** `mod` is Cmd held (Ctrl on Windows and Linux), as for following a
     * link. */
    | { t: 'mouse'; kind: 'down' | 'move' | 'up'; x: number; y: number; mod?: boolean }
    /** A wheel event's deltas, with the DOM's `deltaMode`. `zoom` is set for
     * Ctrl or Cmd with the wheel, and for pinching on a trackpad. */
    | { t: 'wheel'; x: number; y: number; delta: number; dx: number; mode: number; zoom: boolean }
    /** The user asked to close the window. */
    | { t: 'close' }
    /** How the window's sound player is doing. */
    | ({ t: 'audio' } & AudioReport)
    /** How big the window drew a Mermaid diagram, in CSS pixels, or why it
     * couldn't. */
    | { t: 'diagram'; id: string; width: number; height: number; error?: string }
    /** A file dropped on the window, where it was dropped, with its bytes in
     * base64 (or why the window couldn't read them). One message per file. */
    | { t: 'drop'; x: number; y: number; name: string; data?: string; error?: string }
    /** The window drew an `animating` frame and is ready for the next one. */
    | { t: 'tick' };

/** Messages from Node to the window. */
export type ServerMessage =
    /** `animating`: something is gliding, so the window asks for the next
     * frame (with `tick`) once it has drawn this one, in step with the
     * display. `tracking`: a menu is open, so the window sends `move`
     * for the pointer even with no button down. */
    | { t: 'frame'; title: string; dirty: boolean; cmds: DrawCmd[]; animating?: boolean; tracking?: boolean }
    /** Wim is exiting; the window should close. */
    | { t: 'quit' }
    | { t: 'audio'; cmd: AudioCommand };

/** What the window should do with its sound player (an <audio> element). */
export type AudioCommand =
    | { op: 'load'; src: string }
    | { op: 'play' }
    | { op: 'pause' }
    | { op: 'seek'; time: number }
    | { op: 'volume'; volume: number }
    | { op: 'stop' };

/** How the window's sound player is doing, for the file at `src`. */
export interface AudioReport {
    src: string;
    time: number;
    duration: number;
    paused: boolean;
    volume: number;
    error?: string;
}

/** A font style for text, as CSS's `font` shorthand starts. */
export type TextStyle = 'italic' | 'bold' | 'italic bold';

/** One drawing operation. Coordinates are CSS pixels; colors are CSS colors. */
export type DrawCmd =
    | [op: 'rect', x: number, y: number, w: number, h: number, color: string, radius?: number]
    | [op: 'stroke', x: number, y: number, w: number, h: number, color: string]
    /** Text on the character grid: each character takes one cell starting at
     * `x`, centered vertically in the row whose top is `y`. */
    | [op: 'text', x: number, y: number, text: string, color: string, style?: TextStyle]
    | [op: 'poly', points: number[], color: string]
    /** An image from Wim's server (`src` is its path there), drawn to fill
     * the box, or with `fit` scaled down to fit it if needed (never up) and
     * centered in it. */
    | [op: 'image', x: number, y: number, w: number, h: number, src: string, fit?: boolean]
    /** A Mermaid diagram, drawn from its source with Mermaid's theme
     * variables to fill the box. With no width the window only draws it to
     * say how big it is. */
    | [op: 'diagram', x: number, y: number, w: number, h: number, id: string, source: string, theme: Record<string, string>]
    | [op: 'clip', x: number, y: number, w: number, h: number]
    | [op: 'unclip'];
