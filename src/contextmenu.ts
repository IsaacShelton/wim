// The right-click menu: a small list of actions drawn over everything else.
// The window is only a canvas, so Node draws it and tracks the pointer.

import { Box } from './popup';
import { DrawCmd } from './protocol';
import { theme } from './theme';

export type MenuAction = 'cut' | 'copy' | 'paste' | 'selectAll' | 'wrap';

export interface MenuItem {
    action: MenuAction;
    label: string;
    /** Shown at the right, such as the shortcut. */
    hint?: string;
    /** Greyed out and not clickable. */
    disabled?: boolean;
    /** A tick before the label, for a setting that is on. */
    checked?: boolean;
    /** A line is drawn above it. */
    separator?: boolean;
}

/** Vertical padding inside the menu's border, in pixels. */
const PAD = 4;

export class ContextMenu {
    /** The item under the pointer or keyboard, if any. */
    hover: number | undefined;

    constructor(
        readonly x: number,
        readonly y: number,
        readonly items: readonly MenuItem[],
    ) {}

    /** Where the menu goes: at the click, moved in if it would leave the
     * window. */
    box(cw: number, lh: number, width: number, height: number): Box {
        const cols = Math.max(...this.items.map((i) => 4 + Array.from(i.label).length + (i.hint ? 3 + Array.from(i.hint).length : 0)));
        const w = cols * cw;
        const h = this.items.length * lh + this.items.filter((i) => i.separator).length * 5 + 2 * PAD;
        const left = Math.max(Math.min(this.x, width - w), 0);
        const top = Math.max(Math.min(this.y, height - h), 0);
        return { left, top, right: left + w, bottom: top + h };
    }

    /** The top of each item, in the box. */
    private tops(box: Box, lh: number): number[] {
        let y = box.top + PAD;
        return this.items.map((item) => {
            if (item.separator) y += 5;
            const top = y;
            y += lh;
            return top;
        });
    }

    /** The item at a point, if the point is on an enabled one. */
    itemAt(px: number, py: number, cw: number, lh: number, width: number, height: number): number | undefined {
        const box = this.box(cw, lh, width, height);
        if (px < box.left || px >= box.right) return undefined;
        const tops = this.tops(box, lh);
        const i = tops.findIndex((top) => py >= top && py < top + lh);
        return i >= 0 && !this.items[i].disabled ? i : undefined;
    }

    contains(px: number, py: number, cw: number, lh: number, width: number, height: number): boolean {
        const box = this.box(cw, lh, width, height);
        return px >= box.left && px < box.right && py >= box.top && py < box.bottom;
    }

    /** Move the keyboard's choice up (-1) or down, over enabled items only. */
    move(delta: 1 | -1): void {
        const n = this.items.length;
        let i = this.hover ?? (delta > 0 ? -1 : n);
        for (let k = 0; k < n; k++) {
            i = (i + delta + n) % n;
            if (!this.items[i].disabled) {
                this.hover = i;
                return;
            }
        }
    }

    paint(cmds: DrawCmd[], cw: number, lh: number, width: number, height: number): void {
        const box = this.box(cw, lh, width, height);
        const w = box.right - box.left;
        cmds.push(['rect', box.left, box.top, w, box.bottom - box.top, theme.POPUP_BG, 0]);
        cmds.push(['stroke', box.left, box.top, w, box.bottom - box.top, theme.POPUP_BORDER]);
        const tops = this.tops(box, lh);
        this.items.forEach((item, i) => {
            const top = tops[i];
            if (item.separator) cmds.push(['rect', box.left + cw / 2, top - 3, w - cw, 1, theme.POPUP_BORDER, 0]);
            if (i === this.hover) cmds.push(['rect', box.left + 2, top, w - 4, lh, theme.POPUP_SELECTION, 0]);
            const color = item.disabled ? theme.COMMENT : theme.FG;
            if (item.checked) cmds.push(['text', box.left + cw, top, '✓', color]);
            cmds.push(['text', box.left + 2.5 * cw, top, item.label, color]);
            if (item.hint) {
                const x = box.right - (Array.from(item.hint).length + 1) * cw;
                cmds.push(['text', x, top, item.hint, theme.COMMENT]);
            }
        });
    }
}
