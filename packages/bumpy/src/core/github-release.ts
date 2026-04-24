import { tryRunArgs, runArgsAsync } from '../utils/shell.ts';
import { log } from '../utils/logger.ts';
import { listTags } from './git.ts';
import { generateChangelogEntry } from './changelog.ts';
import type { ChangelogFormatter } from './changelog.ts';
import type { PlannedRelease, BumpFile } from '../types.ts';

/** Get the current HEAD commit SHA */
function getHeadSha(rootDir: string): string | null {
  return tryRunArgs(['git', 'rev-parse', 'HEAD'], { cwd: rootDir });
}

export interface GitHubReleaseOptions {
  dryRun?: boolean;
  title?: string;
  formatter?: ChangelogFormatter;
}

/** Create individual GitHub releases for each published package */
export async function createIndividualReleases(
  releases: PlannedRelease[],
  bumpFiles: BumpFile[],
  rootDir: string,
  opts: GitHubReleaseOptions = {},
): Promise<void> {
  if (!isGhAvailable()) {
    log.dim('  gh CLI not found — skipping GitHub releases');
    return;
  }

  const headSha = getHeadSha(rootDir);

  for (const release of releases) {
    const tag = `${release.name}@${release.newVersion}`;
    const body = opts.formatter
      ? await generateReleaseBody(release, bumpFiles, opts.formatter)
      : buildReleaseBody(release, bumpFiles);
    const title = `${release.name} v${release.newVersion}`;

    if (opts.dryRun) {
      log.dim(`  Would create GitHub release: ${title}`);
      continue;
    }

    try {
      // Use --target so gh can create the tag on the remote if it wasn't pushed yet
      const args = ['gh', 'release', 'create', tag, '--title', title, '--notes', body];
      if (headSha) args.push('--target', headSha);
      await runArgsAsync(args, {
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
  bumpFiles: BumpFile[],
  rootDir: string,
  opts: GitHubReleaseOptions = {},
): Promise<void> {
  if (!isGhAvailable()) {
    log.dim('  gh CLI not found — skipping GitHub release');
    return;
  }

  if (releases.length === 0) return;

  const date = new Date().toISOString().split('T')[0];
  const existing = listTags(`release-${date}*`, { cwd: rootDir });
  const { tag, title } = resolveAggregateTagAndTitle(date!, existing, opts.title);
  const body = opts.formatter
    ? await generateAggregateBody(releases, bumpFiles, opts.formatter)
    : buildAggregateBody(releases, bumpFiles);

  if (opts.dryRun) {
    log.dim(`  Would create aggregate GitHub release: ${title}`);
    log.dim(`  Tag: ${tag}`);
    return;
  }

  try {
    // Create the tag if it doesn't exist
    tryRunArgs(['git', 'tag', tag], { cwd: rootDir });

    // Use --target so gh can create the tag on the remote if it wasn't pushed yet
    const headSha = getHeadSha(rootDir);
    const args = ['gh', 'release', 'create', tag, '--title', title, '--notes', body];
    if (headSha) args.push('--target', headSha);
    await runArgsAsync(args, {
      cwd: rootDir,
    });
    log.success(`Created aggregate GitHub release: ${title}`);
  } catch (err) {
    log.warn(`Failed to create aggregate GitHub release: ${err instanceof Error ? err.message : err}`);
  }
}

/** Generate a release body for a single package using the changelog formatter */
async function generateReleaseBody(
  release: PlannedRelease,
  bumpFiles: BumpFile[],
  formatter: ChangelogFormatter,
): Promise<string> {
  const entry = await generateChangelogEntry(release, bumpFiles, formatter, undefined, 'github-release');
  // Strip the version heading — the GitHub release title already has the version
  return stripVersionHeading(entry).trim() || 'No changelog entries.';
}

/** Generate an aggregate release body using the changelog formatter */
async function generateAggregateBody(
  releases: PlannedRelease[],
  bumpFiles: BumpFile[],
  formatter: ChangelogFormatter,
): Promise<string> {
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
      const entry = await generateChangelogEntry(release, bumpFiles, formatter, undefined, 'github-release');
      const body = stripVersionHeading(entry).trim();
      if (body) {
        lines.push(body);
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

/** Strip the leading ## version heading and date sub-heading from a changelog entry */
function stripVersionHeading(entry: string): string {
  return entry
    .replace(/^## .+\n/, '') // remove ## version heading
    .replace(/^<sub>.+<\/sub>\n/, '') // remove <sub>date</sub> line
    .replace(/^_.+_\n/, ''); // remove _date_ line
}

function buildReleaseBody(release: PlannedRelease, bumpFiles: BumpFile[]): string {
  const lines: string[] = [];
  const relevant = bumpFiles.filter((bf) => release.bumpFiles.includes(bf.id));

  if (relevant.length > 0) {
    for (const bf of relevant) {
      if (bf.summary) {
        lines.push(`- ${bf.summary.split('\n')[0]}`);
      }
    }
  }

  if (release.isDependencyBump && relevant.length === 0) {
    lines.push('- Updated dependencies');
  }

  return lines.join('\n') || 'No changelog entries.';
}

function buildAggregateBody(releases: PlannedRelease[], bumpFiles: BumpFile[]): string {
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
      const relevant = bumpFiles.filter((bf) => release.bumpFiles.includes(bf.id));
      if (relevant.length > 0) {
        for (const bf of relevant) {
          if (bf.summary) {
            lines.push(`- ${bf.summary.split('\n')[0]}`);
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

/** Compute the aggregate release tag and title, appending -n suffix if a tag for the same date already exists */
export function resolveAggregateTagAndTitle(
  date: string,
  existingTags: string[],
  titleTemplate?: string,
): { tag: string; title: string } {
  const baseTag = `release-${date}`;
  const suffix = existingTags.length === 0 ? '' : `-${existingTags.length + 1}`;
  const tag = `${baseTag}${suffix}`;
  const template = titleTemplate || 'Release {{date}}';
  const title = template.replace('{{date}}', `${date}${suffix}`);
  return { tag, title };
}

function isGhAvailable(): boolean {
  return tryRunArgs(['gh', '--version']) !== null;
}
