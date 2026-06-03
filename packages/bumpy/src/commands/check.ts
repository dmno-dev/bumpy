import { relative, resolve } from 'node:path';
import picomatch from 'picomatch';
import { log, colorize } from '../utils/logger.ts';
import { loadConfig, loadPackageConfig, getBumpyDir } from '../core/config.ts';
import { discoverWorkspace } from '../core/workspace.ts';
import { readBumpFiles, filterBranchBumpFiles } from '../core/bump-file.ts';
import { getChangedFiles, getFileStatuses, getBaseCompareRef, readFileAtRef } from '../core/git.ts';
import {
  detectPackageManager,
  parseCatalogs,
  diffCatalogMaps,
  isCatalogRefAffected,
  CATALOG_FILES,
} from '../utils/package-manager.ts';
import { readText, exists } from '../utils/fs.ts';
import { DEP_TYPES } from '../types.ts';
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

  const hasEmptyBumpFile = effectiveEmptyIds.length > 0;

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

  // Check which changed packages are missing bump files
  const missing = changedPackages.filter((name) => !coveredPackages.has(name));

  // An empty bump file covers all remaining packages (in non-strict mode)
  // It acts as a blanket acknowledgment that non-publishable changes are expected
  const hasAnyCoverage = effectiveBumpFiles.length > 0 || hasEmptyBumpFile;
  const allCovered = missing.length === 0 || (hasEmptyBumpFile && !opts.strict);

  if (allCovered) {
    if (hasEmptyBumpFile && missing.length > 0) {
      // Empty bump file covers remaining packages — inform the user
      log.success('Empty bump file found — uncovered packages acknowledged.');
    } else {
      log.success(`🐸 All ${changedPackages.length} changed package(s) have bump files.`);
    }
    if (effectiveBumpFiles.length > 0) {
      printBumpFileList(
        effectiveBumpFiles.map((bf) => bf.id),
        bumpyRelDir,
        bumpFileStatuses,
      );
    }
    return;
  }

  // Determine failure behavior
  // - No coverage at all: fail by default (unless --no-fail)
  // - Partial coverage: fail only with --strict (unless --no-fail)
  const willFail = !opts.noFail && (opts.strict || !hasAnyCoverage);

  (willFail ? log.error : log.warn)(`${missing.length} changed package(s) missing bump files:\n`);
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
  if (willFail) process.exit(1);
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

  // Catalog change detection: if a catalog file changed, find packages whose
  // catalog: dep references resolve to a changed catalog entry
  const catalogChanges = await getChangedCatalogEntries(rootDir, config.baseBranch, changedFiles);
  if (catalogChanges.size > 0) {
    for (const [name, pkg] of packages) {
      if (changed.has(name)) continue;
      for (const depType of DEP_TYPES) {
        const deps = pkg[depType];
        let matched = false;
        for (const [depName, range] of Object.entries(deps)) {
          if (isCatalogRefAffected(range, depName, catalogChanges)) {
            changed.add(name);
            matched = true;
            break;
          }
        }
        if (matched) break;
      }
    }
  }

  return [...changed];
}

/**
 * Compute which catalog entries changed between the base ref and HEAD.
 * Returns Map<catalogName, Set<depName>>. Empty if no catalog files changed.
 */
async function getChangedCatalogEntries(
  rootDir: string,
  baseBranch: string,
  changedFiles: string[],
): Promise<Map<string, Set<string>>> {
  const catalogFileChanged = changedFiles.some((f) => (CATALOG_FILES as readonly string[]).includes(f));
  if (!catalogFileChanged) return new Map();

  const baseRef = getBaseCompareRef(rootDir, baseBranch);

  const pm = await detectPackageManager(rootDir);

  // Load "after" (current working tree state)
  const afterYaml =
    pm === 'pnpm' && (await exists(resolve(rootDir, 'pnpm-workspace.yaml')))
      ? await readText(resolve(rootDir, 'pnpm-workspace.yaml'))
      : null;
  const afterPkgJson = (await exists(resolve(rootDir, 'package.json')))
    ? await readText(resolve(rootDir, 'package.json'))
    : null;
  const afterCatalogs = parseCatalogs(afterYaml, afterPkgJson);

  // Load "before" (state at base ref). pnpm-workspace.yaml is only relevant for pnpm.
  const beforeYaml = pm === 'pnpm' ? readFileAtRef(rootDir, baseRef, 'pnpm-workspace.yaml') : null;
  const beforePkgJson = readFileAtRef(rootDir, baseRef, 'package.json');
  const beforeCatalogs = parseCatalogs(beforeYaml, beforePkgJson);

  return diffCatalogMaps(beforeCatalogs, afterCatalogs);
}
