import semver from 'semver';
import { log, colorize } from '../utils/logger.ts';
import { loadConfig } from '../core/config.ts';
import { discoverWorkspace } from '../core/workspace.ts';
import { DependencyGraph } from '../core/dep-graph.ts';
import { forcePushTag, hasUncommittedChanges, tagExists } from '../core/git.ts';
import { publishPackages, willUseOidcExclusively } from '../core/publish-pipeline.ts';
import { readBumpFiles } from '../core/bump-file.ts';
import { assembleReleasePlan } from '../core/release-plan.ts';
import { channelNames, resolveActiveChannel, type ResolvedChannel } from '../core/channels.ts';
import { buildChannelReleasePlan, writeTransientVersionsInPlace } from '../core/prerelease.ts';
import {
  buildSnapshotReleasePlan,
  resolveSnapshot,
  assertSnapshotPrerelease,
  type ResolvedSnapshot,
} from '../core/snapshot.ts';
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
  publishTargetLabel,
  resolvePackageRegistry,
  parseRepoSlug,
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
import { runArgsAsync, tryRunArgs } from '../utils/shell.ts';
import type { BumpyConfig, PackageConfig, ReleasePlan, PlannedRelease, WorkspacePackage } from '../types.ts';
import type { CatalogMap } from '../utils/package-manager.ts';
import type { PackageManager } from '../types.ts';

interface PublishCommandOptions {
  dryRun?: boolean;
  tag?: string;
  noPush?: boolean;
  /** Filter to specific packages by name/glob (comma-separated) */
  filter?: string;
  /** Channel name override (otherwise inferred from the current branch) */
  channel?: string;
  /** Publish a transient snapshot under this name (mutually exclusive with channel) */
  snapshot?: string;
  /** Recovered bump files from a version commit — used for GitHub release body generation */
  recoveredBumpFiles?: import('../types.ts').BumpFile[];
  /** Package names to exclude from publishing (e.g., packages with pending non-none bumps) */
  excludePackages?: Set<string>;
}

/**
 * Publish packages that have been versioned but not yet published.
 *
 * On the base branch: detects unpublished versions by comparing package.json versions
 * against the npm registry.
 *
 * On a channel branch: prerelease versions are never committed, so they are computed
 * here — targets from the cycle's bump files, counters from the registry — written
 * transiently into the working tree, published to the channel's dist-tag, and restored.
 */
export async function publishCommand(
  rootDir: string,
  opts: PublishCommandOptions,
): Promise<SnapshotPublishOutcome | null | void> {
  const config = await loadConfig(rootDir);
  const { packages, catalogs } = await discoverWorkspace(rootDir, config);
  const { packageManager: detectedPm } = await detectWorkspaces(rootDir);
  const depGraph = new DependencyGraph(packages);

  if (!opts.dryRun && hasUncommittedChanges({ cwd: rootDir })) {
    log.warn('You have uncommitted changes. Commit or stash them before publishing.');
    process.exit(1);
  }

  // Snapshots are a distinct, transient release model — never mixed with the channel flow.
  if (opts.snapshot !== undefined) {
    if (opts.channel !== undefined) {
      log.error('--snapshot and --channel cannot be used together — they are distinct release models.');
      process.exit(1);
    }
    return await publishSnapshot(rootDir, config, packages, catalogs, detectedPm, depGraph, opts);
  }

  const channel = resolveActiveChannel(rootDir, config, opts.channel);
  if (channel) {
    await publishChannel(rootDir, config, packages, catalogs, detectedPm, depGraph, channel, opts);
    return;
  }

  // Find packages that need publishing — use cached plan from `ci plan` if available,
  // otherwise query the registry
  let toPublish = await findUnpublishedWithCache(rootDir, packages, config);

  // When channels are configured, prerelease versions must never reach the stable
  // flow (they'd land on @latest). With the no-commit model this can't normally
  // happen — committed versions are always stable — so a suffixed version here
  // means something went wrong. Refuse loudly rather than publish it.
  if (Object.keys(config.channels || {}).length > 0) {
    const prereleases = toPublish.filter((r) => semver.prerelease(r.newVersion) !== null);
    if (prereleases.length > 0) {
      log.error('Refusing to publish prerelease versions outside a channel:');
      for (const r of prereleases) log.error(`  • ${r.name}@${r.newVersion}`);
      log.error('Prerelease versions should never be committed — see https://bumpy.varlock.dev/docs/prereleases');
      process.exit(1);
    }
  }

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

  await runPublishFlow(rootDir, config, packages, catalogs, detectedPm, depGraph, releasePlan, {
    dryRun: opts.dryRun,
    tag: opts.tag,
    noPush: opts.noPush,
  });
}

