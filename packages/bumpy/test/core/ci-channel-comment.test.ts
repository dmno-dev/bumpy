import { describe, test, expect } from 'bun:test';
import { formatReleasePlanComment } from '../../src/commands/ci.ts';
import { resolveChannels } from '../../src/core/channels.ts';
import { makeRelease, makeReleasePlan, makeBumpFile, makeConfig } from '../helpers.ts';

const channel = resolveChannels(makeConfig({ channels: { next: { branch: 'next', preid: 'rc', tag: 'next' } } })).get(
  'next',
)!;

const plan = makeReleasePlan(
  [makeRelease('@myorg/core', '1.2.0', { type: 'minor', oldVersion: '1.1.0', bumpFiles: ['feat'] })],
  [makeBumpFile('feat', [{ name: '@myorg/core', type: 'minor' }], 'Add a feature')],
);

describe('formatReleasePlanComment — stable (no channel)', () => {
  const comment = formatReleasePlanComment(plan, plan.bumpFiles, '1', 'feature-branch', 'npm');

  test('uses the normal "next version bump" headline', () => {
    expect(comment).toContain('included in the next version bump');
    expect(comment).not.toContain('prerelease channel');
  });

  test('shows plain stable versions (no preid suffix)', () => {
    expect(comment).toContain('1.1.0 → **1.2.0**');
    expect(comment).not.toContain('-rc.');
  });
});

describe('formatReleasePlanComment — prerelease channel', () => {
  const comment = formatReleasePlanComment(plan, plan.bumpFiles, '1', 'feature-branch', 'npm', [], [], [], channel);

  test('headline makes the channel + prerelease explicit', () => {
    expect(comment).toContain('`next` prerelease channel');
    expect(comment).toContain('prerelease');
    expect(comment).toContain('@next');
  });

  test('versions carry the wildcard "-rc.x" suffix', () => {
    expect(comment).toContain('1.1.0 → **1.2.0-rc.x**');
  });

  test('includes a dist-tag install hint and promotion note', () => {
    expect(comment).toContain('npm i @myorg/core@next');
    expect(comment).toContain('Promote to a stable release by merging `next`');
  });
});
