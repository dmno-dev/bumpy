import { resolve } from 'node:path';
import { rm } from 'node:fs/promises';
import semver from 'semver';
import { readJson, updateJsonNestedField } from '../utils/fs.ts';
import { runStreaming } from '../utils/shell.ts';
import { log, colorize } from '../utils/logger.ts';
import { DependencyGraph } from './dep-graph.ts';
import { stripProtocol } from './semver.ts';
import { resolveCatalogDep, type CatalogMap } from '../utils/package-manager.ts';
import { getPackageTargets, targetSupportsRelease } from './targets/registry.ts';
import type { ReleaseKind, ResolvedTarget, TargetPhase, TargetPublishContext } from './targets/types.ts';
import type { PublishTargetState } from './github-release.ts';
import type { ReleasePlan, PlannedRelease, WorkspacePackage, BumpyConfig, PackageManager } from '../types.ts';

// Re-exported for callers/tests that historically imported these from the pipeline
export { detectOidcProvider, willUseOidcExclusively } from './targets/npm.ts';

export interface PublishOptions {
  dryRun?: boolean;
  tag?: string; // npm dist-tag (e.g., "next", "beta")
  /** What kind of release this is — targets can opt out of snapshots/prereleases */
  releaseKind?: ReleaseKind;
  /**
   * Per-package target states recorded by previous runs (from the GitHub release
   * metadata). Targets already `success` are skipped — per-target resume: if npm
   * succeeded and open-vsx failed, the retry only re-runs open-vsx. `staged` targets
   * are re-checked against the registry and skipped while still awaiting approval.
   */
  priorStates?: Map<string, Record<string, PublishTargetState>>;
  /**
   * Restrict the run to targets of one phase. The publish flow runs the `release`
   * phase, publishes the GitHub release, then runs `post-release` (targets that need
   * the release's public URLs). Unset = every target in one pass (snapshots, tests).
   * Builds and protocol resolution happen in the release pass only.
   */
  phase?: TargetPhase;
}

export interface TargetOutcome {
  /** Target instance name (the release-metadata key) */
  target: string;
  type: string;
  /**
   * - success: live on the registry
   * - staged: accepted but held by the registry for an out-of-band step (npm 2FA approval)
   * - failed: errored, or blocked because a dependency failed on this same target
   * - skipped: see `skipKind`
   */
  status: 'success' | 'staged' | 'failed' | 'skipped';
  error?: string;
  /** Registry handle for a staged publish (e.g. the npm stage id) */
  ref?: string;
  /** Human-readable skip explanation (display only — logic switches on skipKind) */
  reason?: string;
  /**
   * Why a target was skipped, structurally:
   * - 'metadata': release metadata already records success (per-target resume)
   * - 'registry': the pre-publish guard found the version live on the registry
   * - 'staged': a previous run staged it and it is still awaiting approval
   * - 'capability': the target opted out of this release kind (snapshot/prerelease)
   * Metadata/registry skips mean the version IS live — consumers treat them as
   * success for release-metadata purposes.
   */
  skipKind?: 'metadata' | 'registry' | 'staged' | 'capability';
}

export interface PublishResult {
  /** Packages where at least one target went live this run */
  published: { name: string; version: string }[];
  /** Packages where at least one target was staged (accepted, awaiting approval) this run */
  staged: { name: string; version: string }[];
  /** Packages that published nothing (no targets, all targets skipped, private, ...) */
  skipped: { name: string; reason: string }[];
  /** Packages where at least one target failed (may also appear in `published`) */
  failed: { name: string; error: string }[];
  /** Per-package, per-target outcomes for this run */
  targetOutcomes: Map<string, TargetOutcome[]>;
}

