import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { resolve } from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { extractBumpFileIdsFromChangedFiles, filterBranchBumpFiles } from '../../src/core/bump-file.ts';
import { findChangedPackages, resolveDirectBumpCoverage } from '../../src/commands/check.ts';
import { makeBumpFile, makePkg, makeConfig } from '../helpers.ts';

describe('extractBumpFileIdsFromChangedFiles', () => {
  test('extracts bump file IDs from changed files', () => {
    const ids = extractBumpFileIdsFromChangedFiles([
      '.bumpy/my-change.md',
      '.bumpy/other-fix.md',
      'packages/core/src/index.ts',
    ]);
    expect(ids).toEqual(new Set(['my-change', 'other-fix']));
  });

  test('ignores README.md', () => {
    const ids = extractBumpFileIdsFromChangedFiles(['.bumpy/README.md', '.bumpy/real-change.md']);
    expect(ids).toEqual(new Set(['real-change']));
  });

  test('ignores non-bumpy files', () => {
    const ids = extractBumpFileIdsFromChangedFiles(['src/index.ts', 'package.json']);
    expect(ids).toEqual(new Set());
  });
});

describe('filterBranchBumpFiles', () => {
  test('filters to only bump files in changed list', () => {
    const all = [
      makeBumpFile('change-a', [{ name: 'pkg-a', type: 'minor' }]),
      makeBumpFile('change-b', [{ name: 'pkg-b', type: 'patch' }]),
    ];
    const changed = ['.bumpy/change-a.md', 'packages/core/src/index.ts'];

    const { branchBumpFiles } = filterBranchBumpFiles(all, changed);
    expect(branchBumpFiles).toHaveLength(1);
    expect(branchBumpFiles[0]!.id).toBe('change-a');
  });

  test('returns all bump files when all are changed', () => {
    const all = [
      makeBumpFile('change-a', [{ name: 'pkg-a', type: 'minor' }]),
      makeBumpFile('change-b', [{ name: 'pkg-b', type: 'patch' }]),
    ];
    const changed = ['.bumpy/change-a.md', '.bumpy/change-b.md'];

    const { branchBumpFiles } = filterBranchBumpFiles(all, changed);
    expect(branchBumpFiles).toHaveLength(2);
  });

  test('emptyBumpFileIds is false when no rootDir provided', () => {
    const all = [makeBumpFile('change-a', [{ name: 'pkg-a', type: 'minor' }])];
    const changed = ['.bumpy/change-a.md', '.bumpy/empty-one.md'];

    const { emptyBumpFileIds } = filterBranchBumpFiles(all, changed);
    expect(emptyBumpFileIds).toHaveLength(0);
  });

  describe('with rootDir (empty bump file detection)', () => {
    const tmpDir = resolve(import.meta.dir, '../../.test-tmp-check');
    const bumpyDir = resolve(tmpDir, '.bumpy');

    beforeEach(async () => {
      await mkdir(bumpyDir, { recursive: true });
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    test('detects empty bump file that exists on disk', async () => {
      // Write an empty bump file to disk
      await writeFile(resolve(bumpyDir, 'empty-one.md'), '---\n---\n');

      const all = [makeBumpFile('change-a', [{ name: 'pkg-a', type: 'minor' }])];
      const changed = ['.bumpy/change-a.md', '.bumpy/empty-one.md'];

      const { emptyBumpFileIds } = filterBranchBumpFiles(all, changed, tmpDir);
      expect(emptyBumpFileIds).toHaveLength(1);
    });

    test('does not detect deleted bump file as empty', async () => {
      // empty-one.md does NOT exist on disk (was deleted)
      const all = [makeBumpFile('change-a', [{ name: 'pkg-a', type: 'minor' }])];
      const changed = ['.bumpy/change-a.md', '.bumpy/empty-one.md'];

      const { emptyBumpFileIds } = filterBranchBumpFiles(all, changed, tmpDir);
      expect(emptyBumpFileIds).toHaveLength(0);
    });

    test('does not flag non-empty bump files as empty', async () => {
      const all = [makeBumpFile('change-a', [{ name: 'pkg-a', type: 'minor' }])];
      const changed = ['.bumpy/change-a.md'];

      const { emptyBumpFileIds } = filterBranchBumpFiles(all, changed, tmpDir);
      expect(emptyBumpFileIds).toHaveLength(0);
    });
  });
});

describe('findChangedPackages', () => {
  const rootDir = '/repo';

  test('detects the root package in a single-package repo', async () => {
    // Single-package repo: the only package IS the root, so pkg.dir === rootDir
    // and its relative dir is empty. Every changed file belongs to it.
    const packages = new Map([['fledgling', makePkg('fledgling', '1.0.0', { dir: rootDir })]]);
    const changed = ['src/cli.ts', 'package.json', 'src/wizard.ts'];

    const result = await findChangedPackages(changed, packages, rootDir, makeConfig());
    expect(result).toEqual(['fledgling']);
  });

  test('respects changedFilePatterns for the root package', async () => {
    const packages = new Map([['fledgling', makePkg('fledgling', '1.0.0', { dir: rootDir })]]);
    const config = makeConfig({ changedFilePatterns: ['src/**'] });

    expect(await findChangedPackages(['src/cli.ts'], packages, rootDir, config)).toEqual(['fledgling']);
    // A file outside the pattern shouldn't count as a change
    expect(await findChangedPackages(['README.md'], packages, rootDir, config)).toEqual([]);
  });

  test('still scopes changes by directory in a monorepo', async () => {
    const packages = new Map([
      ['pkg-a', makePkg('pkg-a', '1.0.0', { dir: `${rootDir}/packages/pkg-a` })],
      ['pkg-b', makePkg('pkg-b', '1.0.0', { dir: `${rootDir}/packages/pkg-b` })],
    ]);
    const changed = ['packages/pkg-a/src/index.ts'];

    const result = await findChangedPackages(changed, packages, rootDir, makeConfig());
    expect(result).toEqual(['pkg-a']);
  });

  describe('sourcePaths', () => {
    const packages = new Map([
      ['@x/helper-darwin', makePkg('@x/helper-darwin', '1.0.0', { dir: `${rootDir}/packages/helpers/darwin` })],
      ['@x/helper-linux', makePkg('@x/helper-linux', '1.0.0', { dir: `${rootDir}/packages/helpers/linux` })],
      ['swift-src', makePkg('swift-src', '1.0.0', { dir: `${rootDir}/packages/swift-src` })],
    ]);

    test('a file outside the package matching sourcePaths marks it changed', async () => {
      const config = makeConfig({
        packages: { '@x/helper-darwin': { sourcePaths: ['packages/swift-src/**'] } },
      });
      const result = await findChangedPackages(['packages/swift-src/Sources/main.swift'], packages, rootDir, config);
      expect(result.sort()).toEqual(['@x/helper-darwin', 'swift-src']);
    });

    test('a non-matching file does not mark it changed', async () => {
      const config = makeConfig({
        packages: { '@x/helper-darwin': { sourcePaths: ['packages/swift-src/**'] } },
      });
      expect(await findChangedPackages(['packages/other/index.ts'], packages, rootDir, config)).toEqual([]);
    });

    test('negated patterns exclude matches', async () => {
      const config = makeConfig({
        packages: { '@x/helper-darwin': { sourcePaths: ['packages/swift-src/**', '!**/*.md'] } },
      });
      const result = await findChangedPackages(['packages/swift-src/README.md'], packages, rootDir, config);
      expect(result).toEqual(['swift-src']);
    });

    test('works with glob package keys', async () => {
      const config = makeConfig({
        packages: { '@x/helper-*': { sourcePaths: ['native/**'] } },
      });
      const result = await findChangedPackages(['native/shared.c'], packages, rootDir, config);
      expect(result.sort()).toEqual(['@x/helper-darwin', '@x/helper-linux']);
    });

    test('./ in the root config is relative to the repo root', async () => {
      const config = makeConfig({
        packages: { '@x/helper-darwin': { sourcePaths: ['./packages/swift-src/**'] } },
      });
      const result = await findChangedPackages(['packages/swift-src/main.swift'], packages, rootDir, config);
      expect(result.sort()).toEqual(['@x/helper-darwin', 'swift-src']);
    });

    describe('declared in package.json', () => {
      const tmpRoot = resolve(import.meta.dir, '../../.test-tmp-source-paths');
      const helperDir = resolve(tmpRoot, 'packages/helpers/darwin');
      const pkgs = new Map([
        ['helper', makePkg('helper', '1.0.0', { dir: helperDir })],
        ['swift-src', makePkg('swift-src', '1.0.0', { dir: resolve(tmpRoot, 'packages/swift-src') })],
      ]);

      beforeEach(async () => {
        await mkdir(helperDir, { recursive: true });
        await writeFile(
          resolve(helperDir, 'package.json'),
          JSON.stringify({
            name: 'helper',
            bumpy: { sourcePaths: ['../../swift-src/**', '!../../swift-src/**/*.md', 'shared/**'] },
          }),
        );
      });
      afterEach(async () => {
        await rm(tmpRoot, { recursive: true, force: true });
      });

      test('./ and ../ patterns are relative to the package dir', async () => {
        const changed = ['packages/swift-src/main.swift'];
        expect((await findChangedPackages(changed, pkgs, tmpRoot, makeConfig())).sort()).toEqual([
          'helper',
          'swift-src',
        ]);
        const docs = ['packages/swift-src/README.md'];
        expect(await findChangedPackages(docs, pkgs, tmpRoot, makeConfig())).toEqual(['swift-src']);
      });

      test('plain patterns stay repo-root-relative', async () => {
        expect(await findChangedPackages(['shared/x.c'], pkgs, tmpRoot, makeConfig())).toEqual(['helper']);
      });
    });

    test('changedFilePatterns does not filter sourcePaths matches', async () => {
      const config = makeConfig({
        changedFilePatterns: ['src/**'],
        packages: { '@x/helper-darwin': { sourcePaths: ['packages/swift-src/**'] } },
      });
      const result = await findChangedPackages(['packages/swift-src/Package.swift'], packages, rootDir, config);
      expect(result).toEqual(['@x/helper-darwin']);
    });
  });
});

describe('resolveDirectBumpCoverage', () => {
  const packages = new Map([
    ['cli', makePkg('cli', '1.0.0')],
    ['@cli/bin-darwin', makePkg('@cli/bin-darwin', '1.0.0', { bumpy: { directBump: false } })],
    ['@cli/bin-linux', makePkg('@cli/bin-linux', '1.0.0', { bumpy: { directBump: false } })],
    ['other', makePkg('other', '1.0.0')],
  ]);
  const config = makeConfig({ fixed: [['cli', '@cli/bin-*']] });

  test('normal packages pass through unchanged', () => {
    const { missing, hints } = resolveDirectBumpCoverage(['other'], new Set(), packages, config);
    expect(missing).toEqual(['other']);
    expect(hints.size).toBe(0);
  });

  test('directBump package is covered when a fixed-group member is covered', () => {
    const { missing } = resolveDirectBumpCoverage(['@cli/bin-darwin'], new Set(['cli']), packages, config);
    expect(missing).toEqual([]);
  });

  test('uncovered directBump package stays missing with a hint naming bumpable members', () => {
    const { missing, hints } = resolveDirectBumpCoverage(['@cli/bin-darwin', 'other'], new Set(), packages, config);
    expect(missing).toEqual(['@cli/bin-darwin', 'other']);
    expect(hints.get('@cli/bin-darwin')).toContain('cli');
    expect(hints.has('other')).toBe(false);
  });

  test('directBump package outside any fixed group gets a generic hint', () => {
    const loosePackages = new Map([['loner', makePkg('loner', '1.0.0', { bumpy: { directBump: false } })]]);
    const { missing, hints } = resolveDirectBumpCoverage(['loner'], new Set(), loosePackages, makeConfig());
    expect(missing).toEqual(['loner']);
    expect(hints.get('loner')).toContain('fixed group');
  });
});
