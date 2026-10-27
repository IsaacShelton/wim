// Messages between Node (which runs the editor) and the window (which only
// draws and forwards input). Both sides import these types.

/** Messages from the window to Node. */
export type ClientMessage =
    /** The window's size and font metrics, in CSS pixels. */
    | { t: 'resize'; width: number; height: number; charW: number; lineH: number }
    /** A key: a named key (`Esc`, `Left`, ...) or one typed character. */
    | { t: 'key'; key: string; ctrl: boolean; alt: boolean }
    /** Cmd shortcuts (Ctrl+Shift on Windows and Linux). `agents` (Cmd+L)
     * shows or hides the Claude Code panel. */
    | { t: 'command'; name: 'save' | 'copy' | 'cut' | 'paste' | 'agents' }
    | { t: 'mouse'; kind: 'down' | 'move' | 'up'; x: number; y: number }
    /** A wheel event's deltas, with the DOM's `deltaMode`. `zoom` is set for
     * Ctrl or Cmd with the wheel, and for pinching on a trackpad. */
    | { t: 'wheel'; x: number; y: number; delta: number; dx: number; mode: number; zoom: boolean }
    /** The user asked to close the window. */
    | { t: 'close' }
    /** How the window's sound player is doing. */
    | ({ t: 'audio' } & AudioReport);

/** Messages from Node to the window. */
export type ServerMessage =
    | { t: 'frame'; title: string; dirty: boolean; cmds: DrawCmd[] }
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

/** One drawing operation. Coordinates are CSS pixels; colors are CSS colors. */
export type DrawCmd =
    | [op: 'rect', x: number, y: number, w: number, h: number, color: string, radius?: number]
    | [op: 'stroke', x: number, y: number, w: number, h: number, color: string]
    /** Text on the character grid: each character takes one cell starting at
     * `x`, centered vertically in the row whose top is `y`. */
    | [op: 'text', x: number, y: number, text: string, color: string, italic?: boolean]
    | [op: 'poly', points: number[], color: string]
    /** An image from Wim's server (`src` is its path there), drawn to fill
     * the box, or with `fit` scaled down to fit it if needed (never up) and
     * centered in it. */
    | [op: 'image', x: number, y: number, w: number, h: number, src: string, fit?: boolean]
    | [op: 'clip', x: number, y: number, w: number, h: number]
    | [op: 'unclip'];
