import semver from 'semver';
import { tryRunArgs } from '../utils/shell.ts';
import { fetchPublishedVersions, usesNpmRegistry } from './prerelease.ts';
import type { BumpyConfig, ReleasePlan, PlannedRelease, WorkspacePackage } from '../types.ts';

/**
 * Snapshot releases publish the pending release plan transiently — a throwaway
 * preview of "what the next release would be", under a non-`latest` dist-tag — without
 * consuming bump files, writing changelogs, committing, or creating git/GitHub releases.
 *
 * The target (major.minor.patch) comes from the normal release plan; the snapshot name
 * is both the version preid and (by default) the dist-tag. What makes each publish unique
 * is the configured `versionStrategy`:
 * - `sha` → `<target>-<name>-<short-sha>` — idempotent per commit (re-runs skip)
 * - `timestamp` → `<target>-<name>-<UTC timestamp>` — always unique
 */

export type SnapshotVersionStrategy = BumpyConfig['snapshot']['versionStrategy'];

/** A snapshot request with name sanitized and per-run suffix resolved */
export interface ResolvedSnapshot {
  /** Raw name as passed on the CLI (for messages) */
  rawName: string;
  /** Sanitized name — used as the version preid and the default dist-tag */
  name: string;
  /** npm dist-tag the snapshot publishes to (explicit `--tag` wins, else the name) */
  tag: string;
  strategy: SnapshotVersionStrategy;
  /** Version suffix shared across every package in the run (the short sha or timestamp) */
  suffix: string;
}

/**
 * Turn a name into a valid semver prerelease identifier / npm dist-tag: lowercase,
 * non-alphanumeric runs collapsed to `-`, leading/trailing `-` trimmed. So a branch
 * name like `feature/Foo_Bar` becomes `feature-foo-bar`.
 */
export function sanitizeSnapshotName(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!cleaned) {
    throw new Error(`Invalid snapshot name "${name}" — must contain at least one alphanumeric character.`);
  }
  return cleaned;
}

/** Short (7-char) HEAD sha, or null outside a git repo */
function shortHeadSha(rootDir: string): string | null {
  const sha = tryRunArgs(['git', 'rev-parse', '--short=7', 'HEAD'], { cwd: rootDir });
  return sha && /^[0-9a-f]{7,}$/.test(sha) ? sha : null;
}

/** Compact UTC timestamp `YYYYMMDDHHmmss` (numeric, stable-sorting) */
function utcTimestamp(date: Date): string {
  const p = (n: number, len = 2) => String(n).padStart(len, '0');
  return (
    `${p(date.getUTCFullYear(), 4)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`
  );
}

/**
 * Resolve a snapshot request: sanitize the name, pick the dist-tag, and compute the
 * per-run version suffix for `sha`/`timestamp`. `now` is injectable for deterministic tests.
 */
export function resolveSnapshot(
  rawName: string,
  config: BumpyConfig,
  rootDir: string,
  opts: { tag?: string; now?: Date } = {},
): ResolvedSnapshot {
  const name = sanitizeSnapshotName(rawName);
  const strategy = config.snapshot.versionStrategy;

  let suffix: string;
  if (strategy === 'sha') {
    const sha = shortHeadSha(rootDir);
    if (!sha) {
      throw new Error(
        'Snapshot versionStrategy "sha" needs a git commit to derive the version from, but HEAD could not be resolved.\n' +
          '  Commit your changes (or switch `snapshot.versionStrategy` to "timestamp").',
      );
    }
    suffix = sha;
  } else {
    suffix = utcTimestamp(opts.now ?? new Date());
  }

  return { rawName, name, tag: opts.tag ?? name, strategy, suffix };
}

/** Compose the snapshot version for one target: `<target>-<name>-<suffix>` */
export function snapshotVersion(target: string, snapshot: ResolvedSnapshot): string {
  return `${target}-${snapshot.name}-${snapshot.suffix}`;
}

export interface SnapshotReleasePlanResult {
  /** The plan with snapshot versions applied (packages already published from this commit removed) */
  plan: ReleasePlan;
  /** Packages skipped because this exact snapshot version was already published */
  alreadyPublished: Array<{ name: string; version: string }>;
  warnings: string[];
}

/**
 * Transform a stable release plan (targets from bump files) into a snapshot plan: each
 * release's newVersion becomes the snapshot version. Unpublishable private packages are
 * dropped — a snapshot has to be installable from a registry to be useful.
 *
 * Idempotency: if the exact snapshot version is already on the registry, the package is
 * skipped rather than re-published (npm forbids republishing). For `sha` this means
 * re-running on the same commit is a no-op; `timestamp` versions essentially never collide.
 */
export async function buildSnapshotReleasePlan(
  stablePlan: ReleasePlan,
  snapshot: ResolvedSnapshot,
  packages: Map<string, WorkspacePackage>,
): Promise<SnapshotReleasePlanResult> {
  const warnings = [...stablePlan.warnings];
  const alreadyPublished: Array<{ name: string; version: string }> = [];
  const releases: PlannedRelease[] = [];

  await Promise.all(
    stablePlan.releases.map(async (release) => {
      const pkg = packages.get(release.name);
      if (!pkg) return;
      // Unpublishable packages can't be installed from a dist-tag — nothing to snapshot
      if (pkg.private && !pkg.bumpy?.publishCommand) return;

      const target = release.newVersion; // stable target from the bump files
      const version = snapshotVersion(target, snapshot);

      // The version embeds its own uniqueness (sha/timestamp), so a collision means we
      // already published this exact snapshot — skip to stay idempotent (re-run on the
      // same commit). Only registry-backed packages can be checked this way.
      if (usesNpmRegistry(pkg)) {
        const versions = await fetchPublishedVersions(pkg.name, pkg.bumpy?.registry);
        if (versions.includes(version)) {
          alreadyPublished.push({ name: release.name, version });
          return;
        }
      }

      releases.push({ ...release, newVersion: version });
    }),
  );

  releases.sort((a, b) => a.name.localeCompare(b.name));
  return { plan: { bumpFiles: stablePlan.bumpFiles, releases, warnings }, alreadyPublished, warnings };
}

/** One-line summary of a snapshot plan's versions, for logs and PR comments */
export function formatSnapshotVersionSummary(releases: PlannedRelease[]): string {
  if (releases.length === 0) return '';
  if (releases.length === 1) return `${releases[0]!.name}@${releases[0]!.newVersion}`;
  return `${releases.length} packages`;
}

/** Guard: a snapshot version must be a valid prerelease (never collides with a stable release) */
export function assertSnapshotPrerelease(version: string): void {
  if (semver.prerelease(version) === null) {
    throw new Error(`Snapshot version "${version}" is not a prerelease — refusing to publish (would land on @latest).`);
  }
}
