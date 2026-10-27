// User key mappings, translated from `~/.config/nvim/init.lua` (leader `,`,
// `timeoutlen` 300ms). Mappings to Neovim plugins Wim doesn't have
// (gitsigns) are left out; Telescope's pickers, nvim-spider's subword
// motions and the theme toggle become Wim's own.

import { KeyInput, keyIs, keysEq, keysStartWith, parseKeys, plain } from './editor/keys';

/** How long to wait for the rest of an ambiguous mapping (`timeoutlen`), in ms. */
export const TIMEOUT = 300;

const LEADER = ',';

/** `Operator`: after an operator, waiting for its motion (`d`, `c`...). */
export type MapMode = 'Normal' | 'Visual' | 'Insert' | 'Operator';

/** Actions handled by the window rather than the editor. */
export type Command =
    | 'WindowLeft'
    | 'WindowRight'
    | 'WindowUp'
    | 'WindowDown'
    | 'ToggleTree'
    /** Between Wim's colors and Nord (`,th`, the config's theme toggle). */
    | 'ToggleTheme'
    /** Telescope's `find_files`. */
    | 'FindFiles'
    /** Telescope's `live_grep`. */
    | 'LiveGrep'
    /** Read one more character and insert it before the cursor. */
    | 'InsertCharBefore'
    /** Read one more character and insert it after the cursor. */
    | 'InsertCharAfter';

/** Language server features. */
export type LspAction =
    | { t: 'Goto'; method: 'definition' | 'declaration' | 'implementation' | 'typeDefinition' }
    | { t: 'References' }
    | { t: 'Hover' }
    | { t: 'Rename' }
    | { t: 'CodeAction' }
    | { t: 'DocumentSymbols' }
    | { t: 'WorkspaceSymbols' }
    | { t: 'Format' }
    /** `]d`, `[d`; with a severity, only diagnostics of that severity. */
    | { t: 'JumpDiagnostic'; forward: boolean; severity?: number }
    /** Every file's diagnostics, in a picker. */
    | { t: 'ListDiagnostics'; severity?: number };

export type Rhs =
    /** Keys fed to the editor without further mapping (`noremap`). */
    | { t: 'Keys'; keys: KeyInput[] }
    | { t: 'Command'; command: Command }
    | { t: 'Lsp'; action: LspAction };

/** Whether a mapping makes sense while the file tree has focus: window
 * commands, `:` commands and project-wide pickers do, editing keys don't. */
export function worksInTree(rhs: Rhs): boolean {
    if (rhs.t === 'Command') return rhs.command !== 'InsertCharBefore' && rhs.command !== 'InsertCharAfter';
    if (rhs.t === 'Lsp') return rhs.action.t === 'WorkspaceSymbols' || rhs.action.t === 'ListDiagnostics';
    return rhs.keys.length > 0 && keyIs(rhs.keys[0], ':');
}

interface Mapping {
    modes: readonly MapMode[];
    lhs: KeyInput[];
    rhs: Rhs;
}

export type Lookup =
    | { t: 'None' }
    /** `keys` start one or more longer mappings. */
    | { t: 'Prefix' }
    /** `keys` are a complete mapping; `ambiguous` if they also start another. */
    | { t: 'Exact'; rhs: Rhs; ambiguous: boolean };

export class Keymap {
    private constructor(private readonly maps: Mapping[]) {}

