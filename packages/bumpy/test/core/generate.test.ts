import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { mapFilesToPackages, mapCommitToPackages } from '../../src/commands/generate.ts';
import { discoverWorkspace } from '../../src/core/workspace.ts';
import { loadConfig } from '../../src/core/config.ts';
import { makePkg, createTempGitRepo, cleanupTempDir, gitInDir } from '../helpers.ts';

describe('mapFilesToPackages', () => {
  const rootDir = '/repo';

  test('attributes every file to the root package in a single-package repo', () => {
    const packages = new Map([['fledgling', makePkg('fledgling', '1.0.0', { dir: rootDir })]]);
    const result = mapFilesToPackages(['src/cli.ts', 'package.json'], packages, rootDir);
    expect(result).toEqual(['fledgling']);
  });

  test('scopes files by directory in a monorepo', () => {
    const packages = new Map([
      ['pkg-a', makePkg('pkg-a', '1.0.0', { dir: `${rootDir}/packages/pkg-a` })],
      ['pkg-b', makePkg('pkg-b', '1.0.0', { dir: `${rootDir}/packages/pkg-b` })],
    ]);
    const result = mapFilesToPackages(['packages/pkg-b/src/index.ts'], packages, rootDir);
    expect(result).toEqual(['pkg-b']);
  });

  test('attributes files matching sourcePaths to the package', () => {
    // pkg.bumpy holds sourcePaths already resolved to repo-root-relative by loadPackageConfig
    const packages = new Map([
      [
        'helper',
        makePkg('helper', '1.0.0', {
          dir: `${rootDir}/packages/helper`,
          bumpy: { sourcePaths: ['packages/swift-src/**', '!**/*.md'] },
        }),
      ],
      ['swift-src', makePkg('swift-src', '1.0.0', { dir: `${rootDir}/packages/swift-src` })],
    ]);
    expect(mapFilesToPackages(['packages/swift-src/main.swift'], packages, rootDir).sort()).toEqual([
      'helper',
      'swift-src',
    ]);
    expect(mapFilesToPackages(['packages/swift-src/README.md'], packages, rootDir)).toEqual(['swift-src']);
  });
});

