// Messages between Node (which runs the editor) and the window (which only
// draws and forwards input). Both sides import these types.

/** Messages from the window to Node. */
export type ClientMessage =
    /** The window's size and font metrics, in CSS pixels. */
    | { t: 'resize'; width: number; height: number; charW: number; lineH: number }
    /** A key: a named key (`Esc`, `Left`, ...) or one typed character. */
    | { t: 'key'; key: string; ctrl: boolean; alt: boolean }
    /** Cmd shortcuts (Ctrl+Shift on Windows and Linux). */
    | { t: 'command'; name: 'save' | 'copy' | 'cut' | 'paste' }
    | { t: 'mouse'; kind: 'down' | 'move' | 'up'; x: number; y: number }
    /** A wheel event's deltas, with the DOM's `deltaMode`. `zoom` is set for
     * Ctrl or Cmd with the wheel, and for pinching on a trackpad. */
    | { t: 'wheel'; x: number; y: number; delta: number; dx: number; mode: number; zoom: boolean }
    /** The user asked to close the window. */
    | { t: 'close' };

/** Messages from Node to the window. */
export type ServerMessage =
    | { t: 'frame'; title: string; dirty: boolean; cmds: DrawCmd[] }
    /** Wim is exiting; the window should close. */
    | { t: 'quit' };

/** One drawing operation. Coordinates are CSS pixels; colors are CSS colors. */
export type DrawCmd =
    | [op: 'rect', x: number, y: number, w: number, h: number, color: string, radius?: number]
    | [op: 'stroke', x: number, y: number, w: number, h: number, color: string]
    /** Text on the character grid: each character takes one cell starting at
     * `x`, centered vertically in the row whose top is `y`. */
    | [op: 'text', x: number, y: number, text: string, color: string]
    | [op: 'poly', points: number[], color: string]
    /** An image from Wim's server (`src` is its path there), drawn to fill
     * the box, or with `fit` scaled down to fit it if needed (never up) and
     * centered in it. */
    | [op: 'image', x: number, y: number, w: number, h: number, src: string, fit?: boolean]
    | [op: 'clip', x: number, y: number, w: number, h: number]
    | [op: 'unclip'];
