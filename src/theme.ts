// Colors: Wim's own, after Atom's One Dark, or Nord as the Neovim config sets
// it up (nord.nvim, and lualine's nord theme for the mode colors). `,th` or
// `:colorscheme` switches between them.

import type { Token } from './highlight';

const ONE_DARK = {
    BG: '#282c34',
    FG: '#abb2bf',
    CURSOR_LINE: '#2c313c',
    GUTTER: '#4b5263',
    GUTTER_CURRENT: '#e5c07b',
    TILDE: '#3b4048',
    SELECTION: '#3e4451',
    SEARCH: '#5c4f2e',
    CURSOR: '#528bff',
    STATUS_BG: '#21252b',
    ERROR: '#e06c75',
    /** Yank flash, as `[r, g, b]`; the alpha fades over time. */
    FLASH: [0xe5, 0xc0, 0x7b],

    KEYWORD: '#c678dd',
    TYPE: '#e5c07b',
    CONSTANT: '#d19a66',
    STRING: '#98c379',
    COMMENT: '#7f848e',
    FUNCTION: '#61afef',
    MACRO: '#56b6c2',

    MODE_NORMAL: '#61afef',
    MODE_INSERT: '#98c379',
    MODE_VISUAL: '#c678dd',
    MODE_REPLACE: '#e06c75',
    MODE_COMMAND: '#e5c07b',
    MODE_TREE: '#56b6c2',

    DIAGNOSTIC_ERROR: '#e06c75',
    DIAGNOSTIC_WARN: '#e5c07b',
    DIAGNOSTIC_INFO: '#61afef',
    DIAGNOSTIC_HINT: '#56b6c2',
    /** Other uses of the symbol under the cursor. */
    REFERENCE: '#3a404b',
    POPUP_BG: '#21252b',
    POPUP_BORDER: '#5c6370',
    POPUP_SELECTION: '#3e4451',
};

export type Theme = typeof ONE_DARK;

/** nord.nvim's colors (palette names in comments). */
const NORD: Theme = {
    BG: '#2E3440', // polar night origin
    FG: '#D8DEE9', // snow storm origin
    CURSOR_LINE: '#3B4252', // polar night bright
    GUTTER: '#4C566A', // polar night brightest
    GUTTER_CURRENT: '#D8DEE9',
    TILDE: '#3B4252',
    SELECTION: '#434C5E', // polar night brighter
    // The config's `search.theme = 'vim'` reverses ice; behind text, a
    // darker ice keeps the text readable.
    SEARCH: '#4C6A78',
    CURSOR: '#88C0D0', // frost ice
    STATUS_BG: '#3B4252',
    ERROR: '#BF616A', // aurora red
    FLASH: [0xeb, 0xcb, 0x8b], // aurora yellow

    KEYWORD: '#81A1C1', // frost artic water
    TYPE: '#81A1C1',
    CONSTANT: '#B48EAD', // aurora purple
    STRING: '#A3BE8C', // aurora green
    COMMENT: '#616E88', // polar night light
    FUNCTION: '#88C0D0',
    MACRO: '#81A1C1',

    MODE_NORMAL: '#88C0D0',
    MODE_INSERT: '#ECEFF4', // snow storm brightest
    MODE_VISUAL: '#8FBCBB', // frost polar water
    MODE_REPLACE: '#EBCB8B', // aurora yellow
    MODE_COMMAND: '#B48EAD',
    MODE_TREE: '#8FBCBB',

    DIAGNOSTIC_ERROR: '#BF616A',
    DIAGNOSTIC_WARN: '#EBCB8B',
    DIAGNOSTIC_INFO: '#88C0D0',
    DIAGNOSTIC_HINT: '#81A1C1',
    REFERENCE: '#434C5E',
    POPUP_BG: '#3B4252', // Pmenu
    POPUP_BORDER: '#4C566A', // FloatBorder
    POPUP_SELECTION: '#434C5E', // PmenuSel
};

const THEMES = { onedark: ONE_DARK, nord: NORD };

export type ThemeName = keyof typeof THEMES;

export function isThemeName(name: string): name is ThemeName {
    return name in THEMES;
}

/** The colors in use. Painting reads it each frame, so switching takes
 * effect on the next frame. */
export const theme: Theme = { ...ONE_DARK };

let current: ThemeName = 'onedark';

export function themeName(): ThemeName {
    return current;
}

export function setTheme(name: ThemeName): void {
    current = name;
    Object.assign(theme, THEMES[name]);
}

/** The color for a syntax highlighting token. */
export function tokenColor(token: Token): string {
    switch (token) {
        case 'Normal':
            return theme.FG;
        case 'Keyword':
            return theme.KEYWORD;
        case 'Type':
            return theme.TYPE;
        case 'Constant':
        case 'Number':
            return theme.CONSTANT;
        case 'String':
            return theme.STRING;
        case 'Comment':
            return theme.COMMENT;
        case 'Function':
            return theme.FUNCTION;
        case 'Macro':
            return theme.MACRO;
    }
}