describe('mapCommitToPackages — catalog changes', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempGitRepo();
    gitInDir(['config', 'user.email', 'test@example.com'], tmpDir);
    gitInDir(['config', 'user.name', 'Test'], tmpDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tmpDir);
  });

  async function writeFileAt(path: string, content: string): Promise<void> {
    await mkdir(resolve(tmpDir, path, '..'), { recursive: true });
    await writeFile(resolve(tmpDir, path), content);
  }
  async function writeJson(path: string, data: unknown): Promise<void> {
    await writeFileAt(path, JSON.stringify(data, null, 2));
  }

  test('a commit that only bumps a catalog entry maps to the packages consuming it', async () => {
    await writeJson('package.json', { name: 'root', private: true });
    await writeFileAt(
      'pnpm-workspace.yaml',
      "packages:\n  - 'packages/*'\ncatalog:\n  react: ^18.2.0\n  lodash: ^4.0.0\n",
    );
    await writeFileAt('pnpm-lock.yaml', '');
    await writeJson('packages/foo/package.json', {
      name: 'foo',
      version: '1.0.0',
      dependencies: { react: 'catalog:' },
    });
    await writeJson('packages/bar/package.json', {
      name: 'bar',
      version: '1.0.0',
      dependencies: { lodash: 'catalog:' },
    });
    await writeJson('packages/baz/package.json', { name: 'baz', version: '1.0.0', dependencies: { react: '^18.0.0' } });
    gitInDir(['add', '.'], tmpDir);
    gitInDir(['commit', '-m', 'init monorepo'], tmpDir);

    await writeFileAt(
      'pnpm-workspace.yaml',
      "packages:\n  - 'packages/*'\ncatalog:\n  react: ^18.3.1\n  lodash: ^4.0.0\n",
    );
    gitInDir(['commit', '-am', 'Bump react catalog entry to ^18.3.1'], tmpDir);
    const hash = gitInDir(['rev-parse', 'HEAD'], tmpDir);

    const { packages } = await discoverWorkspace(tmpDir, await loadConfig(tmpDir));
    expect(await mapCommitToPackages(hash, packages, tmpDir)).toEqual(['foo']);
  });

  test('root package.json catalog (bun/npm) and named catalogs are detected too', async () => {
    await writeJson('package.json', {
      name: 'root',
      private: true,
      workspaces: { packages: ['packages/*'], catalog: { react: '^18.2.0' }, catalogs: { tools: { vite: '^5.0.0' } } },
    });
    await writeFileAt('bun.lock', '');
    await writeJson('packages/app/package.json', {
      name: 'app',
      version: '1.0.0',
      devDependencies: { vite: 'catalog:tools' },
    });
    await writeJson('packages/ui/package.json', {
      name: 'ui',
      version: '1.0.0',
      peerDependencies: { react: 'catalog:' },
    });
    gitInDir(['add', '.'], tmpDir);
    gitInDir(['commit', '-m', 'init monorepo'], tmpDir);

    await writeJson('package.json', {
      name: 'root',
      private: true,
      workspaces: { packages: ['packages/*'], catalog: { react: '^18.2.0' }, catalogs: { tools: { vite: '^6.0.0' } } },
    });
    gitInDir(['commit', '-am', 'chore: bump vite'], tmpDir);
    const hash = gitInDir(['rev-parse', 'HEAD'], tmpDir);

    const { packages } = await discoverWorkspace(tmpDir, await loadConfig(tmpDir));
    expect(await mapCommitToPackages(hash, packages, tmpDir)).toEqual(['app']);
  });

  test('a catalog commit from before a package-manager migration is still detected', async () => {
    // pnpm repo: catalog bump commit…
    await writeJson('package.json', { name: 'root', private: true });
    await writeFileAt('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\ncatalog:\n  react: ^18.2.0\n");
    await writeFileAt('pnpm-lock.yaml', '');
    await writeJson('packages/foo/package.json', {
      name: 'foo',
      version: '1.0.0',
      dependencies: { react: 'catalog:' },
    });
    gitInDir(['add', '.'], tmpDir);
    gitInDir(['commit', '-m', 'init monorepo'], tmpDir);
    await writeFileAt('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\ncatalog:\n  react: ^18.3.1\n");
    gitInDir(['commit', '-am', 'bump react catalog entry'], tmpDir);
    const catalogCommit = gitInDir(['rev-parse', 'HEAD'], tmpDir);

    // …then a later commit migrates the repo to Yarn, moving the catalog to .yarnrc.yml
    gitInDir(['rm', '-q', 'pnpm-workspace.yaml', 'pnpm-lock.yaml'], tmpDir);
    await writeFileAt('yarn.lock', '');
    await writeFileAt('.yarnrc.yml', 'catalog:\n  react: ^18.3.1\n');
    await writeJson('package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    gitInDir(['add', '.'], tmpDir);
    gitInDir(['commit', '-m', 'migrate to yarn'], tmpDir);

    const { packages } = await discoverWorkspace(tmpDir, await loadConfig(tmpDir));
    expect(await mapCommitToPackages(catalogCommit, packages, tmpDir)).toEqual(['foo']);
  });

  test('a root-level commit that changes no catalog entries maps to nothing', async () => {
    await writeJson('package.json', { name: 'root', private: true });
    await writeFileAt('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\ncatalog:\n  react: ^18.2.0\n");
    await writeFileAt('pnpm-lock.yaml', '');
    await writeJson('packages/foo/package.json', {
      name: 'foo',
      version: '1.0.0',
      dependencies: { react: 'catalog:' },
    });
    gitInDir(['add', '.'], tmpDir);
    gitInDir(['commit', '-m', 'init monorepo'], tmpDir);

    // Reorder keys in pnpm-workspace.yaml and touch the root package.json — no entry changes
    await writeFileAt('pnpm-workspace.yaml', "catalog:\n  react: ^18.2.0\npackages:\n  - 'packages/*'\n");
    await writeJson('package.json', { name: 'root', private: true, description: 'hi' });
    gitInDir(['commit', '-am', 'tidy root files'], tmpDir);
    const hash = gitInDir(['rev-parse', 'HEAD'], tmpDir);

    const { packages } = await discoverWorkspace(tmpDir, await loadConfig(tmpDir));
    expect(await mapCommitToPackages(hash, packages, tmpDir)).toEqual([]);
  });
});
