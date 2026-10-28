// Numbers that glide to where they are going instead of jumping there: the
// caret and the scroll position, when `editor.smoothCaret` and
// `editor.smoothScroll` are on.

/** Close enough to the target to stop, in the value's units (lines or
 * columns). */
const REST = 0.02;
/** How far back a glide starts when it leaves rest: one frame, so the first
 * frame already moves. */
const FIRST_STEP = 16;

/** A number that follows its target, closing about 63% of the gap every
 * `tau` ms, so it is fast at first and settles gently. */
export class Glide {
    private at: number | undefined;
    private target = 0;
    private time = 0;

    constructor(private readonly tau: number) {}

    /** Where the value is at `now` (ms), heading for `target`. It starts no
     * further than `maxGap` away, so a long jump only glides the last part. */
    step(target: number, now: number, maxGap = Infinity): number {
        if (this.at === undefined) {
            this.at = target;
        } else {
            if (this.at === this.target) this.time = now - FIRST_STEP;
            const gap = Math.min(Math.max(this.at - target, -maxGap), maxGap);
            this.at = target + gap * Math.exp(-Math.max(now - this.time, 0) / this.tau);
            if (Math.abs(this.at - target) < REST) this.at = target;
        }
        this.target = target;
        this.time = now;
        return this.at;
    }

    /** Whether it has yet to reach its target. */
    get moving(): boolean {
        return this.at !== undefined && this.at !== this.target;
    }

    /** Jump to the next target. */
    reset(): void {
        this.at = undefined;
    }
}
