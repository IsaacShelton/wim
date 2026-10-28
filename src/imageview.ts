// Zooming and panning an image: which part of the image is in the middle of
// the view, and how large it is drawn. Changes from the keyboard glide there
// over a few frames; the mouse moves it directly.

/** How far one zoom step goes. */
const STEP = 1.25;
const MIN_SCALE = 0.02;
const MAX_SCALE = 64;
/** The share of the remaining distance covered every `EASE_MS` when gliding. */
const EASE = 0.3;
const EASE_MS = 16;

export interface Size {
    width: number;
    height: number;
}

/** Where to draw the image, relative to the view's top left. */
export interface Placement {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface State {
    /** Screen pixels per image pixel. */
    scale: number;
    /** The image point (in image pixels) at the middle of the view. */
    cx: number;
    cy: number;
}

export class ImageView {
    /** Fitting the view: the scale follows the view's size. */
    private fit = true;
    /** Where the view is going. */
    private target: State;
    /** Where it is drawn now; the same as `target` unless gliding. */
    private shown: State;
    private gliding = false;
    /** When the glide last moved, in ms; unset as it leaves rest. */
    private ticked: number | undefined;

    constructor(private readonly image: Size) {
        this.target = { scale: 1, cx: image.width / 2, cy: image.height / 2 };
        this.shown = { ...this.target };
    }

    /** Shrink to fit the view. A small image that would fit two or more
     * times its size is enlarged by the most whole times that fits, which
     * keeps its pixels square and sharp. */
    private fitScale(view: Size): number {
        const fit = Math.min(view.width / this.image.width, view.height / this.image.height);
        return fit >= 2 ? Math.floor(fit) : Math.min(fit, 1);
    }

    /** Bring a fitting target up to date with the view's size. */
    private settle(view: Size): void {
        if (this.fit) this.target.scale = this.fitScale(view);
        if (!this.gliding) this.shown = { ...this.target };
    }

    /** The scale it is drawn at, for the status line. */
    currentScale(view: Size): number {
        this.settle(view);
        return this.shown.scale;
    }

    /** Keep the image in sight: the middle of the view stays over it. */
    private clamp(s: State): State {
        return {
            scale: s.scale,
            cx: Math.min(Math.max(s.cx, 0), this.image.width),
            cy: Math.min(Math.max(s.cy, 0), this.image.height),
        };
    }

    /** Go to `next`: glide there, or jump. */
    private go(next: State, glide: boolean): void {
        this.target = this.clamp(next);
        if (glide) {
            if (!this.gliding) this.ticked = undefined;
            this.gliding = true;
        } else {
            this.shown = { ...this.target };
            this.gliding = false;
        }
    }

    /** Back to fitting the view, in the middle. */
    reset(view: Size, glide = false): void {
        this.fit = true;
        this.go({ scale: this.fitScale(view), cx: this.image.width / 2, cy: this.image.height / 2 }, glide);
    }

    /** Zoom in (`steps` > 0) or out, keeping the image point under `at` (a
     * point in the view; its middle by default) where it is. Gliding steps
     * add up, so holding a key keeps going. */
    zoom(steps: number, view: Size, at?: { x: number; y: number }, glide = false): void {
        this.settle(view);
        const from = glide ? this.target : this.shown;
        const scale = Math.min(Math.max(from.scale * STEP ** steps, MIN_SCALE), MAX_SCALE);
        const ax = (at?.x ?? view.width / 2) - view.width / 2;
        const ay = (at?.y ?? view.height / 2) - view.height / 2;
        this.fit = false;
        // The image point under `at` stays there.
        this.go({ scale, cx: from.cx + ax / from.scale - ax / scale, cy: from.cy + ay / from.scale - ay / scale }, glide);
    }

    /** Move the image by screen pixels (as dragging does). */
    pan(dx: number, dy: number, view: Size, glide = false): void {
        this.settle(view);
        const from = glide ? this.target : this.shown;
        this.go({ scale: from.scale, cx: from.cx - dx / from.scale, cy: from.cy - dy / from.scale }, glide);
    }

    /** Glide to where it is at `now` (ms), however long the frames take;
     * returns whether there is further to go. */
    tick(view: Size, now: number): boolean {
        if (!this.gliding) return false;
        if (this.fit) this.target.scale = this.fitScale(view);
        // The first frame already moves.
        const dt = Math.max(now - (this.ticked ?? now - EASE_MS), 0);
        this.ticked = now;
        const ease = 1 - (1 - EASE) ** (dt / EASE_MS);
        const t = this.target;
        const s = this.shown;
        // Zoom evenly by moving the scale's logarithm.
        const scale = Math.exp(Math.log(s.scale) + (Math.log(t.scale) - Math.log(s.scale)) * ease);
        const cx = s.cx + (t.cx - s.cx) * ease;
        const cy = s.cy + (t.cy - s.cy) * ease;
        // Done once less than half a screen pixel is left to go.
        const near =
            Math.abs(scale - t.scale) * Math.max(this.image.width, this.image.height) < 0.5 &&
            Math.abs(cx - t.cx) * scale < 0.5 &&
            Math.abs(cy - t.cy) * scale < 0.5;
        if (near) {
            this.shown = { ...t };
            this.gliding = false;
            return false;
        }
        this.shown = { scale, cx, cy };
        return true;
    }

    /** Whether it is on its way somewhere. */
    get moving(): boolean {
        return this.gliding;
    }

    place(view: Size): Placement {
        this.settle(view);
        const s = this.shown;
        return {
            x: view.width / 2 - s.cx * s.scale,
            y: view.height / 2 - s.cy * s.scale,
            width: this.image.width * s.scale,
            height: this.image.height * s.scale,
        };
    }
}