/**
 * Publish a prerelease cycle from a channel branch.
 *
 * The cycle = every bump file on the branch (pending at root or in other channels'
 * dirs, plus shipped in this channel's dir). The whole cycle republishes together
 * each time so the channel dist-tag always points at one coherent, exact-pinned set.
 */
async function publishChannel(
  rootDir: string,
  config: BumpyConfig,
  packages: Map<string, WorkspacePackage>,
  catalogs: CatalogMap,
  detectedPm: PackageManager,
  depGraph: DependencyGraph,
  channel: ResolvedChannel,
  opts: PublishCommandOptions,
): Promise<void> {
  const { bumpFiles, errors: parseErrors } = await readBumpFiles(rootDir, { channels: channelNames(config) });
  if (parseErrors.length > 0) {
    for (const err of parseErrors) log.error(err);
    process.exit(1);
  }

  const shipped = bumpFiles.filter((bf) => bf.channel === channel.name);
  if (shipped.length === 0) {
    log.info(
      `Nothing has shipped on channel "${channel.name}" yet (no bump files in .bumpy/${channel.name}/).\n` +
        `  Run \`bumpy version\` on the channel branch (or merge the release PR) first.`,
    );
    return;
  }

  log.bold(`Channel "${channel.name}" — preid "-${channel.preid}.N", dist-tag @${channel.tag}\n`);

  // Targets from the full cycle's bump files; counters from the registry.
  const stablePlan = assembleReleasePlan(bumpFiles, packages, depGraph, config, {
    prereleasePreid: channel.preid,
  });
  const { plan, alreadyPublished, warnings } = await buildChannelReleasePlan(stablePlan, channel, packages, rootDir);

  for (const w of warnings) log.warn(w);
  for (const skip of alreadyPublished) {
    log.dim(`  Skipping ${skip.name}@${skip.version} — already published from this commit`);
  }

  if (plan.releases.length === 0) {
    log.info('All cycle packages already published from this commit.');
    return;
  }

  // Filter only restricts what gets *published* — the in-place rewrite below still
  // covers the whole plan so dependency pins stay consistent (used for partial-failure resume).
  let toPublish = plan.releases;
  if (opts.filter) {
    const { matchGlob } = await import('../core/config.ts');
    const patterns = opts.filter.split(',').map((p) => p.trim());
    toPublish = toPublish.filter((r) => patterns.some((p) => matchGlob(r.name, p)));
    if (toPublish.length === 0) {
      log.info('No cycle packages match the filter.');
      return;
    }
  }

  // Transiently write computed versions + exact pins into the working tree so
  // pack/build see them; always restored afterwards — prereleases never land in git.
  let restore: (() => Promise<void>) | null = null;
  if (!opts.dryRun) {
    restore = await writeTransientVersionsInPlace(plan, packages);
  }

  try {
    const publishPlan: ReleasePlan = { bumpFiles: plan.bumpFiles, releases: toPublish, warnings: [] };
    await runPublishFlow(rootDir, config, packages, catalogs, detectedPm, depGraph, publishPlan, {
      dryRun: opts.dryRun,
      tag: opts.tag ?? channel.tag,
      noPush: opts.noPush,
    });
  } finally {
    if (restore) {
      await restore();
      log.dim('  Restored package.json files (prerelease versions are not committed)');
    }
  }
}

