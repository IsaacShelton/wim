// Multiple buffers and file I/O.
//
// The active buffer's state lives directly in `Editor`'s fields, so motions
// and operators never need to know about buffers. Every buffer also has a
// `BufferSlot`; switching swaps the active state into its slot and the target
// slot's state out of it.

import * as fs from 'node:fs';

import { absolute, displayName } from '../paths';
import { Buffer, Pos, pos } from './buffer';
import type { Editor, LastVisual, Snapshot } from './editor';
import { EditorError, fail } from './errors';
import { isVisual } from './mode';

export class BufferSlot {
    buffer = new Buffer();
    cursor: Pos = pos(0, 0);
    filePath: string | undefined;
    savedVersion = 0;
    scrollTop = 0;
    scrollLeft = 0;
    wantCol = 0;
    undoStack: Snapshot[] = [];
    redoStack: Snapshot[] = [];
    marks = new Map<string, Pos>();
    lastVisual: LastVisual | undefined;

    constructor(readonly id: number) {}

    isModified(): boolean {
        return this.buffer.version() !== this.savedVersion;
    }
}

/** A buffer as listed in the tab line and by `:ls`. */
export interface BufferInfo {
    id: number;
    name: string;
    modified: boolean;
    active: boolean;
}

const SWAPPED = [
    'buffer',
    'cursor',
    'filePath',
    'savedVersion',
    'scrollTop',
    'scrollLeft',
    'wantCol',
    'undoStack',
    'redoStack',
    'marks',
    'lastVisual',
] as const;

/** A buffer's own state. The active buffer's lives in `Editor`, the others'
 * in their slots. */
export type BufferState = Pick<BufferSlot, (typeof SWAPPED)[number]>;

/** The state of buffer `id`, wherever it lives. Use it right away: once the
 * active buffer changes, the active buffer's state moves. */
export function bufferState(ed: Editor, id: number): BufferState | undefined {
    const i = ed.buffers.findIndex((s) => s.id === id);
    if (i < 0) return undefined;
    return i === ed.current ? ed : ed.buffers[i];
}

/** Every buffer's id and state, in order. */
export function bufferStates(ed: Editor): [number, BufferState][] {
    return ed.buffers.map((s, i) => [s.id, i === ed.current ? ed : s]);
}

/** The id of the buffer showing file `p`, if one does. */
export function findBuffer(ed: Editor, p: string): number | undefined {
    const full = absolute(p);
    return bufferStates(ed).find(([, st]) => st.filePath === full)?.[0];
}

/** The buffer for file `p`, loading it in the background if it isn't open. */
export function backgroundBuffer(ed: Editor, p: string): number {
    const existing = findBuffer(ed, p);
    if (existing !== undefined) return existing;
    const slot = new BufferSlot(ed.nextBufferId);
    ed.nextBufferId += 1;
    slot.filePath = absolute(p);
    try {
        slot.buffer = Buffer.fromText(fs.readFileSync(slot.filePath, 'utf8'));
        slot.savedVersion = slot.buffer.version();
    } catch {
        // A new file.
    }
    ed.buffers.push(slot);
    return slot.id;
}

/** Change buffer `id` with `edit` as one undoable step (or as part of the
 * change in progress, such as an Insert session). */
export function editBuffer(ed: Editor, id: number, edit: (st: BufferState) => void): void {
    const st = bufferState(ed, id);
    if (!st) return;
    const active = st === ed;
    if (active && ed.undoPending !== undefined) {
        edit(st);
    } else {
        const { lines, version } = st.buffer.snapshot();
        edit(st);
        if (st.buffer.version() !== version) {
            st.undoStack.push({ lines, version, cursor: st.cursor });
            st.redoStack = [];
        }
    }
    if (active) ed.clampCursor();
}

function swapSlot(ed: Editor, i: number): void {
    const slot = ed.buffers[i] as unknown as Record<string, unknown>;
    const active = ed as unknown as Record<string, unknown>;
    for (const field of SWAPPED) {
        const tmp = active[field];
        active[field] = slot[field];
        slot[field] = tmp;
    }
}

/** The id of the active buffer (as shown by `:ls`). */
export function bufferId(ed: Editor): number {
    return ed.buffers[ed.current].id;
}

