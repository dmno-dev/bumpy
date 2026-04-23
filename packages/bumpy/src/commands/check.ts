import { relative } from 'node:path';
import picomatch from 'picomatch';
import { log, colorize } from '../utils/logger.ts';
import { loadConfig, loadPackageConfig, getBumpyDir } from '../core/config.ts';
import { discoverWorkspace } from '../core/workspace.ts';
import { readBumpFiles, filterBranchBumpFiles } from '../core/bump-file.ts';
import { getChangedFiles } from '../core/git.ts';
import type { BumpyConfig, WorkspacePackage } from '../types.ts';

interface CheckOptions {
  strict?: boolean;
  noFail?: boolean;
}

/**
 * Local check: detect which packages have changed on this branch
 * and verify they have corresponding bump files.
 * Designed for pre-push hooks — no GitHub API needed.
 *
 * Default: at least one bump file must exist, uncovered packages are warned.
 * --strict: every changed package must be covered.
 * --no-fail: warn only, never exit 1.
 */
export async function checkCommand(rootDir: string, opts: CheckOptions = {}): Promise<void> {
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
  const { bumpFiles: allBumpFiles, errors: parseErrors } = await readBumpFiles(rootDir);
  if (parseErrors.length > 0) {
    for (const err of parseErrors) {
      log.error(err);
    }
    process.exit(1);
  }
  const { branchBumpFiles, emptyBumpFileIds } = filterBranchBumpFiles(allBumpFiles, changedFiles, rootDir);

  // If an empty bump file exists on this branch, the check passes
  if (emptyBumpFileIds.length > 0) {
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

  // No bump files at all — fail by default
  const willFailNoBump = !opts.noFail;
  if (branchBumpFiles.length === 0) {
    (willFailNoBump ? log.error : log.warn)(`${changedPackages.length} changed package(s) missing bump files:\n`);
    for (const name of changedPackages) {
      console.log(`  ${colorize(name, 'yellow')}`);
    }
    console.log();
    log.dim('Run `bumpy add` to create a bump file, or `bumpy add --empty` if no release is needed.');
    log.dim('To adjust which files trigger change detection, set `changedFilePatterns` in .bumpy/_config.json.');
    if (willFailNoBump) process.exit(1);
    return;
  }

  // Check which changed packages are missing bump files
  const missing = changedPackages.filter((name) => !coveredPackages.has(name));

  if (missing.length === 0) {
    log.success(`🐸 All ${changedPackages.length} changed package(s) have bump files.`);
    return;
  }

  // Some packages uncovered — warn by default, fail with --strict
  const willFailUncovered = opts.strict && !opts.noFail;
  (willFailUncovered ? log.error : log.warn)(`${missing.length} changed package(s) missing bump files:\n`);
  for (const name of missing) {
    console.log(`  ${colorize(name, 'yellow')}`);
  }

  if (branchBumpFiles.length > 0) {
    console.log();
    log.dim(`Existing bump files on this branch:`);
    for (const bf of branchBumpFiles) {
      log.dim(`  ${getBumpyDir(rootDir)}/${bf.id}.md`);
    }
  }

  console.log();
  if (opts.strict) {
    log.dim(
      "Run `bumpy add` to create a bump file. Use bump type `none` for packages that changed but don't need a release.",
    );
  } else {
    log.dim('Run `bumpy add` to create a bump file, or `bumpy add --empty` if no release is needed.');
  }
  log.dim('To adjust which files trigger change detection, set `changedFilePatterns` in .bumpy/_config.json.');
  if (willFailUncovered) process.exit(1);
}

/** Map changed files to the packages they belong to */
export async function findChangedPackages(
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
