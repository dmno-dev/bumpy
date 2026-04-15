import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { runArgs } from '../../src/utils/shell.ts';
import {
  createTag,
  tagExists,
  listTags,
  pushWithTags,
  hasUncommittedChanges,
  getCurrentBranch,
  commitFiles,
} from '../../src/core/git.ts';
import { writeText } from '../../src/utils/fs.ts';

function initRepo(dir: string) {
  runArgs(['git', 'init'], { cwd: dir });
  runArgs(['git', 'commit', '--allow-empty', '-m', 'init'], { cwd: dir });
}

describe('git helpers', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'bumpy-git-test-'));
    initRepo(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  // ---- createTag / tagExists ----

  describe('createTag & tagExists', () => {
    test('creates a tag and detects it exists', () => {
      expect(tagExists('v1.0.0', { cwd: tmpDir })).toBe(false);
      createTag('v1.0.0', { cwd: tmpDir });
      expect(tagExists('v1.0.0', { cwd: tmpDir })).toBe(true);
    });

    test('tagExists returns false for non-existent tag', () => {
      expect(tagExists('nope', { cwd: tmpDir })).toBe(false);
    });

    test('scoped package tag with @ and /', () => {
      createTag('@scope/pkg@1.2.3', { cwd: tmpDir });
      expect(tagExists('@scope/pkg@1.2.3', { cwd: tmpDir })).toBe(true);
      expect(tagExists('@scope/pkg@1.2.4', { cwd: tmpDir })).toBe(false);
    });
  });

  // ---- listTags ----

  describe('listTags', () => {
    test('returns empty array when no tags match', () => {
      expect(listTags('v*', { cwd: tmpDir })).toEqual([]);
    });

    test('lists tags matching a pattern', () => {
      createTag('v1.0.0', { cwd: tmpDir });
      createTag('v1.1.0', { cwd: tmpDir });
      createTag('other-tag', { cwd: tmpDir });

      const result = listTags('v*', { cwd: tmpDir });
      expect(result).toContain('v1.0.0');
      expect(result).toContain('v1.1.0');
      expect(result).not.toContain('other-tag');
    });

    test('glob matches date-based release tags for suffix logic', () => {
      // This is the pattern used by createAggregateRelease
      createTag('release-2026-04-14', { cwd: tmpDir });
      expect(listTags('release-2026-04-14*', { cwd: tmpDir })).toEqual(['release-2026-04-14']);

      createTag('release-2026-04-14-2', { cwd: tmpDir });
      const tags = listTags('release-2026-04-14*', { cwd: tmpDir });
      expect(tags).toHaveLength(2);
      expect(tags).toContain('release-2026-04-14');
      expect(tags).toContain('release-2026-04-14-2');

      // Different date should not match
      createTag('release-2026-04-15', { cwd: tmpDir });
      expect(listTags('release-2026-04-14*', { cwd: tmpDir })).toHaveLength(2);
    });
  });

  // ---- hasUncommittedChanges ----

  describe('hasUncommittedChanges', () => {
    test('returns false on clean repo', () => {
      expect(hasUncommittedChanges({ cwd: tmpDir })).toBe(false);
    });

    test('returns true with uncommitted files', async () => {
      await writeText(resolve(tmpDir, 'dirty.txt'), 'hello');
      expect(hasUncommittedChanges({ cwd: tmpDir })).toBe(true);
    });
  });

  // ---- getCurrentBranch ----

  describe('getCurrentBranch', () => {
    test('returns current branch name', () => {
      // git init defaults to main or master depending on config
      const branch = getCurrentBranch({ cwd: tmpDir });
      expect(typeof branch).toBe('string');
      expect(branch!.length).toBeGreaterThan(0);
    });
  });

  // ---- commitFiles ----

  describe('commitFiles', () => {
    test('stages and commits specified files', async () => {
      await writeText(resolve(tmpDir, 'a.txt'), 'aaa');
      await writeText(resolve(tmpDir, 'b.txt'), 'bbb');

      commitFiles(['a.txt', 'b.txt'], 'add files', { cwd: tmpDir });

      // Verify clean working tree
      expect(hasUncommittedChanges({ cwd: tmpDir })).toBe(false);
    });

    test('only stages specified files', async () => {
      await writeText(resolve(tmpDir, 'staged.txt'), 'yes');
      await writeText(resolve(tmpDir, 'unstaged.txt'), 'no');

      commitFiles(['staged.txt'], 'partial commit', { cwd: tmpDir });

      // unstaged.txt should still be dirty
      expect(hasUncommittedChanges({ cwd: tmpDir })).toBe(true);
    });
  });

  // ---- pushWithTags ----

  describe('pushWithTags', () => {
    test('pushes commits and tags to remote', async () => {
      // Set up a bare remote and clone
      const remoteDir = await mkdtemp(resolve(tmpdir(), 'bumpy-remote-'));
      runArgs(['git', 'init', '--bare'], { cwd: remoteDir });
      runArgs(['git', 'remote', 'add', 'origin', remoteDir], { cwd: tmpDir });

      createTag('v1.0.0', { cwd: tmpDir });
      pushWithTags({ cwd: tmpDir });

      // Clone from remote and check the tag arrived
      const cloneDir = await mkdtemp(resolve(tmpdir(), 'bumpy-clone-'));
      runArgs(['git', 'clone', remoteDir, '.'], { cwd: cloneDir });
      expect(tagExists('v1.0.0', { cwd: cloneDir })).toBe(true);

      await rm(remoteDir, { recursive: true });
      await rm(cloneDir, { recursive: true });
    });
  });
});
