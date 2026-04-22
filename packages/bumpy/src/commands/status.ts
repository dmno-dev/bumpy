import { log, colorize } from '../utils/logger.ts';
import { loadConfig } from '../core/config.ts';
import { discoverPackages } from '../core/workspace.ts';
import { DependencyGraph } from '../core/dep-graph.ts';
import { readBumpFiles, filterBranchBumpFiles } from '../core/bump-file.ts';
import { assembleReleasePlan } from '../core/release-plan.ts';
import { getCurrentBranch, getChangedFiles } from '../core/git.ts';
import type { BumpyConfig, PackageConfig, PlannedRelease, WorkspacePackage } from '../types.ts';

interface StatusOptions {
  json?: boolean;
  /** Output only package names, one per line (useful for piping) */
  packagesOnly?: boolean;
  /** Filter to specific bump types: "major", "minor", "patch" */
  bumpType?: string;
  /** Filter to specific packages (comma-separated names or globs) */
  filter?: string;
  /** Show verbose output including bump file details */
  verbose?: boolean;
}

export async function statusCommand(rootDir: string, opts: StatusOptions): Promise<void> {
  const config = await loadConfig(rootDir);
  const packages = await discoverPackages(rootDir, config);
  const depGraph = new DependencyGraph(packages);
  const { bumpFiles, errors: parseErrors } = await readBumpFiles(rootDir);

  if (parseErrors.length > 0) {
    for (const err of parseErrors) {
      log.error(err);
    }
  }

  if (bumpFiles.length === 0) {
    if (opts.json) {
      console.log(JSON.stringify({ bumpFiles: [], releases: [], packageNames: [] }, null, 2));
    } else if (!opts.packagesOnly) {
      log.info('No pending bump files.');
    }
    process.exit(1); // exit 1 = no releases pending (useful for CI)
  }

  const plan = assembleReleasePlan(bumpFiles, packages, depGraph, config);

  // Determine which bump files belong to the current branch (if not on base branch)
  let branchBumpFileIds: Set<string> | undefined;
  const currentBranch = getCurrentBranch({ cwd: rootDir });
  if (currentBranch && currentBranch !== config.baseBranch) {
    const changedFiles = getChangedFiles(rootDir, config.baseBranch);
    const result = filterBranchBumpFiles(bumpFiles, changedFiles, rootDir);
    branchBumpFileIds = result.branchBumpFileIds;
  }

  // Apply filters
  let releases = plan.releases;
  if (opts.bumpType) {
    const types = opts.bumpType.split(',').map((t) => t.trim());
    releases = releases.filter((r) => types.includes(r.type));
  }
  if (opts.filter) {
    const { matchGlob } = await import('../core/config.ts');
    const patterns = opts.filter.split(',').map((p) => p.trim());
    releases = releases.filter((r) => patterns.some((p) => matchGlob(r.name, p)));
  }

  if (opts.json) {
    const jsonOutput = {
      bumpFiles: plan.bumpFiles.map((bf) => ({
        id: bf.id,
        summary: bf.summary,
        releases: bf.releases.map((r) => ({ name: r.name, type: r.type })),
        ...(branchBumpFileIds ? { inCurrentBranch: branchBumpFileIds.has(bf.id) } : {}),
      })),
      releases: releases.map((r) => {
        const pkg = packages.get(r.name);
        const pkgConfig = pkg?.bumpy || {};
        return {
          name: r.name,
          type: r.type,
          oldVersion: r.oldVersion,
          newVersion: r.newVersion,
          dir: pkg?.relativeDir,
          bumpFiles: r.bumpFiles,
          isDependencyBump: r.isDependencyBump,
          isCascadeBump: r.isCascadeBump,
          ...(branchBumpFileIds
            ? {
                inCurrentBranch: r.bumpFiles.some((id) => branchBumpFileIds!.has(id)),
              }
            : {}),
          publishTargets: getPublishTargets(pkg, pkgConfig, config),
        };
      }),
      packageNames: releases.map((r) => r.name),
    };
    console.log(JSON.stringify(jsonOutput, null, 2));
    return;
  }

  if (opts.packagesOnly) {
    for (const r of releases) {
      console.log(r.name);
    }
    return;
  }

  // Pretty output
  log.bold(`${bumpFiles.length} bump file(s) pending\n`);

  if (releases.length === 0) {
    log.warn('No packages match the current filters.');
    return;
  }

  // Group by bump type
  const groups: [string, string, PlannedRelease[]][] = [
    ['Major', 'red', releases.filter((r) => r.type === 'major')],
    ['Minor', 'yellow', releases.filter((r) => r.type === 'minor')],
    ['Patch', 'green', releases.filter((r) => r.type === 'patch')],
  ];

  for (const [label, color, group] of groups) {
    if (group.length === 0) continue;
    log.bold(colorize(label, color as 'red' | 'yellow' | 'green'));
    for (const r of group) {
      printRelease(r, packages);
    }
    console.log();
  }

  // Show warnings from the release plan
  if (plan.warnings.length > 0) {
    for (const w of plan.warnings) {
      log.warn(w);
    }
    console.log();
  }

  if (opts.verbose) {
    log.bold('Bump files:');
    for (const bf of plan.bumpFiles) {
      console.log(`  ${colorize(bf.id, 'cyan')}`);
      for (const r of bf.releases) {
        console.log(`    ${r.name}: ${r.type}`);
      }
      if (bf.summary) {
        console.log(`    ${colorize(bf.summary.split('\n')[0]!, 'dim')}`);
      }
    }
  }
}

function printRelease(r: PlannedRelease, packages: Map<string, WorkspacePackage>) {
  const pkg = packages.get(r.name);
  const dir = pkg ? colorize(` (${pkg.relativeDir})`, 'dim') : '';
  const suffix = r.isDependencyBump
    ? colorize(' ← dependency bump', 'dim')
    : r.isCascadeBump
      ? colorize(' ← cascade', 'dim')
      : '';
  console.log(`  ${r.name}: ${r.oldVersion} → ${colorize(r.newVersion, 'cyan')}${suffix}${dir}`);
}

/** Determine which publish targets a package will use */
function getPublishTargets(
  pkg: WorkspacePackage | undefined,
  pkgConfig: Partial<PackageConfig>,
  _config: BumpyConfig,
): string[] {
  if (!pkg) return [];
  // Private packages with no custom command won't publish
  if (pkg.private && !pkgConfig.publishCommand) return [];
  const targets: string[] = [];
  if (pkgConfig.publishCommand) {
    targets.push('custom');
  }
  if (!pkgConfig.publishCommand && !pkgConfig.skipNpmPublish) {
    targets.push('npm');
  }
  return targets;
}
