import { resolve } from 'node:path';
import { rm } from 'node:fs/promises';
import semver from 'semver';
import { readJson, updateJsonNestedField } from '../utils/fs.ts';
import { runStreaming } from '../utils/shell.ts';
import { log, colorize } from '../utils/logger.ts';
import { createTag, tagExists } from './git.ts';
import { DependencyGraph } from './dep-graph.ts';
import { stripProtocol } from './semver.ts';
import { resolveCatalogDep, type CatalogMap } from '../utils/package-manager.ts';
import { getPackageTargets } from './targets/registry.ts';
import type { ReleaseKind, ResolvedTarget, TargetPublishContext } from './targets/types.ts';
import type { ReleasePlan, PlannedRelease, WorkspacePackage, BumpyConfig, PackageManager } from '../types.ts';

// Re-exported for callers/tests that historically imported these from the pipeline
export { detectOidcProvider, willUseOidcExclusively } from './targets/npm.ts';

export interface PublishOptions {
  dryRun?: boolean;
  tag?: string; // npm dist-tag (e.g., "next", "beta")
  /** Skip creating git tags (snapshot releases are ephemeral and never tagged) */
  noTag?: boolean;
  /** What kind of release this is — targets can opt out of snapshots/prereleases */
  releaseKind?: ReleaseKind;
  /**
   * Target instance names that already succeeded in a previous run, per package
   * (from GitHub release metadata). These are skipped, giving per-target resume:
   * if npm succeeded and open-vsx failed, the retry only re-runs open-vsx.
   */
  completedTargets?: Map<string, Set<string>>;
}

export interface TargetOutcome {
  /** Target instance name (the release-metadata key) */
  target: string;
  type: string;
  status: 'success' | 'failed' | 'skipped';
  error?: string;
  /** Human-readable skip explanation (display only — logic switches on skipKind) */
  reason?: string;
  /**
   * Why a target was skipped, structurally:
   * - 'metadata': release metadata already records success (per-target resume)
   * - 'registry': the pre-publish guard found the version live on the registry
   * - 'capability': the target opted out of this release kind (snapshot/prerelease)
   * Metadata/registry skips mean the version IS live — consumers treat them as
   * success for tagging and release-metadata purposes.
   */
  skipKind?: 'metadata' | 'registry' | 'capability';
}

export interface PublishResult {
  /** Packages where at least one target published this run */
  published: { name: string; version: string }[];
  /** Packages that published nothing (no targets, all targets skipped, private, ...) */
  skipped: { name: string; reason: string }[];
  /** Packages where at least one target failed (may also appear in `published`) */
  failed: { name: string; error: string }[];
  /** Per-package, per-target outcomes for this run */
  targetOutcomes: Map<string, TargetOutcome[]>;
}