export function bufferList(ed: Editor): BufferInfo[] {
    return ed.buffers.map((s, i) => {
        const active = i === ed.current;
        return {
            id: s.id,
            name: active ? ed.fileName() : displayName(s.filePath),
            modified: active ? ed.isModified() : s.isModified(),
            active,
        };
    });
}

/** Switch to buffer `id` if it is still open. */
export function switchToBufferQuietly(ed: Editor, id: number): boolean {
    const i = ed.buffers.findIndex((s) => s.id === id);
    if (i < 0) return false;
    activate(ed, i);
    return true;
}

export function switchToBuffer(ed: Editor, id: number): boolean {
    if (switchToBufferQuietly(ed, id)) return true;
    ed.setError(`E86: Buffer ${id} does not exist`);
    return false;
}

function activate(ed: Editor, i: number): void {
    if (i === ed.current) return;
    if (isVisual(ed.mode)) ed.exitVisual();
    ed.mode = 'Normal';
    ed.pending = [];
    ed.commitUndo();
    ed.alternate = bufferId(ed);
    swapSlot(ed, ed.current);
    swapSlot(ed, i);
    ed.current = i;
    ed.yankFlash = undefined;
    ed.clampCursor();
}

export function newBuffer(ed: Editor): void {
    const id = ed.nextBufferId;
    ed.nextBufferId += 1;
    ed.buffers.push(new BufferSlot(id));
    activate(ed, ed.buffers.length - 1);
}

export function cycleBuffer(ed: Editor, delta: number): void {
    const n = ed.buffers.length;
    activate(ed, (((ed.current + delta) % n) + n) % n);
}

export function firstOrLastBuffer(ed: Editor, last: boolean): void {
    activate(ed, last ? ed.buffers.length - 1 : 0);
}

export function alternateBuffer(ed: Editor): void {
    if (ed.alternate === undefined) ed.setError('E23: No alternate file');
    else switchToBuffer(ed, ed.alternate);
}

/** Switch to the buffer whose name matches `query` (`:b name`). Throws the
 * error message when there is no single match. */
export function switchByName(ed: Editor, query: string): void {
    const list = bufferList(ed);
    const exact = list.filter((b) => b.name === query);
    const matches = exact.length > 0 ? exact : list.filter((b) => b.name.includes(query));
    if (matches.length === 1) {
        switchToBuffer(ed, matches[0].id);
        return;
    }
    if (matches.length === 0) fail(`E94: No matching buffer for ${query}`);
    fail(`E93: More than one match for ${query}`);
}

/** Open `p`, reusing a buffer that already shows it. An empty, unnamed,
 * unmodified buffer is replaced rather than kept around. */
export function openFile(ed: Editor, p: string): void {
    const full = absolute(p);
    const existing = ed.buffers.findIndex((s, i) => (i === ed.current ? ed.filePath : s.filePath) === full);
    if (existing >= 0) {
        activate(ed, existing);
        return;
    }
    const reusable =
        ed.filePath === undefined && !ed.isModified() && ed.buffer.lineCount() === 1 && ed.buffer.lineLen(0) === 0;
    if (!reusable) newBuffer(ed);
    loadFile(ed, full);
}

/** (Re)load the active buffer from `p`. */
export function loadFile(ed: Editor, p: string): void {
    const name = displayName(p);
    let bytes: globalThis.Buffer;
    try {
        bytes = fs.readFileSync(p);
    } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
            loadText(ed, '');
            ed.filePath = p;
            ed.setMessage(`"${name}" [New]`);
        } else {
            ed.setError(`E484: Can't open file ${name}: ${err.message}`);
        }
        return;
    }
    loadText(ed, bytes.toString('utf8'));
    ed.filePath = p;
    ed.setMessage(`"${name}" ${ed.buffer.lineCount()}L, ${bytes.length}B`);
}

export function loadText(ed: Editor, text: string): void {
    ed.buffer = Buffer.fromText(text);
    ed.savedVersion = ed.buffer.version();
    ed.cursor = pos(0, 0);
    ed.scrollTop = 0;
    ed.scrollLeft = 0;
    ed.wantCol = 0;
    ed.mode = 'Normal';
    ed.undoStack = [];
    ed.redoStack = [];
    ed.undoPending = undefined;
    ed.marks = new Map();
    ed.lastVisual = undefined;
}

