import { resolve } from "node:path";
import { unlink } from "node:fs/promises";
import { readJson, writeJson, readText } from "../utils/fs.ts";
import { runAsync } from "../utils/shell.ts";
import { log, colorize } from "../utils/logger.ts";
import { createTag, tagExists } from "./git.ts";
import { DependencyGraph } from "./dep-graph.ts";
import { stripProtocol } from "./semver.ts";
import { resolveCatalogDep, type CatalogMap } from "../utils/package-manager.ts";
import type {
  ReleasePlan,
  PlannedRelease,
  WorkspacePackage,
  BumpyConfig,
  PackageManager,
} from "../types.ts";

export interface PublishOptions {
  dryRun?: boolean;
  tag?: string; // npm dist-tag (e.g., "next", "beta")
}

export interface PublishResult {
  published: { name: string; version: string }[];
  skipped: { name: string; reason: string }[];
  failed: { name: string; error: string }[];
}

/**
 * Publish all packages in the release plan.
 * Order: topological (dependencies published before dependents).
 */
export async function publishPackages(
  releasePlan: ReleasePlan,
  packages: Map<string, WorkspacePackage>,
  depGraph: DependencyGraph,
  config: BumpyConfig,
  rootDir: string,
  opts: PublishOptions = {},
  catalogs: CatalogMap = new Map(),
  detectedPm: PackageManager = "npm",
): Promise<PublishResult> {
  const result: PublishResult = { published: [], skipped: [], failed: [] };
  const publishConfig = config.publish;

  // Resolve "auto" pack manager to detected PM
  const packManager = publishConfig.packManager === "auto" ? detectedPm : publishConfig.packManager;

  // Topological sort for correct publish order
  const topoOrder = depGraph.topologicalSort(packages);
  const releaseMap = new Map(releasePlan.releases.map((r) => [r.name, r]));

  // Filter to only packages that need publishing, in topo order
  const ordered: PlannedRelease[] = [];
  for (const name of topoOrder) {
    const release = releaseMap.get(name);
    if (release) ordered.push(release);
  }

  for (const release of ordered) {
    const pkg = packages.get(release.name)!;
    const pkgConfig = pkg.bumpy || {};

    // Skip private packages unless they have a custom publish command
    if (pkg.private && !pkgConfig.publishCommand) {
      if (config.privatePackages.tag) {
        createGitTag(release, rootDir, opts);
      }
      result.skipped.push({ name: release.name, reason: "private" });
      continue;
    }

    log.step(`Publishing ${colorize(release.name, "cyan")}@${release.newVersion}`);

    try {
      // 1. Build
      if (pkgConfig.buildCommand) {
        log.dim(`  Building...`);
        if (!opts.dryRun) {
          await runAsync(pkgConfig.buildCommand, { cwd: pkg.dir });
        }
      }

      // 2. Resolve workspace:/catalog: protocols if using in-place mode
      //    (for pack mode, the PM pack command handles this; for custom commands, always resolve)
      const needsInPlaceResolve =
        pkgConfig.publishCommand ||
        publishConfig.protocolResolution === "in-place";
      if (needsInPlaceResolve) {
        // Always write resolved protocols — dryRun only skips the actual publish command
        await resolveProtocolsInPlace(pkg, packages, releasePlan, catalogs);
      }

      // 3. Publish
      if (pkgConfig.publishCommand) {
        // Custom publish command(s)
        const commands = Array.isArray(pkgConfig.publishCommand)
          ? pkgConfig.publishCommand
          : [pkgConfig.publishCommand];

        for (const cmd of commands) {
          const expanded = cmd
            .replace(/\{\{version\}\}/g, release.newVersion)
            .replace(/\{\{name\}\}/g, release.name);
          log.dim(`  Running: ${expanded}`);
          if (!opts.dryRun) {
            await runAsync(expanded, { cwd: pkg.dir });
          }
        }
      } else if (!pkgConfig.skipNpmPublish) {
        // Standard publish flow
        if (publishConfig.protocolResolution === "pack") {
          await packThenPublish(pkg, pkgConfig, config, packManager, opts);
        } else {
          // "in-place" already resolved above; "none" skips resolution
          await npmPublishDirect(pkg, pkgConfig, config, opts);
        }
      } else {
        result.skipped.push({ name: release.name, reason: "skipNpmPublish" });
        createGitTag(release, rootDir, opts);
        continue;
      }

      // 3. Git tag
      createGitTag(release, rootDir, opts);

      result.published.push({ name: release.name, version: release.newVersion });
      log.success(`  Published ${release.name}@${release.newVersion}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error(`  Failed to publish ${release.name}: ${errMsg}`);
      result.failed.push({ name: release.name, error: errMsg });
    }
  }

  return result;
}

/**
 * Pack with the PM (which resolves workspace:/catalog: protocols into the tarball),
 * then publish the tarball with npm (which supports OIDC/provenance).
 */
async function packThenPublish(
  pkg: WorkspacePackage,
  pkgConfig: WorkspacePackage["bumpy"] & {},
  config: BumpyConfig,
  packManager: PackageManager,
  opts: PublishOptions,
): Promise<void> {
  const packCmd = getPackCommand(packManager);
  log.dim(`  Packing with: ${packCmd}`);

  if (opts.dryRun) {
    const publishCmd = buildPublishCommand(pkg, pkgConfig, config, opts, "<tarball>");
    log.dim(`  Would publish with: ${publishCmd}`);
    return;
  }

  // Pack and capture the tarball filename
  const packOutput = await runAsync(packCmd, { cwd: pkg.dir });
  // Pack commands output the tarball filename on the last line
  const tarball = parseTarballPath(packOutput, pkg.dir);

  try {
    // Publish the tarball
    const publishCmd = buildPublishCommand(pkg, pkgConfig, config, opts, tarball);
    log.dim(`  Publishing: ${publishCmd}`);
    await runAsync(publishCmd, { cwd: pkg.dir });
  } finally {
    // Clean up tarball
    try { await unlink(tarball); } catch { /* ignore */ }
  }
}

/** Publish directly from the package directory (no tarball) */
async function npmPublishDirect(
  pkg: WorkspacePackage,
  pkgConfig: WorkspacePackage["bumpy"] & {},
  config: BumpyConfig,
  opts: PublishOptions,
): Promise<void> {
  const cmd = buildPublishCommand(pkg, pkgConfig, config, opts);
  log.dim(`  Running: ${cmd}`);
  if (!opts.dryRun) {
    await runAsync(cmd, { cwd: pkg.dir });
  }
}

function getPackCommand(pm: PackageManager): string {
  switch (pm) {
    case "pnpm": return "pnpm pack";
    case "bun": return "bun pm pack";
    case "yarn": return "yarn pack";
    case "npm":
    default: return "npm pack";
  }
}

function buildPublishCommand(
  pkg: WorkspacePackage,
  pkgConfig: WorkspacePackage["bumpy"] & {},
  config: BumpyConfig,
  opts: PublishOptions,
  tarball?: string,
): string {
  const publishManager = config.publish.publishManager;
  const parts: string[] = [];

  // Base command
  if (publishManager === "yarn") {
    parts.push("yarn npm publish");
  } else {
    parts.push(`${publishManager} publish`);
  }

  // Tarball path (if pack-then-publish)
  if (tarball) parts.push(tarball);

  // Access
  const access = pkgConfig?.access || config.access;
  parts.push(`--access ${access}`);

  // Registry
  if (pkgConfig?.registry) parts.push(`--registry ${pkgConfig.registry}`);

  // Dist tag
  if (opts.tag) parts.push(`--tag ${opts.tag}`);

  // Extra user-configured args (e.g., --provenance)
  if (config.publish.publishArgs.length > 0) {
    parts.push(...config.publish.publishArgs);
  }

  return parts.join(" ");
}

/** Parse the tarball path from pack command output */
function parseTarballPath(output: string, cwd: string): string {
  // Most PMs output the tarball filename on the last non-empty line
  const lines = output.trim().split("\n").filter(Boolean);
  const lastLine = lines[lines.length - 1]?.trim() || "";

  // If it's an absolute path, use it directly
  if (lastLine.startsWith("/")) return lastLine;

  // Otherwise treat it as relative to cwd
  return resolve(cwd, lastLine);
}

function createGitTag(
  release: PlannedRelease,
  rootDir: string,
  opts: PublishOptions,
): void {
  const tag = `${release.name}@${release.newVersion}`;
  if (opts.dryRun) {
    log.dim(`  Would create tag: ${tag}`);
    return;
  }
  if (tagExists(tag, { cwd: rootDir })) {
    log.dim(`  Tag ${tag} already exists, skipping`);
    return;
  }
  createTag(tag, { cwd: rootDir });
  log.dim(`  Tagged: ${tag}`);
}

/**
 * Resolve workspace:/catalog: protocols by rewriting package.json in-place.
 * Used for custom publish commands and "in-place" protocolResolution mode.
 */
async function resolveProtocolsInPlace(
  pkg: WorkspacePackage,
  packages: Map<string, WorkspacePackage>,
  releasePlan: ReleasePlan,
  catalogs: CatalogMap,
): Promise<void> {
  const pkgJsonPath = resolve(pkg.dir, "package.json");
  const pkgJson = await readJson<Record<string, unknown>>(pkgJsonPath);
  let modified = false;

  const releaseMap = new Map(releasePlan.releases.map((r) => [r.name, r]));

  for (const depField of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const) {
    const deps = pkgJson[depField] as Record<string, string> | undefined;
    if (!deps) continue;

    for (const [depName, range] of Object.entries(deps)) {
      let resolved: string | null = null;

      if (range.startsWith("catalog:")) {
        resolved = resolveCatalogDep(depName, range, catalogs);
        if (!resolved) {
          log.warn(`  Could not resolve ${depName}: "${range}" — catalog entry not found`);
          continue;
        }
      } else if (range.startsWith("workspace:")) {
        const cleanRange = stripProtocol(range);

        if (cleanRange === "*" || cleanRange === "^" || cleanRange === "~") {
          const depPkg = packages.get(depName);
          const depRelease = releaseMap.get(depName);
          const version = depRelease?.newVersion || depPkg?.version || "0.0.0";
          const prefix = cleanRange === "*" ? "^" : cleanRange;
          resolved = `${prefix}${version}`;
        } else {
          resolved = cleanRange;
        }
      }

      if (resolved) {
        deps[depName] = resolved;
        modified = true;
      }
    }
  }

  if (modified) {
    await writeJson(pkgJsonPath, pkgJson);
  }
}
