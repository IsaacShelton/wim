// Regions of text that operators act on.

import { Pos, pos } from './buffer';

/** A region of text. Charwise ranges have an exclusive end; linewise ranges
 * cover the lines `start.line..=end.line`. */
export interface Range {
    start: Pos;
    end: Pos;
    linewise: boolean;
}

export function charRange(start: Pos, end: Pos): Range {
    return { start, end, linewise: false };
}

export function lineRange(first: number, last: number): Range {
    return { start: pos(first, 0), end: pos(last, 0), linewise: true };
}
