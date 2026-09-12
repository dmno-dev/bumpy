import { log } from '../utils/logger.ts';
import {
  composeReleaseBody,
  finalizeRelease,
  updateReleaseBody,
  updateReleaseBodyStatus,
  type PublishTargetState,
  type ReleaseMetadata,
} from './github-release.ts';
import { targetLabel } from './targets/registry.ts';
import type { ResolvedTarget } from './targets/types.ts';
import type { WorkspacePackage } from '../types.ts';

/**
 * Per-target release state, shared by the publish flow and any out-of-band
 * reconciliation (e.g. promoting staged publishes once they go live).
 */

/** A GitHub release bumpy manages: its tag, parsed metadata, current body, and draft-ness */
export interface ReleaseInfo {
  tag: string;
  metadata: ReleaseMetadata;
  existingBody: string | null;
  isDraft: boolean;
}

/** The metadata entry for a target whose version is live on its registry */
export function liveTargetState(
  target: ResolvedTarget,
  pkg: WorkspacePackage,
  version: string,
  repoSlug: string | undefined,
): PublishTargetState {
  const label = targetLabel(target, pkg);
  return {
    status: 'success',
    publishedAt: new Date().toISOString(),
    url: target.plugin.publishUrl?.(pkg, version, target.options, { repoSlug }),
    ...(label !== target.name ? { label } : {}),
  };
}

/**
 * Whether the release can be published: every release-phase target is live (success,
 * or skipped — e.g. a marketplace target on a prerelease) and at least one succeeded.
 * A `staged` target holds it open. Post-release targets consume the published release
 * and never gate it; a package with no release-phase targets is complete immediately.
 */
export function releaseComplete(metadata: ReleaseMetadata, targets: ResolvedTarget[]): boolean {
  const gating = targets.filter((t) => t.phase === 'release').map((t) => metadata.targets[t.name]);
  if (gating.length === 0) return true;
  return (
    gating.every((s) => s?.status === 'success' || s?.status === 'skipped') &&
    gating.some((s) => s?.status === 'success')
  );
}

/**
 * Write updated metadata back to the GitHub release, then finalize the draft once
 * `releaseComplete` holds.
 *
 * Metadata keys for targets that are no longer configured (renamed/removed mid-release)
 * are pruned unless they succeeded — a stale pending/failed entry would otherwise block
 * finalization forever.
 */
export async function reconcileRelease(
  info: ReleaseInfo,
  targets: ResolvedTarget[],
  changed: boolean,
  rootDir: string,
): Promise<void> {
  const currentNames = new Set(targets.map((t) => t.name));
  for (const [name, state] of Object.entries(info.metadata.targets)) {
    if (currentNames.has(name) || state.status === 'success') continue;
    log.warn(
      `  ${info.tag}: dropping "${name}" (${state.status}) from release metadata — target is no longer configured`,
    );
    delete info.metadata.targets[name];
    changed = true;
  }
  if (!changed && !info.isDraft) return;

  try {
    if (changed) {
      const updatedBody = info.existingBody
        ? updateReleaseBodyStatus(info.existingBody, info.metadata)
        : composeReleaseBody('', info.metadata);
      await updateReleaseBody(info.tag, updatedBody, rootDir);
    }

    if (info.isDraft && releaseComplete(info.metadata, targets)) {
      await finalizeRelease(info.tag, rootDir);
      info.isDraft = false;
      log.dim(`  Finalized release: ${info.tag}`);
    }
  } catch (err) {
    log.warn(`  Failed to update release for ${info.tag}: ${err instanceof Error ? err.message : err}`);
  }
}
