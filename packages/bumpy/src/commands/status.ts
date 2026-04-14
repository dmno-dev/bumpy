import { log, colorize } from "../utils/logger.ts";
import { loadConfig } from "../core/config.ts";
import { discoverPackages } from "../core/workspace.ts";
import { DependencyGraph } from "../core/dep-graph.ts";
import { readChangesets } from "../core/changeset.ts";
import { assembleReleasePlan } from "../core/release-plan.ts";
import type { PlannedRelease, WorkspacePackage } from "../types.ts";

interface StatusOptions {
  json?: boolean;
  /** Output only package names, one per line (useful for piping) */
  packagesOnly?: boolean;
  /** Filter to specific bump types: "major", "minor", "patch" */
  bumpType?: string;
  /** Filter to specific packages (comma-separated names or globs) */
  filter?: string;
  /** Show verbose output including changeset details */
  verbose?: boolean;
}

export async function statusCommand(rootDir: string, opts: StatusOptions): Promise<void> {
  const config = await loadConfig(rootDir);
  const packages = await discoverPackages(rootDir, config);
  const depGraph = new DependencyGraph(packages);
  const changesets = await readChangesets(rootDir);

  if (changesets.length === 0) {
    if (opts.json) {
      console.log(JSON.stringify({ changesets: [], releases: [], packageNames: [] }, null, 2));
    } else if (!opts.packagesOnly) {
      log.info("No pending changesets.");
    }
    process.exit(1); // exit 1 = no releases pending (useful for CI)
  }

  const plan = assembleReleasePlan(changesets, packages, depGraph, config);

  // Apply filters
  let releases = plan.releases;
  if (opts.bumpType) {
    const types = opts.bumpType.split(",").map((t) => t.trim());
    releases = releases.filter((r) => types.includes(r.type));
  }
  if (opts.filter) {
    const { matchGlob } = await import("../core/config.ts");
    const patterns = opts.filter.split(",").map((p) => p.trim());
    releases = releases.filter((r) =>
      patterns.some((p) => matchGlob(r.name, p))
    );
  }

  if (opts.json) {
    const jsonOutput = {
      changesets: plan.changesets.map((cs) => ({
        id: cs.id,
        summary: cs.summary,
        releases: cs.releases.map((r) => ({ name: r.name, type: r.type })),
      })),
      releases: releases.map((r) => ({
        name: r.name,
        type: r.type,
        oldVersion: r.oldVersion,
        newVersion: r.newVersion,
        dir: packages.get(r.name)?.relativeDir,
        changesets: r.changesets,
        isDependencyBump: r.isDependencyBump,
        isCascadeBump: r.isCascadeBump,
      })),
      packageNames: releases.map((r) => r.name),
    };
    console.log(JSON.stringify(jsonOutput, null, 2));
    return;
  }

  if (opts.packagesOnly) {
    for (const r of releases) {
      console.log(r.name);
    }
    return;
  }

  // Pretty output
  log.bold(`${changesets.length} changeset(s) pending\n`);

  if (releases.length === 0) {
    log.warn("No packages match the current filters.");
    return;
  }

  // Group by bump type
  const groups: [string, string, PlannedRelease[]][] = [
    ["Major", "red", releases.filter((r) => r.type === "major")],
    ["Minor", "yellow", releases.filter((r) => r.type === "minor")],
    ["Patch", "green", releases.filter((r) => r.type === "patch")],
  ];

  for (const [label, color, group] of groups) {
    if (group.length === 0) continue;
    log.bold(colorize(label, color as "red" | "yellow" | "green"));
    for (const r of group) {
      printRelease(r, packages);
    }
    console.log();
  }

  if (opts.verbose) {
    log.bold("Changesets:");
    for (const cs of plan.changesets) {
      console.log(`  ${colorize(cs.id, "cyan")}`);
      for (const r of cs.releases) {
        console.log(`    ${r.name}: ${r.type}`);
      }
      if (cs.summary) {
        console.log(`    ${colorize(cs.summary.split("\n")[0]!, "dim")}`);
      }
    }
  }
}

function printRelease(
  r: PlannedRelease,
  packages: Map<string, WorkspacePackage>,
) {
  const pkg = packages.get(r.name);
  const dir = pkg ? colorize(` (${pkg.relativeDir})`, "dim") : "";
  const suffix = r.isDependencyBump
    ? colorize(" ← dependency bump", "dim")
    : r.isCascadeBump
      ? colorize(" ← cascade", "dim")
      : "";
  console.log(`  ${r.name}: ${r.oldVersion} → ${colorize(r.newVersion, "cyan")}${suffix}${dir}`);
}
