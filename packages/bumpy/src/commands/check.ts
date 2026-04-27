import { relative } from 'node:path';
import picomatch from 'picomatch';
import { log, colorize } from '../utils/logger.ts';
import { loadConfig, loadPackageConfig, getBumpyDir } from '../core/config.ts';
import { discoverWorkspace } from '../core/workspace.ts';
import { readBumpFiles, filterBranchBumpFiles } from '../core/bump-file.ts';
import { getChangedFiles, getFileStatuses } from '../core/git.ts';
import type { BumpyConfig, WorkspacePackage } from '../types.ts';

export type HookContext = 'pre-commit' | 'pre-push';

interface CheckOptions {
  strict?: boolean;
  noFail?: boolean;
  hook?: HookContext;
}

/**
 * Local check: detect which packages have changed on this branch
 * and verify they have corresponding bump files.
 * Designed for pre-push hooks — no GitHub API needed.
 *
 * Default: at least one bump file must exist, uncovered packages are warned.
 * --strict: every changed package must be covered.
 * --no-fail: warn only, never exit 1.
 * --hook pre-commit: only staged + committed bump files count.
 * --hook pre-push: only committed bump files count.
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

  // Get git status of bump files to detect untracked/staged files
  const bumpyDir = getBumpyDir(rootDir);
  const bumpyRelDir = relative(rootDir, bumpyDir);
  const fileStatuses = getFileStatuses(bumpyRelDir, { cwd: rootDir });

  // Augment changedFiles with untracked/staged bump files that aren't already in the list
  const augmentedChangedFiles = [...changedFiles];
  for (const [file] of fileStatuses) {
    if (file.endsWith('.md') && !file.endsWith('README.md') && !augmentedChangedFiles.includes(file)) {
      augmentedChangedFiles.push(file);
    }
  }

  const { branchBumpFiles, emptyBumpFileIds } = filterBranchBumpFiles(allBumpFiles, augmentedChangedFiles, rootDir);

  // Determine which bump files count based on hook context
  const bumpFileStatuses = new Map<string, 'committed' | 'staged' | 'untracked'>();
  for (const bf of branchBumpFiles) {
    const filePath = `${bumpyRelDir}/${bf.id}.md`;
    const status = fileStatuses.get(filePath);
    bumpFileStatuses.set(bf.id, status ?? 'committed');
  }
  for (const id of emptyBumpFileIds) {
    const filePath = `${bumpyRelDir}/${id}.md`;
    const status = fileStatuses.get(filePath);
    bumpFileStatuses.set(id, status ?? 'committed');
  }

  // Filter bump files based on hook context
  const effectiveBumpFiles = opts.hook
    ? branchBumpFiles.filter((bf) => {
        const status = bumpFileStatuses.get(bf.id)!;
        if (opts.hook === 'pre-push') return status === 'committed';
        if (opts.hook === 'pre-commit') return status !== 'untracked';
        return true;
      })
    : branchBumpFiles;

  const effectiveEmptyIds = opts.hook
    ? emptyBumpFileIds.filter((id) => {
        const status = bumpFileStatuses.get(id)!;
        if (opts.hook === 'pre-push') return status === 'committed';
        if (opts.hook === 'pre-commit') return status !== 'untracked';
        return true;
      })
    : emptyBumpFileIds;

  // Warn about bump files that won't count in the current hook context
  if (opts.hook) {
    const excludedBumpFiles = branchBumpFiles.filter((bf) => !effectiveBumpFiles.includes(bf));
    const excludedEmptyIds = emptyBumpFileIds.filter((id) => !effectiveEmptyIds.includes(id));

    for (const bf of excludedBumpFiles) {
      const status = bumpFileStatuses.get(bf.id)!;
      if (opts.hook === 'pre-push' && status === 'staged') {
        log.warn(`${bumpyRelDir}/${bf.id}.md is staged but not committed — it won't be included in the push`);
      } else if (status === 'untracked') {
        log.warn(`${bumpyRelDir}/${bf.id}.md is untracked — run \`git add\` to include it`);
      }
    }
    for (const id of excludedEmptyIds) {
      const status = bumpFileStatuses.get(id)!;
      if (opts.hook === 'pre-push' && status === 'staged') {
        log.warn(`${bumpyRelDir}/${id}.md is staged but not committed — it won't be included in the push`);
      } else if (status === 'untracked') {
        log.warn(`${bumpyRelDir}/${id}.md is untracked — run \`git add\` to include it`);
      }
    }
  }

  // If an empty bump file exists on this branch, the check passes
  if (effectiveEmptyIds.length > 0) {
    log.success('Empty bump file found — no releases needed.');
    return;
  }

  // Find which packages are covered by bump files on this branch
  const coveredPackages = new Set<string>();
  for (const bf of effectiveBumpFiles) {
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
  if (effectiveBumpFiles.length === 0) {
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
    printBumpFileList(
      effectiveBumpFiles.map((bf) => bf.id),
      bumpyRelDir,
      bumpFileStatuses,
    );
    return;
  }

  // Some packages uncovered — warn by default, fail with --strict
  const willFailUncovered = opts.strict && !opts.noFail;
  (willFailUncovered ? log.error : log.warn)(`${missing.length} changed package(s) missing bump files:\n`);
  for (const name of missing) {
    console.log(`  ${colorize(name, 'yellow')}`);
  }

  if (effectiveBumpFiles.length > 0) {
    console.log();
    printBumpFileList(
      effectiveBumpFiles.map((bf) => bf.id),
      bumpyRelDir,
      bumpFileStatuses,
    );
  }

  console.log();
  if (opts.strict) {
    log.dim(
      "Run `bumpy add` to create a bump file. Use bump type `none` for packages that changed but don't need a bump.",
    );
  } else {
    log.dim('Run `bumpy add` to create a bump file, or `bumpy add --empty` if no release is needed.');
  }
  log.dim('To adjust which files trigger change detection, set `changedFilePatterns` in .bumpy/_config.json.');
  if (willFailUncovered) process.exit(1);
}

function printBumpFileList(
  ids: string[],
  bumpyRelDir: string,
  statuses: Map<string, 'committed' | 'staged' | 'untracked'>,
): void {
  log.dim('Bump files on this branch:');
  for (const id of ids) {
    const status = statuses.get(id);
    const statusLabel =
      status === 'staged'
        ? colorize(' (staged)', 'yellow')
        : status === 'untracked'
          ? colorize(' (untracked)', 'yellow')
          : '';
    log.dim(`  ${bumpyRelDir}/${id}.md${statusLabel}`);
  }
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