/**
 * Publish a transient snapshot from the pending bump files.
 *
 * Snapshots are throwaway previews — "what the next release would be", published now under
 * a non-`latest` dist-tag (default: the snapshot name). The computed plan is written into the
 * working tree, published, then restored. Unlike the stable/channel flows this never consumes
 * bump files, writes changelogs, commits, creates git tags, or makes GitHub releases.
 *
 * Strict by design: a snapshot requires pending bump files. With nothing to release there's
 * no version plan to snapshot, so we stop with a clear message rather than guessing.
 *
 * Returns the resolved snapshot and the packages actually published (empty for dry runs or
 * when everything was already published) so callers like `ci release` can comment on the PR.
 */
export interface SnapshotPublishOutcome {
  snapshot: ResolvedSnapshot;
  published: { name: string; version: string }[];
}

async function publishSnapshot(
  rootDir: string,
  config: BumpyConfig,
  packages: Map<string, WorkspacePackage>,
  catalogs: CatalogMap,
  detectedPm: PackageManager,
  depGraph: DependencyGraph,
  opts: PublishCommandOptions,
): Promise<SnapshotPublishOutcome | null> {
  const snapshot = resolveSnapshot(opts.snapshot!, config, rootDir, { tag: opts.tag });

  const { bumpFiles, errors: parseErrors } = await readBumpFiles(rootDir, { channels: channelNames(config) });
  if (parseErrors.length > 0) {
    for (const err of parseErrors) log.error(err);
    process.exit(1);
  }

  // Targets come from the normal stable plan; snapshots don't widen the cascade the way
  // channels do (no prereleasePreid) — they preview exactly the pending release.
  const stablePlan = assembleReleasePlan(bumpFiles, packages, depGraph, config);
  if (stablePlan.releases.length === 0) {
    log.info(
      `No pending releases to snapshot — snapshots require pending bump files.\n` +
        `  Run \`bumpy add\` to declare the changes you want to preview.`,
    );
    return null;
  }

  log.bold(`Snapshot "${snapshot.name}" — dist-tag @${snapshot.tag} (strategy: ${snapshot.strategy})\n`);

  const { plan, alreadyPublished, warnings } = await buildSnapshotReleasePlan(stablePlan, snapshot, packages);
  for (const w of warnings) log.warn(w);
  for (const skip of alreadyPublished) {
    log.dim(`  Skipping ${skip.name}@${skip.version} — this snapshot was already published`);
  }

  if (plan.releases.length === 0) {
    log.info('Nothing to publish — every package in the plan was already published for this snapshot.');
    return { snapshot, published: [] };
  }

  // Snapshot versions must always be prereleases — a stable version here would land on @latest.
  for (const r of plan.releases) assertSnapshotPrerelease(r.newVersion);

  // Filter restricts what gets published; the in-place rewrite below still covers the whole
  // plan so in-plan dependency pins stay consistent.
  let toPublish = plan.releases;
  if (opts.filter) {
    const { matchGlob } = await import('../core/config.ts');
    const patterns = opts.filter.split(',').map((p) => p.trim());
    toPublish = toPublish.filter((r) => patterns.some((p) => matchGlob(r.name, p)));
    if (toPublish.length === 0) {
      log.info('No snapshot packages match the filter.');
      return { snapshot, published: [] };
    }
  }

  if (opts.dryRun) {
    log.bold('Dry run — would publish:');
  } else {
    log.bold('Publishing:');
  }
  for (const r of toPublish) console.log(`  ${r.name}@${colorize(r.newVersion, 'cyan')}`);
  console.log();

  // Transiently write versions + exact pins so build/pack see them; always restored —
  // snapshot versions never land in git.
  let restore: (() => Promise<void>) | null = null;
  if (!opts.dryRun) {
    restore = await writeTransientVersionsInPlace(plan, packages);
  }

  let published: { name: string; version: string }[] = [];
  try {
    const publishPlan: ReleasePlan = { bumpFiles: [], releases: toPublish, warnings: [] };
    const result = await publishPackages(
      publishPlan,
      packages,
      depGraph,
      config,
      rootDir,
      { dryRun: opts.dryRun, tag: snapshot.tag, noTag: true },
      catalogs,
      detectedPm,
    );
    published = result.published;

    if (result.published.length > 0) {
      log.success(`🐸 Published ${result.published.length} snapshot package(s) to @${snapshot.tag}`);
    }
    if (result.skipped.length > 0) {
      log.dim(`Skipped ${result.skipped.length}: ${result.skipped.map((s) => s.name).join(', ')}`);
    }
    if (result.failed.length > 0) {
      log.error(`Failed ${result.failed.length}: ${result.failed.map((f) => `${f.name} (${f.error})`).join(', ')}`);
      process.exit(1);
    }
  } finally {
    if (restore) {
      await restore();
      log.dim('  Restored package.json files (snapshot versions are not committed)');
    }
  }

  return { snapshot, published };
}

