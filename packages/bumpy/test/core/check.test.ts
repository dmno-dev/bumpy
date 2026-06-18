import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { resolve } from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { extractBumpFileIdsFromChangedFiles, filterBranchBumpFiles } from '../../src/core/bump-file.ts';
import { findChangedPackages } from '../../src/commands/check.ts';
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
});
