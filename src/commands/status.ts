import { log, colorize } from "../utils/logger.ts";
import { loadConfig } from "../core/config.ts";
import { discoverPackages } from "../core/workspace.ts";
import { DependencyGraph } from "../core/dep-graph.ts";
import { readChangesets } from "../core/changeset.ts";
import { assembleReleasePlan } from "../core/release-plan.ts";

interface StatusOptions {
  json?: boolean;
}

export async function statusCommand(rootDir: string, opts: StatusOptions): Promise<void> {
  const config = await loadConfig(rootDir);
  const packages = await discoverPackages(rootDir, config);
  const depGraph = new DependencyGraph(packages);
  const changesets = await readChangesets(rootDir);

  if (changesets.length === 0) {
    if (opts.json) {
      console.log(JSON.stringify({ changesets: [], releases: [] }, null, 2));
    } else {
      log.info("No pending changesets.");
    }
    process.exit(1); // exit 1 = no releases pending (useful for CI)
  }

  const plan = assembleReleasePlan(changesets, packages, depGraph, config);

  if (opts.json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  // Display summary
  log.bold(`${changesets.length} changeset(s) pending\n`);

  if (plan.releases.length === 0) {
    log.warn("Changesets found but no packages would be released.");
    return;
  }

  // Group by bump type
  const majors = plan.releases.filter((r) => r.type === "major");
  const minors = plan.releases.filter((r) => r.type === "minor");
  const patches = plan.releases.filter((r) => r.type === "patch");

  if (majors.length > 0) {
    log.bold(colorize("Major", "red"));
    for (const r of majors) printRelease(r);
    console.log();
  }
  if (minors.length > 0) {
    log.bold(colorize("Minor", "yellow"));
    for (const r of minors) printRelease(r);
    console.log();
  }
  if (patches.length > 0) {
    log.bold(colorize("Patch", "green"));
    for (const r of patches) printRelease(r);
    console.log();
  }
}

function printRelease(r: { name: string; oldVersion: string; newVersion: string; isDependencyBump: boolean; isCascadeBump: boolean }) {
  const suffix = r.isDependencyBump
    ? colorize(" (dependency bump)", "dim")
    : r.isCascadeBump
      ? colorize(" (cascade)", "dim")
      : "";
  console.log(`  ${r.name}: ${r.oldVersion} → ${colorize(r.newVersion, "cyan")}${suffix}`);
}
