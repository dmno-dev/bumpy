import { log, colorize } from '../utils/logger.ts';
import { loadConfig } from '../core/config.ts';
import { discoverWorkspace } from '../core/workspace.ts';
import { DependencyGraph } from '../core/dep-graph.ts';
import { pushWithTags, hasUncommittedChanges } from '../core/git.ts';
import { publishPackages } from '../core/publish-pipeline.ts';
import {
  createIndividualReleases,
  findReleaseByTag,
  createDraftRelease,
  updateReleaseBody,
  updateReleaseBodyStatus,
  finalizeRelease,
  finalizeSupersededDrafts,
  composeReleaseBody,
  buildPublishUrl,
  isGhAvailable,
  getHeadSha,
  generateReleaseBody,
  buildReleaseBody,
  type ReleaseMetadata,
  type PublishTargetState,
} from '../core/github-release.ts';
import { loadFormatter } from '../core/changelog.ts';
import { detectWorkspaces } from '../utils/package-manager.ts';
import { CI_PLAN_CACHE_PATH } from './ci.ts';
import { tryRunArgs } from '../utils/shell.ts';
import type { BumpyConfig, PackageConfig, ReleasePlan, PlannedRelease, WorkspacePackage } from '../types.ts';

interface PublishCommandOptions {
  dryRun?: boolean;
  tag?: string;
  noPush?: boolean;
  /** Filter to specific packages by name/glob (comma-separated) */
  filter?: string;
  /** Recovered bump files from a version commit — used for GitHub release body generation */
  recoveredBumpFiles?: import('../types.ts').BumpFile[];
  /** Package names to exclude from publishing (e.g., packages with pending non-none bumps) */
  excludePackages?: Set<string>;
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

