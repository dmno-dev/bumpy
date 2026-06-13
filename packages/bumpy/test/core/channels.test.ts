import { describe, test, expect } from 'bun:test';
import { resolveChannels, matchChannelByBranch, channelNames } from '../../src/core/channels.ts';
import { makeConfig } from '../helpers.ts';

describe('resolveChannels', () => {
  test('applies defaults: preid/tag = channel name, versionPr derived from base config', () => {
    const config = makeConfig({ channels: { next: { branch: 'next' } } });
    const channels = resolveChannels(config);
    const next = channels.get('next')!;
    expect(next.preid).toBe('next');
    expect(next.tag).toBe('next');
    expect(next.versionPr.title).toBe('🐸 Versioned release (next)');
    expect(next.versionPr.branch).toBe('bumpy/version-packages-next');
    expect(next.versionPr.automerge).toBe(false);
  });

  test('respects explicit overrides', () => {
    const config = makeConfig({
      channels: {
        next: {
          branch: 'release-next',
          preid: 'rc',
          tag: 'canary',
          versionPr: { title: 'Ship it', branch: 'my/branch', automerge: true },
        },
      },
    });
    const next = resolveChannels(config).get('next')!;
    expect(next.branch).toBe('release-next');
    expect(next.preid).toBe('rc');
    expect(next.tag).toBe('canary');
    expect(next.versionPr).toEqual({ title: 'Ship it', branch: 'my/branch', automerge: true });
  });

  test('supports multiple channels', () => {
    const config = makeConfig({
      channels: {
        next: { branch: 'next', preid: 'rc' },
        beta: { branch: 'beta' },
      },
    });
    const channels = resolveChannels(config);
    expect(channels.size).toBe(2);
    expect(channelNames(config)).toEqual(['next', 'beta']);
  });

  test('rejects missing branch', () => {
    const config = makeConfig({ channels: { next: {} as never } });
    expect(() => resolveChannels(config)).toThrow(/missing required "branch"/);
  });

  test('rejects channel on the base branch', () => {
    const config = makeConfig({ channels: { next: { branch: 'main' } } });
    expect(() => resolveChannels(config)).toThrow(/base branch/);
  });

  test('rejects two channels sharing a branch', () => {
    const config = makeConfig({
      channels: {
        next: { branch: 'next' },
        rc: { branch: 'next' },
      },
    });
    expect(() => resolveChannels(config)).toThrow(/both use branch/);
  });

  test('rejects reserved and invalid channel names', () => {
    expect(() => resolveChannels(makeConfig({ channels: { _config: { branch: 'x' } } }))).toThrow(/Invalid channel/);
    expect(() => resolveChannels(makeConfig({ channels: { README: { branch: 'x' } } }))).toThrow(/Invalid channel/);
    expect(() => resolveChannels(makeConfig({ channels: { 'foo/bar': { branch: 'x' } } }))).toThrow(/Invalid channel/);
    expect(() => resolveChannels(makeConfig({ channels: { '../up': { branch: 'x' } } }))).toThrow(/Invalid channel/);
  });
});

describe('matchChannelByBranch', () => {
  const config = makeConfig({
    channels: {
      next: { branch: 'next', preid: 'rc' },
      beta: { branch: 'release/beta' },
    },
  });

  test('matches channel branches', () => {
    expect(matchChannelByBranch(config, 'next')?.name).toBe('next');
    expect(matchChannelByBranch(config, 'release/beta')?.name).toBe('beta');
  });

  test('returns null for non-channel branches', () => {
    expect(matchChannelByBranch(config, 'main')).toBeNull();
    expect(matchChannelByBranch(config, 'feature/foo')).toBeNull();
    expect(matchChannelByBranch(config, null)).toBeNull();
  });

  test('returns null when no channels configured', () => {
    expect(matchChannelByBranch(makeConfig(), 'next')).toBeNull();
  });
});
