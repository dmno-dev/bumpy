import { readdir, unlink } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { getBumpyDir, matchGlob } from './config.ts';
import { writeBumpFile } from './bump-file.ts';
import { readFileAtRef } from './git.ts';
import { catalogYamlFile, detectPackageManager, parseCatalogs, resolveCatalogDep } from '../utils/package-manager.ts';
import type { CatalogMap } from '../utils/package-manager.ts';
import { ensureDir, exists, readText } from '../utils/fs.ts';
import { slugify } from '../utils/names.ts';
import { DEP_TYPES } from '../types.ts';
import type { BumpyConfig, DepType, WorkspacePackage } from '../types.ts';

/**
 * Auto-generated bump files for dependency updates (Dependabot, Renovate, …).
 *
 * Modeled on the-guild-org/changesets-dependencies-action: diff each managed package's
 * `package.json` dependency fields against the base, and write one patch bump file per
 * affected package whose summary lists the changed deps. Files are named
 * deterministically (`deps-<suffix>-<pkg>.md`) so re-running regenerates them in place
 * and removes ones that no longer apply.
 */

export interface DependencyChange {
  name: string;
  depType: DepType;
  kind: 'added' | 'updated' | 'removed';
  /** Range before (absent for `added`) — catalog refs resolved to the catalog's range */
  from?: string;
  /** Range after (absent for `removed`) — catalog refs resolved to the catalog's range */
  to?: string;
}

/** Bump file id prefix for all auto-generated dependency bump files */
export const DEP_BUMP_FILE_PREFIX = 'deps-';

/** File id for a package's generated dependency bump file, e.g. `deps-pr42-myorg-core` */
export function depBumpFileId(suffix: string, pkgName: string): string {
  return `${DEP_BUMP_FILE_PREFIX}${slugify(suffix)}-${slugify(pkgName)}`;
}

/**
 * The dependency fields whose changes should produce a release for this package: the
 * ones that affect what consumers install (everything not in `ignoredPackageJsonFields`),
 * plus `devDependencies` entries matching the package's `releaseTriggeringDevDeps`.
 */
function isReleaseRelevantDep(depType: DepType, depName: string, pkg: WorkspacePackage, ignored: Set<string>): boolean {
  if (!ignored.has(depType)) return true;
  if (depType !== 'devDependencies') return false;
  return (pkg.bumpy?.releaseTriggeringDevDeps ?? []).some((pattern) => matchGlob(depName, pattern));
}

/** Internal workspace deps are handled by bumpy's own cascade/propagation — not "dependency updates" */
function isWorkspaceRange(range: string | undefined): boolean {
  return !!range && range.startsWith('workspace:');
}

function resolveRange(depName: string, range: string | undefined, catalogs: CatalogMap): string | undefined {
  if (range === undefined) return undefined;
  return resolveCatalogDep(depName, range, catalogs) ?? range;
}

async function loadCatalogsAt(rootDir: string, ref: string | null): Promise<CatalogMap> {
  const pm = await detectPackageManager(rootDir);
  const yamlFile = catalogYamlFile(pm);
  if (ref) {
    return parseCatalogs(
      yamlFile ? readFileAtRef(rootDir, ref, yamlFile) : null,
      readFileAtRef(rootDir, ref, 'package.json'),
    );
  }
  const read = async (file: string) =>
    (await exists(resolve(rootDir, file))) ? readText(resolve(rootDir, file)) : null;
  return parseCatalogs(yamlFile ? await read(yamlFile) : null, await read('package.json'));
}

/**
 * Diff the release-relevant dependencies of every managed package between `baseRef` and
 * the working tree. Packages that are new on this branch, or opt out of direct bumps
 * (`directBump: false`), are skipped. Catalog refs (`catalog:`) are resolved on both
 * sides, so a catalog-only update is reported against every package that uses it.
 */