/** Combine the results of two pipeline passes (release + post-release phases) */
export function mergePublishResults(a: PublishResult, b: PublishResult): PublishResult {
  const byName = <T extends { name: string }>(x: T[], y: T[]) => [
    ...x,
    ...y.filter((r) => !x.some((s) => s.name === r.name)),
  ];
  const targetOutcomes = new Map(a.targetOutcomes);
  for (const [name, outcomes] of b.targetOutcomes) {
    targetOutcomes.set(name, [...(targetOutcomes.get(name) ?? []), ...outcomes]);
  }
  return {
    published: byName(a.published, b.published),
    staged: byName(a.staged, b.staged),
    skipped: byName(a.skipped, b.skipped).filter((s) => !a.published.some((p) => p.name === s.name)),
    failed: [
      ...a.failed.filter((f) => !b.failed.some((g) => g.name === f.name)),
      ...b.failed.map((f) => {
        const prior = a.failed.find((g) => g.name === f.name);
        return prior ? { name: f.name, error: `${prior.error}; ${f.error}` } : f;
      }),
    ],
    targetOutcomes,
  };
}

/**
 * Whether a package's run left the version out on some registry: something went live
 * or was staged now, or the registry guard found it already live. The release
 * orchestration uses this to decide that the version's git tag must exist.
 */
export function releaseShipped(outcomes: TargetOutcome[]): boolean {
  return outcomes.some((o) => o.status === 'success' || o.status === 'staged' || o.skipKind === 'registry');
}

/**
 * Publish all packages in the release plan.
 *
 * Order: topological across packages (dependencies before dependents), declared
 * order across each package's targets. One target failing does not block sibling
 * targets on the same package — but it does block the SAME target on dependents:
 * `B@jsr` must not go out referencing an `A@jsr` that never landed. Blocked targets
 * are recorded as failures and retried on the next run, after the dependency.
 *
 * The pipeline publishes; it does not tag or touch GitHub releases — the caller
 * orchestrates those from the outcomes.
 */
