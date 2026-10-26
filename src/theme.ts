// Colors, after Atom's One Dark.

import type { Token } from './highlight';

export const theme = {
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
} as const;

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
