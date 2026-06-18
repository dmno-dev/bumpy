import { tryRunArgs, runArgsAsync } from '../utils/shell.ts';
import { log } from '../utils/logger.ts';
import { generateChangelogEntry } from './changelog.ts';
import type { ChangelogFormatter } from './changelog.ts';
import type { PlannedRelease, BumpFile, PackageConfig, WorkspacePackage } from '../types.ts';

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
      // Mark prerelease versions so they never show as "latest" on GitHub
      if (/-/.test(release.newVersion)) args.push('--prerelease');
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
  /** Human-readable label, e.g. "GitHub Packages" for npm targets on a GHP registry. Falls back to the target key. */
  label?: string;
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
    const label = state.label ?? name;
    switch (state.status) {
      case 'success':
        lines.push(state.url ? `- ✅ [${label}](${state.url})` : `- ✅ ${label}`);
        break;
      case 'failed':
        lines.push(`- ❌ ${label} — will retry on next CI run`);
        break;
      case 'skipped':
        lines.push(
          state.supersededBy
            ? `- ⏭️ ${label} — skipped (superseded by ${state.supersededBy})`
            : `- ⏭️ ${label} — skipped`,
        );
        break;
      case 'pending':
        lines.push(`- ⏳ ${label}`);
        break;
    }
  }
  return lines.join('\n');
}

const GITHUB_PACKAGES_HOST = 'npm.pkg.github.com';
const DEFAULT_NPM_HOST = 'registry.npmjs.org';

/** Extract the host from a registry URL, tolerating missing protocols and trailing slashes. */
function registryHost(registry: string): string {
  try {
    return new URL(registry).host;
  } catch {
    try {
      return new URL(`https://${registry}`).host;
    } catch {
      return '';
    }
  }
}

/** Whether a registry URL points at GitHub Packages (npm.pkg.github.com). */
export function isGitHubPackagesRegistry(registry?: string): boolean {
  return !!registry && registryHost(registry) === GITHUB_PACKAGES_HOST;
}

/** Whether a registry URL is the public npmjs.com registry (the default). */
function isDefaultNpmRegistry(registry?: string): boolean {
  return !registry || registryHost(registry) === DEFAULT_NPM_HOST;
}

/**
 * Human-readable label for a publish target, accounting for the configured registry.
 * An `npm`-type target on a GitHub Packages registry is labelled "GitHub Packages".
 */
export function publishTargetLabel(targetType: string, registry?: string): string {
  if (targetType === 'npm' && isGitHubPackagesRegistry(registry)) {
    return 'GitHub Packages';
  }
  return targetType;
}

/**
 * Resolve the effective publish registry for a package: the bumpy `registry` config
 * wins, falling back to npm-native `publishConfig.registry` in package.json.
 */
export function resolvePackageRegistry(
  pkg: WorkspacePackage | undefined,
  pkgConfig: Partial<PackageConfig> | undefined,
): string | undefined {
  if (pkgConfig?.registry) return pkgConfig.registry;
  const publishConfig = pkg?.packageJson?.publishConfig;
  if (publishConfig && typeof publishConfig === 'object' && 'registry' in publishConfig) {
    const registry = (publishConfig as { registry?: unknown }).registry;
    if (typeof registry === 'string' && registry) return registry;
  }
  return undefined;
}

/** Parse an "owner/repo" slug from a package.json `repository` field (string or object form). */
export function parseRepoSlug(repository: unknown): string | undefined {
  const url =
    typeof repository === 'string'
      ? repository
      : repository && typeof repository === 'object' && 'url' in repository
        ? String((repository as { url?: unknown }).url ?? '')
        : '';
  if (!url) return undefined;
  // Handles git+https://github.com/owner/repo.git, git@github.com:owner/repo.git, https://github.com/owner/repo
  const match = url.match(/github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?\/?(?:[#?].*)?$/);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

export interface BuildPublishUrlOptions {
  /** Configured registry for the package (bumpy config or publishConfig). */
  registry?: string;
  /** "owner/repo" slug, used to build GitHub Packages URLs. */
  repoSlug?: string;
}

/** Build a browsable URL for a published package, honouring the configured registry. */
export function buildPublishUrl(
  name: string,
  version: string,
  targetType: string,
  opts: BuildPublishUrlOptions = {},
): string | undefined {
  switch (targetType) {
    case 'npm': {
      if (isGitHubPackagesRegistry(opts.registry)) {
        // GitHub Packages has no per-version page; link to the package page under the repo.
        if (!opts.repoSlug) return undefined;
        const unscoped = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
        return `https://github.com/${opts.repoSlug}/pkgs/npm/${unscoped}`;
      }
      // Custom/private registries have no canonical browsable URL — avoid a dead npmjs.com link.
      if (!isDefaultNpmRegistry(opts.registry)) return undefined;
      return `https://www.npmjs.com/package/${name}/v/${version}`;
    }
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
  opts?: { prerelease?: boolean },
): Promise<void> {
  const args = ['gh', 'release', 'create', tag, '--title', title, '--notes', body, '--draft'];
  if (opts?.prerelease) args.push('--prerelease');
  if (targetSha) args.push('--target', targetSha);
  await withReleaseToken(() => runArgsAsync(args, { cwd: rootDir }));
}

/** Update an existing GitHub release's body */
export async function updateReleaseBody(tag: string, body: string, rootDir: string): Promise<void> {
  await withReleaseToken(() => runArgsAsync(['gh', 'release', 'edit', tag, '--notes', body], { cwd: rootDir }));
}

/** Finalize a draft release (remove draft status) */
export async function finalizeRelease(tag: string, rootDir: string): Promise<void> {
  await withReleaseToken(() => runArgsAsync(['gh', 'release', 'edit', tag, '--draft=false'], { cwd: rootDir }));
}

/** Delete a GitHub release */
export async function deleteRelease(tag: string, rootDir: string): Promise<void> {
  await withReleaseToken(() => runArgsAsync(['gh', 'release', 'delete', tag, '--yes'], { cwd: rootDir }));
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
