import { resolve } from 'node:path';
import { exists, readJson, readText } from './fs.ts';
import type { PackageManager } from '../types.ts';
import yaml from 'js-yaml';

export interface WorkspaceInfo {
  packageManager: PackageManager;
  globs: string[];
  catalogs: CatalogMap;
}

/** Map of catalog name → { depName → version }. Default catalog uses "" as key. */
export type CatalogMap = Map<string, Record<string, string>>;

/** Detect the package manager, extract workspace globs, and load catalogs */
export async function detectWorkspaces(rootDir: string): Promise<WorkspaceInfo> {
  const pm = await detectPackageManager(rootDir);
  const globs = await getWorkspaceGlobs(rootDir, pm);
  const catalogs = await loadCatalogs(rootDir, pm);
  return { packageManager: pm, globs, catalogs };
}

export async function detectPackageManager(rootDir: string): Promise<PackageManager> {
  // Check lockfiles in priority order
  if ((await exists(resolve(rootDir, 'bun.lock'))) || (await exists(resolve(rootDir, 'bun.lockb')))) {
    return 'bun';
  }
  if (await exists(resolve(rootDir, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (await exists(resolve(rootDir, 'yarn.lock'))) {
    return 'yarn';
  }
  // Fallback: check packageManager field in package.json
  try {
    const pkg = await readJson<Record<string, unknown>>(resolve(rootDir, 'package.json'));
    if (typeof pkg.packageManager === 'string') {
      const name = pkg.packageManager.split('@')[0];
      if (name === 'pnpm' || name === 'yarn' || name === 'bun') return name;
    }
  } catch {
    // ignore
  }
  return 'npm';
}

async function getWorkspaceGlobs(rootDir: string, pm: PackageManager): Promise<string[]> {
  // pnpm uses pnpm-workspace.yaml
  if (pm === 'pnpm') {
    const wsFile = resolve(rootDir, 'pnpm-workspace.yaml');
    if (await exists(wsFile)) {
      const content = await readText(wsFile);
      const parsed = yaml.load(content) as { packages?: string[] } | null;
      if (parsed?.packages) return parsed.packages;
    }
  }

  // npm, yarn, bun all use "workspaces" in package.json
  try {
    const pkg = await readJson<Record<string, unknown>>(resolve(rootDir, 'package.json'));
    const workspaces = pkg.workspaces;
    if (Array.isArray(workspaces)) return workspaces as string[];
    // Yarn supports { packages: [...] } format
    if (workspaces && typeof workspaces === 'object' && 'packages' in workspaces) {
      const pkgs = (workspaces as { packages: string[] }).packages;
      if (Array.isArray(pkgs)) return pkgs;
    }
  } catch {
    // ignore
  }

  return [];
}

/**
 * Files that may contain catalog definitions, in the order they're applied.
 * Later entries override earlier ones (matching loadCatalogs behavior).
 */
export const CATALOG_FILES = ['pnpm-workspace.yaml', 'package.json'] as const;

/**
 * Normalize a catalog name to its canonical form.
 * pnpm/bun treat "default" and the unnamed top-level catalog interchangeably,
 * so we store and look up the default catalog under "" regardless of which alias
 * the user wrote.
 */
function normalizeCatalogName(name: string): string {
  return name === 'default' ? '' : name;
}

/** Parse catalog definitions from the raw contents of pnpm-workspace.yaml and root package.json */
export function parseCatalogs(pnpmWorkspaceYaml: string | null, rootPackageJson: string | null): CatalogMap {
  const catalogs: CatalogMap = new Map();

  const addNamed = (raw: Record<string, Record<string, string>>): void => {
    for (const [name, deps] of Object.entries(raw)) {
      catalogs.set(normalizeCatalogName(name), deps);
    }
  };

  if (pnpmWorkspaceYaml) {
    try {
      const parsed = yaml.load(pnpmWorkspaceYaml) as {
        catalog?: Record<string, string>;
        catalogs?: Record<string, Record<string, string>>;
      } | null;

      if (parsed?.catalog) {
        catalogs.set('', parsed.catalog); // default catalog
      }
      if (parsed?.catalogs) {
        addNamed(parsed.catalogs);
      }
    } catch {
      // ignore malformed yaml
    }
  }

  if (rootPackageJson) {
    try {
      const pkg = JSON.parse(rootPackageJson) as Record<string, unknown>;

      // Top-level catalog/catalogs (used by bun, yarn, and proposed npm)
      if (pkg.catalog && typeof pkg.catalog === 'object') {
        catalogs.set('', pkg.catalog as Record<string, string>);
      }
      if (pkg.catalogs && typeof pkg.catalogs === 'object') {
        addNamed(pkg.catalogs as Record<string, Record<string, string>>);
      }

      // Inside workspaces object (bun style)
      const workspaces = pkg.workspaces;
      if (workspaces && typeof workspaces === 'object' && !Array.isArray(workspaces)) {
        const ws = workspaces as Record<string, unknown>;
        if (ws.catalog && typeof ws.catalog === 'object') {
          catalogs.set('', ws.catalog as Record<string, string>);
        }
        if (ws.catalogs && typeof ws.catalogs === 'object') {
          addNamed(ws.catalogs as Record<string, Record<string, string>>);
        }
      }
    } catch {
      // ignore malformed json
    }
  }

  return catalogs;
}

/** Load catalog definitions from pnpm-workspace.yaml or root package.json */
async function loadCatalogs(rootDir: string, pm: PackageManager): Promise<CatalogMap> {
  // pnpm-workspace.yaml is only read for pnpm — other PMs don't recognize it
  let pnpmYaml: string | null = null;
  if (pm === 'pnpm') {
    const wsFile = resolve(rootDir, 'pnpm-workspace.yaml');
    if (await exists(wsFile)) {
      pnpmYaml = await readText(wsFile);
    }
  }

  let pkgJsonText: string | null = null;
  const pkgJsonPath = resolve(rootDir, 'package.json');
  if (await exists(pkgJsonPath)) {
    pkgJsonText = await readText(pkgJsonPath);
  }

  return parseCatalogs(pnpmYaml, pkgJsonText);
}

/** Extract the catalog name from a `catalog:` / `catalog:<name>` range, normalizing the default alias */
function catalogNameFromRange(range: string): string {
  return normalizeCatalogName(range.slice('catalog:'.length).trim());
}

/** Resolve a specific dependency's catalog: reference */
export function resolveCatalogDep(depName: string, range: string, catalogs: CatalogMap): string | null {
  if (!range.startsWith('catalog:')) return null;
  const catalog = catalogs.get(catalogNameFromRange(range));
  if (!catalog) return null;
  return catalog[depName] ?? null;
}

/**
 * Diff two catalog states and return the set of (catalogName → changed depNames).
 * Includes added, removed, and version-changed entries.
 */
export function diffCatalogMaps(before: CatalogMap, after: CatalogMap): Map<string, Set<string>> {
  const changes = new Map<string, Set<string>>();
  const catalogNames = new Set([...before.keys(), ...after.keys()]);

  for (const catalogName of catalogNames) {
    const beforeDeps = before.get(catalogName) ?? {};
    const afterDeps = after.get(catalogName) ?? {};
    const depNames = new Set([...Object.keys(beforeDeps), ...Object.keys(afterDeps)]);
    const changedDeps = new Set<string>();
    for (const depName of depNames) {
      if (beforeDeps[depName] !== afterDeps[depName]) {
        changedDeps.add(depName);
      }
    }
    if (changedDeps.size > 0) {
      changes.set(catalogName, changedDeps);
    }
  }

  return changes;
}

/**
 * Given a set of catalog entries that have changed, return the set of catalog
 * references (e.g. "catalog:" or "catalog:testing") that affect those entries.
 * Used to match package.json dep ranges against changed catalog entries.
 */
export function isCatalogRefAffected(
  range: string,
  depName: string,
  catalogChanges: Map<string, Set<string>>,
): boolean {
  if (!range.startsWith('catalog:')) return false;
  return catalogChanges.get(catalogNameFromRange(range))?.has(depName) ?? false;
}
