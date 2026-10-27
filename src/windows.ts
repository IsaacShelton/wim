// Split windows: a tree of windows, each showing a buffer with its own cursor
// and scroll position. Splits share their space evenly (Vim's `equalalways`).
// The editor itself works on one buffer at a time, the active window's; the
// other windows keep where they were for when they are painted or return.

import { Pos, pos } from './editor/buffer';

export interface Win {
    readonly id: number;
    bufferId: number;
    cursor: Pos;
    scrollTop: number;
    scrollLeft: number;
    wantCol: number;
}

/** `Row`: side by side (`:vsplit`); `Column`: one above another (`:split`). */
export type SplitDir = 'Row' | 'Column';

type Node = { t: 'Win'; win: Win } | { t: 'Split'; dir: SplitDir; children: Node[] };

export interface Rect {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

/** Where a window goes: its text, and its name bar below it when there are
 * several windows. */
export interface WinRect {
    win: Win;
    area: Rect;
    bar?: Rect;
}

export type Direction = 'Left' | 'Right' | 'Up' | 'Down';

export class Windows {
    private root: Node;
    active: Win;
    /** The window active before this one (`<C-w>p`). */
    previous: Win | undefined;
    private nextId = 1;

    constructor(bufferId: number) {
        this.active = this.make({ bufferId, cursor: pos(0, 0), scrollTop: 0, scrollLeft: 0, wantCol: 0 });
        this.root = { t: 'Win', win: this.active };
    }

    private make(state: Omit<Win, 'id'>): Win {
        return { id: this.nextId++, ...state };
    }

    /** Every window, left to right and top to bottom. */
    list(): Win[] {
        const out: Win[] = [];
        const walk = (n: Node): void => {
            if (n.t === 'Win') out.push(n.win);
            else n.children.forEach(walk);
        };
        walk(this.root);
        return out;
    }

    get count(): number {
        return this.list().length;
    }

    /** The node holding `win` and its parent split. */
    private find(win: Win): { node: Node; parent?: Extract<Node, { t: 'Split' }> } | undefined {
        const walk = (n: Node, parent?: Extract<Node, { t: 'Split' }>): ReturnType<Windows['find']> => {
            if (n.t === 'Win') return n.win === win ? { node: n, parent } : undefined;
            for (const c of n.children) {
                const found = walk(c, n);
                if (found) return found;
            }
            return undefined;
        };
        return walk(this.root);
    }

    /** Split the active window: a new window showing the same, before it
     * (above or to the left, as Vim does), becomes active. */
    split(dir: SplitDir): Win {
        const old = this.active;
        const win = this.make({ ...old });
        const found = this.find(old)!;
        const leaf: Node = { t: 'Win', win };
        if (found.parent && found.parent.dir === dir) {
            found.parent.children.splice(found.parent.children.indexOf(found.node), 0, leaf);
        } else {
            const split: Node = { t: 'Split', dir, children: [leaf, found.node] };
            if (found.parent) found.parent.children[found.parent.children.indexOf(found.node)] = split;
            else this.root = split;
        }
        this.focus(win);
        return win;
    }

    focus(win: Win): void {
        if (win === this.active) return;
        this.previous = this.active;
        this.active = win;
    }

    /** Close `win`, unless it is the last. The window after it (or before)
     * becomes active if it was. */
    close(win: Win): boolean {
        const found = this.find(win);
        if (!found?.parent) return false;
        const siblings = found.parent.children;
        const i = siblings.indexOf(found.node);
        siblings.splice(i, 1);
        if (win === this.active || win === this.previous) {
            // The nearest window where it was.
            let next: Node = siblings[Math.min(i, siblings.length - 1)];
            while (next.t === 'Split') next = next.children[0];
            if (win === this.active) this.active = this.previous && this.previous !== win ? this.previous : next.win;
            this.previous = undefined;
        }
        this.collapse();
        return true;
    }

    /** Close every window but the active one. */
    only(): void {
        this.root = { t: 'Win', win: this.active };
        this.previous = undefined;
    }

    /** Remove splits left with one child. */
    private collapse(): void {
        const fix = (n: Node): Node => {
            if (n.t === 'Win') return n;
            n.children = n.children.map(fix);
            // A split in a split the same way joins its parent.
            n.children = n.children.flatMap((c) => (c.t === 'Split' && c.dir === n.dir ? c.children : [c]));
            return n.children.length === 1 ? n.children[0] : n;
        };
        this.root = fix(this.root);
    }

    /** Lay the windows out in `area`: equal shares, with a `barH` tall name
     * bar under each (when there are several) and `gap` between side-by-side
     * windows. */
    layout(area: Rect, barH: number, gap: number): WinRect[] {
        const bars = this.count > 1;
        const out: WinRect[] = [];
        const walk = (n: Node, r: Rect): void => {
            if (n.t === 'Win') {
                const bottom = bars ? Math.max(r.bottom - barH, r.top) : r.bottom;
                out.push({ win: n.win, area: { ...r, bottom }, bar: bars ? { ...r, top: bottom } : undefined });
                return;
            }
            const k = n.children.length;
            if (n.dir === 'Row') {
                const width = (r.right - r.left - gap * (k - 1)) / k;
                n.children.forEach((c, i) => {
                    const left = Math.round(r.left + i * (width + gap));
                    const right = i === k - 1 ? r.right : Math.round(r.left + i * (width + gap) + width);
                    walk(c, { ...r, left, right });
                });
            } else {
                // Whole rows each, the last taking what is left.
                const height = Math.floor((r.bottom - r.top) / k / barH) * barH;
                n.children.forEach((c, i) => {
                    const top = r.top + i * height;
                    walk(c, { ...r, top, bottom: i === k - 1 ? r.bottom : top + height });
                });
            }
        };
        walk(this.root, area);
        return out;
    }

    /** The window next to `from` in a direction: of those beyond its edge that
     * overlap it, the nearest (and then the most overlapping). */
    neighbor(rects: readonly WinRect[], from: Win, dir: Direction): Win | undefined {
        const box = (w: WinRect): Rect => ({ ...w.area, bottom: w.bar ? w.bar.bottom : w.area.bottom });
        const me = rects.find((r) => r.win === from);
        if (!me) return undefined;
        const a = box(me);
        let best: { win: Win; distance: number; overlap: number } | undefined;
        for (const r of rects) {
            if (r.win === from) continue;
            const b = box(r);
            const horizontal = dir === 'Left' || dir === 'Right';
            const distance =
                dir === 'Left' ? a.left - b.right : dir === 'Right' ? b.left - a.right : dir === 'Up' ? a.top - b.bottom : b.top - a.bottom;
            const overlap = horizontal
                ? Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
                : Math.min(a.right, b.right) - Math.max(a.left, b.left);
            if (distance < 0 || overlap <= 0) continue;
            if (!best || distance < best.distance || (distance === best.distance && overlap > best.overlap)) {
                best = { win: r.win, distance, overlap };
            }
        }
        return best?.win;
    }
}