/**
 * Publish all packages in the release plan.
 * Order: topological across packages (dependencies published before dependents),
 * declared order across each package's targets. One target failing is recorded and
 * does not block sibling targets — retries are per-target via release metadata.
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
  const result: PublishResult = { published: [], skipped: [], failed: [], targetOutcomes: new Map() };
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
  const preflighted = new Set<string>();
  for (const release of ordered) {
    const pkg = packages.get(release.name)!;
    for (const target of getPackageTargets(pkg, config)) {
      if (preflighted.has(target.name)) continue;
      preflighted.add(target.name);
      await target.plugin.preflight?.({
        rootDir,
        config,
        options: target.options,
        dryRun: !!opts.dryRun,
      });
    }
  }

  for (const release of ordered) {
    const pkg = packages.get(release.name)!;
    const pkgConfig = pkg.bumpy || {};
    const targets = getPackageTargets(pkg, config);
    const completed = opts.completedTargets?.get(release.name);

    // Packages with no targets publish nowhere; git tags still apply per config
    if (targets.length === 0) {
      if (pkg.private) {
        if (config.privatePackages.tag) createGitTag(release, rootDir, opts);
        result.skipped.push({ name: release.name, reason: 'private' });
      } else {
        // Legacy skipNpmPublish behavior: no publish, but still tag the version
        createGitTag(release, rootDir, opts);
        result.skipped.push({ name: release.name, reason: 'no publish targets' });
      }
      continue;
    }

    log.step(`Publishing ${colorize(release.name, 'cyan')}@${release.newVersion}`);

    const outcomes: TargetOutcome[] = [];
    result.targetOutcomes.set(release.name, outcomes);
    // Artifacts shared across this package's targets, keyed by artifact kind
    const artifacts = new Map<string, string>();

    try {
      // 1. Build (once per package, before any target)
      if (pkgConfig.buildCommand) {
        log.dim(`  Building...`);
        if (!opts.dryRun) {
          await runStreaming(pkgConfig.buildCommand, { cwd: pkg.dir });
        }
      }

      // 2. Resolve workspace:/catalog: protocols in-place when any target reads the
      //    manifest from the package dir (custom commands, vsce, npm in-place mode)
      const needsInPlaceResolve = targets.some((t) => t.plugin.needsProtocolResolution?.(t.options, config));
      if (needsInPlaceResolve) {
        // Always write resolved protocols — dryRun only skips the actual publish commands
        await resolveProtocolsInPlace(pkg, packages, releasePlan, catalogs);
      }

      // 3. Publish each target
      const isPrerelease = semver.prerelease(release.newVersion) !== null;
      for (const target of targets) {
        const outcome = await publishOneTarget(target, {
          pkg,
          pkgConfig,
          release,
          config,
          rootDir,
          opts,
          releaseKind,
          isPrerelease,
          completed,
          artifacts,
          detectedPm,
        });
        outcomes.push(outcome);
        if (outcome.status === 'failed') {
          log.error(`  Failed to publish ${release.name} → ${target.name}: ${outcome.error}`);
        }
      }
    } catch (err) {
      // Package-level failure (build / protocol resolution) — no target ran
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error(`  Failed to publish ${release.name}: ${errMsg}`);
      result.failed.push({ name: release.name, error: errMsg });
      await cleanupArtifacts(artifacts);
      continue;
    }

    await cleanupArtifacts(artifacts);

    // 4. Git tag — the tag asserts "this version exists somewhere", so it is created
    //    as soon as any target has succeeded (now, in a previous run, or out-of-band
    //    per the registry guard)
    const succeededNow = outcomes.filter((o) => o.status === 'success');
    const failedNow = outcomes.filter((o) => o.status === 'failed');
    const alreadyLive = (o: TargetOutcome) => o.skipKind === 'metadata' || o.skipKind === 'registry';
    const anySuccess = succeededNow.length > 0 || (completed?.size ?? 0) > 0 || outcomes.some(alreadyLive);
    if (anySuccess) {
      createGitTag(release, rootDir, opts);
    }

    // Package-level classification
    if (succeededNow.length > 0) {
      result.published.push({ name: release.name, version: release.newVersion });
      const summary =
        targets.length === 1
          ? ''
          : ` (${succeededNow.map((o) => o.target).join(', ')}${failedNow.length ? ` — ${failedNow.length} failed` : ''})`;
      log.success(`  Published ${release.name}@${release.newVersion}${summary}`);
    } else if (failedNow.length === 0) {
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
    completed: Set<string> | undefined;
    artifacts: Map<string, string>;
    detectedPm: PackageManager;
  },
): Promise<TargetOutcome> {
  const { pkg, release, config, opts, releaseKind, isPrerelease, completed, artifacts } = args;
  const base = { target: target.name, type: target.type };

  // Already succeeded in a previous run (per release metadata) — don't re-publish
  if (completed?.has(target.name)) {
    log.dim(`  Skipping ${target.name} — already published (per release metadata)`);
    return { ...base, status: 'skipped', skipKind: 'metadata', reason: 'already published' };
  }

  // Capability gates
  const caps = target.plugin.capabilities;
  if (releaseKind === 'snapshot' && !caps.snapshots) {
    log.dim(`  Skipping ${target.name} — target does not support snapshot releases`);
    return { ...base, status: 'skipped', skipKind: 'capability', reason: 'snapshots not supported' };
  }
  if (isPrerelease && !caps.prereleases) {
    log.dim(`  Skipping ${target.name} — target does not support prerelease versions`);
    return { ...base, status: 'skipped', skipKind: 'capability', reason: 'prereleases not supported' };
  }

  // Registry-level idempotency guard: even without release metadata (gh unavailable,
  // draft deleted), never publish a version that's already live — registries reject
  // republishes with far less helpful errors. Runs before the artifact build so a
  // fully-published package doesn't rebuild anything.
  if (!opts.dryRun && target.plugin.checkPublished) {
    const published = await target.plugin.checkPublished(pkg, release.newVersion, target.options).catch(() => null);
    if (published === true) {
      log.dim(`  Skipping ${target.name} — ${release.newVersion} already on registry`);
      return { ...base, status: 'skipped', skipKind: 'registry', reason: 'already on registry' };
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

    await target.plugin.publish(ctx);
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

function createGitTag(release: PlannedRelease, rootDir: string, opts: PublishOptions): void {
  if (opts.noTag) return;
  const tag = `${release.name}@${release.newVersion}`;
  if (opts.dryRun) {
    log.dim(`  Would create tag: ${tag}`);
    return;
  }
  if (tagExists(tag, { cwd: rootDir })) {
    log.dim(`  Tag ${tag} already exists, skipping`);
    return;
  }
  createTag(tag, { cwd: rootDir });
  log.dim(`  Tagged: ${tag}`);
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
