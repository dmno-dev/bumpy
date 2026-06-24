import { resolve } from 'node:path';
import semver from 'semver';
import { readText, writeText, updateJsonFields, updateJsonNestedField } from '../utils/fs.ts';
import { runArgsAsync, tryRunArgs } from '../utils/shell.ts';
import { listTags } from './git.ts';
import type { ResolvedChannel } from './channels.ts';
import type { ReleasePlan, PlannedRelease, WorkspacePackage } from '../types.ts';

/**
 * Prerelease versions are never committed to git — they are derived at publish time:
 * the target (major.minor.patch) comes from the cycle's bump files via the normal
 * release plan, and the counter comes from the registry: max published `-<preid>.N`
 * for that target, plus one. This makes counters immune to branch resets, abandoned
 * cycles, and re-runs.
 */

/** Published prerelease state for one package at one target version */
export interface PublishedPrereleaseState {
  /** Existing counters for `<target>-<preid>.N` on the registry (or git tags for non-npm packages) */
  counters: number[];
  /** Whether the stable target version itself is already published */
  stablePublished: boolean;
}

/**
 * Extract existing prerelease counters for a target+preid from a list of published versions.
 * Only exact `<target>-<preid>.<N>` versions count — other preids and targets are ignored.
 */
export function extractPrereleaseCounters(versions: string[], target: string, preid: string): number[] {
  const counters: number[] = [];
  for (const v of versions) {
    const parsed = semver.parse(v);
    if (!parsed) continue;
    if (`${parsed.major}.${parsed.minor}.${parsed.patch}` !== target) continue;
    if (parsed.prerelease.length !== 2) continue;
    if (parsed.prerelease[0] !== preid) continue;
    const n = parsed.prerelease[1];
    if (typeof n === 'number') counters.push(n);
  }
  return counters;
}

/** Compute the next prerelease version: `<target>-<preid>.<max existing counter + 1>` */
export function nextPrereleaseVersion(target: string, preid: string, existingCounters: number[]): string {
  const next = existingCounters.length > 0 ? Math.max(...existingCounters) + 1 : 0;
  return `${target}-${preid}.${next}`;
}

/** Fetch all published versions of a package from the registry */
export async function fetchPublishedVersions(name: string, registry?: string): Promise<string[]> {
  const args = ['npm', 'info', name, 'versions', '--json'];
  if (registry) args.push('--registry', registry);
  try {
    const raw = await runArgsAsync(args);
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((v) => typeof v === 'string');
    if (typeof parsed === 'string') return [parsed]; // single-version packages
    return [];
  } catch {
    // Package doesn't exist yet (first prerelease ever) or registry unreachable
    return [];
  }
}

