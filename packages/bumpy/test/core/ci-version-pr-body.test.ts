import { describe, test, expect } from 'bun:test';
import { formatVersionPrBody } from '../../src/commands/ci.ts';
import { assembleReleasePlan } from '../../src/core/release-plan.ts';
import { DependencyGraph } from '../../src/core/dep-graph.ts';
import { makePkg, makeConfig } from '../helpers.ts';
import type { ReleasePlan, PlannedRelease, BumpFile } from '../../src/types.ts';

// GitHub rejects PR bodies longer than 65536 characters. bumpy should degrade
// gracefully rather than fail the release when there are many packages and/or
// huge change summaries.
const GH_LIMIT = 65_536;

function makePlan(count: number, summary: string): ReleasePlan {
  const releases: PlannedRelease[] = [];
  const bumpFiles: BumpFile[] = [];
  for (let i = 0; i < count; i++) {
    const id = `bump-${i}`;
    bumpFiles.push({ id, releases: [{ name: `@scope/pkg-${i}`, type: 'minor' }], summary });
    releases.push({
      name: `@scope/pkg-${i}`,
      type: 'minor',
      oldVersion: '1.0.0',
      newVersion: '1.1.0',
      bumpFiles: [id],
      isDependencyBump: false,
      isCascadeBump: false,
      isGroupBump: false,
      bumpSources: [],
    });
  }
  return { bumpFiles, releases, warnings: [] };
}

const packageDirs = new Map<string, string>();
for (let i = 0; i < 200; i++) packageDirs.set(`@scope/pkg-${i}`, `packages/pkg-${i}`);

describe('formatVersionPrBody — within size limit', () => {
  const body = formatVersionPrBody(makePlan(3, 'Add a feature'), 'Release', packageDirs, 'owner/repo', '42');

  test('includes inline change summaries', () => {
    expect(body).toContain('Add a feature');
    expect(body).toContain('@scope/pkg-0');
    expect(body.length).toBeLessThanOrEqual(GH_LIMIT);
  });
});

describe('formatVersionPrBody — exceeds limit via large summaries', () => {
  // 30 packages each with a multi-KB summary blows past 65536 chars.
  const bigSummary = 'Detailed change notes. '.repeat(150);
  const body = formatVersionPrBody(makePlan(30, bigSummary), 'Release', packageDirs, 'owner/repo', '42');

  test('stays under the GitHub limit', () => {
    expect(body.length).toBeLessThanOrEqual(GH_LIMIT);
  });

  test('drops the inline summaries but keeps the version-bump list', () => {
    expect(body).not.toContain('Detailed change notes.');
    expect(body).toContain('@scope/pkg-0');
    expect(body).toContain('@scope/pkg-29');
    expect(body).toContain('too many changes to summarize');
  });
});

describe('formatVersionPrBody — follow-only packages (directBump: false)', () => {
  const packages = new Map([
    ['varlock', makePkg('varlock', '1.16.1')],
    ['@varlock/helper-darwin', makePkg('@varlock/helper-darwin', '1.16.1', { bumpy: { directBump: false } })],
    ['@varlock/helper-linux', makePkg('@varlock/helper-linux', '1.16.1', { bumpy: { directBump: false } })],
  ]);
  const bumpFiles: BumpFile[] = [{ id: 'cs1', releases: [{ name: 'varlock', type: 'minor' }], summary: 'New stuff' }];
  const config = makeConfig({ fixed: [['varlock', '@varlock/helper-*']] });
  const plan = assembleReleasePlan(bumpFiles, packages, new DependencyGraph(packages), config);

  const dirs = new Map([
    ['varlock', 'packages/varlock'],
    ['@varlock/helper-darwin', 'packages/helper-darwin'],
    ['@varlock/helper-linux', 'packages/helper-linux'],
  ]);
  const body = formatVersionPrBody(plan, 'Release', dirs, 'owner/repo', '42');

  test('followers get no section of their own', () => {
    expect(body).toContain('#### `varlock` 1.16.1 → **1.17.0**');
    expect(body).not.toContain('#### `@varlock/helper-darwin`');
    expect(body).not.toContain('#### `@varlock/helper-linux`');
  });

  test('followers are listed on a released-together line under the driver', () => {
    expect(body).toContain('Released together at **1.17.0** (fixed group)');
    expect(body).toContain('@varlock/helper-darwin');
    expect(body).toContain('@varlock/helper-linux');
  });

  test('follower names link to their changelogs', () => {
    expect(body).toContain('[`@varlock/helper-darwin`](https://github.com/owner/repo/pull/42/changes#diff-');
  });

  test('a follow-only release with no resolvable driver renders normally', () => {
    const orphanPlan: ReleasePlan = {
      bumpFiles: [],
      warnings: [],
      releases: [
        {
          name: '@varlock/helper-darwin',
          type: 'patch',
          oldVersion: '1.0.0',
          newVersion: '1.0.1',
          bumpFiles: [],
          isDependencyBump: true,
          isCascadeBump: false,
          isGroupBump: false,
          bumpSources: [],
          followOnly: true,
        },
      ],
    };
    const orphanBody = formatVersionPrBody(orphanPlan, 'Release', dirs, 'owner/repo', '42');
    expect(orphanBody).toContain('#### `@varlock/helper-darwin` 1.0.0 → **1.0.1**');
  });
});

describe('formatVersionPrBody — exceeds limit even compact', () => {
  // Thousands of packages: even the header-only list overflows.
  const body = formatVersionPrBody(makePlan(3000, 'x'), 'Release', packageDirs, 'owner/repo', '42');

  test('hard-truncates to under the GitHub limit', () => {
    expect(body.length).toBeLessThanOrEqual(GH_LIMIT);
    expect(body).toContain('truncated');
  });
});
