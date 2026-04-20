import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { makeRelease, createTempGitRepo, cleanupTempDir } from '../helpers.ts';
import { installShellMock, uninstallShellMock, getCallsMatching, addMockRule } from '../helpers-shell-mock.ts';
import { listTags, tagExists } from '../../src/core/git.ts';
import {
  resolveAggregateTagAndTitle,
  createAggregateRelease,
  createIndividualReleases,
} from '../../src/core/github-release.ts';

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

// ---- Integration tests using real git repos + mocked gh CLI ----

describe('createAggregateRelease', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempGitRepo();
    installShellMock();
    addMockRule({ match: /^gh release create/, response: '' });
  });

  afterEach(async () => {
    uninstallShellMock();
    await cleanupTempDir(tmpDir);
  });

  test('creates a date-based git tag', async () => {
    const releases = [makeRelease('pkg-a', '1.0.0', { type: 'minor' })];

    await createAggregateRelease(releases, [], tmpDir);

    const today = new Date().toISOString().split('T')[0];
    expect(tagExists(`release-${today}`, { cwd: tmpDir })).toBe(true);
  });

  test('calls gh release create with correct arguments', async () => {
    const releases = [makeRelease('pkg-a', '1.0.0', { type: 'minor' })];

    await createAggregateRelease(releases, [], tmpDir);

    const ghCalls = getCallsMatching('gh release create');
    expect(ghCalls).toHaveLength(1);
    expect(ghCalls[0]!.command).toContain('release-');
    expect(ghCalls[0]!.command).toContain('--title');
    expect(ghCalls[0]!.command).toContain('--notes');
  });

  test('second call on same day creates tag with -2 suffix', async () => {
    const releases = [makeRelease('pkg-a', '1.0.0')];
    const today = new Date().toISOString().split('T')[0];

    await createAggregateRelease(releases, [], tmpDir);
    expect(tagExists(`release-${today}`, { cwd: tmpDir })).toBe(true);

    await createAggregateRelease(releases, [], tmpDir);
    expect(tagExists(`release-${today}-2`, { cwd: tmpDir })).toBe(true);

    await createAggregateRelease(releases, [], tmpDir);
    expect(tagExists(`release-${today}-3`, { cwd: tmpDir })).toBe(true);

    const tags = listTags(`release-${today}*`, { cwd: tmpDir });
    expect(tags).toHaveLength(3);
  });

  test('skips with empty releases array', async () => {
    await createAggregateRelease([], [], tmpDir);

    const tags = listTags('release-*', { cwd: tmpDir });
    expect(tags).toHaveLength(0);
    const ghCalls = getCallsMatching('gh release create');
    expect(ghCalls).toHaveLength(0);
  });

  test('handles gh failure gracefully', async () => {
    // Override the default gh release create rule with an error
    installShellMock();
    addMockRule({ match: /^gh release create/, error: 'auth required' });

    const releases = [makeRelease('pkg-a', '1.0.0', { type: 'minor' })];

    // Should not throw
    await createAggregateRelease(releases, [], tmpDir);

    // Tag should still be created (git tag happens before gh release create)
    const today = new Date().toISOString().split('T')[0];
    expect(tagExists(`release-${today}`, { cwd: tmpDir })).toBe(true);
  });

  test('skips entirely when gh is not available', async () => {
    installShellMock({ interceptGh: false });
    addMockRule({ match: 'gh --version', error: 'not found' });

    const releases = [makeRelease('pkg-a', '1.0.0')];
    await createAggregateRelease(releases, [], tmpDir);

    const tags = listTags('release-*', { cwd: tmpDir });
    expect(tags).toHaveLength(0);
  });
});

describe('createIndividualReleases', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempGitRepo();
    installShellMock();
    addMockRule({ match: /^gh release create/, response: '' });
  });

  afterEach(async () => {
    uninstallShellMock();
    await cleanupTempDir(tmpDir);
  });

  test('dry run does not create tags or call gh', async () => {
    const releases = [makeRelease('pkg-a', '1.0.0'), makeRelease('pkg-b', '2.0.0')];

    await createIndividualReleases(releases, [], tmpDir, { dryRun: true });

    expect(tagExists('pkg-a@1.0.0', { cwd: tmpDir })).toBe(false);
    expect(tagExists('pkg-b@2.0.0', { cwd: tmpDir })).toBe(false);

    const ghCalls = getCallsMatching('gh release create');
    expect(ghCalls).toHaveLength(0);
  });

  test('creates per-package releases via gh', async () => {
    const releases = [
      makeRelease('pkg-a', '1.0.0', { type: 'minor' }),
      makeRelease('pkg-b', '2.0.0', { type: 'major' }),
    ];

    await createIndividualReleases(releases, [], tmpDir);

    const ghCalls = getCallsMatching('gh release create');
    expect(ghCalls).toHaveLength(2);
    expect(ghCalls[0]!.command).toContain('pkg-a@1.0.0');
    expect(ghCalls[1]!.command).toContain('pkg-b@2.0.0');
  });

  test('includes bump file summaries in release body', async () => {
    const bumpFiles = [
      { id: 'cs1', releases: [{ name: 'pkg-a', type: 'patch' as const }], summary: 'Fixed the login bug' },
    ];
    const releases = [makeRelease('pkg-a', '1.0.1', { bumpFiles: ['cs1'] })];

    await createIndividualReleases(releases, bumpFiles, tmpDir);

    const ghCalls = getCallsMatching('gh release create');
    expect(ghCalls).toHaveLength(1);
    const notesIdx = ghCalls[0]!.args!.indexOf('--notes');
    expect(notesIdx).toBeGreaterThan(-1);
    expect(ghCalls[0]!.args![notesIdx + 1]).toContain('Fixed the login bug');
  });

  test('continues after individual release failure', async () => {
    installShellMock();
    addMockRule({ match: 'pkg-a@1.0.0', error: 'tag already exists' });
    addMockRule({ match: /^gh release create/, response: '' });

    const releases = [makeRelease('pkg-a', '1.0.0'), makeRelease('pkg-b', '2.0.0')];

    await createIndividualReleases(releases, [], tmpDir);

    const ghCalls = getCallsMatching('gh release create');
    expect(ghCalls).toHaveLength(2);
  });
});
