#!/usr/bin/env node
// Wim: a Vim-like code editor. Usage: node wim.js [file or directory]
//
// Builds itself first when the compiled code in dist/ is missing or older
// than the sources (npm may be set to skip the `prepare` build script).

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const entry = path.join(__dirname, 'dist', 'src', 'main.js');
const client = path.join(__dirname, 'dist', 'web', 'ui', 'client.js');

/** The newest modification time among the sources and build settings. */
function newestSource(dir) {
    let newest = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) newest = Math.max(newest, newestSource(p));
        else if (/\.(ts|json)$/.test(e.name)) newest = Math.max(newest, fs.statSync(p).mtimeMs);
    }
    return newest;
}

function builtAt(file) {
    try {
        return fs.statSync(file).mtimeMs;
    } catch {
        return 0;
    }
}

function build() {
    const tsc = path.join(__dirname, 'node_modules', 'typescript', 'bin', 'tsc');
    if (!fs.existsSync(tsc)) {
        process.stderr.write(`wim: not built yet. Run \`npm install\` in ${__dirname}\n`);
        process.exit(1);
    }
    for (const project of ['.', path.join('src', 'ui')]) {
        const result = spawnSync(process.execPath, [tsc, '-p', project], { cwd: __dirname, stdio: 'inherit' });
        if (result.status !== 0) {
            process.stderr.write('wim: the build failed\n');
            process.exit(1);
        }
    }
}

const sources = Math.max(newestSource(path.join(__dirname, 'src')), builtAt(path.join(__dirname, 'tsconfig.json')));
if (Math.min(builtAt(entry), builtAt(client)) < sources) build();

require(entry)
    .main(process.argv.slice(2))
    .catch((e) => {
        process.stderr.write('wim: ' + (e && e.message ? e.message : String(e)) + '\n');
        process.exit(1);
    });
