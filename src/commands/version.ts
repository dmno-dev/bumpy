import { log, colorize } from "../utils/logger.ts";
import { loadConfig } from "../core/config.ts";
import { discoverPackages } from "../core/workspace.ts";
import { DependencyGraph } from "../core/dep-graph.ts";
import { readChangesets } from "../core/changeset.ts";
import { assembleReleasePlan } from "../core/release-plan.ts";
import { applyReleasePlan } from "../core/apply-release-plan.ts";
import { run } from "../utils/shell.ts";

export async function versionCommand(rootDir: string): Promise<void> {
  const config = await loadConfig(rootDir);
  const packages = await discoverPackages(rootDir, config);
  const depGraph = new DependencyGraph(packages);
  const changesets = await readChangesets(rootDir);

  if (changesets.length === 0) {
    log.info("No pending changesets.");
    return;
  }

  const plan = assembleReleasePlan(changesets, packages, depGraph, config);

  if (plan.releases.length === 0) {
    log.warn("Changesets found but no packages would be released.");
    return;
  }

  // Show what will happen
  log.step("Applying version bumps:");
  for (const r of plan.releases) {
    const tag = r.isDependencyBump ? " (dep)" : r.isCascadeBump ? " (cascade)" : "";
    console.log(`  ${r.name}: ${r.oldVersion} → ${colorize(r.newVersion, "cyan")}${tag}`);
  }

  // Apply the plan
  await applyReleasePlan(plan, packages, rootDir, config);

  log.success(`Updated ${plan.releases.length} package(s)`);
  log.dim(`  Deleted ${changesets.length} changeset file(s)`);

  // Optionally commit
  if (config.commit) {
    const files = plan.releases.flatMap((r) => {
      const pkg = packages.get(r.name)!;
      return [`${pkg.relativeDir}/package.json`, `${pkg.relativeDir}/CHANGELOG.md`];
    });
    // Also stage the deleted changeset files
    try {
      run("git add -A .bumpy/", { cwd: rootDir });
      for (const file of files) {
        run(`git add "${file}"`, { cwd: rootDir });
      }
      const msg = `Version packages\n\n${plan.releases.map((r) => `${r.name}@${r.newVersion}`).join("\n")}`;
      run(`git commit -m "${msg.replace(/"/g, '\\"')}"`, { cwd: rootDir });
      log.success("Created git commit");
    } catch (e) {
      log.warn(`Git commit failed: ${e}`);
    }
  }
}
