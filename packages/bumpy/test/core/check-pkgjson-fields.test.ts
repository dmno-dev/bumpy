import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { findChangedPackages } from '../../src/commands/check.ts';
import { discoverWorkspace } from '../../src/core/workspace.ts';
import { getChangedFiles } from '../../src/core/git.ts';
import { loadConfig } from '../../src/core/config.ts';
import { createTempGitRepo, cleanupTempDir, gitInDir } from '../helpers.ts';

/**
 * Integration tests for field-aware package.json change detection. Each test sets up a
 * temp git repo on `main`, branches off, edits a single package's package.json, and
 * checks whether that package is flagged as changed (i.e. requires a bump file).
 */
describe('findChangedPackages — package.json field awareness', () => {
  let tmpDir: string;
  const teardown: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    tmpDir = await createTempGitRepo();
    gitInDir(['branch', '-M', 'main'], tmpDir);
    gitInDir(['config', 'user.email', 'test@example.com'], tmpDir);
    gitInDir(['config', 'user.name', 'Test'], tmpDir);
  });

  afterEach(async () => {
    for (const fn of teardown) await fn();
    teardown.length = 0;
    await cleanupTempDir(tmpDir);
  });

  async function setupOriginMain(): Promise<void> {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const remote = await mkdtemp(resolve(tmpdir(), 'bumpy-remote-'));
    gitInDir(['init', '--bare'], remote);
    gitInDir(['remote', 'add', 'origin', remote], tmpDir);
    gitInDir(['push', '-u', 'origin', 'main'], tmpDir);
    teardown.push(() => rm(remote, { recursive: true, force: true }));
  }

  async function writeJson(path: string, data: unknown): Promise<void> {
    await mkdir(resolve(tmpDir, path, '..'), { recursive: true });
    await writeFile(resolve(tmpDir, path), `${JSON.stringify(data, null, 2)}\n`);
  }

  /** Set up a single-package monorepo on main, then branch to "feature". */
  async function setupPkg(pkgJson: Record<string, unknown>): Promise<void> {
    await writeJson('package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    await writeJson('packages/app/package.json', { name: 'app', version: '1.0.0', ...pkgJson });
    gitInDir(['add', '.'], tmpDir);
    gitInDir(['commit', '-m', 'init'], tmpDir);
    await setupOriginMain();
    gitInDir(['checkout', '-b', 'feature'], tmpDir);
  }

  async function detect(): Promise<string[]> {
    const config = await loadConfig(tmpDir);
    const { packages } = await discoverWorkspace(tmpDir, config);
    const changedFiles = getChangedFiles(tmpDir, config.baseBranch);
    return findChangedPackages(changedFiles, packages, tmpDir, config);
  }

  test('a devDependencies-only change does NOT flag the package', async () => {
    await setupPkg({ devDependencies: { vitest: '^1.0.0' } });
    await writeJson('packages/app/package.json', {
      name: 'app',
      version: '1.0.0',
      devDependencies: { vitest: '^2.0.0' },
    });
    gitInDir(['commit', '-am', 'bump vitest (dev only)'], tmpDir);
    expect(await detect()).not.toContain('app');
  });

  test('a dependencies change flags the package', async () => {
    await setupPkg({ dependencies: { lodash: '^4.0.0' } });
    await writeJson('packages/app/package.json', {
      name: 'app',
      version: '1.0.0',
      dependencies: { lodash: '^4.17.0' },
    });
    gitInDir(['commit', '-am', 'bump lodash (runtime)'], tmpDir);
    expect(await detect()).toContain('app');
  });

  test('a metadata change (description) still flags the package', async () => {
    await setupPkg({ description: 'old' });
    await writeJson('packages/app/package.json', { name: 'app', version: '1.0.0', description: 'new' });
    gitInDir(['commit', '-am', 'edit description'], tmpDir);
    expect(await detect()).toContain('app');
  });

  test('an exports change flags the package', async () => {
    await setupPkg({ exports: { '.': './index.js' } });
    await writeJson('packages/app/package.json', {
      name: 'app',
      version: '1.0.0',
      exports: { '.': './dist/index.js' },
    });
    gitInDir(['commit', '-am', 'change exports'], tmpDir);
    expect(await detect()).toContain('app');
  });

  test('a bundled devDependency change DOES flag the package', async () => {
    await setupPkg({
      devDependencies: { 'bundled-lib': '^1.0.0', vitest: '^1.0.0' },
      bumpy: { releaseDevDependencies: ['bundled-lib'] },
    });
    await writeJson('packages/app/package.json', {
      name: 'app',
      version: '1.0.0',
      devDependencies: { 'bundled-lib': '^2.0.0', vitest: '^1.0.0' },
      bumpy: { releaseDevDependencies: ['bundled-lib'] },
    });
    gitInDir(['commit', '-am', 'bump bundled-lib'], tmpDir);
    expect(await detect()).toContain('app');
  });

  test('a non-bundled devDependency change alongside a bundled marker stays unflagged', async () => {
    await setupPkg({
      devDependencies: { 'bundled-lib': '^1.0.0', vitest: '^1.0.0' },
      bumpy: { releaseDevDependencies: ['bundled-lib'] },
    });
    await writeJson('packages/app/package.json', {
      name: 'app',
      version: '1.0.0',
      devDependencies: { 'bundled-lib': '^1.0.0', vitest: '^2.0.0' },
      bumpy: { releaseDevDependencies: ['bundled-lib'] },
    });
    gitInDir(['commit', '-am', 'bump vitest only'], tmpDir);
    expect(await detect()).not.toContain('app');
  });

  test('a source file change flags the package regardless of package.json', async () => {
    await setupPkg({ devDependencies: { vitest: '^1.0.0' } });
    await writeFile(resolve(tmpDir, 'packages/app/index.ts'), 'export const x = 1;\n');
    // also a dev-only package.json change that on its own wouldn't flag
    await writeJson('packages/app/package.json', {
      name: 'app',
      version: '1.0.0',
      devDependencies: { vitest: '^2.0.0' },
    });
    gitInDir(['add', '.'], tmpDir);
    gitInDir(['commit', '-m', 'real code change + dev bump'], tmpDir);
    expect(await detect()).toContain('app');
  });

  test('ignoredPackageJsonFields can relax additional fields (e.g. scripts)', async () => {
    await writeJson('package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    await writeJson('.bumpy/_config.json', { ignoredPackageJsonFields: ['devDependencies', 'scripts'] });
    await mkdir(resolve(tmpDir, '.bumpy'), { recursive: true });
    await writeFile(resolve(tmpDir, '.bumpy/README.md'), '');
    await writeJson('packages/app/package.json', { name: 'app', version: '1.0.0', scripts: { build: 'tsc' } });
    gitInDir(['add', '.'], tmpDir);
    gitInDir(['commit', '-m', 'init'], tmpDir);
    await setupOriginMain();
    gitInDir(['checkout', '-b', 'feature'], tmpDir);

    await writeJson('packages/app/package.json', { name: 'app', version: '1.0.0', scripts: { build: 'tsdown' } });
    gitInDir(['commit', '-am', 'change build script'], tmpDir);

    expect(await detect()).not.toContain('app');
  });
});
