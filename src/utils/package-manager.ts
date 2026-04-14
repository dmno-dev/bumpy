import { resolve } from "node:path";
import { exists, readJson, readText } from "./fs.ts";
import type { PackageManager } from "../types.ts";
import yaml from "js-yaml";

export interface WorkspaceGlobs {
  packageManager: PackageManager;
  globs: string[];
}

/** Detect the package manager and extract workspace globs for a monorepo root */
export async function detectWorkspaces(rootDir: string): Promise<WorkspaceGlobs> {
  const pm = await detectPackageManager(rootDir);
  const globs = await getWorkspaceGlobs(rootDir, pm);
  return { packageManager: pm, globs };
}

async function detectPackageManager(rootDir: string): Promise<PackageManager> {
  // Check lockfiles in priority order
  if (await exists(resolve(rootDir, "bun.lock")) || await exists(resolve(rootDir, "bun.lockb"))) {
    return "bun";
  }
  if (await exists(resolve(rootDir, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (await exists(resolve(rootDir, "yarn.lock"))) {
    return "yarn";
  }
  // Fallback: check packageManager field in package.json
  try {
    const pkg = await readJson<Record<string, unknown>>(resolve(rootDir, "package.json"));
    if (typeof pkg.packageManager === "string") {
      const name = pkg.packageManager.split("@")[0];
      if (name === "pnpm" || name === "yarn" || name === "bun") return name;
    }
  } catch {
    // ignore
  }
  return "npm";
}

async function getWorkspaceGlobs(rootDir: string, pm: PackageManager): Promise<string[]> {
  // pnpm uses pnpm-workspace.yaml
  if (pm === "pnpm") {
    const wsFile = resolve(rootDir, "pnpm-workspace.yaml");
    if (await exists(wsFile)) {
      const content = await readText(wsFile);
      const parsed = yaml.load(content) as { packages?: string[] } | null;
      if (parsed?.packages) return parsed.packages;
    }
  }

  // npm, yarn, bun all use "workspaces" in package.json
  try {
    const pkg = await readJson<Record<string, unknown>>(resolve(rootDir, "package.json"));
    const workspaces = pkg.workspaces;
    if (Array.isArray(workspaces)) return workspaces as string[];
    // Yarn supports { packages: [...] } format
    if (workspaces && typeof workspaces === "object" && "packages" in workspaces) {
      const pkgs = (workspaces as { packages: string[] }).packages;
      if (Array.isArray(pkgs)) return pkgs;
    }
  } catch {
    // ignore
  }

  return [];
}
