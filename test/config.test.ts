// Tests for the settings file.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { test } from 'node:test';

import { configPath, defaultConfig, loadConfig, parseConfig } from '../src/config';
import { findNerdFont } from '../src/fonts';

test('the defaults keep Claude Code off and have a preset for each level', () => {
    const c = defaultConfig();
    assert.equal(c.claude.enabled, false);
    assert.deepEqual(c.claude.presets.low, { model: 'claude-haiku-5-5', effort: 'low' });
    assert.deepEqual(c.claude.presets.medium, { model: 'claude-sonnet-5-5', effort: 'medium' });
    assert.deepEqual(c.claude.presets.high, { model: 'claude-opus-5-5', effort: 'high' });
});

test('settings override the defaults, and the rest stays', () => {
    const { config, warnings } = parseConfig(
        JSON.stringify({ theme: 'nord', claude: { enabled: true, defaultPreset: 'low', presets: { low: { model: 'haiku', effort: 'medium' } } }, terminal: { shell: 'bash' } }),
    );
    assert.deepEqual(warnings, []);
    assert.equal(config.theme, 'nord');
    assert.equal(config.claude.enabled, true);
    assert.equal(config.claude.defaultPreset, 'low');
    assert.deepEqual(config.claude.presets.low, { model: 'haiku', effort: 'medium' });
    assert.equal(config.claude.presets.high.model, 'claude-opus-5-5');
    assert.equal(config.terminal.shell, 'bash');
});

test('bad settings are reported and ignored', () => {
    const { config, warnings } = parseConfig(
        JSON.stringify({ theme: 'neon', claude: { enabled: 'yes', presets: { high: { model: 3, effort: 'extreme' } } } }),
    );
    assert.equal(config.theme, 'onedark');
    assert.equal(config.claude.enabled, false);
    assert.equal(warnings.length, 4);
    assert.match(warnings.join('\n'), /theme/);
    assert.match(warnings.join('\n'), /claude\.enabled/);
    assert.match(warnings.join('\n'), /claude\.presets\.high\.effort/);
    assert.match(parseConfig('{ not json').warnings[0], /wim\.config\.json/);
});

test('a missing file is the defaults', () => {
    assert.deepEqual(loadConfig('/nonexistent/wim.config.json'), { config: defaultConfig(), warnings: [] });
});

test("Wim's own settings file is valid", () => {
    assert.ok(fs.existsSync(configPath()), configPath());
    assert.deepEqual(loadConfig().warnings, []);
});

test('a Nerd Font comes with Wim', () => {
    const font = findNerdFont();
    assert.ok(font?.includes('fonts'), String(font));
    assert.ok(fs.existsSync(font!));
});
