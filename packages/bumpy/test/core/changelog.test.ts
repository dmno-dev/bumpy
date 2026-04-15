import { test, expect, describe } from 'bun:test';
import { makeRelease, makeChangeset } from '../helpers.ts';
import { defaultFormatter, generateChangelogEntry, prependToChangelog } from '../../src/core/changelog.ts';

describe('defaultFormatter', () => {
  test('formats basic release with changesets', async () => {
    const release = makeRelease('pkg-a', '1.1.0', {
      type: 'minor',
      oldVersion: '1.0.0',
      changesets: ['cs1', 'cs2'],
    });
    const changesets = [
      makeChangeset('cs1', [{ name: 'pkg-a', type: 'minor' }], 'Added new feature'),
      makeChangeset('cs2', [{ name: 'pkg-a', type: 'patch' }], 'Fixed a bug'),
    ];

    const result = await defaultFormatter({ release, changesets, date: '2026-04-14' });

    expect(result).toContain('## 1.1.0');
    expect(result).toContain('_2026-04-14_');
    expect(result).toContain('- Added new feature');
    expect(result).toContain('- Fixed a bug');
  });

  test('formats dependency bump with no changesets', async () => {
    const release = makeRelease('pkg-a', '1.0.1', {
      isDependencyBump: true,
      changesets: [],
    });

    const result = await defaultFormatter({ release, changesets: [], date: '2026-04-14' });

    expect(result).toContain('- Updated dependencies');
  });

  test('formats cascade bump with no changesets', async () => {
    const release = makeRelease('pkg-a', '1.0.1', {
      isCascadeBump: true,
      changesets: [],
    });

    const result = await defaultFormatter({ release, changesets: [], date: '2026-04-14' });

    expect(result).toContain('- Version bump via cascade rule');
  });

  test('dependency bump takes precedence over cascade in message', async () => {
    const release = makeRelease('pkg-a', '1.0.1', {
      isDependencyBump: true,
      isCascadeBump: true,
      changesets: [],
    });

    const result = await defaultFormatter({ release, changesets: [], date: '2026-04-14' });

    expect(result).toContain('- Updated dependencies');
    expect(result).not.toContain('cascade');
  });

  test('handles multi-line changeset summaries', async () => {
    const release = makeRelease('pkg-a', '1.1.0', {
      type: 'minor',
      changesets: ['cs1'],
    });
    const changesets = [makeChangeset('cs1', [{ name: 'pkg-a', type: 'minor' }], 'First line\n\nSecond paragraph')];

    const result = await defaultFormatter({ release, changesets, date: '2026-04-14' });

    expect(result).toContain('- First line');
    expect(result).toContain('  Second paragraph');
  });

  test('only includes changesets referenced by the release', async () => {
    const release = makeRelease('pkg-a', '1.0.1', { changesets: ['cs1'] });
    const changesets = [
      makeChangeset('cs1', [{ name: 'pkg-a', type: 'patch' }], 'Relevant fix'),
      makeChangeset('cs2', [{ name: 'pkg-b', type: 'patch' }], 'Unrelated fix'),
    ];

    const result = await defaultFormatter({ release, changesets, date: '2026-04-14' });

    expect(result).toContain('Relevant fix');
    expect(result).not.toContain('Unrelated fix');
  });
});

describe('generateChangelogEntry', () => {
  test('uses default formatter when none specified', async () => {
    const release = makeRelease('pkg-a', '1.0.1', { changesets: ['cs1'] });
    const changesets = [makeChangeset('cs1', [{ name: 'pkg-a', type: 'patch' }], 'Fix')];

    const result = await generateChangelogEntry(release, changesets);

    expect(result).toContain('## 1.0.1');
    expect(result).toContain('- Fix');
  });

  test('uses custom formatter', async () => {
    const customFormatter = (ctx: any) => `Custom: ${ctx.release.newVersion}`;
    const release = makeRelease('pkg-a', '2.0.0');

    const result = await generateChangelogEntry(release, [], customFormatter);

    expect(result).toBe('Custom: 2.0.0');
  });

  test('uses provided date', async () => {
    const release = makeRelease('pkg-a', '1.0.0');

    const result = await generateChangelogEntry(release, [], undefined, '2020-01-01');

    expect(result).toContain('_2020-01-01_');
  });
});

describe('prependToChangelog', () => {
  test('prepends to existing changelog with title and entries', () => {
    const existing = '# Changelog\n\n## 1.0.0\n\n- Initial release\n';
    const newEntry = '## 1.1.0\n\n- New feature\n';

    const result = prependToChangelog(existing, newEntry);

    expect(result).toContain('# Changelog');
    // New entry should appear before old entry
    const newIdx = result.indexOf('## 1.1.0');
    const oldIdx = result.indexOf('## 1.0.0');
    expect(newIdx).toBeLessThan(oldIdx);
  });

  test('creates fresh changelog when no existing content', () => {
    const result = prependToChangelog('', '## 1.0.0\n\n- Initial\n');

    expect(result).toContain('# Changelog');
    expect(result).toContain('## 1.0.0');
  });

  test('appends after title when no existing entries', () => {
    const existing = '# Changelog';
    const newEntry = '## 1.0.0\n\n- First\n';

    const result = prependToChangelog(existing, newEntry);

    expect(result).toContain('# Changelog');
    expect(result).toContain('## 1.0.0');
  });

  test('preserves all existing content', () => {
    const existing = '# Changelog\n\n## 1.0.0\n\n- Old entry\n';
    const newEntry = '## 2.0.0\n\n- New entry\n';

    const result = prependToChangelog(existing, newEntry);

    expect(result).toContain('- Old entry');
    expect(result).toContain('- New entry');
  });
});
