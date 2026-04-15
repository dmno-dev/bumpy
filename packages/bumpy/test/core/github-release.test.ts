import { test, expect, describe } from 'bun:test';
import { resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { runArgs } from '../../src/utils/shell.ts';
import { listTags, tagExists } from '../../src/core/git.ts';
import {
  resolveAggregateTagAndTitle,
  createAggregateRelease,
  createIndividualReleases,
} from '../../src/core/github-release.ts';
import type { PlannedRelease } from '../../src/types.ts';

function initRepo(dir: string) {
  runArgs(['git', 'init'], { cwd: dir });
  runArgs(['git', 'commit', '--allow-empty', '-m', 'init'], { cwd: dir });
}

function makeRelease(name: string, version: string, type: 'major' | 'minor' | 'patch' = 'patch'): PlannedRelease {
  return {
    name,
    type,
    oldVersion: '0.0.0',
    newVersion: version,
    changesets: [],
    isDependencyBump: false,
    isCascadeBump: false,
  };
}

// ---- Pure unit tests for tag/title resolution ----

describe('resolveAggregateTagAndTitle', () => {
  test('first release of the day gets no suffix', () => {
    const result = resolveAggregateTagAndTitle('2026-04-14', []);
    expect(result.tag).toBe('release-2026-04-14');
    expect(result.title).toBe('Release 2026-04-14');
  });

  test('second release of the day gets -2 suffix', () => {
    const result = resolveAggregateTagAndTitle('2026-04-14', ['release-2026-04-14']);
    expect(result.tag).toBe('release-2026-04-14-2');
    expect(result.title).toBe('Release 2026-04-14-2');
  });

  test('third release of the day gets -3 suffix', () => {
    const existing = ['release-2026-04-14', 'release-2026-04-14-2'];
    const result = resolveAggregateTagAndTitle('2026-04-14', existing);
    expect(result.tag).toBe('release-2026-04-14-3');
    expect(result.title).toBe('Release 2026-04-14-3');
  });

  test('custom title template gets date+suffix substituted', () => {
    const result = resolveAggregateTagAndTitle('2026-04-14', ['release-2026-04-14'], 'Deploy {{date}}');
    expect(result.title).toBe('Deploy 2026-04-14-2');
  });

  test('custom title with no suffix', () => {
    const result = resolveAggregateTagAndTitle('2026-04-14', [], 'v{{date}}');
    expect(result.title).toBe('v2026-04-14');
  });
});

// ---- Integration tests using real git repos ----

describe('createAggregateRelease', () => {
  let tmpDir: string;

  test('creates a date-based git tag (gh failure is caught)', async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'bumpy-ghrel-'));
    initRepo(tmpDir);

    const releases = [makeRelease('pkg-a', '1.0.0', 'minor')];

    // This will create the git tag, then fail at `gh release create` (no auth),
    // but the error is caught — we verify the tag was created correctly
    await createAggregateRelease(releases, [], tmpDir);

    const today = new Date().toISOString().split('T')[0];
    expect(tagExists(`release-${today}`, { cwd: tmpDir })).toBe(true);

    await rm(tmpDir, { recursive: true });
  });

  test('second call on same day creates tag with -2 suffix', async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'bumpy-ghrel-'));
    initRepo(tmpDir);

    const releases = [makeRelease('pkg-a', '1.0.0')];
    const today = new Date().toISOString().split('T')[0];

    // First release
    await createAggregateRelease(releases, [], tmpDir);
    expect(tagExists(`release-${today}`, { cwd: tmpDir })).toBe(true);

    // Second release
    await createAggregateRelease(releases, [], tmpDir);
    expect(tagExists(`release-${today}-2`, { cwd: tmpDir })).toBe(true);

    // Third release
    await createAggregateRelease(releases, [], tmpDir);
    expect(tagExists(`release-${today}-3`, { cwd: tmpDir })).toBe(true);

    // All three tags exist
    const tags = listTags(`release-${today}*`, { cwd: tmpDir });
    expect(tags).toHaveLength(3);

    await rm(tmpDir, { recursive: true });
  });

  test('skips with empty releases array', async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'bumpy-ghrel-'));
    initRepo(tmpDir);

    // Should return early, no tags created
    await createAggregateRelease([], [], tmpDir);

    const tags = listTags('release-*', { cwd: tmpDir });
    expect(tags).toHaveLength(0);

    await rm(tmpDir, { recursive: true });
  });
});

describe('createIndividualReleases', () => {
  let tmpDir: string;

  test('dry run does not create tags or call gh', async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'bumpy-ghrel-'));
    initRepo(tmpDir);

    const releases = [makeRelease('pkg-a', '1.0.0'), makeRelease('pkg-b', '2.0.0')];

    await createIndividualReleases(releases, [], tmpDir, { dryRun: true });

    // No tags should be created in dry-run mode
    expect(tagExists('pkg-a@1.0.0', { cwd: tmpDir })).toBe(false);
    expect(tagExists('pkg-b@2.0.0', { cwd: tmpDir })).toBe(false);

    await rm(tmpDir, { recursive: true });
  });

  test('creates per-package releases (gh failure is caught)', async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'bumpy-ghrel-'));
    initRepo(tmpDir);

    const releases = [makeRelease('pkg-a', '1.0.0', 'minor'), makeRelease('pkg-b', '2.0.0', 'major')];

    // gh will fail but errors are caught per-release — all releases attempted
    await createIndividualReleases(releases, [], tmpDir);

    // Individual releases don't create git tags (that's done by publish-pipeline)
    // but this verifies the function doesn't throw on gh failure
    await rm(tmpDir, { recursive: true });
  });
});
