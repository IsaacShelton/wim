// Zooming and panning an image: which part of the image is in the middle of
// the view, and how large it is drawn.

/** How far one zoom step goes. */
const STEP = 1.25;
const MIN_SCALE = 0.02;
const MAX_SCALE = 64;

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

export class ImageView {
    /** Screen pixels per image pixel; undefined to fit the view. */
    private scale: number | undefined;
    /** The image point (in image pixels) at the middle of the view. */
    private cx: number;
    private cy: number;

    constructor(private readonly image: Size) {
        this.cx = image.width / 2;
        this.cy = image.height / 2;
    }

    /** Shrink to fit the view, but never enlarge. */
    private fitScale(view: Size): number {
        return Math.min(1, view.width / this.image.width, view.height / this.image.height);
    }

    /** The scale it is drawn at, for the status line. */
    currentScale(view: Size): number {
        return this.scale ?? this.fitScale(view);
    }

    get fitted(): boolean {
        return this.scale === undefined;
    }

    /** Back to fitting the view. */
    reset(): void {
        this.scale = undefined;
        this.cx = this.image.width / 2;
        this.cy = this.image.height / 2;
    }

    /** Zoom in (`steps` > 0) or out, keeping the image point under `at` (a
     * point in the view; its middle by default) where it is. */
    zoom(steps: number, view: Size, at?: { x: number; y: number }): void {
        const old = this.currentScale(view);
        const scale = Math.min(Math.max(old * STEP ** steps, MIN_SCALE), MAX_SCALE);
        const ax = (at?.x ?? view.width / 2) - view.width / 2;
        const ay = (at?.y ?? view.height / 2) - view.height / 2;
        // The image point under `at` stays there.
        this.cx += ax / old - ax / scale;
        this.cy += ay / old - ay / scale;
        this.scale = scale;
        this.clamp();
    }

    /** Move the image by screen pixels (as dragging does). */
    pan(dx: number, dy: number, view: Size): void {
        const s = this.currentScale(view);
        this.cx -= dx / s;
        this.cy -= dy / s;
        this.clamp();
    }

    /** Keep the image in sight: the middle of the view stays over it. */
    private clamp(): void {
        this.cx = Math.min(Math.max(this.cx, 0), this.image.width);
        this.cy = Math.min(Math.max(this.cy, 0), this.image.height);
    }

    place(view: Size): Placement {
        const s = this.currentScale(view);
        return {
            x: view.width / 2 - this.cx * s,
            y: view.height / 2 - this.cy * s,
            width: this.image.width * s,
            height: this.image.height * s,
        };
    }
}
