// Editor modes.

export type CmdKind = 'Ex' | 'SearchForward' | 'SearchBackward';
export type Mode = 'Normal' | 'Insert' | 'Replace' | 'Visual' | 'VisualLine' | CmdKind;

export function isVisual(m: Mode): boolean {
    return m === 'Visual' || m === 'VisualLine';
}

export function isInsert(m: Mode): boolean {
    return m === 'Insert' || m === 'Replace';
}

export function isCmdLine(m: Mode): m is CmdKind {
    return m === 'Ex' || m === 'SearchForward' || m === 'SearchBackward';
}

/** `wantCol` after `$`: stick to the end of each line. */
export const WANT_EOL = Number.MAX_SAFE_INTEGER;