export function writeFile(ed: Editor, p: string | undefined): boolean {
    const target = p !== undefined ? absolute(p) : ed.filePath;
    if (target === undefined) {
        ed.setError('E32: No file name');
        return false;
    }
    const text = ed.buffer.toFileText();
    try {
        fs.writeFileSync(target, text);
    } catch (e) {
        ed.setError(`E212: Can't open file for writing: ${(e as Error).message}`);
        return false;
    }
    if (ed.filePath === undefined) ed.filePath = target;
    if (ed.filePath === target) ed.savedVersion = ed.buffer.version();
    ed.onWrite?.(target);
    ed.setMessage(
        `"${displayName(target)}" ${ed.buffer.lineCount()}L, ${globalThis.Buffer.byteLength(text)}B written`,
    );
    return true;
}

/** Write buffer `id` to its file, whether or not it is active. */
export function writeBuffer(ed: Editor, id: number): boolean {
    const st = bufferState(ed, id);
    if (st?.filePath === undefined) return false;
    try {
        fs.writeFileSync(st.filePath, st.buffer.toFileText());
    } catch (e) {
        ed.setError(`E212: Can't open file for writing: ${(e as Error).message}`);
        return false;
    }
    st.savedVersion = st.buffer.version();
    ed.onWrite?.(st.filePath);
    return true;
}

/** Write every modified buffer (`:wa`). */
export function writeAll(ed: Editor): boolean {
    let ok = !ed.isModified() || writeFile(ed, undefined);
    ed.buffers.forEach((slot, i) => {
        if (i === ed.current || !slot.isModified()) return;
        if (slot.filePath === undefined) {
            ed.setError(`E141: No file name for buffer ${slot.id}`);
            ok = false;
            return;
        }
        try {
            fs.writeFileSync(slot.filePath, slot.buffer.toFileText());
            slot.savedVersion = slot.buffer.version();
            ed.onWrite?.(slot.filePath);
        } catch (e) {
            ed.setError(`E212: Can't open file for writing: ${(e as Error).message}`);
            ok = false;
        }
    });
    return ok;
}

/** The first buffer with unsaved changes, active buffer first. */
export function firstModifiedBuffer(ed: Editor): BufferInfo | undefined {
    const list = bufferList(ed);
    return list.find((b) => b.active && b.modified) ?? list.find((b) => b.modified);
}

/** Close every buffer (`:%bd`), or every other one (`:bonly`). Throws the
 * last error. */
export function deleteAllBuffers(ed: Editor, force: boolean, keepCurrent: boolean): void {
    const current = bufferId(ed);
    const ids = ed.buffers.map((s) => s.id).filter((id) => !keepCurrent || id !== current);
    let error: unknown;
    for (const id of ids) {
        try {
            deleteBuffer(ed, id, force);
        } catch (e) {
            if (!(e instanceof EditorError)) throw e;
            error = e;
        }
    }
    if (error) throw error;
}

/** Close a buffer (`:bd`); the active one when `id` is undefined. */
export function deleteBuffer(ed: Editor, id: number | undefined, force: boolean): void {
    let i = ed.current;
    if (id !== undefined) {
        i = ed.buffers.findIndex((s) => s.id === id);
        if (i < 0) fail(`E516: No buffers were deleted: ${id}`);
    }
    const slotId = ed.buffers[i].id;
    const modified = i === ed.current ? ed.isModified() : ed.buffers[i].isModified();
    if (modified && !force) fail(`E89: No write since last change for buffer ${slotId} (add ! to override)`);
    if (ed.buffers.length === 1) {
        loadText(ed, '');
        ed.filePath = undefined;
        return;
    }
    if (i === ed.current) {
        const alt = ed.alternate === undefined ? -1 : ed.buffers.findIndex((s) => s.id === ed.alternate);
        const neighbor = i + 1 < ed.buffers.length ? i + 1 : i - 1;
        activate(ed, alt >= 0 && alt !== i ? alt : neighbor);
    }
    ed.buffers.splice(i, 1);
    if (i < ed.current) ed.current -= 1;
    if (ed.alternate === slotId) ed.alternate = undefined;
}
