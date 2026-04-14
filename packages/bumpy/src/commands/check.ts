import { relative } from 'node:path';
import { log, colorize } from '../utils/logger.ts';
import { loadConfig } from '../core/config.ts';
import { discoverWorkspace } from '../core/workspace.ts';
import { readChangesets } from '../core/changeset.ts';
import { tryRun } from '../utils/shell.ts';
import type { WorkspacePackage } from '../types.ts';

/**
 * Local check: detect which packages have changed on this branch
 * and verify they have corresponding changesets.
 * Designed for pre-push hooks — no GitHub API needed.
 */
export async function checkCommand(rootDir: string): Promise<void> {
  const config = await loadConfig(rootDir);
  const { packages } = await discoverWorkspace(rootDir, config);
  const changesets = await readChangesets(rootDir);

  // Find which packages already have changesets
  const coveredPackages = new Set<string>();
  for (const cs of changesets) {
    for (const release of cs.releases) {
      coveredPackages.add(release.name);
    }
  }

  // Find which packages have changed on this branch vs base
  const baseBranch = config.baseBranch;
  const changedFiles = getChangedFiles(rootDir, baseBranch);

  if (changedFiles.length === 0) {
    log.info('No changed files detected.');
    return;
  }

  const changedPackages = findChangedPackages(changedFiles, packages, rootDir);

  if (changedPackages.length === 0) {
    log.info('No managed packages have changed.');
    return;
  }

  // Check which changed packages are missing changesets
  const missing = changedPackages.filter((name) => !coveredPackages.has(name));

  if (missing.length === 0) {
    log.success(`All ${changedPackages.length} changed package(s) have changesets.`);
    return;
  }

  // Report missing
  log.warn(`${missing.length} changed package(s) missing changesets:\n`);
  for (const name of missing) {
    console.log(`  ${colorize(name, 'yellow')}`);
  }
  console.log();
  log.dim('Run `bumpy add` to create a changeset, or `bumpy add --empty` if no release is needed.');
  process.exit(1);
}

/** Get files changed on this branch compared to the base branch */
function getChangedFiles(rootDir: string, baseBranch: string): string[] {
  // Try merge-base first (works on branches)
  const mergeBase = tryRun(`git merge-base HEAD origin/${baseBranch}`, { cwd: rootDir });
  const ref = mergeBase || `origin/${baseBranch}`;
  const diff = tryRun(`git diff --name-only ${ref}`, { cwd: rootDir });
  if (!diff) return [];
  return diff.split('\n').filter(Boolean);
}

/** Map changed files to the packages they belong to */
function findChangedPackages(
  changedFiles: string[],
  packages: Map<string, WorkspacePackage>,
  rootDir: string,
): string[] {
  const changed = new Set<string>();

  for (const file of changedFiles) {
    for (const [name, pkg] of packages) {
      const pkgRelDir = relative(rootDir, pkg.dir);
      if (file.startsWith(pkgRelDir + '/')) {
        changed.add(name);
      }
    }
  }

  return [...changed];
}
