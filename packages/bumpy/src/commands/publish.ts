import { log, colorize } from '../utils/logger.ts';
import { loadConfig } from '../core/config.ts';
import { discoverWorkspace } from '../core/workspace.ts';
import { DependencyGraph } from '../core/dep-graph.ts';
import { pushWithTags, hasUncommittedChanges } from '../core/git.ts';
import { publishPackages } from '../core/publish-pipeline.ts';
import { createIndividualReleases, createAggregateRelease } from '../core/github-release.ts';
import { loadFormatter } from '../core/changelog.ts';
import { detectWorkspaces } from '../utils/package-manager.ts';
import { CI_PLAN_CACHE_PATH } from './ci.ts';
import type { BumpyConfig, PackageConfig, ReleasePlan, PlannedRelease, WorkspacePackage } from '../types.ts';

interface PublishCommandOptions {
  dryRun?: boolean;
  tag?: string;
  noPush?: boolean;
  /** Filter to specific packages by name/glob (comma-separated) */
  filter?: string;
}

/**
 * Publish packages that have been versioned but not yet published.
 * Detects unpublished versions by comparing package.json versions against npm registry.
 */
export async function publishCommand(rootDir: string, opts: PublishCommandOptions): Promise<void> {
  const config = await loadConfig(rootDir);
  const { packages, catalogs } = await discoverWorkspace(rootDir, config);
  const { packageManager: detectedPm } = await detectWorkspaces(rootDir);
  const depGraph = new DependencyGraph(packages);

  if (!opts.dryRun && hasUncommittedChanges({ cwd: rootDir })) {
    log.warn('You have uncommitted changes. Commit or stash them before publishing.');
    process.exit(1);
  }

  // Find packages that need publishing — use cached plan from `ci plan` if available,
  // otherwise query the registry
  let toPublish = await findUnpublishedWithCache(rootDir, packages, config);

  // Apply filter
  if (opts.filter) {
    const { matchGlob } = await import('../core/config.ts');
    const patterns = opts.filter.split(',').map((p) => p.trim());
    toPublish = toPublish.filter((r) => patterns.some((p) => matchGlob(r.name, p)));
  }

  if (toPublish.length === 0) {
    log.info('No unpublished packages found.');
    return;
  }

  // Build a synthetic release plan from unpublished packages
  const releasePlan: ReleasePlan = {
    bumpFiles: [],
    releases: toPublish,
    warnings: [],
  };

  if (opts.dryRun) {
    log.bold('Dry run — would publish:');
  } else {
    log.bold('Publishing:');
  }
  for (const r of toPublish) {
    console.log(`  ${r.name}@${colorize(r.newVersion, 'cyan')}`);
  }
  console.log();

  const result = await publishPackages(
    releasePlan,
    packages,
    depGraph,
    config,
    rootDir,
    {
      dryRun: opts.dryRun,
      tag: opts.tag,
    },
    catalogs,
    detectedPm,
  );

  // Summary
  if (result.published.length > 0) {
    log.success(`🐸 Published ${result.published.length} package(s)`);
  }
  if (result.skipped.length > 0) {
    log.dim(`Skipped ${result.skipped.length}: ${result.skipped.map((s) => s.name).join(', ')}`);
  }
  if (result.failed.length > 0) {
    log.error(`Failed ${result.failed.length}: ${result.failed.map((f) => `${f.name} (${f.error})`).join(', ')}`);
    process.exit(1);
  }

  // Push tags
  if (!opts.dryRun && !opts.noPush && result.published.length > 0) {
    try {
      log.step('Pushing tags...');
      pushWithTags({ cwd: rootDir });
      log.success('Pushed tags to remote');
    } catch (err) {
      log.warn(`Failed to push tags: ${err instanceof Error ? err.message : err}`);
    }
  }

  // GitHub releases
  if (result.published.length > 0) {
    const publishedReleases = releasePlan.releases.filter((r) => result.published.some((p) => p.name === r.name));
    const aggConfig = config.aggregateRelease;
    const isAggregate = aggConfig === true || (typeof aggConfig === 'object' && aggConfig.enabled);
    const aggTitle = typeof aggConfig === 'object' ? aggConfig.title : undefined;

    // Load the changelog formatter so GitHub release bodies match CHANGELOG.md
    const formatter = config.changelog !== false ? await loadFormatter(config.changelog, rootDir) : undefined;

    if (isAggregate) {
      await createAggregateRelease(publishedReleases, releasePlan.bumpFiles, rootDir, {
        dryRun: opts.dryRun,
        title: aggTitle,
        formatter,
      });
    } else {
      await createIndividualReleases(publishedReleases, releasePlan.bumpFiles, rootDir, {
        dryRun: opts.dryRun,
        formatter,
      });
    }
  }
}

