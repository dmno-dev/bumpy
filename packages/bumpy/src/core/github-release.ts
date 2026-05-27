import { tryRunArgs, runArgsAsync } from '../utils/shell.ts';
import { log } from '../utils/logger.ts';
import { generateChangelogEntry } from './changelog.ts';
import type { ChangelogFormatter } from './changelog.ts';
import type { PlannedRelease, BumpFile } from '../types.ts';

/** Get the current HEAD commit SHA */
export function getHeadSha(rootDir: string): string | null {
  return tryRunArgs(['git', 'rev-parse', 'HEAD'], { cwd: rootDir });
}

/**
 * Run an async function with BUMPY_GH_TOKEN as GH_TOKEN if available.
 *
 * GitHub releases created with the default GITHUB_TOKEN won't trigger
 * downstream workflows.  Using BUMPY_GH_TOKEN (a PAT or App token)
 * allows `release` events to fire follow-up workflows.
 *
 * Any errors are scrubbed so the token never appears in CI logs.
 */
async function withReleaseToken<T>(fn: () => Promise<T>): Promise<T> {
  const token = process.env.BUMPY_GH_TOKEN;
  if (!token) return fn();
  const original = process.env.GH_TOKEN;
  process.env.GH_TOKEN = token;
  try {
    return await fn();
  } catch (err) {
    // Redact token from error messages to prevent leakage in CI logs
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(msg.replaceAll(token, '***'));
  } finally {
    if (original !== undefined) {
      process.env.GH_TOKEN = original;
    } else {
      delete process.env.GH_TOKEN;
    }
  }
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
      await withReleaseToken(() => runArgsAsync(args, { cwd: rootDir }));
      log.dim(`  Created GitHub release: ${title}`);
    } catch (err) {
      log.warn(`  Failed to create GitHub release for ${tag}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/** Generate a release body for a single package using the changelog formatter */
export async function generateReleaseBody(
  release: PlannedRelease,
  bumpFiles: BumpFile[],
  formatter: ChangelogFormatter,
): Promise<string> {
  const entry = await generateChangelogEntry(release, bumpFiles, formatter, undefined, 'github-release');
  // Strip the version heading — the GitHub release title already has the version
  return stripVersionHeading(entry).trim() || 'No changelog entries.';
}

/** Strip the leading ## version heading and date sub-heading from a changelog entry */
function stripVersionHeading(entry: string): string {
  return entry
    .replace(/^## .+\n/, '') // remove ## version heading
    .replace(/^<sub>.+<\/sub>\n/, '') // remove <sub>date</sub> line
    .replace(/^_.+_\n/, ''); // remove _date_ line
}

export function buildReleaseBody(release: PlannedRelease, bumpFiles: BumpFile[]): string {
  const lines: string[] = [];
  const relevant = bumpFiles.filter((bf) => release.bumpFiles.includes(bf.id));

  if (relevant.length > 0) {
    for (const bf of relevant) {
      if (bf.summary) {
        lines.push(`- ${bf.summary.split('\n')[0]}`);
      }
    }
  }

  if (relevant.length === 0) {
    const sourceList = release.bumpSources.map((s) => `\`${s.name}\` v${s.newVersion}`).join(', ');
    if (release.isDependencyBump) {
      lines.push(sourceList ? `- Updated dependency ${sourceList}` : '- Updated dependencies');
    } else if (release.isGroupBump) {
      lines.push(sourceList ? `- Version bump from group with ${sourceList}` : '- Version bump from group');
    } else if (release.isCascadeBump) {
      lines.push(sourceList ? `- Version bump from ${sourceList}` : '- Version bump via cascade rule');
    }
  }

  return lines.join('\n') || 'No changelog entries.';
}

export function isGhAvailable(): boolean {
  return tryRunArgs(['gh', '--version']) !== null;
}

// ---- Draft release / publish tracking system ----

const METADATA_START = '<!-- bumpy-metadata';
const METADATA_END = 'bumpy-metadata -->';

export type PublishTargetStatus = 'pending' | 'success' | 'failed' | 'skipped';

