import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { findChangedPackages } from '../../src/commands/check.ts';
import { discoverWorkspace } from '../../src/core/workspace.ts';
import { getChangedFiles } from '../../src/core/git.ts';
import { loadConfig } from '../../src/core/config.ts';
import { createTempGitRepo, cleanupTempDir, gitInDir } from '../helpers.ts';

/**
 * Integration tests for catalog-aware change detection in findChangedPackages.
 * Each test sets up a temp git repo with a base "main" branch, creates a feature
 * branch, modifies catalog entries, and verifies which packages are flagged.
 */
describe('findChangedPackages — catalog change detection', () => {
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

  /** Set up a bare remote so getBaseCompareRef can resolve origin/main */
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
    await writeFile(resolve(tmpDir, path), JSON.stringify(data, null, 2));
  }
  async function writeFileAt(path: string, content: string): Promise<void> {
    await mkdir(resolve(tmpDir, path, '..'), { recursive: true });
    await writeFile(resolve(tmpDir, path), content);
  }

  test('pnpm-workspace.yaml catalog change flags consuming packages', async () => {
    // --- base state on main ---
    await writeJson('package.json', { name: 'root', private: true });
    await writeFileAt('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\ncatalog:\n  '@somepkg': ^0.10.0\n");
    await writeFileAt('pnpm-lock.yaml', ''); // marker for pnpm detection
    await writeJson('packages/uses-catalog/package.json', {
      name: 'uses-catalog',
      version: '1.0.0',
      dependencies: { '@somepkg': 'catalog:' },
    });
    await writeJson('packages/no-catalog/package.json', {
      name: 'no-catalog',
      version: '1.0.0',
      dependencies: { lodash: '^4.0.0' },
    });
    gitInDir(['add', '.'], tmpDir);
    gitInDir(['commit', '-m', 'init monorepo'], tmpDir);
    await setupOriginMain();

    // --- branch off main, bump catalog entry ---
    gitInDir(['checkout', '-b', 'feature'], tmpDir);
    await writeFileAt('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\ncatalog:\n  '@somepkg': ^0.11.0\n");
    gitInDir(['commit', '-am', 'bump catalog'], tmpDir);

    // --- assert ---
    const config = await loadConfig(tmpDir);
    const { packages } = await discoverWorkspace(tmpDir, config);
    const changedFiles = getChangedFiles(tmpDir, config.baseBranch);
    const changed = await findChangedPackages(changedFiles, packages, tmpDir, config);

    expect(changed).toContain('uses-catalog');
    expect(changed).not.toContain('no-catalog');
  });

  test('package.json catalog change (bun style) flags consuming packages', async () => {
    await writeJson('package.json', {
      name: 'root',
      private: true,
      workspaces: ['packages/*'],
      catalog: { react: '^19.0.0' },
    });
    await writeFileAt('bun.lock', ''); // bun detection
    await writeJson('packages/web/package.json', {
      name: 'web',
      version: '1.0.0',
      dependencies: { react: 'catalog:' },
    });
    await writeJson('packages/cli/package.json', {
      name: 'cli',
      version: '1.0.0',
      dependencies: { chalk: '^5.0.0' },
    });
    gitInDir(['add', '.'], tmpDir);
    gitInDir(['commit', '-m', 'init'], tmpDir);
    await setupOriginMain();

    gitInDir(['checkout', '-b', 'feature'], tmpDir);
    await writeJson('package.json', {
      name: 'root',
      private: true,
      workspaces: ['packages/*'],
      catalog: { react: '^19.1.0' },
    });
    gitInDir(['commit', '-am', 'bump react in catalog'], tmpDir);

    const config = await loadConfig(tmpDir);
    const { packages } = await discoverWorkspace(tmpDir, config);
    const changedFiles = getChangedFiles(tmpDir, config.baseBranch);
    const changed = await findChangedPackages(changedFiles, packages, tmpDir, config);

    expect(changed).toContain('web');
    expect(changed).not.toContain('cli');
  });

  test('named catalog change only affects packages referencing that named catalog', async () => {
    await writeJson('package.json', { name: 'root', private: true });
    await writeFileAt(
      'pnpm-workspace.yaml',
      "packages:\n  - 'packages/*'\ncatalogs:\n  testing:\n    jest: ^30.0.0\n  build:\n    typescript: ^5.0.0\n",
    );
    await writeFileAt('pnpm-lock.yaml', '');
    await writeJson('packages/uses-testing/package.json', {
      name: 'uses-testing',
      version: '1.0.0',
      devDependencies: { jest: 'catalog:testing' },
    });
    await writeJson('packages/uses-build/package.json', {
      name: 'uses-build',
      version: '1.0.0',
      devDependencies: { typescript: 'catalog:build' },
    });
    gitInDir(['add', '.'], tmpDir);
    gitInDir(['commit', '-m', 'init'], tmpDir);
    await setupOriginMain();

    gitInDir(['checkout', '-b', 'feature'], tmpDir);
    await writeFileAt(
      'pnpm-workspace.yaml',
      "packages:\n  - 'packages/*'\ncatalogs:\n  testing:\n    jest: ^30.1.0\n  build:\n    typescript: ^5.0.0\n",
    );
    gitInDir(['commit', '-am', 'bump jest in testing catalog'], tmpDir);

    const config = await loadConfig(tmpDir);
    const { packages } = await discoverWorkspace(tmpDir, config);
    const changedFiles = getChangedFiles(tmpDir, config.baseBranch);
    const changed = await findChangedPackages(changedFiles, packages, tmpDir, config);

    expect(changed).toContain('uses-testing');
    expect(changed).not.toContain('uses-build');
  });

  test('catalog: in devDependencies / peerDependencies also flags the package', async () => {
    await writeJson('package.json', { name: 'root', private: true });
    await writeFileAt(
      'pnpm-workspace.yaml',
      "packages:\n  - 'packages/*'\ncatalog:\n  typescript: ^5.0.0\n  react: ^19.0.0\n",
    );
    await writeFileAt('pnpm-lock.yaml', '');
    await writeJson('packages/uses-dev/package.json', {
      name: 'uses-dev',
      version: '1.0.0',
      devDependencies: { typescript: 'catalog:' },
    });
    await writeJson('packages/uses-peer/package.json', {
      name: 'uses-peer',
      version: '1.0.0',
      peerDependencies: { react: 'catalog:' },
    });
    gitInDir(['add', '.'], tmpDir);
    gitInDir(['commit', '-m', 'init'], tmpDir);
    await setupOriginMain();

    gitInDir(['checkout', '-b', 'feature'], tmpDir);
    await writeFileAt(
      'pnpm-workspace.yaml',
      "packages:\n  - 'packages/*'\ncatalog:\n  typescript: ^5.1.0\n  react: ^19.1.0\n",
    );
    gitInDir(['commit', '-am', 'bump catalog'], tmpDir);

    const config = await loadConfig(tmpDir);
    const { packages } = await discoverWorkspace(tmpDir, config);
    const changedFiles = getChangedFiles(tmpDir, config.baseBranch);
    const changed = await findChangedPackages(changedFiles, packages, tmpDir, config);

    expect(changed).toContain('uses-dev');
    expect(changed).toContain('uses-peer');
  });

  test('non-catalog dep updates do not trigger detection', async () => {
    await writeJson('package.json', { name: 'root', private: true });
    await writeFileAt('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\ncatalog:\n  react: ^19.0.0\n");
    await writeFileAt('pnpm-lock.yaml', '');
    // pkg-a depends on react with an explicit (non-catalog) range
    await writeJson('packages/pkg-a/package.json', {
      name: 'pkg-a',
      version: '1.0.0',
      dependencies: { react: '^19.0.0' },
    });
    gitInDir(['add', '.'], tmpDir);
    gitInDir(['commit', '-m', 'init'], tmpDir);
    await setupOriginMain();

    gitInDir(['checkout', '-b', 'feature'], tmpDir);
    await writeFileAt('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\ncatalog:\n  react: ^19.1.0\n");
    gitInDir(['commit', '-am', 'bump catalog'], tmpDir);

    const config = await loadConfig(tmpDir);
    const { packages } = await discoverWorkspace(tmpDir, config);
    const changedFiles = getChangedFiles(tmpDir, config.baseBranch);
    const changed = await findChangedPackages(changedFiles, packages, tmpDir, config);

    // pkg-a uses an explicit version, not catalog:, so the catalog change doesn't affect it
    expect(changed).not.toContain('pkg-a');
  });
});
