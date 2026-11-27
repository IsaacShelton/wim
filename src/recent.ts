// The project folders Wim has opened, most recent first, kept between runs.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** How many projects are remembered. */
const MAX_RECENT = 20;

/** Where recent projects are kept: the user's state directory, so it is
 * per user and survives Wim moving. */
export function recentProjectsPath(): string {
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', 'wim', 'recent-projects.json');
    }
    if (process.platform === 'win32') {
        return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'wim', 'recent-projects.json');
    }
    return path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'wim', 'recent-projects.json');
}

/** The project folders Wim remembers. */
export interface RecentProjects {
    /** The folders, most recent first. */
    list(): string[];
    /** Remember `dir` as the most recent project. */
    add(dir: string): void;
}

/** Recent projects kept in a JSON file between runs. */
export class FileRecentProjects implements RecentProjects {
    private dirs: string[];

    constructor(private readonly file = recentProjectsPath()) {
        this.dirs = read(this.file);
    }

    list(): string[] {
        return [...this.dirs];
    }

    add(dir: string): void {
        const canonical = path.resolve(dir);
        this.dirs = [canonical, ...this.dirs.filter((d) => d !== canonical)].slice(0, MAX_RECENT);
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.writeFileSync(this.file, `${JSON.stringify(this.dirs, null, 2)}\n`);
        } catch {
            // Recent projects are a convenience: a read-only state directory
            // only means Wim forgets them when it closes.
        }
    }
}

/** Recent projects kept only for this run (for tests). */
export class MemoryRecentProjects implements RecentProjects {
    private dirs: string[] = [];

    list(): string[] {
        return [...this.dirs];
    }

    add(dir: string): void {
        const canonical = path.resolve(dir);
        this.dirs = [canonical, ...this.dirs.filter((d) => d !== canonical)].slice(0, MAX_RECENT);
    }
}

/** Read a list of folders, ignoring anything malformed. */
function read(file: string): string[] {
    let data: unknown;
    try {
        data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return [];
    }
    if (!Array.isArray(data)) return [];
    const dirs: string[] = [];
    for (const dir of data) {
        if (typeof dir !== 'string' || dir === '' || dirs.includes(dir)) continue;
        dirs.push(dir);
        if (dirs.length === MAX_RECENT) break;
    }
    return dirs;
}
