import { log, colorize } from '../utils/logger.ts';
import { loadConfig } from '../core/config.ts';
import { discoverWorkspace } from '../core/workspace.ts';
import {
  isGhAvailable,
  findReleaseByTag,
  findStagedReleases,
  updateReleaseBody,
  updateReleaseBodyStatus,
  finalizeRelease,
  buildPublishUrl,
  publishTargetLabel,
  resolvePackageRegistry,
  parseRepoSlug,
  type DraftReleaseInfo,
} from '../core/github-release.ts';
import { checkIfPublished } from './publish.ts';

export interface FinalizeCommandOptions {
  /** Finalize only this release (`name@version`). Omit to reconcile every staged release. */
  tag?: string;
  dryRun?: boolean;
}

/** Split a `name@version` tag on the last `@` so scoped names (`@scope/pkg`) survive. */
function parseTag(tag: string): { name: string; version: string } | null {
  const idx = tag.lastIndexOf('@');
  if (idx <= 0) return null;
  return { name: tag.slice(0, idx), version: tag.slice(idx + 1) };
}

/**
 * Reconcile staged releases against the registry.
 *
 * A staged publish (`npm stage publish`) leaves the GitHub release as a draft with
 * its targets marked `staged`, because the package isn't live until it's approved
 * with 2FA on npmjs.com. This command checks whether each staged version has since
 * gone live and, if so, flips its targets to `success` (with the real package URL)
 * and finalizes the draft — which publishes the GitHub release and fires the
 * `release: published` event for any downstream workflows.
 *
 * Idempotent: a version that's still staged is left untouched, so this is safe to
 * run on a schedule, from a maintainer's machine, or from a stageflight dispatch.
 */
export async function finalizeCommand(rootDir: string, opts: FinalizeCommandOptions = {}): Promise<void> {
  if (!isGhAvailable()) {
    log.error('gh CLI not found — cannot finalize staged releases.');
    process.exit(1);
  }

  // Gather the releases to reconcile.
  let candidates: DraftReleaseInfo[];
  if (opts.tag) {
    const info = await findReleaseByTag(opts.tag, rootDir);
    if (!info) {
      log.error(`No GitHub release found for ${opts.tag}.`);
      process.exit(1);
    }
    candidates = [info];
  } else {
    candidates = await findStagedReleases(rootDir);
    if (candidates.length === 0) {
      log.info('No staged releases awaiting finalization.');
      return;
    }
  }

  // Workspace lookup gives us per-package registry/repo for building the live URL.
  // Best-effort: a release whose package has left the workspace still finalizes
  // against the default registry.
  const config = await loadConfig(rootDir);
  const { packages } = await discoverWorkspace(rootDir, config);

  let finalized = 0;
  let stillStaged = 0;

  for (const info of candidates) {
    const meta = info.metadata;
    if (!meta) {
      log.dim(`  ${info.tag} — no bumpy metadata, skipping`);
      continue;
    }

    const stagedTargets = Object.entries(meta.targets).filter(([, s]) => s.status === 'staged');
    if (stagedTargets.length === 0) {
      log.dim(`  ${info.tag} — nothing staged, skipping`);
      continue;
    }

    const parsed = parseTag(info.tag);
    if (!parsed) {
      log.warn(`  ${info.tag} — could not parse name@version, skipping`);
      continue;
    }
    const { name, version } = parsed;

    const pkg = packages.get(name);
    const pkgConfig = pkg?.bumpy;
    const registry = resolvePackageRegistry(pkg, pkgConfig);
    const repoSlug = parseRepoSlug(pkg?.packageJson?.repository) ?? process.env.GITHUB_REPOSITORY;

    // Is the staged version live on the registry now?
    const live = await checkIfPublished(name, version, pkgConfig);
    if (!live) {
      log.dim(`  ${colorize(info.tag, 'cyan')} — still staged, not yet live on the registry`);
      stillStaged++;
      continue;
    }

    // Flip every staged target to success.
    for (const [targetName] of stagedTargets) {
      const label = publishTargetLabel(targetName, registry);
      meta.targets[targetName] = {
        status: 'success',
        publishedAt: new Date().toISOString(),
        url: buildPublishUrl(name, version, targetName, { registry, repoSlug }),
        ...(label !== targetName ? { label } : {}),
      };
    }

    if (opts.dryRun) {
      log.dim(`  Would finalize ${info.tag} — now live`);
      finalized++;
      continue;
    }

    try {
      const updatedBody = updateReleaseBodyStatus(info.body, meta);
      await updateReleaseBody(info.tag, updatedBody, rootDir);

      // Publish the GitHub release only once every target is live (fires release: published).
      const allSucceeded = Object.values(meta.targets).every((t) => t.status === 'success');
      if (allSucceeded && info.isDraft) {
        await finalizeRelease(info.tag, rootDir);
      }
      log.success(`  Finalized ${colorize(info.tag, 'cyan')} — now live`);
      finalized++;
    } catch (err) {
      log.warn(`  Failed to finalize ${info.tag}: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (finalized > 0) log.success(`🐸 Finalized ${finalized} release(s)`);
  if (stillStaged > 0) log.info(`${stillStaged} release(s) still awaiting approval`);
}
