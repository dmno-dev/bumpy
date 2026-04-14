import { log, colorize } from "../utils/logger.ts";
import { loadConfig } from "../core/config.ts";
import { discoverWorkspace } from "../core/workspace.ts";
import { DependencyGraph } from "../core/dep-graph.ts";
import { pushWithTags, hasUncommittedChanges } from "../core/git.ts";
import { publishPackages, type PublishOptions } from "../core/publish-pipeline.ts";
import { createIndividualReleases, createAggregateRelease } from "../core/github-release.ts";
import { detectWorkspaces } from "../utils/package-manager.ts";
import type { ReleasePlan, PlannedRelease, WorkspacePackage } from "../types.ts";

interface PublishCommandOptions {
  dryRun?: boolean;
  tag?: string;
  noPush?: boolean;
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
    log.warn("You have uncommitted changes. Commit or stash them before publishing.");
    process.exit(1);
  }

  // Find packages that need publishing by checking which ones have versions
  // not yet on the registry
  const toPublish = await findUnpublishedPackages(packages, config);

  if (toPublish.length === 0) {
    log.info("No unpublished packages found.");
    return;
  }

  // Build a synthetic release plan from unpublished packages
  const releasePlan: ReleasePlan = {
    changesets: [],
    releases: toPublish,
  };

  if (opts.dryRun) {
    log.bold("Dry run — would publish:");
  } else {
    log.bold("Publishing:");
  }
  for (const r of toPublish) {
    console.log(`  ${r.name}@${colorize(r.newVersion, "cyan")}`);
  }
  console.log();

  const result = await publishPackages(releasePlan, packages, depGraph, config, rootDir, {
    dryRun: opts.dryRun,
    tag: opts.tag,
  }, catalogs, detectedPm);

  // Summary
  if (result.published.length > 0) {
    log.success(`Published ${result.published.length} package(s)`);
  }
  if (result.skipped.length > 0) {
    log.dim(`Skipped ${result.skipped.length}: ${result.skipped.map((s) => s.name).join(", ")}`);
  }
  if (result.failed.length > 0) {
    log.error(`Failed ${result.failed.length}: ${result.failed.map((f) => `${f.name} (${f.error})`).join(", ")}`);
    process.exit(1);
  }

  // Push tags
  if (!opts.dryRun && !opts.noPush && result.published.length > 0) {
    try {
      log.step("Pushing tags...");
      pushWithTags({ cwd: rootDir });
      log.success("Pushed tags to remote");
    } catch (err) {
      log.warn(`Failed to push tags: ${err instanceof Error ? err.message : err}`);
    }
  }

  // GitHub releases
  if (result.published.length > 0) {
    const publishedReleases = releasePlan.releases.filter((r) =>
      result.published.some((p) => p.name === r.name)
    );
    const aggConfig = config.aggregateRelease;
    const isAggregate = aggConfig === true || (typeof aggConfig === "object" && aggConfig.enabled);
    const aggTitle = typeof aggConfig === "object" ? aggConfig.title : undefined;

    if (isAggregate) {
      await createAggregateRelease(publishedReleases, releasePlan.changesets, rootDir, {
        dryRun: opts.dryRun,
        title: aggTitle,
      });
    } else {
      await createIndividualReleases(publishedReleases, releasePlan.changesets, rootDir, {
        dryRun: opts.dryRun,
      });
    }
  }
}

/**
 * Find packages whose current version is not on the npm registry.
 * Falls back to checking git tags if npm info fails.
 */
async function findUnpublishedPackages(
  packages: Map<string, WorkspacePackage>,
  config: Record<string, unknown> & { privatePackages: { version: boolean } },
): Promise<PlannedRelease[]> {
  const unpublished: PlannedRelease[] = [];

  for (const [name, pkg] of packages) {
    // Skip private packages unless they have custom publish config
    if (pkg.private && !pkg.bumpy?.publishCommand) continue;
    // Skip ignored
    if (pkg.version === "0.0.0") continue;

    const isPublished = await checkIfPublished(name, pkg.version, pkg.bumpy?.registry);
    if (!isPublished) {
      unpublished.push({
        name,
        type: "patch", // doesn't matter for publish, just needs a value
        oldVersion: pkg.version, // we don't know the old version
        newVersion: pkg.version,
        changesets: [],
        isDependencyBump: false,
        isCascadeBump: false,
      });
    }
  }

  return unpublished;
}

async function checkIfPublished(name: string, version: string, registry?: string): Promise<boolean> {
  try {
    const { runAsync } = await import("../utils/shell.ts");
    const regFlag = registry ? `--registry ${registry}` : "";
    const result = await runAsync(`npm info "${name}@${version}" version ${regFlag}`.trim());
    return result === version;
  } catch {
    // Package doesn't exist on registry yet, or network error
    return false;
  }
}
