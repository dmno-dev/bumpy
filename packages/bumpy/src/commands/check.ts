import { relative } from 'node:path';
import picomatch from 'picomatch';
import { log, colorize } from '../utils/logger.ts';
import { loadConfig, loadPackageConfig } from '../core/config.ts';
import { discoverWorkspace } from '../core/workspace.ts';
import { readBumpFiles, filterBranchBumpFiles } from '../core/bump-file.ts';
import { getChangedFiles } from '../core/git.ts';
import type { BumpyConfig, WorkspacePackage } from '../types.ts';

/**
 * Local check: detect which packages have changed on this branch
 * and verify they have corresponding bump files.
 * Designed for pre-push hooks — no GitHub API needed.
 */
export async function checkCommand(rootDir: string): Promise<void> {
  const config = await loadConfig(rootDir);
  const { packages } = await discoverWorkspace(rootDir, config);

  // Find which files have changed on this branch vs base
  const baseBranch = config.baseBranch;
  const changedFiles = getChangedFiles(rootDir, baseBranch);

  if (changedFiles.length === 0) {
    log.info('No changed files detected.');
    return;
  }

  // Filter to only bump files added/modified on this branch
  const allBumpFiles = await readBumpFiles(rootDir);
  const { branchBumpFiles, branchBumpFileIds } = filterBranchBumpFiles(allBumpFiles, changedFiles);

  // If a bump file was changed but didn't parse (empty bump file), the check passes
  const hasEmptyBumpFile = branchBumpFileIds.size > branchBumpFiles.length;
  if (hasEmptyBumpFile) {
    log.success('Empty bump file found — no releases needed.');
    return;
  }

  // Find which packages are covered by bump files on this branch
  const coveredPackages = new Set<string>();
  for (const bf of branchBumpFiles) {
    for (const release of bf.releases) {
      coveredPackages.add(release.name);
    }
  }

  const changedPackages = await findChangedPackages(changedFiles, packages, rootDir, config);

  if (changedPackages.length === 0) {
    log.info('No managed packages have changed.');
    return;
  }

  // Check which changed packages are missing bump files
  const missing = changedPackages.filter((name) => !coveredPackages.has(name));

  if (missing.length === 0) {
    log.success(`All ${changedPackages.length} changed package(s) have bump files.`);
    return;
  }

  // Report missing
  log.warn(`${missing.length} changed package(s) missing bump files:\n`);
  for (const name of missing) {
    console.log(`  ${colorize(name, 'yellow')}`);
  }
  console.log();
  log.dim('Run `bumpy add` to create a bump file, or `bumpy add --empty` if no release is needed.');
  process.exit(1);
}

/** Map changed files to the packages they belong to */
async function findChangedPackages(
  changedFiles: string[],
  packages: Map<string, WorkspacePackage>,
  rootDir: string,
  config: BumpyConfig,
): Promise<string[]> {
  const changed = new Set<string>();

  // Build per-package matchers (per-package patterns override root patterns)
  const matchers = new Map<string, picomatch.Matcher>();
  for (const [name, pkg] of packages) {
    const pkgConfig = await loadPackageConfig(pkg.dir, config, name);
    const patterns = pkgConfig.changedFilePatterns ?? config.changedFilePatterns;
    matchers.set(name, picomatch(patterns));
  }

  for (const file of changedFiles) {
    for (const [name, pkg] of packages) {
      const pkgRelDir = relative(rootDir, pkg.dir);
      if (file.startsWith(pkgRelDir + '/')) {
        const relToPackage = file.slice(pkgRelDir.length + 1);
        if (matchers.get(name)!(relToPackage)) {
          changed.add(name);
        }
      }
    }
  }

  return [...changed];
}
