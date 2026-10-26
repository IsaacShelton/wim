// The language servers Wim knows how to run: which files each one handles,
// where to find it and which directory it should treat as the project.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface ServerSpec {
    /** The name shown to the user, such as `rust-analyzer`. */
    name: string;
    /** The language id for a file this server handles, if it handles it. */
    languageId: (file: string) => string | undefined;
    /** Ways to start the server, in order of preference. A command that fails
     * to start (or exits before initializing) falls through to the next. */
    commands: (root: string) => ServerCommand[];
    /** The project directory for a file. */
    root: (file: string) => string;
    /** Answers to `workspace/configuration`, by section. */
    settings?: Record<string, unknown>;
    initializationOptions?: unknown;
}

export interface ServerCommand {
    command: string;
    args: string[];
}

function extension(file: string): string {
    return path.extname(file).slice(1).toLowerCase();
}

/** The nearest directory from `file` upwards containing one of `markers`. */
export function findUp(file: string, markers: readonly string[]): string | undefined {
    let dir = path.dirname(file);
    for (;;) {
        if (markers.some((m) => fs.existsSync(path.join(dir, m)))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
}

/** Where Mason (the Neovim package manager) installs language servers. */
function masonBin(): string {
    if (process.platform === 'win32') {
        const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
        return path.join(local, 'nvim-data', 'mason', 'bin');
    }
    const data = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share');
    return path.join(data, 'nvim', 'mason', 'bin');
}

/** Every executable called `name` in `dirs`, then Mason's, then on the PATH. */
export function findExecutables(name: string, dirs: readonly string[] = []): string[] {
    const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
    const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter((d) => d !== '');
    const found: string[] = [];
    for (const dir of [...dirs, masonBin(), ...pathDirs]) {
        for (const ext of exts) {
            const p = path.join(dir, name + ext);
            try {
                if (fs.statSync(p).isFile() && !found.includes(p)) {
                    fs.accessSync(p, fs.constants.X_OK);
                    found.push(p);
                }
            } catch {
                // Not there, or not executable.
            }
        }
    }
    return found;
}

const RUST_ANALYZER: ServerSpec = {
    name: 'rust-analyzer',
    languageId: (file) => (extension(file) === 'rs' ? 'rust' : undefined),
    commands: () => findExecutables('rust-analyzer').map((command) => ({ command, args: [] })),
    root: (file) => {
        const crate = findUp(file, ['Cargo.toml']);
        if (crate === undefined) return path.dirname(file);
        // A crate's files belong to its workspace, if it is in one.
        for (let dir: string | undefined = crate; dir !== undefined; dir = findUp(dir, ['Cargo.toml'])) {
            if (isCargoWorkspace(dir)) return dir;
        }
        return crate;
    },
};

function isCargoWorkspace(dir: string): boolean {
    try {
        return /^\s*\[workspace\]/m.test(fs.readFileSync(path.join(dir, 'Cargo.toml'), 'utf8'));
    } catch {
        return false;
    }
}

const TS_LANGUAGES: Record<string, string> = {
    ts: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    tsx: 'typescriptreact',
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    jsx: 'javascriptreact',
};

const TYPESCRIPT: ServerSpec = {
    name: 'typescript-language-server',
    languageId: (file) => TS_LANGUAGES[extension(file)],
    // A project's own copy comes first.
    commands: (root) =>
        findExecutables('typescript-language-server', [path.join(root, 'node_modules', '.bin')]).map((command) => ({
            command,
            args: ['--stdio'],
        })),
    root: (file) =>
        findUp(file, ['tsconfig.json', 'jsconfig.json', 'package.json', '.git']) ?? path.dirname(file),
    initializationOptions: { hostInfo: 'wim' },
};

export function defaultServers(): ServerSpec[] {
    return [RUST_ANALYZER, TYPESCRIPT];
}
