import { describe, test, expect } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readBumpFiles, moveBumpFilesToChannel, recoverDeletedBumpFiles } from '../../src/core/bump-file.ts';
import { createTempGitRepo, cleanupTempDir, gitInDir } from '../helpers.ts';

async function writeBumpFileAt(dir: string, relPath: string, pkgName = 'pkg-a', bump = 'minor'): Promise<void> {
  const filePath = resolve(dir, relPath);
  await mkdir(resolve(filePath, '..'), { recursive: true });
  await writeFile(filePath, `---\n"${pkgName}": ${bump}\n---\n\nSome change\n`);
}

describe('readBumpFiles with channels', () => {
  test('reads root files as pending and channel files with their channel set', async () => {
    const dir = await createTempGitRepo();
    try {
      await writeBumpFileAt(dir, '.bumpy/pending-fix.md');
      await writeBumpFileAt(dir, '.bumpy/next/shipped-feature.md');
      await writeBumpFileAt(dir, '.bumpy/beta/other-channel.md');

      const { bumpFiles, errors } = await readBumpFiles(dir, { channels: ['next', 'beta'] });
      expect(errors).toEqual([]);
      const byId = new Map(bumpFiles.map((bf) => [bf.id, bf]));
      expect(byId.get('pending-fix')?.channel).toBeUndefined();
      expect(byId.get('shipped-feature')?.channel).toBe('next');
      expect(byId.get('other-channel')?.channel).toBe('beta');
    } finally {
      await cleanupTempDir(dir);
    }
  });

  test('ignores channel dirs not in the channels option', async () => {
    const dir = await createTempGitRepo();
    try {
      await writeBumpFileAt(dir, '.bumpy/next/shipped.md');
      const { bumpFiles } = await readBumpFiles(dir);
      expect(bumpFiles).toEqual([]);
    } finally {
      await cleanupTempDir(dir);
    }
  });

  test('flags duplicate IDs across root and channel dirs as an error', async () => {
    const dir = await createTempGitRepo();
    try {
      await writeBumpFileAt(dir, '.bumpy/same-change.md');
      await writeBumpFileAt(dir, '.bumpy/next/same-change.md');
      const { bumpFiles, errors } = await readBumpFiles(dir, { channels: ['next'] });
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain('same-change');
      expect(bumpFiles.length).toBe(1); // only the first copy kept
    } finally {
      await cleanupTempDir(dir);
    }
  });
});

describe('moveBumpFilesToChannel', () => {
  test('moves pending files (root and other channels) into the channel dir', async () => {
    const dir = await createTempGitRepo();
    try {
      await writeBumpFileAt(dir, '.bumpy/from-root.md');
      await writeBumpFileAt(dir, '.bumpy/alpha/from-alpha.md');
      await writeBumpFileAt(dir, '.bumpy/beta/already-here.md');

      const { bumpFiles } = await readBumpFiles(dir, { channels: ['alpha', 'beta'] });
      await moveBumpFilesToChannel(dir, bumpFiles, 'beta');

      expect(existsSync(resolve(dir, '.bumpy/beta/from-root.md'))).toBe(true);
      expect(existsSync(resolve(dir, '.bumpy/beta/from-alpha.md'))).toBe(true);
      expect(existsSync(resolve(dir, '.bumpy/beta/already-here.md'))).toBe(true);
      expect(existsSync(resolve(dir, '.bumpy/from-root.md'))).toBe(false);
      expect(existsSync(resolve(dir, '.bumpy/alpha/from-alpha.md'))).toBe(false);
    } finally {
      await cleanupTempDir(dir);
    }
  });
});

describe('recoverDeletedBumpFiles with channel dirs', () => {
  test('recovers bump files deleted from channel subdirs in the HEAD commit', async () => {
    const dir = await createTempGitRepo();
    try {
      await writeBumpFileAt(dir, '.bumpy/next/shipped-feature.md', 'pkg-a', 'minor');
      await writeBumpFileAt(dir, '.bumpy/root-fix.md', 'pkg-b', 'patch');
      gitInDir(['add', '-A'], dir);
      gitInDir(['commit', '-m', 'add bump files'], dir);
      gitInDir(['rm', '-r', '.bumpy'], dir);
      gitInDir(['commit', '-m', 'version packages'], dir);

      const recovered = recoverDeletedBumpFiles(dir);
      const ids = recovered.map((bf) => bf.id).sort();
      expect(ids).toEqual(['root-fix', 'shipped-feature']);
    } finally {
      await cleanupTempDir(dir);
    }
  });
});
