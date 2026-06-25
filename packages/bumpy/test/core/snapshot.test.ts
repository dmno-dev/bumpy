import { describe, test, expect, afterEach } from 'bun:test';
import semver from 'semver';
import {
  sanitizeSnapshotName,
  resolveSnapshot,
  snapshotVersion,
  buildSnapshotReleasePlan,
  assertSnapshotPrerelease,
  formatSnapshotVersionSummary,
  type ResolvedSnapshot,
} from '../../src/core/snapshot.ts';
import { makePkg, makeConfig, makeRelease, makeReleasePlan, createTempGitRepo, cleanupTempDir } from '../helpers.ts';

describe('sanitizeSnapshotName', () => {
  test('passes through clean names', () => {
    expect(sanitizeSnapshotName('pr-123')).toBe('pr-123');
  });

  test('lowercases and collapses invalid runs to hyphens', () => {
    expect(sanitizeSnapshotName('feature/Foo_Bar')).toBe('feature-foo-bar');
    expect(sanitizeSnapshotName('PR #123')).toBe('pr-123');
  });

  test('trims leading/trailing hyphens', () => {
    expect(sanitizeSnapshotName('--pr-123--')).toBe('pr-123');
    expect(sanitizeSnapshotName('/feature/x/')).toBe('feature-x');
  });

  test('produces a valid semver prerelease identifier', () => {
    const name = sanitizeSnapshotName('feature/Foo_Bar');
    expect(semver.valid(`1.2.3-${name}.0`)).not.toBeNull();
  });

  test('throws when nothing alphanumeric remains', () => {
    expect(() => sanitizeSnapshotName('///')).toThrow(/at least one alphanumeric/);
    expect(() => sanitizeSnapshotName('   ')).toThrow();
  });
});

describe('resolveSnapshot', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await cleanupTempDir(dir);
    dir = '';
  });

  test('sha strategy resolves the short HEAD sha as the suffix', async () => {
    dir = await createTempGitRepo();
    const config = makeConfig({ snapshot: { versionStrategy: 'sha' } });
    const snap = resolveSnapshot('pr-123', config, dir);
    expect(snap.name).toBe('pr-123');
    expect(snap.tag).toBe('pr-123');
    expect(snap.strategy).toBe('sha');
    expect(snap.suffix).toMatch(/^[0-9a-f]{7}$/);
  });

  test('timestamp strategy uses an injected date', () => {
    const config = makeConfig({ snapshot: { versionStrategy: 'timestamp' } });
    const now = new Date(Date.UTC(2026, 5, 23, 12, 34, 56)); // June is month index 5
    const snap = resolveSnapshot('pr-123', config, '/nonexistent', { now });
    expect(snap.suffix).toBe('20260623123456');
  });

  test('explicit tag overrides the default (name)', () => {
    const config = makeConfig({ snapshot: { versionStrategy: 'timestamp' } });
    const snap = resolveSnapshot('sha-abc', config, '/x', { tag: 'pr-7' });
    expect(snap.name).toBe('sha-abc');
    expect(snap.tag).toBe('pr-7');
  });

  test('sanitizes the name into the preid and default tag', () => {
    const config = makeConfig({ snapshot: { versionStrategy: 'timestamp' } });
    const snap = resolveSnapshot('feature/Foo', config, '/x');
    expect(snap.name).toBe('feature-foo');
    expect(snap.tag).toBe('feature-foo');
  });

  test('sha strategy throws when HEAD cannot be resolved', () => {
    const config = makeConfig({ snapshot: { versionStrategy: 'sha' } });
    expect(() => resolveSnapshot('pr-1', config, '/definitely/not/a/repo')).toThrow(/sha/);
  });
});

