import { resolve, relative } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { readJson, exists } from "../utils/fs.ts";
import { detectWorkspaces } from "../utils/package-manager.ts";
import { loadPackageConfig } from "./config.ts";
import type { BumpyConfig, WorkspacePackage } from "../types.ts";

/** Discover all workspace packages in a monorepo */
export async function discoverPackages(
  rootDir: string,
  config: BumpyConfig,
): Promise<Map<string, WorkspacePackage>> {
  const { globs } = await detectWorkspaces(rootDir);
  if (globs.length === 0) {
    throw new Error("No workspace globs found. Is this a monorepo?");
  }

  const packages = new Map<string, WorkspacePackage>();
  for (const glob of globs) {
    const dirs = await resolveGlob(rootDir, glob);
    for (const dir of dirs) {
      const pkg = await loadWorkspacePackage(dir, rootDir, config);
      if (pkg) {
        if (config.ignore.includes(pkg.name)) continue;
        packages.set(pkg.name, pkg);
      }
    }
  }
  return packages;
}

/** Resolve a workspace glob pattern to directories containing package.json */
async function resolveGlob(rootDir: string, pattern: string): Promise<string[]> {
  // Handle simple patterns: "packages/*", "plugins/*", "apps/*"
  // Also handle deeper patterns: "packages/**"
  const parts = pattern.split("/");
  return expandGlob(rootDir, parts);
}

async function expandGlob(baseDir: string, parts: string[]): Promise<string[]> {
  if (parts.length === 0) {
    // Check if this dir has a package.json
    if (await exists(resolve(baseDir, "package.json"))) {
      return [baseDir];
    }
    return [];
  }

  const [current, ...rest] = parts;
  if (current === "*") {
    // Match any single directory
    const entries = await safeReaddir(baseDir);
    const results: string[] = [];
    for (const entry of entries) {
      const entryPath = resolve(baseDir, entry);
      if (await isDirectory(entryPath)) {
        results.push(...await expandGlob(entryPath, rest));
      }
    }
    return results;
  } else if (current === "**") {
    // Match any depth
    const results: string[] = [];
    // Try matching at this level (skip the **)
    results.push(...await expandGlob(baseDir, rest));
    // Try descending into subdirs
    const entries = await safeReaddir(baseDir);
    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "node_modules") continue;
      const entryPath = resolve(baseDir, entry);
      if (await isDirectory(entryPath)) {
        results.push(...await expandGlob(entryPath, parts)); // keep the ** in pattern
      }
    }
    return results;
  } else {
    // Literal directory name
    const next = resolve(baseDir, current!);
    if (await isDirectory(next)) {
      return expandGlob(next, rest);
    }
    return [];
  }
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function loadWorkspacePackage(
  dir: string,
  rootDir: string,
  config: BumpyConfig,
): Promise<WorkspacePackage | null> {
  const pkgPath = resolve(dir, "package.json");
  if (!(await exists(pkgPath))) return null;

  let pkg: Record<string, unknown>;
  try {
    pkg = await readJson<Record<string, unknown>>(pkgPath);
  } catch {
    return null;
  }

  const name = pkg.name as string;
  if (!name) return null;

  const bumpy = await loadPackageConfig(dir, config, name);

  return {
    name,
    version: (pkg.version as string) || "0.0.0",
    dir: resolve(dir),
    relativeDir: relative(rootDir, dir),
    packageJson: pkg,
    private: !!pkg.private,
    dependencies: (pkg.dependencies as Record<string, string>) || {},
    devDependencies: (pkg.devDependencies as Record<string, string>) || {},
    peerDependencies: (pkg.peerDependencies as Record<string, string>) || {},
    optionalDependencies: (pkg.optionalDependencies as Record<string, string>) || {},
    bumpy,
  };
}
