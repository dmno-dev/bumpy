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

async function detectPackageManager(rootDir: string): Promise<PackageManager> {
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

/** Load catalog definitions from pnpm-workspace.yaml or root package.json */
async function loadCatalogs(rootDir: string, pm: PackageManager): Promise<CatalogMap> {
  const catalogs: CatalogMap = new Map();

  if (pm === 'pnpm') {
    // pnpm: catalogs live in pnpm-workspace.yaml
    const wsFile = resolve(rootDir, 'pnpm-workspace.yaml');
    if (await exists(wsFile)) {
      const content = await readText(wsFile);
      const parsed = yaml.load(content) as {
        catalog?: Record<string, string>;
        catalogs?: Record<string, Record<string, string>>;
      } | null;

      if (parsed?.catalog) {
        catalogs.set('', parsed.catalog); // default catalog
      }
      if (parsed?.catalogs) {
        for (const [name, deps] of Object.entries(parsed.catalogs)) {
          catalogs.set(name, deps);
        }
      }
    }
  }

  // bun/npm/yarn + pnpm fallback: catalogs in root package.json
  try {
    const pkg = await readJson<Record<string, unknown>>(resolve(rootDir, 'package.json'));

    // Check top-level catalog/catalogs
    if (pkg.catalog && typeof pkg.catalog === 'object') {
      catalogs.set('', pkg.catalog as Record<string, string>);
    }
    if (pkg.catalogs && typeof pkg.catalogs === 'object') {
      for (const [name, deps] of Object.entries(pkg.catalogs as Record<string, Record<string, string>>)) {
        catalogs.set(name, deps);
      }
    }

    // Also check inside workspaces object (bun style)
    const workspaces = pkg.workspaces;
    if (workspaces && typeof workspaces === 'object' && !Array.isArray(workspaces)) {
      const ws = workspaces as Record<string, unknown>;
      if (ws.catalog && typeof ws.catalog === 'object') {
        catalogs.set('', ws.catalog as Record<string, string>);
      }
      if (ws.catalogs && typeof ws.catalogs === 'object') {
        for (const [name, deps] of Object.entries(ws.catalogs as Record<string, Record<string, string>>)) {
          catalogs.set(name, deps);
        }
      }
    }
  } catch {
    // ignore
  }

  return catalogs;
}

/** Resolve a specific dependency's catalog: reference */
export function resolveCatalogDep(depName: string, range: string, catalogs: CatalogMap): string | null {
  if (!range.startsWith('catalog:')) return null;
  const catalogName = range.slice('catalog:'.length).trim() || '';
  const catalog = catalogs.get(catalogName);
  if (!catalog) return null;
  return catalog[depName] ?? null;
}