export interface PublishTargetState {
  status: PublishTargetStatus;
  publishedAt?: string;
  error?: string;
  lastAttempt?: string;
  reason?: string;
  supersededBy?: string;
  url?: string;
}

export interface ReleaseMetadata {
  version: string;
  targets: Record<string, PublishTargetState>;
}

export interface DraftReleaseInfo {
  tag: string;
  title: string;
  body: string;
  isDraft: boolean;
  metadata: ReleaseMetadata | null;
}

/** Parse bumpy metadata from a release body */
export function parseReleaseMetadata(body: string): ReleaseMetadata | null {
  const startIdx = body.indexOf(METADATA_START);
  const endIdx = body.indexOf(METADATA_END);
  if (startIdx === -1 || endIdx === -1) return null;

  const jsonStr = body.slice(startIdx + METADATA_START.length, endIdx).trim();
  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

/** Serialize metadata into an HTML comment */
function serializeMetadata(metadata: ReleaseMetadata): string {
  return `${METADATA_START}\n${JSON.stringify(metadata, null, 2)}\n${METADATA_END}`;
}

/** Build the "Published to" section from target states */
export function formatPublishedToSection(targets: Record<string, PublishTargetState>): string {
  const lines: string[] = ['#### Published to'];
  for (const [name, state] of Object.entries(targets)) {
    switch (state.status) {
      case 'success':
        lines.push(state.url ? `- ✅ [${name}](${state.url})` : `- ✅ ${name}`);
        break;
      case 'failed':
        lines.push(`- ❌ ${name} — will retry on next CI run`);
        break;
      case 'skipped':
        lines.push(
          state.supersededBy
            ? `- ⏭️ ${name} — skipped (superseded by ${state.supersededBy})`
            : `- ⏭️ ${name} — skipped`,
        );
        break;
      case 'pending':
        lines.push(`- ⏳ ${name}`);
        break;
    }
  }
  return lines.join('\n');
}

/** Build a URL for a published package on a registry */
export function buildPublishUrl(
  name: string,
  version: string,
  targetType: string,
  _registry?: string,
): string | undefined {
  switch (targetType) {
    case 'npm':
      return `https://www.npmjs.com/package/${name}/v/${version}`;
    case 'jsr': {
      // JSR uses @scope/name format
      const parts = name.startsWith('@') ? name.slice(1).split('/') : [name];
      return parts.length === 2
        ? `https://jsr.io/@${parts[0]}/${parts[1]}@${version}`
        : `https://jsr.io/${name}@${version}`;
    }
    default:
      return undefined;
  }
}

/**
 * Compose a full release body from changelog content + publish status + metadata.
 * Preserves existing changelog content when updating (only replaces the status/metadata sections).
 */
export function composeReleaseBody(changelogContent: string, metadata: ReleaseMetadata): string {
  const publishSection = formatPublishedToSection(metadata.targets);
  const metadataComment = serializeMetadata(metadata);
  return `${changelogContent}\n\n${publishSection}\n\n${metadataComment}`;
}

/**
 * Update just the status/metadata sections of an existing release body,
 * preserving the changelog content above.
 */
export function updateReleaseBodyStatus(existingBody: string, metadata: ReleaseMetadata): string {
  // Find where the "Published to" section starts
  const publishIdx = existingBody.indexOf('#### Published to');
  const metaIdx = existingBody.indexOf(METADATA_START);

  // Determine where changelog content ends
  let changelogContent: string;
  if (publishIdx !== -1) {
    changelogContent = existingBody.slice(0, publishIdx).trimEnd();
  } else if (metaIdx !== -1) {
    changelogContent = existingBody.slice(0, metaIdx).trimEnd();
  } else {
    changelogContent = existingBody.trimEnd();
  }

  return composeReleaseBody(changelogContent, metadata);
}

/** Look up an existing GitHub release (draft or published) by tag */
export async function findReleaseByTag(tag: string, rootDir: string): Promise<DraftReleaseInfo | null> {
  if (!isGhAvailable()) return null;

  try {
    const json = await runArgsAsync(['gh', 'release', 'view', tag, '--json', 'tagName,name,body,isDraft'], {
      cwd: rootDir,
    });
    const data = JSON.parse(json);
    return {
      tag: data.tagName,
      title: data.name,
      body: data.body,
      isDraft: data.isDraft,
      metadata: parseReleaseMetadata(data.body),
    };
  } catch {
    return null;
  }
}

/** Create a draft GitHub release */
export async function createDraftRelease(
  tag: string,
  title: string,
  body: string,
  rootDir: string,
  targetSha?: string,
): Promise<void> {
  const args = ['gh', 'release', 'create', tag, '--title', title, '--notes', body, '--draft'];
  if (targetSha) args.push('--target', targetSha);
  await runArgsAsync(args, { cwd: rootDir });
}

/** Update an existing GitHub release's body */
export async function updateReleaseBody(tag: string, body: string, rootDir: string): Promise<void> {
  await runArgsAsync(['gh', 'release', 'edit', tag, '--notes', body], { cwd: rootDir });
}

/** Finalize a draft release (remove draft status) */
export async function finalizeRelease(tag: string, rootDir: string): Promise<void> {
  await runArgsAsync(['gh', 'release', 'edit', tag, '--draft=false'], { cwd: rootDir });
}

/** Delete a GitHub release */
export async function deleteRelease(tag: string, rootDir: string): Promise<void> {
  await runArgsAsync(['gh', 'release', 'delete', tag, '--yes'], { cwd: rootDir });
}

/** Find draft releases for a package (by name prefix) that are older than the current version */
export async function findStaleDraftReleases(
  packageName: string,
  currentVersion: string,
  rootDir: string,
): Promise<Array<{ tag: string; body: string; metadata: ReleaseMetadata | null }>> {
  if (!isGhAvailable()) return [];

  const currentTag = `${packageName}@${currentVersion}`;
  try {
    const json = await runArgsAsync(['gh', 'release', 'list', '--json', 'tagName,isDraft,name', '--limit', '20'], {
      cwd: rootDir,
    });
    const releases: Array<{ tagName: string; isDraft: boolean; name: string }> = JSON.parse(json);

    const stale: Array<{ tag: string; body: string; metadata: ReleaseMetadata | null }> = [];
    for (const r of releases) {
      // Only look at drafts for the same package with a different version
      if (!r.isDraft) continue;
      if (!r.tagName.startsWith(`${packageName}@`)) continue;
      if (r.tagName === currentTag) continue;

      // Fetch full body to check metadata
      const info = await findReleaseByTag(r.tagName, rootDir);
      if (info) {
        stale.push({ tag: r.tagName, body: info.body, metadata: info.metadata });
      }
    }
    return stale;
  } catch {
    return [];
  }
}

/**
 * Finalize stale draft releases as superseded.
 * Updates their metadata targets to "skipped" and marks them as non-draft.
 */
export async function finalizeSupersededDrafts(
  packageName: string,
  newVersion: string,
  rootDir: string,
): Promise<void> {
  const staleDrafts = await findStaleDraftReleases(packageName, newVersion, rootDir);

  for (const draft of staleDrafts) {
    log.dim(`  Finalizing draft release ${draft.tag} — superseded by ${newVersion}`);

    if (draft.metadata) {
      // Update all non-success targets to "skipped"
      for (const [targetName, state] of Object.entries(draft.metadata.targets)) {
        if (state.status !== 'success') {
          draft.metadata.targets[targetName] = {
            status: 'skipped',
            reason: 'superseded',
            supersededBy: newVersion,
          };
        }
      }
      const updatedBody = updateReleaseBodyStatus(draft.body, draft.metadata);
      try {
        await updateReleaseBody(draft.tag, updatedBody, rootDir);
        await finalizeRelease(draft.tag, rootDir);
      } catch (err) {
        log.warn(`  Failed to finalize superseded release ${draft.tag}: ${err instanceof Error ? err.message : err}`);
      }
    } else {
      // No metadata — just finalize the draft as-is
      try {
        await finalizeRelease(draft.tag, rootDir);
      } catch (err) {
        log.warn(`  Failed to finalize superseded release ${draft.tag}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
}
