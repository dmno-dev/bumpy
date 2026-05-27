import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { makeRelease, createTempGitRepo, cleanupTempDir } from '../helpers.ts';
import { installShellMock, uninstallShellMock, getCallsMatching, addMockRule } from '../helpers-shell-mock.ts';
import { tagExists } from '../../src/core/git.ts';
import { createIndividualReleases } from '../../src/core/github-release.ts';

// ---- Integration tests using real git repos + mocked gh CLI ----

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
