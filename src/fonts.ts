// Finds a Nerd Font, whose glyphs draw the file icons: the one bundled in
// Wim's `fonts` directory, or else an installed one.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function fontDirs(): string[] {
    const home = os.homedir();
    if (process.platform === 'win32') {
        const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
        return [path.join(local, 'Microsoft', 'Windows', 'Fonts'), path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts')];
    }
    return [
        path.join(home, 'Library/Fonts'),
        '/Library/Fonts',
        path.join(home, '.local/share/fonts'),
        path.join(home, '.fonts'),
        '/usr/share/fonts',
        '/usr/local/share/fonts',
    ];
}

/** Font files in `dir` and its immediate subdirectories. */
function fontFiles(dir: string): string[] {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
    const files: string[] = [];
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            try {
                files.push(...fs.readdirSync(p).map((n) => path.join(p, n)));
            } catch {
                // Skip unreadable directories.
            }
        } else {
            files.push(p);
        }
    }
    return files;
}

/** The font Wim ships with, from the compiled code in `dist/src`. */
function bundledFont(): string | undefined {
    const dir = path.join(__dirname, '..', '..', 'fonts');
    try {
        const name = fs.readdirSync(dir).find((n) => /NerdFont.*\.(ttf|otf)$/i.test(n));
        return name && path.join(dir, name);
    } catch {
        return undefined;
    }
}

export function findNerdFont(): string | undefined {
    const bundled = bundledFont();
    if (bundled) return bundled;
    const fonts = fontDirs()
        .flatMap(fontFiles)
        .filter((p) => {
            const name = path.basename(p);
            return name.includes('NerdFont') && name.includes('Regular') && /\.(ttf|otf)$/i.test(name);
        })
        .sort();
    // The "Mono" variants keep icons one cell wide.
    return fonts.find((p) => path.basename(p).includes('NerdFontMono-')) ?? fonts[0];
}
