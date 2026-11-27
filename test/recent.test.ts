// Tests for the recent project folders the project menu offers.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { FileRecentProjects, MemoryRecentProjects } from '../src/recent';

function tempState(): { dir: string; file: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wim-recent-'));
    return { dir, file: path.join(dir, 'recent-projects.json') };
}

test('recent projects are kept newest first, without duplicates', () => {
    const { dir, file } = tempState();
    try {
        const recents = new FileRecentProjects(file);
        recents.add(path.join(dir, 'one'));
        recents.add(path.join(dir, 'two'));
        recents.add(path.join(dir, 'one'));
        assert.deepEqual(recents.list(), [path.join(dir, 'one'), path.join(dir, 'two')]);
        const nextRun = new FileRecentProjects(file);
        assert.deepEqual(nextRun.list(), recents.list(), 'they survive Wim closing');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('only the twenty newest projects are remembered', () => {
    const recents = new MemoryRecentProjects();
    for (let i = 0; i < 25; i++) recents.add(path.join(os.tmpdir(), `project-${i}`));
    const list = recents.list();
    assert.equal(list.length, 20);
    assert.equal(list[0], path.join(os.tmpdir(), 'project-24'));
    assert.equal(list[19], path.join(os.tmpdir(), 'project-5'));
});

test('a malformed recent projects file is empty', () => {
    const { dir, file } = tempState();
    try {
        fs.writeFileSync(file, 'not json');
        assert.deepEqual(new FileRecentProjects(file).list(), []);
        fs.writeFileSync(file, JSON.stringify(['/a', 3, '', '/b', '/a']));
        assert.deepEqual(new FileRecentProjects(file).list(), ['/a', '/b'], 'bad entries and duplicates are left out');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});