export async function publishPackages(
  releasePlan: ReleasePlan,
  packages: Map<string, WorkspacePackage>,
  depGraph: DependencyGraph,
  config: BumpyConfig,
  rootDir: string,
  opts: PublishOptions = {},
  catalogs: CatalogMap = new Map(),
  detectedPm: PackageManager = 'npm',
): Promise<PublishResult> {
  const result: PublishResult = { published: [], staged: [], skipped: [], failed: [], targetOutcomes: new Map() };
  const releaseKind = opts.releaseKind ?? 'stable';

  // Topological sort for correct publish order
  const topoOrder = depGraph.topologicalSort(packages);
  const releaseMap = new Map(releasePlan.releases.map((r) => [r.name, r]));

  // Filter to only packages that need publishing, in topo order
  const ordered: PlannedRelease[] = [];
  for (const name of topoOrder) {
    const release = releaseMap.get(name);
    if (release) ordered.push(release);
  }

  // Preflight each unique target instance once, before anything publishes.
  // A preflight throw aborts the whole run — better than failing halfway through.
  // Instances are distinct by name AND options: inline entries in different packages
  // share a name (it defaults to the type) while carrying different options, and each
  // combination needs its own validation (npmStaged, provenance, ...).
  const inPhase = (t: ResolvedTarget) => !opts.phase || t.phase === opts.phase;
  const preflighted = new Set<string>();
  for (const release of ordered) {
    const pkg = packages.get(release.name)!;
    for (const target of getPackageTargets(pkg, config).filter(inPhase)) {
      const key = `${target.name}\0${JSON.stringify(target.options)}`;
      if (preflighted.has(key)) continue;
      preflighted.add(key);
      await target.plugin.preflight?.({
        rootDir,
        config,
        options: target.options,
        dryRun: !!opts.dryRun,
      });
    }
  }

  // Targets that failed (or were blocked) this run, per package — dependents consult
  // this so a dependency's failure on target T blocks their own publish to T
  const failedTargets = new Map<string, Set<string>>();

  for (const release of ordered) {
    const pkg = packages.get(release.name)!;
    const pkgConfig = pkg.bumpy || {};
    const allTargets = getPackageTargets(pkg, config);
    const targets = allTargets.filter(inPhase);
    const prior = opts.priorStates?.get(release.name) ?? {};
    const buildPass = opts.phase !== 'post-release';

    // The post-release pass only touches packages with post-release targets
    if (!buildPass && targets.length === 0) continue;

    // Private packages with no targets publish nowhere and build nothing
    if (allTargets.length === 0 && pkg.private) {
      result.skipped.push({ name: release.name, reason: 'private' });
      continue;
    }

    // A public package with no targets (`publishTargets: []`) still goes through the
    // build step below — dependents may bundle its output — and is tracked by git tag
    if (targets.length > 0) {
      log.step(`Publishing ${colorize(release.name, 'cyan')}@${release.newVersion}`);
    } else if (allTargets.length === 0) {
      log.step(`Preparing ${colorize(release.name, 'cyan')}@${release.newVersion} (no publish targets)`);
    } else {
      log.step(
        `Building ${colorize(release.name, 'cyan')}@${release.newVersion} (targets run after the release is published)`,
      );
    }

    const outcomes: TargetOutcome[] = [];
    result.targetOutcomes.set(release.name, outcomes);
    // Artifacts shared across this package's targets, keyed by artifact kind
    const artifacts = new Map<string, string>();

    try {
      // 1. Build (once per package, before any target — release pass only)
      if (pkgConfig.buildCommand && buildPass) {
        log.dim(`  Building...`);
        if (!opts.dryRun) {
          await runStreaming(pkgConfig.buildCommand, { cwd: pkg.dir });
        }
      }

      // 2. Resolve workspace:/catalog: protocols in-place when any target reads the
      //    manifest from the package dir (custom commands, vsce, npm in-place mode)
      const needsInPlaceResolve =
        buildPass && allTargets.some((t) => t.plugin.needsProtocolResolution?.(t.options, config));
      if (needsInPlaceResolve) {
        // Always write resolved protocols — dryRun only skips the actual publish commands
        await resolveProtocolsInPlace(pkg, packages, releasePlan, catalogs);
      }

      // 3. Publish each target
      const isPrerelease = semver.prerelease(release.newVersion) !== null;
      const inPlanDeps = planDependencies(pkg, releaseMap);
      for (const target of targets) {
        const blockedBy = inPlanDeps.find((dep) => failedTargets.get(dep)?.has(target.name));
        const outcome = blockedBy
          ? blockedOutcome(target, blockedBy)
          : await publishOneTarget(target, {
              pkg,
              pkgConfig,
              release,
              config,
              rootDir,
              opts,
              releaseKind,
              isPrerelease,
              prior: prior[target.name],
              artifacts,
              detectedPm,
            });
        outcomes.push(outcome);
        if (outcome.status === 'failed') {
          log.error(`  Failed to publish ${release.name} → ${target.name}: ${outcome.error}`);
        }
      }
    } catch (err) {
      // Package-level failure (build / protocol resolution) — no target ran, so every
      // target counts as failed for dependents
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error(`  Failed to publish ${release.name}: ${errMsg}`);
      result.failed.push({ name: release.name, error: errMsg });
      failedTargets.set(release.name, new Set(targets.map((t) => t.name)));
      await cleanupArtifacts(artifacts);
      continue;
    }

    await cleanupArtifacts(artifacts);

    if (allTargets.length === 0) {
      result.skipped.push({ name: release.name, reason: 'no publish targets' });
      continue;
    }
    if (targets.length === 0) continue; // built; its targets run in the post-release pass

    // Package-level classification
    const succeededNow = outcomes.filter((o) => o.status === 'success');
    const stagedNow = outcomes.filter((o) => o.status === 'staged');
    const failedNow = outcomes.filter((o) => o.status === 'failed');
    if (failedNow.length > 0) {
      failedTargets.set(release.name, new Set(failedNow.map((o) => o.target)));
    }
    if (succeededNow.length > 0) {
      result.published.push({ name: release.name, version: release.newVersion });
    }
    if (stagedNow.length > 0) {
      result.staged.push({ name: release.name, version: release.newVersion });
    }
    if (succeededNow.length > 0 || stagedNow.length > 0) {
      const shipped = [...succeededNow, ...stagedNow];
      const summary =
        targets.length === 1
          ? ''
          : ` (${shipped.map((o) => o.target).join(', ')}${failedNow.length ? ` — ${failedNow.length} failed` : ''})`;
      const verb = succeededNow.length > 0 ? 'Published' : 'Staged';
      log.success(`  ${verb} ${release.name}@${release.newVersion}${summary}`);
    } else if (failedNow.length === 0) {
      const alreadyLive = (o: TargetOutcome) => o.skipKind === 'metadata' || o.skipKind === 'registry';
      const reason = outcomes.every(alreadyLive) ? 'already published' : (outcomes[0]?.reason ?? 'all targets skipped');
      result.skipped.push({ name: release.name, reason });
    }
    if (failedNow.length > 0) {
      result.failed.push({
        name: release.name,
        error: failedNow.map((o) => `${o.target}: ${o.error}`).join('; '),
      });
    }
  }

  return result;
}