    static fromNeovimConfig(): Keymap {
        const N: MapMode[] = ['Normal'];
        const NV: MapMode[] = ['Normal', 'Visual'];
        const V: MapMode[] = ['Visual'];
        const I: MapMode[] = ['Insert'];
        const NVO: MapMode[] = ['Normal', 'Visual', 'Operator'];
        const keys = (s: string): Rhs => ({ t: 'Keys', keys: parseKeys(s) });
        const plug = (name: string): Rhs => ({ t: 'Keys', keys: [plain(`<Plug>${name}`)] });
        const command = (c: Command): Rhs => ({ t: 'Command', command: c });
        const lsp = (action: LspAction): Rhs => ({ t: 'Lsp', action });
        const maps: [MapMode[], string, Rhs][] = [
            // Insert a single character before/after the cursor (Option+c/d).
            [N, 'ç', command('InsertCharBefore')],
            [N, '∂', command('InsertCharAfter')],
            // Jump to / place global marks (Option+a/r/s/t, Option+Shift+…).
            [N, 'å', keys("'Azz")],
            [N, '®', keys("'Rzz")],
            [N, 'ß', keys("'Szz")],
            [N, '†', keys("'Tzz")],
            [N, 'Å', keys('mA')],
            [N, '‰', keys('mR')],
            [N, 'Í', keys('mS')],
            [N, 'ˇ', keys('mT')],
            // Writing and quitting.
            [N, '<leader>;', keys(':w<CR>')],
            [N, '<leader>:', keys(':wqa<CR>')],
            [N, '<leader>o', keys(':w<CR>')],
            [N, "<leader>'", keys(':w<CR>')],
            [N, '<leader>v', keys(':q<CR>')],
            [N, '<leader>V', keys(':q!<CR>')],
            // Paragraph motions on Option+j/k; outermost block with [f / ]f.
            [NV, '∆', keys('}')],
            [NV, '˚', keys('{')],
            [NV, '[f', keys('[{'.repeat(12))],
            [NV, ']f', keys(']}'.repeat(12))],
            // Insert-mode cursor movement.
            [I, '<C-l>', keys('<Right>')],
            [I, '<C-h>', keys('<Left>')],
            [I, '<C-k>', keys('<Up>')],
            [I, '<C-j>', keys('<Down>')],
            // Window navigation.
            [N, '<C-h>', command('WindowLeft')],
            [N, '<C-l>', command('WindowRight')],
            [N, '<C-j>', command('WindowDown')],
            [N, '<C-k>', command('WindowUp')],
            // Buffers.
            [N, '<Tab>', keys(':bnext<CR>')],
            [N, '<S-Tab>', keys(':bprev<CR>')],
            [N, '<leader>x', keys(':bd<CR>')],
            [N, '<leader>X', keys(':%bd<CR>')],
            [N, '<leader>K', keys(':bonly<CR>')],
            // Paste the last yank rather than the last delete.
            [NV, '<leader>p', keys('"0p')],
            [NV, '<leader>P', keys('"0P')],
            [NV, '<leader>d', keys('dd')],
            // Move lines with Option+Shift+j/k.
            [V, 'Ô', keys(":m '>+1<CR>gv")],
            [V, '\u{f8ff}', keys(":m '<-2<CR>gv")],
            [N, 'Ô', keys('V')],
            [N, '\u{f8ff}', keys('V')],
            [N, '<C-n>', command('ToggleTree')],
            [N, '<leader>th', command('ToggleTheme')],
            // Subword motions (nvim-spider).
            [NVO, '<leader>w', plug('SubwordW')],
            [NVO, '<leader>e', plug('SubwordE')],
            [NVO, '<leader>b', plug('SubwordB')],
            [NVO, '<leader>ge', plug('SubwordGe')],
            // Jump forward, as <C-i> is <Tab> in a terminal.
            [N, '<C-y>', keys('<C-i>')],
            // Telescope.
            [N, '<leader>a', command('FindFiles')],
            [N, '<leader>fw', command('LiveGrep')],
            // Language servers (set on LspAttach in the Neovim config; `K` is
            // Neovim's default hover mapping, `zK` the config's fold peek).
            [N, 'gd', lsp({ t: 'Goto', method: 'definition' })],
            [N, 'gr', lsp({ t: 'References' })],
            [N, 'gi', lsp({ t: 'Goto', method: 'implementation' })],
            [N, 'gt', lsp({ t: 'Goto', method: 'typeDefinition' })],
            [N, 'gD', lsp({ t: 'Goto', method: 'declaration' })],
            [N, '<leader>S', lsp({ t: 'DocumentSymbols' })],
            [N, '<leader>fs', lsp({ t: 'WorkspaceSymbols' })],
            [N, '<leader>ra', lsp({ t: 'Rename' })],
            [NV, '<leader>ca', lsp({ t: 'CodeAction' })],
            [NV, '<leader>f', lsp({ t: 'Format' })],
            [N, 'K', lsp({ t: 'Hover' })],
            [N, 'zK', lsp({ t: 'Hover' })],
            // Diagnostics: next/previous of any severity, or of severity 1-4.
            [N, ']d', lsp({ t: 'JumpDiagnostic', forward: true })],
            [N, '[d', lsp({ t: 'JumpDiagnostic', forward: false })],
            ...[1, 2, 3, 4].flatMap((severity): [MapMode[], string, Rhs][] => [
                [N, `]${severity}`, lsp({ t: 'JumpDiagnostic', forward: true, severity })],
                [N, `[${severity}`, lsp({ t: 'JumpDiagnostic', forward: false, severity })],
                [N, `<leader>${severity}`, lsp({ t: 'ListDiagnostics', severity })],
            ]),
            [N, '<leader>q', lsp({ t: 'ListDiagnostics' })],
            [N, '<leader>z', lsp({ t: 'ListDiagnostics', severity: 1 })],
        ];
        // On Windows and Linux, Alt+letter arrives as <M-letter> rather than the
        // character Option types on a Mac, so map those too.
        const altTwins: [string, string][] = [
            ['ç', '<M-c>'],
            ['∂', '<M-d>'],
            ['å', '<M-a>'],
            ['®', '<M-r>'],
            ['ß', '<M-s>'],
            ['†', '<M-t>'],
            ['Å', '<M-A>'],
            ['‰', '<M-R>'],
            ['Í', '<M-S>'],
            ['ˇ', '<M-T>'],
            ['∆', '<M-j>'],
            ['˚', '<M-k>'],
            ['Ô', '<M-J>'],
            ['\u{f8ff}', '<M-K>'],
        ];
        for (const [option, altKey] of altTwins) {
            for (const [modes, , rhs] of maps.filter(([, lhs]) => lhs === option)) maps.push([modes, altKey, rhs]);
        }
        return new Keymap(
            maps.map(([modes, lhs, rhs]) => ({ modes, lhs: parseKeys(lhs.replace('<leader>', LEADER)), rhs })),
        );
    }

    lookup(mode: MapMode, keys: readonly KeyInput[], inTree: boolean): Lookup {
        let exact: Rhs | undefined;
        let longer = false;
        for (const m of this.maps) {
            if (!m.modes.includes(mode) || (inTree && !worksInTree(m.rhs))) continue;
            if (keysEq(m.lhs, keys)) exact = m.rhs;
            else if (keysStartWith(m.lhs, keys)) longer = true;
        }
        if (exact) return { t: 'Exact', rhs: exact, ambiguous: longer };
        return longer ? { t: 'Prefix' } : { t: 'None' };
    }
}
