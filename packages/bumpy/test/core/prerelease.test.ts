import { describe, test, expect } from 'bun:test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  extractPrereleaseCounters,
  nextPrereleaseVersion,
  writeChannelVersionsInPlace,
  formatChannelVersionSummary,
  channelDisplayPlan,
} from '../../src/core/prerelease.ts';
import { makePkg, makeRelease, makeReleasePlan, createTempGitRepo, cleanupTempDir } from '../helpers.ts';

describe('extractPrereleaseCounters', () => {
  test('extracts counters for matching target + preid only', () => {
    const versions = [
      '1.1.0', // stable — ignored
      '1.2.0-rc.0',
      '1.2.0-rc.3',
      '1.2.0-beta.5', // different preid — ignored
      '1.3.0-rc.1', // different target — ignored
      '1.2.0-rc.x', // non-numeric counter — ignored
      '1.2.0-rc.1.hotfix', // extra identifier — ignored
    ];
    expect(extractPrereleaseCounters(versions, '1.2.0', 'rc').sort((a, b) => a - b)).toEqual([0, 3]);
  });

  test('returns empty for no matches', () => {
    expect(extractPrereleaseCounters(['1.0.0', '2.0.0-beta.0'], '1.2.0', 'rc')).toEqual([]);
    expect(extractPrereleaseCounters([], '1.2.0', 'rc')).toEqual([]);
  });
});

describe('nextPrereleaseVersion', () => {
  test('starts at .0 when nothing published', () => {
    expect(nextPrereleaseVersion('1.2.0', 'rc', [])).toBe('1.2.0-rc.0');
  });

  test('counts above the max published counter (registry floor)', () => {
    expect(nextPrereleaseVersion('1.2.0', 'rc', [0, 1, 3])).toBe('1.2.0-rc.4');
  });

  test('counter resets implicitly when the target moves (no committed state)', () => {
    // published 1.2.0-rc.0..3, then a major lands → target becomes 2.0.0
    expect(nextPrereleaseVersion('2.0.0', 'rc', extractPrereleaseCounters(['1.2.0-rc.3'], '2.0.0', 'rc'))).toBe(
      '2.0.0-rc.0',
    );
  });
});

describe('writeChannelVersionsInPlace', () => {
  test('writes prerelease versions and exact-pins in-cycle deps, then restores', async () => {
    const dir = await createTempGitRepo();
    try {
      const coreDir = resolve(dir, 'packages/core');
      const pluginDir = resolve(dir, 'packages/plugin');
      await mkdir(coreDir, { recursive: true });
      await mkdir(pluginDir, { recursive: true });

      const coreJson = JSON.stringify({ name: 'core', version: '1.1.0' }, null, 2) + '\n';
      const pluginJson =
        JSON.stringify(
          {
            name: 'plugin',
            version: '1.0.0',
            dependencies: { core: 'workspace:^', lodash: '^4.0.0' },
            peerDependencies: { core: '^1.0.0' },
            devDependencies: { core: 'workspace:*' },
          },
          null,
          2,
        ) + '\n';
      await writeFile(resolve(coreDir, 'package.json'), coreJson);
      await writeFile(resolve(pluginDir, 'package.json'), pluginJson);

      const core = makePkg('core', '1.1.0', { dir: coreDir });
      const plugin = makePkg('plugin', '1.0.0', {
        dir: pluginDir,
        dependencies: { core: 'workspace:^', lodash: '^4.0.0' },
        peerDependencies: { core: '^1.0.0' },
        devDependencies: { core: 'workspace:*' },
      });
      const packages = new Map([
        ['core', core],
        ['plugin', plugin],
      ]);

      const plan = makeReleasePlan([
        makeRelease('core', '1.2.0-rc.1', { oldVersion: '1.1.0' }),
        makeRelease('plugin', '1.0.1-rc.1', { oldVersion: '1.0.0' }),
      ]);

      const restore = await writeChannelVersionsInPlace(plan, packages);

      const writtenCore = JSON.parse(await readFile(resolve(coreDir, 'package.json'), 'utf-8'));
      const writtenPlugin = JSON.parse(await readFile(resolve(pluginDir, 'package.json'), 'utf-8'));
      expect(writtenCore.version).toBe('1.2.0-rc.1');
      expect(writtenPlugin.version).toBe('1.0.1-rc.1');
      // In-cycle deps exact-pinned (no range, no workspace: protocol)
      expect(writtenPlugin.dependencies.core).toBe('1.2.0-rc.1');
      expect(writtenPlugin.peerDependencies.core).toBe('1.2.0-rc.1');
      // Out-of-cycle deps untouched
      expect(writtenPlugin.dependencies.lodash).toBe('^4.0.0');
      // Dev deps untouched (not installed by consumers)
      expect(writtenPlugin.devDependencies.core).toBe('workspace:*');

      await restore();
      expect(await readFile(resolve(coreDir, 'package.json'), 'utf-8')).toBe(coreJson);
      expect(await readFile(resolve(pluginDir, 'package.json'), 'utf-8')).toBe(pluginJson);
    } finally {
      await cleanupTempDir(dir);
    }
  });
});

describe('formatChannelVersionSummary', () => {
  test('single release shows name@version', () => {
    expect(formatChannelVersionSummary([makeRelease('core', '1.2.0-rc.x')])).toBe('core@1.2.0-rc.x');
  });

  test('multiple releases show a count instead of an arbitrary lead', () => {
    const releases = [
      makeRelease('plugin', '1.0.1-rc.x', { isDependencyBump: true }),
      makeRelease('core', '1.2.0-rc.x'),
      makeRelease('utils', '2.0.1-rc.x', { isDependencyBump: true }),
    ];
    expect(formatChannelVersionSummary(releases)).toBe('3 packages');
  });

  test('empty plan', () => {
    expect(formatChannelVersionSummary([])).toBe('');
  });
});

describe('channelDisplayPlan', () => {
  const channel = {
    name: 'next',
    branch: 'next',
    preid: 'rc',
    tag: 'next',
    versionPr: { title: '🐸 Versioned prerelease (next)', branch: 'bumpy/release-next', automerge: false },
  };

  test('appends a wildcard counter to each target', () => {
    const plan = makeReleasePlan([makeRelease('core', '1.2.0', { oldVersion: '1.1.0' })]);
    const packages = new Map([['core', makePkg('core', '1.1.0')]]);
    const display = channelDisplayPlan(plan, channel, packages);
    expect(display.releases.map((r) => r.newVersion)).toEqual(['1.2.0-rc.x']);
  });

  test('drops unpublishable packages, keeps private ones with a publishCommand', () => {
    const plan = makeReleasePlan([
      makeRelease('core', '1.2.0'),
      makeRelease('internal', '0.5.0'),
      makeRelease('cli', '2.0.0'),
    ]);
    const packages = new Map([
      ['core', makePkg('core', '1.1.0')],
      ['internal', makePkg('internal', '0.4.0', { private: true })],
      ['cli', makePkg('cli', '1.9.0', { private: true, bumpy: { publishCommand: 'cargo publish' } })],
    ]);
    const display = channelDisplayPlan(plan, channel, packages);
    expect(display.releases.map((r) => r.name)).toEqual(['core', 'cli']);
  });
});