describe('snapshotVersion', () => {
  const base = (overrides: Partial<ResolvedSnapshot>): ResolvedSnapshot => ({
    rawName: 'pr-123',
    name: 'pr-123',
    tag: 'pr-123',
    strategy: 'sha',
    suffix: 'a1b2c3d',
    ...overrides,
  });

  test('sha → <target>-<name>-<sha>', () => {
    const v = snapshotVersion('1.4.0', base({ strategy: 'sha', suffix: 'a1b2c3d' }));
    expect(v).toBe('1.4.0-pr-123-a1b2c3d');
    expect(semver.valid(v)).toBe(v);
    expect(semver.prerelease(v)).not.toBeNull();
  });

  test('timestamp → <target>-<name>-<timestamp>', () => {
    const v = snapshotVersion('2.0.0', base({ strategy: 'timestamp', suffix: '20260623123456' }));
    expect(v).toBe('2.0.0-pr-123-20260623123456');
    expect(semver.valid(v)).toBe(v);
  });

  test('snapshot versions sort below their stable target', () => {
    const v = snapshotVersion('1.4.0', base({}));
    expect(semver.lt(v, '1.4.0')).toBe(true);
  });
});

describe('buildSnapshotReleasePlan', () => {
  // Use private packages with a custom publishCommand: publishable (kept in the plan) but
  // not registry-backed, so no `npm info` network call happens in tests.
  const publishable = (name: string, version: string) =>
    makePkg(name, version, { private: true, bumpy: { publishCommand: 'echo publish' } });

  test('applies sha snapshot versions to each release', async () => {
    const packages = new Map([['a', publishable('a', '1.0.0')]]);
    const plan = makeReleasePlan([makeRelease('a', '1.1.0', { type: 'minor' })]);
    const snapshot: ResolvedSnapshot = {
      rawName: 'pr-9',
      name: 'pr-9',
      tag: 'pr-9',
      strategy: 'sha',
      suffix: 'deadbee',
    };

    const { plan: out, alreadyPublished } = await buildSnapshotReleasePlan(plan, snapshot, packages);
    expect(alreadyPublished).toEqual([]);
    expect(out.releases).toHaveLength(1);
    expect(out.releases[0]!.newVersion).toBe('1.1.0-pr-9-deadbee');
  });

  test('drops unpublishable private packages (no publishCommand)', async () => {
    const packages = new Map([
      ['a', publishable('a', '1.0.0')],
      ['b', makePkg('b', '2.0.0', { private: true })], // truly unpublishable
    ]);
    const plan = makeReleasePlan([makeRelease('a', '1.1.0'), makeRelease('b', '2.0.1')]);
    const snapshot: ResolvedSnapshot = {
      rawName: 'pr-1',
      name: 'pr-1',
      tag: 'pr-1',
      strategy: 'timestamp',
      suffix: '20260101000000',
    };

    const { plan: out } = await buildSnapshotReleasePlan(plan, snapshot, packages);
    expect(out.releases.map((r) => r.name)).toEqual(['a']);
  });

  test('sorts releases by name', async () => {
    const packages = new Map([
      ['z', publishable('z', '1.0.0')],
      ['a', publishable('a', '1.0.0')],
    ]);
    const plan = makeReleasePlan([makeRelease('z', '1.1.0'), makeRelease('a', '1.1.0')]);
    const snapshot: ResolvedSnapshot = {
      rawName: 'pr-1',
      name: 'pr-1',
      tag: 'pr-1',
      strategy: 'sha',
      suffix: 'abcdef0',
    };

    const { plan: out } = await buildSnapshotReleasePlan(plan, snapshot, packages);
    expect(out.releases.map((r) => r.name)).toEqual(['a', 'z']);
  });
});

describe('assertSnapshotPrerelease', () => {
  test('passes for prerelease versions', () => {
    expect(() => assertSnapshotPrerelease('1.0.0-pr-1-abc')).not.toThrow();
  });

  test('throws for stable versions (would land on @latest)', () => {
    expect(() => assertSnapshotPrerelease('1.0.0')).toThrow(/not a prerelease/);
  });
});

describe('formatSnapshotVersionSummary', () => {
  test('empty', () => {
    expect(formatSnapshotVersionSummary([])).toBe('');
  });
  test('single', () => {
    expect(formatSnapshotVersionSummary([makeRelease('a', '1.0.0-pr-1-abc')])).toBe('a@1.0.0-pr-1-abc');
  });
  test('multiple', () => {
    expect(formatSnapshotVersionSummary([makeRelease('a', '1.0.0'), makeRelease('b', '2.0.0')])).toBe('2 packages');
  });
});
