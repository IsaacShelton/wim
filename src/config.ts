// Wim's settings, from `wim.config.json` in Wim's own directory (beside
// package.json). Anything missing or invalid falls back to the default, with
// a warning.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { EffortLevel } from './agent/backend';
import { EFFORTS } from './agent/session';
import { ThemeName, isThemeName } from './theme';

/** How hard an agent is asked to work: the model, and its effort. */
export interface Preset {
    /** A model alias (`haiku`, `sonnet`, `opus`) or id; unset for Claude
     * Code's default. */
    model?: string;
    effort?: EffortLevel;
}

export const PRESET_NAMES = ['low', 'medium', 'high'] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

export interface Config {
    theme: ThemeName;
    claude: {
        /** Whether Wim connects to Claude Code at all. */
        enabled: boolean;
        /** Settings for low, medium and high complexity tasks. */
        presets: Record<PresetName, Preset>;
        /** The preset new sessions start with (by default `high`); unset
         * (`null` in the file) keeps Claude Code's own settings. */
        defaultPreset?: PresetName;
        /** How long the prompt cache lives after a request, in minutes. */
        cacheMinutes: number;
    };
    terminal: {
        /** The shell to run (by default zsh, or PowerShell on Windows). */
        shell?: string;
    };
    editor: {
        /** Whether the caret glides to where it moves instead of jumping. */
        smoothCaret: boolean;
        /** Whether the text glides when it scrolls (`<C-d>`, `<C-u>`, the
         * mouse wheel, ...) instead of jumping. */
        smoothScroll: boolean;
    };
}

export const DEFAULT_CONFIG: Config = {
    theme: 'onedark',
    claude: {
        enabled: false,
        presets: {
            low: { model: 'claude-haiku-5-5', effort: 'low' },
            medium: { model: 'claude-sonnet-5-5', effort: 'medium' },
            high: { model: 'claude-opus-5-5', effort: 'high' },
        },
        defaultPreset: 'high',
        cacheMinutes: 60,
    },
    terminal: {},
    editor: {
        smoothCaret: false,
        smoothScroll: false,
    },
};

/** A fresh copy of the defaults. */
export function defaultConfig(): Config {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config;
}

/** Where the settings file is: Wim's root, from the compiled code in
 * `dist/src`. */
export function configPath(): string {
    return path.join(__dirname, '..', '..', 'wim.config.json');
}

type Obj = Record<string, unknown>;

function isObject(v: unknown): v is Obj {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The settings in `text` (JSON), over the defaults, and what was wrong with
 * it. */
export function parseConfig(text: string): { config: Config; warnings: string[] } {
    const config = defaultConfig();
    const warnings: string[] = [];
    let root: unknown;
    try {
        root = JSON.parse(text);
    } catch (e) {
        return { config, warnings: [`wim.config.json: ${(e as Error).message}`] };
    }
    if (!isObject(root)) return { config, warnings: ['wim.config.json: expected an object'] };
    const warn = (key: string, expected: string): void => {
        warnings.push(`wim.config.json: ${key} should be ${expected}`);
    };

    if (root.theme !== undefined) {
        if (typeof root.theme === 'string' && isThemeName(root.theme)) config.theme = root.theme;
        else warn('theme', '"onedark" or "nord"');
    }

    const claude = root.claude;
    if (claude !== undefined && !isObject(claude)) {
        warn('claude', 'an object');
    } else if (claude) {
        if (claude.enabled !== undefined) {
            if (typeof claude.enabled === 'boolean') config.claude.enabled = claude.enabled;
            else warn('claude.enabled', 'true or false');
        }
        if (claude.cacheMinutes !== undefined) {
            if (typeof claude.cacheMinutes === 'number' && claude.cacheMinutes > 0) config.claude.cacheMinutes = claude.cacheMinutes;
            else warn('claude.cacheMinutes', 'a number above 0');
        }
        if (claude.defaultPreset === null) {
            delete config.claude.defaultPreset;
        } else if (claude.defaultPreset !== undefined) {
            if (PRESET_NAMES.includes(claude.defaultPreset as PresetName)) config.claude.defaultPreset = claude.defaultPreset as PresetName;
            else warn('claude.defaultPreset', '"low", "medium", "high" or null');
        }
        const presets = claude.presets;
        if (presets !== undefined && !isObject(presets)) {
            warn('claude.presets', 'an object');
        } else if (presets) {
            for (const name of PRESET_NAMES) {
                const p = presets[name];
                if (p === undefined) continue;
                if (!isObject(p)) {
                    warn(`claude.presets.${name}`, 'an object with "model" and "effort"');
                    continue;
                }
                const preset: Preset = {};
                if (typeof p.model === 'string' && p.model !== '') preset.model = p.model;
                else if (p.model !== undefined) warn(`claude.presets.${name}.model`, 'a model name');
                if (typeof p.effort === 'string' && EFFORTS.includes(p.effort as EffortLevel)) preset.effort = p.effort as EffortLevel;
                else if (p.effort !== undefined) warn(`claude.presets.${name}.effort`, EFFORTS.map((e) => `"${e}"`).join(', '));
                config.claude.presets[name] = preset;
            }
        }
    }

    const terminal = root.terminal;
    if (terminal !== undefined && !isObject(terminal)) {
        warn('terminal', 'an object');
    } else if (terminal && terminal.shell !== undefined) {
        if (typeof terminal.shell === 'string' && terminal.shell !== '') config.terminal.shell = terminal.shell;
        else warn('terminal.shell', 'a shell program');
    }

    const editor = root.editor;
    if (editor !== undefined && !isObject(editor)) {
        warn('editor', 'an object');
    } else if (editor) {
        for (const key of ['smoothCaret', 'smoothScroll'] as const) {
            const value = editor[key];
            if (value === undefined) continue;
            if (typeof value === 'boolean') config.editor[key] = value;
            else warn(`editor.${key}`, 'true or false');
        }
    }
    return { config, warnings };
}

/** Read the settings file. A missing file is the defaults, silently. */
export function loadConfig(file = configPath()): { config: Config; warnings: string[] } {
    let text: string;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch {
        return { config: defaultConfig(), warnings: [] };
    }
    return parseConfig(text);
}
