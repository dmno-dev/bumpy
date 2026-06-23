import { describe, test, expect } from 'bun:test';
import { formatVersionPrBody } from '../../src/commands/ci.ts';
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

describe('formatVersionPrBody — exceeds limit even compact', () => {
  // Thousands of packages: even the header-only list overflows.
  const body = formatVersionPrBody(makePlan(3000, 'x'), 'Release', packageDirs, 'owner/repo', '42');

  test('hard-truncates to under the GitHub limit', () => {
    expect(body.length).toBeLessThanOrEqual(GH_LIMIT);
    expect(body).toContain('truncated');
  });
});