  // Exclude packages with pending non-none bumps (they'll be superseded by the next version PR)
  if (opts.excludePackages && opts.excludePackages.size > 0) {
    const excluded = toPublish.filter((r) => opts.excludePackages!.has(r.name));
    if (excluded.length > 0) {
      for (const r of excluded) {
        log.dim(`  Skipping ${r.name}@${r.newVersion} — pending bump will supersede this version`);
      }
      toPublish = toPublish.filter((r) => !opts.excludePackages!.has(r.name));
    }
  }

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
  // Use recovered bump files (from version commit) when available so that
  // GitHub release bodies can be generated with the formatter
  const recoveredBumpFiles = opts.recoveredBumpFiles || [];
  if (recoveredBumpFiles.length > 0) {
    for (const release of toPublish) {
      release.bumpFiles = recoveredBumpFiles
        .filter((bf) => bf.releases.some((r) => r.name === release.name))
        .map((bf) => bf.id);
    }
  }
  const releasePlan: ReleasePlan = {
    bumpFiles: recoveredBumpFiles,
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

  // Load the changelog formatter for release note generation
  const formatter = config.changelog !== false ? await loadFormatter(config.changelog, rootDir) : undefined;
  const ghAvailable = isGhAvailable();

  // Determine publish targets for each package
  const publishTargetsByPkg = new Map<string, string[]>();
  for (const release of toPublish) {
    const pkg = packages.get(release.name)!;
    const pkgConfig = pkg.bumpy || {};
    const targets: string[] = [];
    if (pkgConfig.publishCommand) {
      targets.push('custom');
    } else if (!pkgConfig.skipNpmPublish) {
      targets.push('npm');
    }
    publishTargetsByPkg.set(release.name, targets);
  }

  // For each package, set up draft releases (if gh is available and not dry run)
  const releaseMetadataByPkg = new Map<
    string,
    { tag: string; metadata: ReleaseMetadata; existingBody: string | null }
  >();

  if (ghAvailable && !opts.dryRun) {
    for (const release of toPublish) {
      const tag = `${release.name}@${release.newVersion}`;
      const targets = publishTargetsByPkg.get(release.name) || [];
      if (targets.length === 0) continue;

      const existing = await findReleaseByTag(tag, rootDir);

      if (existing && existing.metadata) {
        // Existing draft/release with metadata — use it for retry logic
        log.dim(`  Found existing release for ${tag} (${existing.isDraft ? 'draft' : 'published'})`);
        releaseMetadataByPkg.set(release.name, {
          tag,
          metadata: existing.metadata,
          existingBody: existing.body,
        });
      } else if (existing && !existing.metadata) {
        // Existing release without bumpy metadata — leave it alone (user-created or old-style)
        log.dim(`  Found existing release for ${tag} without bumpy metadata — skipping draft management`);
      } else {
        // No existing release — finalize any stale drafts for older versions, then create a new draft
        await finalizeSupersededDrafts(release.name, release.newVersion, rootDir);

        const changelogContent = formatter
          ? await generateReleaseBody(release, releasePlan.bumpFiles, formatter)
          : buildReleaseBody(release, releasePlan.bumpFiles);

        const initialTargets: Record<string, PublishTargetState> = {};
        for (const t of targets) {
          initialTargets[t] = { status: 'pending' };
        }
        const metadata: ReleaseMetadata = {
          version: release.newVersion,
          targets: initialTargets,
        };
        const body = composeReleaseBody(changelogContent, metadata);
        const title = `${release.name} v${release.newVersion}`;
        const headSha = getHeadSha(rootDir);

        try {
          await createDraftRelease(tag, title, body, rootDir, headSha || undefined);
          log.dim(`  Created draft release: ${title}`);
          releaseMetadataByPkg.set(release.name, { tag, metadata, existingBody: body });
        } catch (err) {
          log.warn(`  Failed to create draft release for ${tag}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    // Handle tag movement: if no targets succeeded yet, move tag to HEAD
    for (const release of toPublish) {
      const info = releaseMetadataByPkg.get(release.name);
      if (!info) continue;

      const anySucceeded = Object.values(info.metadata.targets).some((t) => t.status === 'success');
      if (!anySucceeded) {
        // Safe to move tag to HEAD
        const tag = info.tag;
        const headSha = getHeadSha(rootDir);
        const tagSha = tryRunArgs(['git', 'rev-parse', tag], { cwd: rootDir });
        if (headSha && tagSha && headSha !== tagSha) {
          // Count commits between tag and HEAD
          const count = tryRunArgs(['git', 'rev-list', '--count', `${tag}..HEAD`], { cwd: rootDir });
          log.dim(`  Moving version tag ${tag} to HEAD (includes ${count} commit(s) since versioning)`);
          tryRunArgs(['git', 'tag', '-f', tag], { cwd: rootDir });
        }
      } else {
        // Tag stays — log divergence if any
        const tag = info.tag;
        const headSha = getHeadSha(rootDir);
        const tagSha = tryRunArgs(['git', 'rev-parse', tag], { cwd: rootDir });
        if (headSha && tagSha && headSha !== tagSha) {
          const count = tryRunArgs(['git', 'rev-list', '--count', `${tag}..HEAD`], { cwd: rootDir });
          log.warn(
            `  HEAD is ${count} commit(s) ahead of version tag ${tag} — some targets already published from tagged commit`,
          );
        }
      }
    }
  }

  // Filter out packages where all targets already succeeded (from previous runs)
  const alreadyPublished: string[] = [];
  for (const release of toPublish) {
    const info = releaseMetadataByPkg.get(release.name);
    if (!info) continue;
    const targets = publishTargetsByPkg.get(release.name) || [];
    const allDone = targets.every((t) => info.metadata.targets[t]?.status === 'success');
    if (allDone) {
      alreadyPublished.push(release.name);
    }
  }
  if (alreadyPublished.length > 0) {
    for (const name of alreadyPublished) {
      log.dim(`  Skipping ${name} — all targets already published (per draft release metadata)`);
    }
    toPublish = toPublish.filter((r) => !alreadyPublished.includes(r.name));
    releasePlan.releases = toPublish;
  }

  if (toPublish.length === 0) {
    log.info('All packages already published successfully.');
    return;
  }

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

  // Update draft release metadata with results
  if (ghAvailable && !opts.dryRun) {
    for (const release of releasePlan.releases) {
      const info = releaseMetadataByPkg.get(release.name);
      if (!info) continue;

      const targets = publishTargetsByPkg.get(release.name) || [];
      const published = result.published.find((p) => p.name === release.name);
      const failed = result.failed.find((f) => f.name === release.name);

      let changed = false;
      for (const targetName of targets) {
        // Skip already-succeeded targets
        if (info.metadata.targets[targetName]?.status === 'success') continue;

        if (published) {
          info.metadata.targets[targetName] = {
            status: 'success',
            publishedAt: new Date().toISOString(),
            url: buildPublishUrl(release.name, release.newVersion, targetName),
          };
          changed = true;
        } else if (failed) {
          info.metadata.targets[targetName] = {
            status: 'failed',
            error: failed.error,
            lastAttempt: new Date().toISOString(),
          };
          changed = true;
        }
      }

      if (changed) {
        try {
          const updatedBody = info.existingBody
            ? updateReleaseBodyStatus(info.existingBody, info.metadata)
            : composeReleaseBody('', info.metadata);
          await updateReleaseBody(info.tag, updatedBody, rootDir);

          // Finalize if all targets succeeded
          const allSucceeded = Object.values(info.metadata.targets).every((t) => t.status === 'success');
          if (allSucceeded) {
            await finalizeRelease(info.tag, rootDir);
            log.dim(`  Finalized release: ${info.tag}`);
          }
        } catch (err) {
          log.warn(`  Failed to update release for ${info.tag}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
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

  // Fallback: if gh isn't available, we can't use draft releases — use legacy individual releases
  if (!ghAvailable && result.published.length > 0) {
    const publishedReleases = releasePlan.releases.filter((r) => result.published.some((p) => p.name === r.name));
    await createIndividualReleases(publishedReleases, releasePlan.bumpFiles, rootDir, {
      dryRun: opts.dryRun,
      formatter,
    });
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
