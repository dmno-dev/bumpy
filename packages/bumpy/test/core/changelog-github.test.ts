import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { makeRelease, makeBumpFile } from '../helpers.ts';
import { installShellMock, uninstallShellMock, addMockRule } from '../helpers-shell-mock.ts';
import { createGithubFormatter } from '../../src/core/changelog-github.ts';

describe('createGithubFormatter', () => {
  beforeEach(() => {
    installShellMock();
    addMockRule({ match: 'gh repo view', response: 'dmno-dev/bumpy' });
  });

  afterEach(() => {
    uninstallShellMock();
  });

  test('formats basic release entry', async () => {
    addMockRule({ match: /^git log/, response: '' });

    const formatter = createGithubFormatter({ repo: 'dmno-dev/bumpy' });
    const release = makeRelease('pkg-a', '1.1.0', {
      type: 'minor',
      bumpFiles: ['cs1'],
    });
    const bumpFiles = [makeBumpFile('cs1', [{ name: 'pkg-a', type: 'minor' }], 'Added feature X')];

    const result = await formatter({ release, bumpFiles, date: '2026-04-14' });

    expect(result).toContain('## 1.1.0');
    expect(result).toContain('<sub>2026-04-14</sub>');
    expect(result).toContain('Added feature X');
  });

  test('includes PR link when bump file has PR metadata', async () => {
    addMockRule({ match: /^git log/, response: '' });
    addMockRule({
      match: /gh pr view 42/,
      response: JSON.stringify({
        url: 'https://github.com/dmno-dev/bumpy/pull/42',
        author: { login: 'contributor' },
        mergeCommit: { oid: 'abc1234567890' },
      }),
    });

    const formatter = createGithubFormatter({ repo: 'dmno-dev/bumpy' });
    const release = makeRelease('pkg-a', '1.0.1', { bumpFiles: ['cs1'] });
    const bumpFiles = [makeBumpFile('cs1', [{ name: 'pkg-a', type: 'patch' }], 'pr: #42\nFixed the bug')];

    const result = await formatter({ release, bumpFiles, date: '2026-04-14' });

    expect(result).toContain('[#42]');
    expect(result).toContain('https://github.com/dmno-dev/bumpy/pull/42');
  });

  test('excludes commit link by default', async () => {
    addMockRule({ match: /^git log/, response: '' });

    const formatter = createGithubFormatter({ repo: 'dmno-dev/bumpy' });
    const release = makeRelease('pkg-a', '1.0.1', { bumpFiles: ['cs1'] });
    const bumpFiles = [makeBumpFile('cs1', [{ name: 'pkg-a', type: 'patch' }], 'commit: abc1234567890\nFixed it')];

    const result = await formatter({ release, bumpFiles, date: '2026-04-14' });

    expect(result).not.toContain('[`abc1234`]');
    expect(result).not.toContain('/commit/abc1234567890');
  });

  test('includes commit link when includeCommitLink is true', async () => {
    addMockRule({ match: /^git log/, response: '' });

    const formatter = createGithubFormatter({ repo: 'dmno-dev/bumpy', includeCommitLink: true });
    const release = makeRelease('pkg-a', '1.0.1', { bumpFiles: ['cs1'] });
    const bumpFiles = [makeBumpFile('cs1', [{ name: 'pkg-a', type: 'patch' }], 'commit: abc1234567890\nFixed it')];

    const result = await formatter({ release, bumpFiles, date: '2026-04-14' });

    expect(result).toContain('[`abc1234`]');
    expect(result).toContain('/commit/abc1234567890');
  });

  test('includes author thanks for external contributors', async () => {
    addMockRule({ match: /^git log/, response: '' });

    const formatter = createGithubFormatter({
      repo: 'dmno-dev/bumpy',
      internalAuthors: ['theoephraim'],
    });
    const release = makeRelease('pkg-a', '1.0.1', { bumpFiles: ['cs1'] });
    const bumpFiles = [makeBumpFile('cs1', [{ name: 'pkg-a', type: 'patch' }], 'author: @external-dev\nFixed it')];

    const result = await formatter({ release, bumpFiles, date: '2026-04-14' });

    expect(result).toContain('Thanks [@external-dev]');
  });

  test('skips thanks for internal authors', async () => {
    addMockRule({ match: /^git log/, response: '' });

    const formatter = createGithubFormatter({
      repo: 'dmno-dev/bumpy',
      internalAuthors: ['theoephraim'],
    });
    const release = makeRelease('pkg-a', '1.0.1', { bumpFiles: ['cs1'] });
    const bumpFiles = [makeBumpFile('cs1', [{ name: 'pkg-a', type: 'patch' }], 'author: @theoephraim\nFixed it')];

    const result = await formatter({ release, bumpFiles, date: '2026-04-14' });

    expect(result).not.toContain('Thanks');
  });

  test('linkifies bare issue references', async () => {
    addMockRule({ match: /^git log/, response: '' });

    const formatter = createGithubFormatter({ repo: 'dmno-dev/bumpy' });
    const release = makeRelease('pkg-a', '1.0.1', { bumpFiles: ['cs1'] });
    const bumpFiles = [makeBumpFile('cs1', [{ name: 'pkg-a', type: 'patch' }], 'Fixed #123 and #456')];

    const result = await formatter({ release, bumpFiles, date: '2026-04-14' });

    expect(result).toContain('[#123](https://github.com/dmno-dev/bumpy/issues/123)');
    expect(result).toContain('[#456](https://github.com/dmno-dev/bumpy/issues/456)');
  });

  test('does not double-linkify already linked references', async () => {
    addMockRule({ match: /^git log/, response: '' });

    const formatter = createGithubFormatter({ repo: 'dmno-dev/bumpy' });
    const release = makeRelease('pkg-a', '1.0.1', { bumpFiles: ['cs1'] });
    const bumpFiles = [
      makeBumpFile('cs1', [{ name: 'pkg-a', type: 'patch' }], 'Fixed [#123](https://example.com/123)'),
    ];

    const result = await formatter({ release, bumpFiles, date: '2026-04-14' });

    expect(result).toContain('[#123](https://example.com/123)');
    expect(result).not.toContain('issues/123');
  });

  test('handles dependency bump with no bump files', async () => {
    const formatter = createGithubFormatter({ repo: 'dmno-dev/bumpy' });
    const release = makeRelease('pkg-a', '1.0.1', {
      isDependencyBump: true,
      bumpFiles: [],
    });

    const result = await formatter({ release, bumpFiles: [], date: '2026-04-14' });

    expect(result).toContain('- Updated dependencies');
  });

  test('handles cascade bump with no bump files', async () => {
    const formatter = createGithubFormatter({ repo: 'dmno-dev/bumpy' });
    const release = makeRelease('pkg-a', '1.0.1', {
      isCascadeBump: true,
      bumpFiles: [],
    });

    const result = await formatter({ release, bumpFiles: [], date: '2026-04-14' });

    expect(result).toContain('- Version bump via cascade rule');
  });

  test('resolves bump file info from git log', async () => {
    addMockRule({
      match: /git log.*\.bumpy\/cs1\.md/,
      response: 'deadbeef1234567890abcdef',
    });
    addMockRule({
      match: /gh pr list.*deadbeef/,
      response: JSON.stringify({
        number: 99,
        url: 'https://github.com/dmno-dev/bumpy/pull/99',
        author: { login: 'contributor' },
      }),
    });

    const formatter = createGithubFormatter({ repo: 'dmno-dev/bumpy' });
    const release = makeRelease('pkg-a', '1.0.1', { bumpFiles: ['cs1'] });
    const bumpFiles = [makeBumpFile('cs1', [{ name: 'pkg-a', type: 'patch' }], 'Some fix')];

    const result = await formatter({ release, bumpFiles, date: '2026-04-14' });

    expect(result).toContain('[#99]');
    expect(result).not.toContain('[`deadbee`]');
    expect(result).toContain('Thanks [@contributor]');
  });

  test('gracefully handles gh errors', async () => {
    addMockRule({ match: /^git log/, response: 'abc123' });
    addMockRule({ match: /^gh pr list/, error: 'auth required' });

    const formatter = createGithubFormatter({ repo: 'dmno-dev/bumpy' });
    const release = makeRelease('pkg-a', '1.0.1', { bumpFiles: ['cs1'] });
    const bumpFiles = [makeBumpFile('cs1', [{ name: 'pkg-a', type: 'patch' }], 'Fix')];

    const result = await formatter({ release, bumpFiles, date: '2026-04-14' });
    expect(result).toContain('Fix');
  });
});