/**
 * The shared publish flow: OIDC checks, draft GitHub releases, topological publish,
 * release metadata updates, tag pushes. Used by both the stable and channel paths.
 * Mutates `releasePlan.releases` as packages are filtered out (already published, etc.).
 */
async function runPublishFlow(
  rootDir: string,
  config: BumpyConfig,
  packages: Map<string, WorkspacePackage>,
  catalogs: CatalogMap,
  detectedPm: PackageManager,
  depGraph: DependencyGraph,
  releasePlan: ReleasePlan,
  opts: { dryRun?: boolean; tag?: string; noPush?: boolean },
): Promise<void> {
  let toPublish = releasePlan.releases;

  if (opts.dryRun) {
    log.bold('Dry run — would publish:');
  } else {
    log.bold('Publishing:');
  }
  for (const r of toPublish) {
    console.log(`  ${r.name}@${colorize(r.newVersion, 'cyan')}`);
  }
  console.log();

  // Trusted publishing (OIDC) cannot bootstrap a new package — fail early if any
  // package being published doesn't exist on npm yet, before we create draft releases.
  // Only checks when OIDC is the only available auth (no token fallback), to avoid
  // false positives for users with id-token: write enabled solely for provenance.
  if (willUseOidcExclusively(rootDir)) {
    const newPackages = await findPackagesMissingFromNpm(toPublish, packages);
    if (newPackages.length > 0) {
      const logFn = opts.dryRun ? log.warn : log.error;
      logFn(`Trusted publishing (OIDC) cannot create a new package. The following don't exist on npm yet:`);
      for (const name of newPackages) logFn(`  • ${name}`);
      logFn(`Publish a 0.0.0 placeholder version manually to claim the name, then configure`);
      logFn(`trusted publishing on npmjs.com. Bumpy will then publish the real version via OIDC.`);
      if (!opts.dryRun) process.exit(1);
    }
  }

  // Load the changelog formatter for release note generation
  const formatter = config.changelog !== false ? await loadFormatter(config.changelog, rootDir) : undefined;
  const ghAvailable = isGhAvailable();

  // Determine publish targets for each package
  const publishTargetsByPkg = new Map<string, string[]>();
  // Registry context per package, used to label targets and build correct release URLs.
  const registryByPkg = new Map<string, { registry?: string; repoSlug?: string }>();
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
    registryByPkg.set(release.name, {
      registry: resolvePackageRegistry(pkg, pkgConfig),
      repoSlug: parseRepoSlug(pkg.packageJson.repository) ?? process.env.GITHUB_REPOSITORY,
    });
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

        const { registry } = registryByPkg.get(release.name) || {};
        const initialTargets: Record<string, PublishTargetState> = {};
        for (const t of targets) {
          const label = publishTargetLabel(t, registry);
          initialTargets[t] = { status: 'pending', ...(label !== t ? { label } : {}) };
        }
        const metadata: ReleaseMetadata = {
          version: release.newVersion,
          targets: initialTargets,
        };
        const body = composeReleaseBody(changelogContent, metadata);
        const title = `${release.name} v${release.newVersion}`;
        const headSha = getHeadSha(rootDir);

        try {
          await createDraftRelease(tag, title, body, rootDir, headSha || undefined, {
            prerelease: semver.prerelease(release.newVersion) !== null,
          });
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

      const { registry, repoSlug } = registryByPkg.get(release.name) || {};
      let changed = false;
      for (const targetName of targets) {
        // Skip already-succeeded targets
        if (info.metadata.targets[targetName]?.status === 'success') continue;

        if (published) {
          const label = publishTargetLabel(targetName, registry);
          info.metadata.targets[targetName] = {
            status: 'success',
            publishedAt: new Date().toISOString(),
            url: buildPublishUrl(release.name, release.newVersion, targetName, { registry, repoSlug }),
            ...(label !== targetName ? { label } : {}),
          };
          changed = true;
        } else if (failed) {
          const label = publishTargetLabel(targetName, registry);
          info.metadata.targets[targetName] = {
            status: 'failed',
            error: failed.error,
            lastAttempt: new Date().toISOString(),
            ...(label !== targetName ? { label } : {}),
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

  // Push tags — per-tag force push only for releases handled this run.
  //
  // We use `releasePlan.releases` (not result.published) so that packages with
  // skipNpmPublish or private packages with `privatePackages.tag` enabled are
  // covered too — their local tags are created in publish-pipeline regardless of
  // whether npm publish ran. Failed packages are skipped (their local tag was
  // not created). The `alreadyPublished` filter above has already stripped
  // packages whose targets all succeeded in prior runs, so we never touch tags
  // tied to a previously-published SHA.
  //
  // Force-push is necessary because `gh release create --draft --target SHA`
  // creates the tag on the remote at draft-creation time. If a previous attempt
  // failed and HEAD has since moved, the remote tag is at a stale SHA and a
  // plain `git push --tags` would reject. Force is safe here because the local
  // tag was just created at the SHA we successfully published from.
  if (!opts.dryRun && !opts.noPush && result.published.length > 0) {
    const failed = new Set(result.failed.map((f) => f.name));
    const pushed: string[] = [];
    log.step('Pushing tags...');
    for (const release of releasePlan.releases) {
      if (failed.has(release.name)) continue;
      const tag = `${release.name}@${release.newVersion}`;
      if (!tagExists(tag, { cwd: rootDir })) continue;
      try {
        forcePushTag(tag, { cwd: rootDir });
        pushed.push(tag);
      } catch (err) {
        log.warn(`  Failed to push tag ${tag}: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (pushed.length > 0) log.success(`Pushed ${pushed.length} tag(s) to remote`);
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

/**
 * Check whether a package exists on npm at all (any version).
 * Returns true if the package is registered, false if it doesn't exist or the query fails.
 */
async function packageExistsOnNpm(name: string, registry?: string): Promise<boolean> {
  const args = ['npm', 'info', name, 'name'];
  if (registry) args.push('--registry', registry);
  try {
    const result = await runArgsAsync(args);
    return result.trim() === name;
  } catch {
    return false;
  }
}

/**
 * Filter `toPublish` to package names that don't exist on npm yet.
 * Skips packages not going through the standard npm publish flow.
 */
async function findPackagesMissingFromNpm(
  toPublish: PlannedRelease[],
  packages: Map<string, WorkspacePackage>,
): Promise<string[]> {
  const missing: string[] = [];
  await Promise.all(
    toPublish.map(async (release) => {
      const pkg = packages.get(release.name)!;
      const pkgConfig = pkg.bumpy || {};
      if (pkgConfig.publishCommand || pkgConfig.skipNpmPublish) return;
      if (pkg.private && !pkgConfig.publishCommand) return;
      const exists = await packageExistsOnNpm(release.name, pkgConfig.registry);
      if (!exists) missing.push(release.name);
    }),
  );
  return missing;
}
