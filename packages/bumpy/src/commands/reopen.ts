import { log, colorize } from '../utils/logger.ts';
import { isGhAvailable, findReleaseByTag, updateReleaseBody, updateReleaseBodyStatus } from '../core/github-release.ts';

export interface ReopenCommandOptions {
  /** The rejected release to reopen (`name@version`). */
  tag: string;
  dryRun?: boolean;
}

/**
 * Reopen a staged release whose staged publish was rejected on npm.
 *
 * npm exposes no public "rejected" signal (a rejected stage looks identical to a still-pending
 * one — both are simply not live), and the finalize job is intentionally credential-free, so
 * bumpy can't auto-detect a rejection. Instead the maintainer (or their approval tooling) runs
 * this after `npm stage reject <stage-id>`.
 *
 * It flips the staged target(s) back to `failed`, which reuses bumpy's existing fix-forward
 * path: the stale 🟡 clears, the version tag un-freezes (a `failed` target isn't "shipped"),
 * and the next `bumpy publish` re-stages the same version. To abandon the version instead, just
 * don't reopen — the next version bump supersedes the draft.
 */
export async function reopenCommand(rootDir: string, opts: ReopenCommandOptions): Promise<void> {
  if (!isGhAvailable()) {
    log.error('gh CLI not found — cannot reopen a staged release.');
    process.exit(1);
  }

  const info = await findReleaseByTag(opts.tag, rootDir);
  if (!info) {
    log.error(`No GitHub release found for ${opts.tag}.`);
    process.exit(1);
  }
  const meta = info.metadata;
  if (!meta) {
    log.error(`${opts.tag} has no bumpy metadata — nothing to reopen.`);
    process.exit(1);
  }

  const stagedTargets = Object.entries(meta.targets).filter(([, s]) => s.status === 'staged');
  if (stagedTargets.length === 0) {
    log.info(`${opts.tag} has no staged targets — nothing to reopen.`);
    return;
  }

  for (const [targetName, state] of stagedTargets) {
    meta.targets[targetName] = {
      status: 'failed',
      error: 'staged publish was rejected — will re-stage on next publish',
      lastAttempt: new Date().toISOString(),
      ...(state.label ? { label: state.label } : {}),
    };
  }

  if (opts.dryRun) {
    log.dim(`  Would reopen ${opts.tag} — ${stagedTargets.length} staged target(s) → failed`);
    return;
  }

  const updatedBody = updateReleaseBodyStatus(info.body, meta);
  await updateReleaseBody(opts.tag, updatedBody, rootDir);
  log.success(`  Reopened ${colorize(opts.tag, 'cyan')} — will re-stage on the next publish run`);
}