/** Runtime dependencies of `pkg` that are part of this release plan (dev deps aren't installed by consumers) */
function planDependencies(pkg: WorkspacePackage, releaseMap: Map<string, PlannedRelease>): string[] {
  const names = new Set<string>();
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
    for (const dep of Object.keys(pkg[field])) {
      if (releaseMap.has(dep)) names.add(dep);
    }
  }
  return [...names];
}

function blockedOutcome(target: ResolvedTarget, dependency: string): TargetOutcome {
  log.dim(`  Skipping ${target.name} — dependency ${dependency} failed on ${target.name} this run`);
  return {
    target: target.name,
    type: target.type,
    status: 'failed',
    error: `blocked: dependency ${dependency} failed on ${target.name} — retried on the next run`,
  };
}

async function publishOneTarget(
  target: ResolvedTarget,
  args: {
    pkg: WorkspacePackage;
    pkgConfig: WorkspacePackage['bumpy'] & {};
    release: PlannedRelease;
    config: BumpyConfig;
    rootDir: string;
    opts: PublishOptions;
    releaseKind: ReleaseKind;
    isPrerelease: boolean;
    prior: PublishTargetState | undefined;
    artifacts: Map<string, string>;
    detectedPm: PackageManager;
  },
): Promise<TargetOutcome> {
  const { pkg, release, config, opts, releaseKind, isPrerelease, prior, artifacts } = args;
  const base = { target: target.name, type: target.type };

  // Already live per a previous run's release metadata — don't re-publish
  if (prior?.status === 'success') {
    log.dim(`  Skipping ${target.name} — already published (per release metadata)`);
    return { ...base, status: 'skipped', skipKind: 'metadata', reason: 'already published' };
  }

  // Capability gates (planners drop packages where no target passes these; this is
  // the per-target guard for mixed packages, e.g. npm + marketplace on a prerelease)
  const caps = target.plugin.capabilities;
  if (!targetSupportsRelease(target, releaseKind, isPrerelease)) {
    const snapshotGate = releaseKind === 'snapshot' && !caps.snapshots;
    log.dim(
      `  Skipping ${target.name} — target does not support ${snapshotGate ? 'snapshot releases' : 'prerelease versions'}`,
    );
    const reason = snapshotGate ? 'snapshots not supported' : 'prereleases not supported';
    return { ...base, status: 'skipped', skipKind: 'capability', reason };
  }

  // The registry is the source of truth for "is it live": ask before every publish.
  // Even without release metadata (gh unavailable, draft deleted), never publish a
  // version that's already out — registries reject republishes with far less helpful
  // errors. Runs before the artifact build so a fully-published package doesn't
  // rebuild anything. Also how a staged publish is promoted once approved.
  if (!opts.dryRun) {
    const live = target.plugin.checkPublished
      ? await target.plugin.checkPublished(pkg, release.newVersion, target.options).catch(() => null)
      : null;
    if (live === true) {
      log.dim(`  Skipping ${target.name} — ${release.newVersion} already on registry`);
      return { ...base, status: 'skipped', skipKind: 'registry', reason: 'already on registry' };
    }
    if (prior?.status === 'staged') {
      // Staged by a previous run and not live yet — re-staging would be a duplicate
      log.dim(`  Skipping ${target.name} — staged, awaiting approval${prior.ref ? ` (stage ${prior.ref})` : ''}`);
      return { ...base, status: 'skipped', skipKind: 'staged', reason: 'awaiting approval', ref: prior.ref };
    }
  }

  try {
    const ctx: TargetPublishContext = {
      pkg,
      pkgConfig: args.pkgConfig,
      version: release.newVersion,
      rootDir: args.rootDir,
      config,
      options: target.options,
      distTag: caps.distTags ? opts.tag : undefined,
      dryRun: !!opts.dryRun,
      releaseKind,
      packManager: args.detectedPm,
    };

    // Per-target pre-publish step (e.g. publish-time version sync into jsr.json /
    // pyproject.toml). Runs after all skip gates so a skipped target never mutates
    // files. Also runs on dry runs — its validation (missing manifests, unclaimed
    // packages) is exactly what dry runs exist to surface; plugins skip only their
    // file writes when ctx.dryRun is set.
    await target.plugin.prepare?.(ctx);

    // Shared artifact: build once per (package, kind), reuse across sibling targets
    const kind = target.plugin.artifactKind?.(target.options, config);
    if (kind) {
      if (!artifacts.has(kind)) {
        if (opts.dryRun) {
          artifacts.set(kind, `<${kind}>`);
        } else {
          if (!target.plugin.buildArtifact) {
            throw new Error(`target "${target.name}" declares artifact kind "${kind}" but has no buildArtifact`);
          }
          artifacts.set(kind, await target.plugin.buildArtifact(ctx));
        }
      }
      ctx.artifactPath = artifacts.get(kind);
    }

    const hookResult = await target.plugin.publish(ctx);
    if (hookResult?.status === 'staged') {
      return { ...base, status: 'staged', ref: hookResult.ref };
    }
    return { ...base, status: 'success' };
  } catch (err) {
    return { ...base, status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}

/** Delete shared artifacts (tarballs, vsix files, python dist dirs) built during a package's publish */
async function cleanupArtifacts(artifacts: Map<string, string>): Promise<void> {
  for (const path of artifacts.values()) {
    if (path.startsWith('<')) continue; // dry-run placeholder
    try {
      await rm(path, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  artifacts.clear();
}

/**
 * Resolve workspace:/catalog: protocols by rewriting package.json in-place.
 * Used for custom publish commands and "in-place" protocolResolution mode.
 */
async function resolveProtocolsInPlace(
  pkg: WorkspacePackage,
  packages: Map<string, WorkspacePackage>,
  releasePlan: ReleasePlan,
  catalogs: CatalogMap,
): Promise<void> {
  const pkgJsonPath = resolve(pkg.dir, 'package.json');
  const pkgJson = await readJson<Record<string, unknown>>(pkgJsonPath);
  const releaseMap = new Map(releasePlan.releases.map((r) => [r.name, r]));

  for (const depField of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
    const deps = pkgJson[depField] as Record<string, string> | undefined;
    if (!deps) continue;

    for (const [depName, range] of Object.entries(deps)) {
      let resolved: string | null = null;

      if (range.startsWith('catalog:')) {
        resolved = resolveCatalogDep(depName, range, catalogs);
        if (!resolved) {
          log.warn(`  Could not resolve ${depName}: "${range}" — catalog entry not found`);
          continue;
        }
      } else if (range.startsWith('workspace:')) {
        const cleanRange = stripProtocol(range);

        if (cleanRange === '*' || cleanRange === '^' || cleanRange === '~') {
          const depPkg = packages.get(depName);
          const depRelease = releaseMap.get(depName);
          const version = depRelease?.newVersion || depPkg?.version || '0.0.0';
          const prefix = cleanRange === '*' ? '^' : cleanRange;
          resolved = `${prefix}${version}`;
        } else {
          resolved = cleanRange;
        }
      }

      if (resolved) {
        await updateJsonNestedField(pkgJsonPath, depField, depName, resolved);
      }
    }
  }
}
