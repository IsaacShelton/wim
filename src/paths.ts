// Path helpers shared by the editor and the file tree.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function expandTilde(p: string): string {
    if (p.startsWith('~')) return os.homedir() + p.slice(1);
    return p;
}

/** The working directory, with symlinks resolved. */
export function currentDir(): string {
    try {
        return fs.realpathSync.native(process.cwd());
    } catch {
        return process.cwd();
    }
}

/** An absolute, canonical form of `p` so the same file is never opened in
 * two buffers. */
export function absolute(p: string): string {
    const full = path.resolve(p);
    try {
        return fs.realpathSync.native(full);
    } catch {
        // A file that doesn't exist yet: canonicalize its directory instead.
        try {
            return path.join(fs.realpathSync.native(path.dirname(full)), path.basename(full));
        } catch {
            return full;
        }
    }
}

/** `child` relative to `parent`, if it is inside it. */
export function stripPrefix(child: string, parent: string): string | undefined {
    const rel = path.relative(parent, child);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    return rel;
}

/** A short name for a path: relative to the working directory or home. */
export function displayName(p: string | undefined): string {
    if (p === undefined) return '[No Name]';
    const rel = stripPrefix(p, currentDir());
    if (rel !== undefined) return rel;
    const home = stripPrefix(p, os.homedir());
    if (home !== undefined) return '~/' + home;
    return p;
}

/** The last component of a display name. */
export function baseName(name: string): string {
    const parts = name.split(/[\\/]/);
    return parts[parts.length - 1];
}