/** Fetch the gitHead recorded for a published version (set by npm publish from a git checkout) */
async function fetchGitHead(name: string, version: string, registry?: string): Promise<string | null> {
  const args = ['npm', 'info', `${name}@${version}`, 'gitHead'];
  if (registry) args.push('--registry', registry);
  try {
    const result = await runArgsAsync(args);
    const sha = result.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** Whether a package publishes through the npm registry (vs custom command / git-tag tracking) */
export function usesNpmRegistry(pkg: WorkspacePackage): boolean {
  return !pkg.bumpy?.publishCommand && !pkg.bumpy?.skipNpmPublish && !pkg.private;
}

/** Query published prerelease state for one package at a target version */
export async function getPublishedPrereleaseState(
  pkg: WorkspacePackage,
  target: string,
  preid: string,
  rootDir: string,
): Promise<PublishedPrereleaseState> {
  if (usesNpmRegistry(pkg)) {
    const versions = await fetchPublishedVersions(pkg.name, pkg.bumpy?.registry);
    return {
      counters: extractPrereleaseCounters(versions, target, preid),
      stablePublished: versions.includes(target),
    };
  }
  // Non-npm packages (custom publish command / skipNpmPublish) — derive from git tags,
  // matching how the stable flow tracks their published-ness.
  const tagVersions = listTags(`${pkg.name}@${target}-${preid}.*`, { cwd: rootDir }).map((t) =>
    t.slice(pkg.name.length + 1),
  );
  return {
    counters: extractPrereleaseCounters(tagVersions, target, preid),
    stablePublished: listTags(`${pkg.name}@${target}`, { cwd: rootDir }).length > 0,
  };
}

export interface ChannelReleasePlanResult {
  /** The plan with prerelease versions applied (packages already published from HEAD removed) */
  plan: ReleasePlan;
  /** Packages skipped because their latest prerelease was already published from this commit */
  alreadyPublished: Array<{ name: string; version: string }>;
  warnings: string[];
}

/**
 * Transform a stable release plan (targets computed from bump files) into a channel
 * prerelease plan: each release's newVersion becomes `<target>-<preid>.<N>` with N
 * derived from the registry floor.
 *
 * Idempotency: if a package's latest published prerelease for this target records a
 * gitHead equal to HEAD (or, for non-npm packages, its tag points at HEAD), the package
 * was already published from this exact commit — it is skipped rather than re-counted.
 */
export async function buildChannelReleasePlan(
  stablePlan: ReleasePlan,
  channel: ResolvedChannel,
  packages: Map<string, WorkspacePackage>,
  rootDir: string,
  opts: {
    /**
     * Display mode (release PR titles/bodies, status output): compute counters but
     * skip the published-from-HEAD checks — the numbers are advisory narrative and
     * the registry wins at actual publish time.
     */
    forDisplay?: boolean;
  } = {},
): Promise<ChannelReleasePlanResult> {
  const headSha = tryRunArgs(['git', 'rev-parse', 'HEAD'], { cwd: rootDir });
  const warnings: string[] = [...stablePlan.warnings];
  const alreadyPublished: Array<{ name: string; version: string }> = [];
  const releases: PlannedRelease[] = [];

  await Promise.all(
    stablePlan.releases.map(async (release) => {
      const pkg = packages.get(release.name);
      if (!pkg) return;
      // Unpublishable packages can't participate in a registry-consumable cycle
      if (pkg.private && !pkg.bumpy?.publishCommand) return;

      const target = release.newVersion; // stable target from the bump files
      const state = await getPublishedPrereleaseState(pkg, target, channel.preid, rootDir);

      if (state.stablePublished) {
        warnings.push(
          `${release.name}@${target} is already published as a stable release — ` +
            `merge ${target}'s release into the "${channel.branch}" branch so the cycle retargets.`,
        );
      }

      if (!opts.forDisplay && state.counters.length > 0 && headSha) {
        const latest = `${target}-${channel.preid}.${Math.max(...state.counters)}`;
        const publishedFromHead = usesNpmRegistry(pkg)
          ? (await fetchGitHead(pkg.name, latest, pkg.bumpy?.registry)) === headSha
          : tryRunArgs(['git', 'rev-parse', `refs/tags/${pkg.name}@${latest}`], { cwd: rootDir }) === headSha;
        if (publishedFromHead) {
          alreadyPublished.push({ name: release.name, version: latest });
          return;
        }
      }

      releases.push({
        ...release,
        newVersion: nextPrereleaseVersion(target, channel.preid, state.counters),
      });
    }),
  );

  releases.sort((a, b) => a.name.localeCompare(b.name));
  return {
    plan: { bumpFiles: stablePlan.bumpFiles, releases, warnings },
    alreadyPublished,
    warnings,
  };
}

/**
 * Transiently write computed versions (and exact pins for in-plan deps) into the
 * working tree's package.json files. Returns a restore function that puts the
 * original contents back — call it in a `finally` after publishing. Used by both
 * the channel prerelease flow and snapshot releases — neither commits its versions.
 *
 * Versions must be on disk before build/pack so that:
 * - PM pack picks up the version for the tarball
 * - builds that bake in the version (banners, __VERSION__) see the right one
 *
 * In-plan dependencies are pinned EXACTLY (`"1.2.0-rc.0"`, no range) so any
 * combination of packages installed from the dist-tag resolves to the
 * coherent set it was published with.
 */
export async function writeTransientVersionsInPlace(
  plan: ReleasePlan,
  packages: Map<string, WorkspacePackage>,
): Promise<() => Promise<void>> {
  const releaseMap = new Map(plan.releases.map((r) => [r.name, r]));
  const originals = new Map<string, string>();

  for (const release of plan.releases) {
    const pkg = packages.get(release.name);
    if (!pkg) continue;
    const pkgJsonPath = resolve(pkg.dir, 'package.json');
    originals.set(pkgJsonPath, await readText(pkgJsonPath));

    await updateJsonFields(pkgJsonPath, { version: release.newVersion });

    // Exact-pin in-cycle deps (dev deps excluded — not installed by consumers)
    for (const depField of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      const deps = pkg[depField];
      for (const depName of Object.keys(deps)) {
        const depRelease = releaseMap.get(depName);
        if (!depRelease) continue;
        await updateJsonNestedField(pkgJsonPath, depField, depName, depRelease.newVersion);
      }
    }
  }

  return async () => {
    for (const [path, content] of originals) {
      await writeText(path, content);
    }
  };
}

/**
 * Derive display versions for a channel cycle without touching the registry:
 * each target gets a wildcard counter (`1.2.0-rc.x`). Everything here comes from
 * committed state (bump files + config), so PR titles/bodies and commit messages
 * can never disagree with what eventually publishes. Unpublishable packages are
 * dropped, mirroring the filter in `buildChannelReleasePlan`.
 */
export function channelDisplayPlan(
  stablePlan: ReleasePlan,
  channel: ResolvedChannel,
  packages: Map<string, WorkspacePackage>,
): ReleasePlan {
  const releases = stablePlan.releases
    .filter((r) => {
      const pkg = packages.get(r.name);
      return !!pkg && !(pkg.private && !pkg.bumpy?.publishCommand);
    })
    .map((r) => ({ ...r, newVersion: `${r.newVersion}-${channel.preid}.x` }));
  return { ...stablePlan, releases };
}

/** One-line summary of a channel plan's versions, for PR titles and commit messages */
export function formatChannelVersionSummary(releases: PlannedRelease[]): string {
  if (releases.length === 0) return '';
  if (releases.length === 1) return `${releases[0]!.name}@${releases[0]!.newVersion}`;
  return `${releases.length} packages`;
}
