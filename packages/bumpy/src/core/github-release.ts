import { tryRunArgs, runArgsAsync } from '../utils/shell.ts';
import { log } from '../utils/logger.ts';
import type { PlannedRelease, Changeset } from '../types.ts';

export interface GitHubReleaseOptions {
  dryRun?: boolean;
  title?: string;
}

/** Create individual GitHub releases for each published package */
export async function createIndividualReleases(
  releases: PlannedRelease[],
  changesets: Changeset[],
  rootDir: string,
  opts: GitHubReleaseOptions = {},
): Promise<void> {
  if (!isGhAvailable()) {
    log.dim('  gh CLI not found — skipping GitHub releases');
    return;
  }

  for (const release of releases) {
    const tag = `${release.name}@${release.newVersion}`;
    const body = buildReleaseBody(release, changesets);
    const title = `${release.name} v${release.newVersion}`;

    if (opts.dryRun) {
      log.dim(`  Would create GitHub release: ${title}`);
      continue;
    }

    try {
      await runArgsAsync(['gh', 'release', 'create', tag, '--title', title, '--notes', body], {
        cwd: rootDir,
      });
      log.dim(`  Created GitHub release: ${title}`);
    } catch (err) {
      log.warn(`  Failed to create GitHub release for ${tag}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/** Create a single aggregated GitHub release for all published packages */
export async function createAggregateRelease(
  releases: PlannedRelease[],
  changesets: Changeset[],
  rootDir: string,
  opts: GitHubReleaseOptions = {},
): Promise<void> {
  if (!isGhAvailable()) {
    log.dim('  gh CLI not found — skipping GitHub release');
    return;
  }

  if (releases.length === 0) return;

  const date = new Date().toISOString().split('T')[0];
  const titleTemplate = opts.title || 'Release {{date}}';
  const title = titleTemplate.replace('{{date}}', date!);

  // Use the first release's tag as the release tag, or create a date-based tag
  const tag = `release-${date}`;
  const body = buildAggregateBody(releases, changesets);

  if (opts.dryRun) {
    log.dim(`  Would create aggregate GitHub release: ${title}`);
    log.dim(`  Tag: ${tag}`);
    return;
  }

  try {
    // Create the tag if it doesn't exist
    tryRunArgs(['git', 'tag', tag], { cwd: rootDir });

    await runArgsAsync(['gh', 'release', 'create', tag, '--title', title, '--notes', body], {
      cwd: rootDir,
    });
    log.success(`Created aggregate GitHub release: ${title}`);
  } catch (err) {
    log.warn(`Failed to create aggregate GitHub release: ${err instanceof Error ? err.message : err}`);
  }
}

function buildReleaseBody(release: PlannedRelease, changesets: Changeset[]): string {
  const lines: string[] = [];
  const relevant = changesets.filter((cs) => release.changesets.includes(cs.id));

  if (relevant.length > 0) {
    for (const cs of relevant) {
      if (cs.summary) {
        lines.push(`- ${cs.summary.split('\n')[0]}`);
      }
    }
  }

  if (release.isDependencyBump && relevant.length === 0) {
    lines.push('- Updated dependencies');
  }

  return lines.join('\n') || 'No changelog entries.';
}

function buildAggregateBody(releases: PlannedRelease[], changesets: Changeset[]): string {
  const lines: string[] = [];

  // Group by bump type
  const groups: [string, PlannedRelease[]][] = [
    ['Major Changes', releases.filter((r) => r.type === 'major')],
    ['Minor Changes', releases.filter((r) => r.type === 'minor')],
    ['Patch Changes', releases.filter((r) => r.type === 'patch')],
  ];

  for (const [heading, group] of groups) {
    if (group.length === 0) continue;
    lines.push(`## ${heading}\n`);

    for (const release of group) {
      lines.push(`### ${release.name} v${release.newVersion}\n`);
      const relevant = changesets.filter((cs) => release.changesets.includes(cs.id));
      if (relevant.length > 0) {
        for (const cs of relevant) {
          if (cs.summary) {
            lines.push(`- ${cs.summary.split('\n')[0]}`);
          }
        }
      } else if (release.isDependencyBump) {
        lines.push('- Updated dependencies');
      } else if (release.isCascadeBump) {
        lines.push('- Version bump via cascade rule');
      }
      lines.push('');
    }
  }

  return lines.join('\n').trim() || 'No changelog entries.';
}

function isGhAvailable(): boolean {
  return tryRunArgs(['gh', '--version']) !== null;
}