export async function detectDependencyChanges(
  rootDir: string,
  config: BumpyConfig,
  packages: Map<string, WorkspacePackage>,
  baseRef: string,
): Promise<Map<string, DependencyChange[]>> {
  const ignored = new Set(config.ignoredPackageJsonFields ?? ['devDependencies']);
  const [beforeCatalogs, afterCatalogs] = await Promise.all([
    loadCatalogsAt(rootDir, baseRef),
    loadCatalogsAt(rootDir, null),
  ]);

  const result = new Map<string, DependencyChange[]>();
  for (const [name, pkg] of packages) {
    if (pkg.bumpy?.directBump === false) continue;

    const pkgRelDir = relative(rootDir, pkg.dir);
    const relPath = pkgRelDir ? `${pkgRelDir}/package.json` : 'package.json';
    const beforeRaw = readFileAtRef(rootDir, baseRef, relPath);
    if (beforeRaw == null) continue; // new package — not a dependency update
    let before: Record<string, unknown>;
    try {
      before = JSON.parse(beforeRaw);
    } catch {
      continue;
    }

    const changes: DependencyChange[] = [];
    for (const depType of DEP_TYPES) {
      const beforeDeps = (before[depType] ?? {}) as Record<string, string>;
      const afterDeps = pkg[depType] ?? {};
      const depNames = [...new Set([...Object.keys(beforeDeps), ...Object.keys(afterDeps)])].sort();
      for (const depName of depNames) {
        if (!isReleaseRelevantDep(depType, depName, pkg, ignored)) continue;
        const rawFrom = beforeDeps[depName];
        const rawTo = afterDeps[depName];
        if (isWorkspaceRange(rawFrom) || isWorkspaceRange(rawTo)) continue;
        const from = resolveRange(depName, rawFrom, beforeCatalogs);
        const to = resolveRange(depName, rawTo, afterCatalogs);
        if (from === to) continue;
        const kind = from === undefined ? 'added' : to === undefined ? 'removed' : 'updated';
        changes.push({ name: depName, depType, kind, from, to });
      }
    }
    if (changes.length > 0) result.set(name, changes);
  }
  return result;
}

/** Best-effort `x.y.z` from a range like `^1.2` or `~1.2.3-beta.1`, for the npm link */
function coerceVersion(range: string): string | null {
  const match = range.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?(-[0-9A-Za-z.-]+)?/);
  if (!match) return null;
  return `${match[1]}.${match[2] ?? 0}.${match[3] ?? 0}${match[4] ?? ''}`;
}

function formatDep(name: string, range: string): string {
  const label = `\`${name}@${range}\``;
  // Only link registry ranges — not git/file/link/npm-alias specifiers
  const version = range.includes(':') || range.includes('/') ? null : coerceVersion(range);
  return version ? `[${label} ↗︎](https://www.npmjs.com/package/${name}/v/${version})` : label;
}

/** One changelog line per changed dependency (same wording as changesets-dependencies-action) */
export function formatDependencyChange(change: DependencyChange): string {
  switch (change.kind) {
    case 'added':
      return `Added dependency ${formatDep(change.name, change.to!)} (to \`${change.depType}\`)`;
    case 'updated':
      return `Updated dependency ${formatDep(change.name, change.to!)} (from \`${change.from}\`, in \`${change.depType}\`)`;
    case 'removed':
      return `Removed dependency ${formatDep(change.name, change.from!)} (from \`${change.depType}\`)`;
  }
}

export function formatDependencySummary(changes: DependencyChange[]): string {
  return ['Dependency updates:', '', ...changes.map((c) => `- ${formatDependencyChange(c)}`)].join('\n');
}

export interface SyncDependencyBumpFilesResult {
  /** Bump file ids written (created or rewritten) */
  written: string[];
  /** Bump file ids removed because their package no longer has dependency changes */
  removed: string[];
}

/**
 * Write one patch bump file per package with dependency changes, and delete previously
 * generated files (same `suffix`) for packages that no longer have any. Only files added
 * on this branch (absent at `baseRef`) are ever deleted — a prefix match alone could
 * also hit an already-merged file from another branch.
 */
export async function syncDependencyBumpFiles(
  rootDir: string,
  changes: Map<string, DependencyChange[]>,
  suffix: string,
  baseRef: string,
): Promise<SyncDependencyBumpFilesResult> {
  const bumpyDir = getBumpyDir(rootDir);
  await ensureDir(bumpyDir);

  const written: string[] = [];
  for (const [pkgName, pkgChanges] of changes) {
    const id = depBumpFileId(suffix, pkgName);
    await writeBumpFile(rootDir, id, [{ name: pkgName, type: 'patch' }], formatDependencySummary(pkgChanges));
    written.push(id);
  }

  const stalePrefix = `${DEP_BUMP_FILE_PREFIX}${slugify(suffix)}-`;
  const removed: string[] = [];
  for (const file of await readdir(bumpyDir)) {
    if (!file.endsWith('.md') || !file.startsWith(stalePrefix)) continue;
    const id = file.slice(0, -'.md'.length);
    if (written.includes(id)) continue;
    if (readFileAtRef(rootDir, baseRef, relative(rootDir, resolve(bumpyDir, file))) != null) continue;
    await unlink(resolve(bumpyDir, file));
    removed.push(id);
  }

  return { written, removed };
}
