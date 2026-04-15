import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { writeJson, readJson, readText, writeText, ensureDir, exists } from '../../src/utils/fs.ts';
import { makeRelease, makeChangeset, makeReleasePlan, makeConfig } from '../helpers.ts';
import { applyReleasePlan } from '../../src/core/apply-release-plan.ts';
import type { WorkspacePackage } from '../../src/types.ts';

describe('applyReleasePlan', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'bumpy-apply-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  async function setupPackage(name: string, version: string, extraPkgJson: Record<string, unknown> = {}) {
    const pkgDir = resolve(tmpDir, `packages/${name}`);
    await ensureDir(pkgDir);
    await writeJson(resolve(pkgDir, 'package.json'), { name, version, ...extraPkgJson });
    return pkgDir;
  }

  test('bumps package.json version', async () => {
    const pkgDir = await setupPackage('pkg-a', '1.0.0');

    const packages = new Map<string, WorkspacePackage>();
    packages.set('pkg-a', {
      name: 'pkg-a',
      version: '1.0.0',
      dir: pkgDir,
      relativeDir: 'packages/pkg-a',
      packageJson: { name: 'pkg-a', version: '1.0.0' },
      private: false,
      dependencies: {},
      devDependencies: {},
      peerDependencies: {},
      optionalDependencies: {},
    });

    const changeset = makeChangeset('cs1', [{ name: 'pkg-a', type: 'minor' }], 'New feature');
    const release = makeRelease('pkg-a', '1.1.0', {
      type: 'minor',
      oldVersion: '1.0.0',
      changesets: ['cs1'],
    });

    // Create the .bumpy dir with changeset file
    await ensureDir(resolve(tmpDir, '.bumpy'));
    await writeText(resolve(tmpDir, '.bumpy/cs1.md'), '---\n"pkg-a": minor\n---\n\nNew feature\n');

    await applyReleasePlan(makeReleasePlan([release], [changeset]), packages, tmpDir, makeConfig());

    const pkgJson = await readJson<Record<string, unknown>>(resolve(pkgDir, 'package.json'));
    expect(pkgJson.version).toBe('1.1.0');
  });

  test('creates CHANGELOG.md when it does not exist', async () => {
    const pkgDir = await setupPackage('pkg-a', '1.0.0');

    const packages = new Map<string, WorkspacePackage>();
    packages.set('pkg-a', {
      name: 'pkg-a',
      version: '1.0.0',
      dir: pkgDir,
      relativeDir: 'packages/pkg-a',
      packageJson: { name: 'pkg-a', version: '1.0.0' },
      private: false,
      dependencies: {},
      devDependencies: {},
      peerDependencies: {},
      optionalDependencies: {},
    });

    const changeset = makeChangeset('cs1', [{ name: 'pkg-a', type: 'patch' }], 'Bug fix');
    const release = makeRelease('pkg-a', '1.0.1', {
      oldVersion: '1.0.0',
      changesets: ['cs1'],
    });

    await ensureDir(resolve(tmpDir, '.bumpy'));
    await writeText(resolve(tmpDir, '.bumpy/cs1.md'), '---\n"pkg-a": patch\n---\n\nBug fix\n');

    await applyReleasePlan(makeReleasePlan([release], [changeset]), packages, tmpDir, makeConfig());

    const changelogPath = resolve(pkgDir, 'CHANGELOG.md');
    expect(await exists(changelogPath)).toBe(true);
    const content = await readText(changelogPath);
    expect(content).toContain('## 1.0.1');
    expect(content).toContain('Bug fix');
  });

  test('prepends to existing CHANGELOG.md', async () => {
    const pkgDir = await setupPackage('pkg-a', '1.0.0');
    await writeText(resolve(pkgDir, 'CHANGELOG.md'), '# Changelog\n\n## 1.0.0\n\n- Initial release\n');

    const packages = new Map<string, WorkspacePackage>();
    packages.set('pkg-a', {
      name: 'pkg-a',
      version: '1.0.0',
      dir: pkgDir,
      relativeDir: 'packages/pkg-a',
      packageJson: { name: 'pkg-a', version: '1.0.0' },
      private: false,
      dependencies: {},
      devDependencies: {},
      peerDependencies: {},
      optionalDependencies: {},
    });

    const changeset = makeChangeset('cs1', [{ name: 'pkg-a', type: 'minor' }], 'Feature');
    const release = makeRelease('pkg-a', '1.1.0', {
      type: 'minor',
      oldVersion: '1.0.0',
      changesets: ['cs1'],
    });

    await ensureDir(resolve(tmpDir, '.bumpy'));
    await writeText(resolve(tmpDir, '.bumpy/cs1.md'), '---\n"pkg-a": minor\n---\n\nFeature\n');

    await applyReleasePlan(makeReleasePlan([release], [changeset]), packages, tmpDir, makeConfig());

    const content = await readText(resolve(pkgDir, 'CHANGELOG.md'));
    // New entry should be before old entry
    const newIdx = content.indexOf('## 1.1.0');
    const oldIdx = content.indexOf('## 1.0.0');
    expect(newIdx).toBeLessThan(oldIdx);
    expect(content).toContain('- Initial release');
  });

  test('updates internal dependency ranges', async () => {
    const coreDir = await setupPackage('core', '1.0.0');
    const appDir = await setupPackage('app', '1.0.0', {
      dependencies: { core: '^1.0.0' },
    });

    const packages = new Map<string, WorkspacePackage>();
    packages.set('core', {
      name: 'core',
      version: '1.0.0',
      dir: coreDir,
      relativeDir: 'packages/core',
      packageJson: { name: 'core', version: '1.0.0' },
      private: false,
      dependencies: {},
      devDependencies: {},
      peerDependencies: {},
      optionalDependencies: {},
    });
    packages.set('app', {
      name: 'app',
      version: '1.0.0',
      dir: appDir,
      relativeDir: 'packages/app',
      packageJson: { name: 'app', version: '1.0.0', dependencies: { core: '^1.0.0' } },
      private: false,
      dependencies: { core: '^1.0.0' },
      devDependencies: {},
      peerDependencies: {},
      optionalDependencies: {},
    });

    const changeset = makeChangeset('cs1', [{ name: 'core', type: 'major' }], 'Breaking');
    const coreRelease = makeRelease('core', '2.0.0', {
      type: 'major',
      oldVersion: '1.0.0',
      changesets: ['cs1'],
    });
    const appRelease = makeRelease('app', '1.0.1', {
      oldVersion: '1.0.0',
      isDependencyBump: true,
    });

    await ensureDir(resolve(tmpDir, '.bumpy'));
    await writeText(resolve(tmpDir, '.bumpy/cs1.md'), '---\n"core": major\n---\n\nBreaking\n');

    await applyReleasePlan(makeReleasePlan([coreRelease, appRelease], [changeset]), packages, tmpDir, makeConfig());

    const appPkg = await readJson<Record<string, unknown>>(resolve(appDir, 'package.json'));
    const deps = appPkg.dependencies as Record<string, string>;
    expect(deps.core).toBe('^2.0.0');
  });

  test('preserves workspace: protocol in dependency ranges', async () => {
    const coreDir = await setupPackage('core', '1.0.0');
    const appDir = await setupPackage('app', '1.0.0', {
      dependencies: { core: 'workspace:^1.0.0' },
    });

    const packages = new Map<string, WorkspacePackage>();
    packages.set('core', {
      name: 'core',
      version: '1.0.0',
      dir: coreDir,
      relativeDir: 'packages/core',
      packageJson: { name: 'core', version: '1.0.0' },
      private: false,
      dependencies: {},
      devDependencies: {},
      peerDependencies: {},
      optionalDependencies: {},
    });
    packages.set('app', {
      name: 'app',
      version: '1.0.0',
      dir: appDir,
      relativeDir: 'packages/app',
      packageJson: { name: 'app', version: '1.0.0', dependencies: { core: 'workspace:^1.0.0' } },
      private: false,
      dependencies: { core: 'workspace:^1.0.0' },
      devDependencies: {},
      peerDependencies: {},
      optionalDependencies: {},
    });

    const coreRelease = makeRelease('core', '2.0.0', { type: 'major', oldVersion: '1.0.0' });
    const appRelease = makeRelease('app', '1.0.1', { oldVersion: '1.0.0', isDependencyBump: true });

    await ensureDir(resolve(tmpDir, '.bumpy'));

    await applyReleasePlan(makeReleasePlan([coreRelease, appRelease]), packages, tmpDir, makeConfig());

    const appPkg = await readJson<Record<string, unknown>>(resolve(appDir, 'package.json'));
    const deps = appPkg.dependencies as Record<string, string>;
    expect(deps.core).toBe('workspace:^2.0.0');
  });

  test('deletes consumed changeset files', async () => {
    const pkgDir = await setupPackage('pkg-a', '1.0.0');

    const packages = new Map<string, WorkspacePackage>();
    packages.set('pkg-a', {
      name: 'pkg-a',
      version: '1.0.0',
      dir: pkgDir,
      relativeDir: 'packages/pkg-a',
      packageJson: { name: 'pkg-a', version: '1.0.0' },
      private: false,
      dependencies: {},
      devDependencies: {},
      peerDependencies: {},
      optionalDependencies: {},
    });

    const changeset = makeChangeset('cs-to-delete', [{ name: 'pkg-a', type: 'patch' }], 'Fix');
    const release = makeRelease('pkg-a', '1.0.1', {
      oldVersion: '1.0.0',
      changesets: ['cs-to-delete'],
    });

    await ensureDir(resolve(tmpDir, '.bumpy'));
    const csPath = resolve(tmpDir, '.bumpy/cs-to-delete.md');
    await writeText(csPath, '---\n"pkg-a": patch\n---\n\nFix\n');
    expect(await exists(csPath)).toBe(true);

    await applyReleasePlan(makeReleasePlan([release], [changeset]), packages, tmpDir, makeConfig());

    expect(await exists(csPath)).toBe(false);
  });
});