/**
 * Try to load cached plan from `ci plan`. Returns the unpublished package names
 * if the cache is valid, or null to fall back to registry lookups.
 *
 * Validates that every cached package exists in the workspace with the same version,
 * so the cache can only filter — never fabricate — the set of packages.
 */
function loadCachedPlan(rootDir: string, packages: Map<string, WorkspacePackage>): Set<string> | null {
  const cachePath = `${rootDir}/${CI_PLAN_CACHE_PATH}`;
  let raw: string;
  try {
    raw = require('node:fs').readFileSync(cachePath, 'utf-8');
    // Clean up cache file after reading
    require('node:fs').unlinkSync(cachePath);
  } catch {
    return null;
  }

  try {
    const cached = JSON.parse(raw);
    if (cached?.mode !== 'publish' || !Array.isArray(cached.releases)) return null;

    const names = new Set<string>();
    for (const r of cached.releases) {
      if (typeof r.name !== 'string' || typeof r.newVersion !== 'string') return null;
      // Validate against workspace — reject if package doesn't exist or version doesn't match
      const pkg = packages.get(r.name);
      if (!pkg || pkg.version !== r.newVersion) {
        log.dim('  ci plan cache is stale — falling back to registry lookups');
        return null;
      }
      names.add(r.name);
    }

    log.dim('  Using cached plan from ci plan');
    return names;
  } catch {
    return null;
  }
}

/**
 * Find unpublished packages, using the ci plan cache if available.
 * Falls back to registry lookups if no cache or cache is invalid.
 */
async function findUnpublishedWithCache(
  rootDir: string,
  packages: Map<string, WorkspacePackage>,
  config: BumpyConfig,
): Promise<PlannedRelease[]> {
  const cachedNames = loadCachedPlan(rootDir, packages);
  if (cachedNames) {
    // Build PlannedRelease entries directly from workspace data — no network needed
    const unpublished: PlannedRelease[] = [];
    for (const name of cachedNames) {
      const pkg = packages.get(name)!;
      unpublished.push({
        name,
        type: 'patch',
        oldVersion: pkg.version,
        newVersion: pkg.version,
        bumpFiles: [],
        isDependencyBump: false,
        isCascadeBump: false,
        isGroupBump: false,
        bumpSources: [],
      });
    }
    return unpublished;
  }
  return findUnpublishedPackages(packages, config);
}

/**
 * Find packages whose current version is not yet published.
 *
 * Detection strategy (per package):
 * 1. Custom `checkPublished` command → run it, compare output to current version
 * 2. `skipNpmPublish` or custom `publishCommand` → check git tags
 * 3. Default → check npm registry via `npm info`
 */
export async function findUnpublishedPackages(
  packages: Map<string, WorkspacePackage>,
  _config: BumpyConfig,
): Promise<PlannedRelease[]> {
  const unpublished: PlannedRelease[] = [];

  for (const [name, pkg] of packages) {
    // Skip private packages unless they have custom publish config
    if (pkg.private && !pkg.bumpy?.publishCommand) continue;
    // Skip ignored
    if (pkg.version === '0.0.0') continue;

    const isPublished = await checkIfPublished(name, pkg.version, pkg.bumpy);
    if (!isPublished) {
      unpublished.push({
        name,
        type: 'patch', // doesn't matter for publish, just needs a value
        oldVersion: pkg.version, // we don't know the old version
        newVersion: pkg.version,
        bumpFiles: [],
        isDependencyBump: false,
        isCascadeBump: false,
        isGroupBump: false,
        bumpSources: [],
      });
    }
  }

  return unpublished;
}

async function checkIfPublished(name: string, version: string, pkgConfig?: PackageConfig): Promise<boolean> {
  const { runAsync, runArgsAsync, tryRunArgs } = await import('../utils/shell.ts');

  // 1. Custom check command (user-defined, runs in shell by design)
  if (pkgConfig?.checkPublished) {
    try {
      const result = await runAsync(pkgConfig.checkPublished);
      return result.trim() === version;
    } catch {
      return false;
    }
  }

  // 2. Non-npm packages — check git tags
  if (pkgConfig?.skipNpmPublish || pkgConfig?.publishCommand) {
    const tag = `${name}@${version}`;
    return tryRunArgs(['git', 'tag', '-l', tag]) === tag;
  }

  // 3. Default — check npm registry
  try {
    const args = ['npm', 'info', `${name}@${version}`, 'version'];
    if (pkgConfig?.registry) args.push('--registry', pkgConfig.registry);
    const result = await runArgsAsync(args);
    return result === version;
  } catch {
    return false;
  }
}
