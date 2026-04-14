import { matchGlob } from "./config.ts";
import { DependencyGraph } from "./dep-graph.ts";
import { bumpVersion, satisfies, stripProtocol } from "./semver.ts";
import {
  type BumpyConfig,
  type BumpType,
  type Changeset,
  type ChangesetRelease,
  type DependencyBumpRule,
  type DepType,
  type PlannedRelease,
  type ReleasePlan,
  type WorkspacePackage,
  DEFAULT_BUMP_RULES,
  bumpLevel,
  maxBump,
  parseIsolatedBump,
  hasCascade,
} from "../types.ts";

interface PlannedBump {
  type: BumpType;
  isolated: boolean;
  isDependencyBump: boolean;
  isCascadeBump: boolean;
  changesets: Set<string>;
}

/**
 * Build a release plan from pending changesets, the dependency graph, and config.
 * This is the core algorithm of bumpy.
 */
export function assembleReleasePlan(
  changesets: Changeset[],
  packages: Map<string, WorkspacePackage>,
  depGraph: DependencyGraph,
  config: BumpyConfig,
): ReleasePlan {
  if (changesets.length === 0) {
    return { changesets: [], releases: [] };
  }

  const planned = new Map<string, PlannedBump>();

  // Step 1: Collect explicit bumps from changesets
  const cascadeOverrides = new Map<string, Map<string, BumpType>>(); // pkg → (glob → bumpType)

  for (const cs of changesets) {
    for (const release of cs.releases) {
      if (!packages.has(release.name)) continue;
      const { bump, isolated } = parseIsolatedBump(release.type);

      const existing = planned.get(release.name);
      if (existing) {
        existing.type = maxBump(existing.type, bump);
        // If ANY changeset is non-isolated, the package is non-isolated
        if (!isolated) existing.isolated = false;
        existing.changesets.add(cs.id);
      } else {
        planned.set(release.name, {
          type: bump,
          isolated,
          isDependencyBump: false,
          isCascadeBump: false,
          changesets: new Set([cs.id]),
        });
      }

      // Collect per-changeset cascade overrides
      if (hasCascade(release)) {
        if (!cascadeOverrides.has(release.name)) {
          cascadeOverrides.set(release.name, new Map());
        }
        const overrides = cascadeOverrides.get(release.name)!;
        for (const [pattern, bumpType] of Object.entries(release.cascade)) {
          const existing = overrides.get(pattern);
          overrides.set(pattern, maxBump(existing, bumpType));
        }
      }
    }
  }

  // Step 2: Apply fixed groups
  for (const group of config.fixed) {
    let groupBump: BumpType | undefined;
    let groupIsolated = true;
    for (const nameOrGlob of group) {
      for (const [name, bump] of planned) {
        if (matchGlob(name, nameOrGlob)) {
          groupBump = maxBump(groupBump, bump.type);
          if (!bump.isolated) groupIsolated = false;
        }
      }
    }
    if (!groupBump) continue;
    // Apply the highest bump to all packages in the group
    for (const nameOrGlob of group) {
      for (const [name] of packages) {
        if (!matchGlob(name, nameOrGlob)) continue;
        const existing = planned.get(name);
        if (existing) {
          existing.type = groupBump;
          existing.isolated = groupIsolated;
        } else {
          planned.set(name, {
            type: groupBump,
            isolated: groupIsolated,
            isDependencyBump: false,
            isCascadeBump: false,
            changesets: new Set(),
          });
        }
      }
    }
  }

  // Step 3: Apply linked groups (same bump level, independent versions)
  for (const group of config.linked) {
    let groupBump: BumpType | undefined;
    for (const nameOrGlob of group) {
      for (const [name, bump] of planned) {
        if (matchGlob(name, nameOrGlob)) {
          groupBump = maxBump(groupBump, bump.type);
        }
      }
    }
    if (!groupBump) continue;
    for (const nameOrGlob of group) {
      for (const [name] of packages) {
        if (!matchGlob(name, nameOrGlob)) continue;
        const existing = planned.get(name);
        if (existing) {
          existing.type = groupBump;
        }
        // linked groups don't add packages that aren't already planned
      }
    }
  }

  // Step 4: Propagate bumps (iterative until stable)
  let changed = true;
  let iterations = 0;
  const MAX_ITERATIONS = 100; // safety valve

  while (changed && iterations < MAX_ITERATIONS) {
    changed = false;
    iterations++;

    for (const [pkgName, bump] of [...planned]) {
      if (bump.isolated) continue;

      // 4a: Apply changeset-level cascade overrides
      const csOverrides = cascadeOverrides.get(pkgName);
      if (csOverrides) {
        for (const [pattern, cascadeBumpType] of csOverrides) {
          for (const [targetName] of packages) {
            if (!matchGlob(targetName, pattern)) continue;
            if (applyBump(planned, targetName, cascadeBumpType, false, true, bump.changesets)) {
              changed = true;
            }
          }
        }
      }

      // 4b: Apply source-side cascadeTo config
      const pkg = packages.get(pkgName);
      const cascadeTo = pkg?.bumpy?.cascadeTo;
      if (cascadeTo) {
        for (const [pattern, rule] of Object.entries(cascadeTo)) {
          if (!shouldTrigger(bump.type, rule.trigger)) continue;
          const cascadeBump = rule.bumpAs === "match" ? bump.type : rule.bumpAs;
          for (const [targetName] of packages) {
            if (!matchGlob(targetName, pattern)) continue;
            if (applyBump(planned, targetName, cascadeBump, false, true, bump.changesets)) {
              changed = true;
            }
          }
        }
      }

      // 4c: Apply dependency graph propagation
      const dependents = depGraph.getDependents(pkgName);
      for (const dep of dependents) {
        const rule = resolveRule(dep.name, pkgName, dep.depType, packages, config);
        if (!shouldTrigger(bump.type, rule.trigger)) continue;

        // Check out-of-range setting
        if (config.updateInternalDependencies === "out-of-range") {
          const newVersion = bumpVersion(packages.get(pkgName)!.version, bump.type);
          if (satisfies(newVersion, stripProtocol(dep.versionRange))) continue;
        }
        if (config.updateInternalDependencies === "none") continue;
        if (config.updateInternalDependencies === "minor" && bumpLevel(bump.type) < bumpLevel("minor")) continue;

        const depBump = rule.bumpAs === "match" ? bump.type : rule.bumpAs;
        if (applyBump(planned, dep.name, depBump, true, false, bump.changesets)) {
          changed = true;
        }
      }
    }
  }

  // Step 5: Calculate new versions
  // Note: packages map already contains only managed packages (filtered by discoverPackages)
  const releases: PlannedRelease[] = [];
  for (const [name, bump] of planned) {
    const pkg = packages.get(name);
    if (!pkg) continue; // skip if not in managed packages

    const newVersion = bumpVersion(pkg.version, bump.type);
    releases.push({
      name,
      type: bump.type,
      oldVersion: pkg.version,
      newVersion,
      changesets: [...bump.changesets],
      isDependencyBump: bump.isDependencyBump,
      isCascadeBump: bump.isCascadeBump,
    });
  }

  // Sort by name for stable output
  releases.sort((a, b) => a.name.localeCompare(b.name));

  return { changesets, releases };
}

/** Apply a bump to a package, upgrading if already planned. Returns true if anything changed. */
function applyBump(
  planned: Map<string, PlannedBump>,
  name: string,
  type: BumpType,
  isDependencyBump: boolean,
  isCascadeBump: boolean,
  sourceChangesets: Set<string>,
): boolean {
  const existing = planned.get(name);
  if (existing) {
    const newType = maxBump(existing.type, type);
    if (newType === existing.type) return false;
    existing.type = newType;
    if (isDependencyBump) existing.isDependencyBump = true;
    if (isCascadeBump) existing.isCascadeBump = true;
    for (const cs of sourceChangesets) existing.changesets.add(cs);
    return true;
  }
  planned.set(name, {
    type,
    isolated: false,
    isDependencyBump,
    isCascadeBump,
    changesets: new Set(sourceChangesets),
  });
  return true;
}

/** Check if a bump level meets the trigger threshold */
function shouldTrigger(bumpType: BumpType, trigger: BumpType | "none"): boolean {
  if (trigger === "none") return false;
  return bumpLevel(bumpType) >= bumpLevel(trigger);
}

/**
 * Resolve the dependency bump rule for a specific dependent/dependency pair.
 * Priority: specificDependencyRules > per-package depType rules > global depType rules > defaults
 */
function resolveRule(
  dependentName: string,
  dependencyName: string,
  depType: DepType,
  packages: Map<string, WorkspacePackage>,
  config: BumpyConfig,
): DependencyBumpRule {
  const dependent = packages.get(dependentName);

  // Check specific dependency rules on the dependent
  if (dependent?.bumpy?.specificDependencyRules?.[dependencyName]) {
    return dependent.bumpy.specificDependencyRules[dependencyName];
  }
  // Check glob patterns in specific dependency rules
  if (dependent?.bumpy?.specificDependencyRules) {
    for (const [pattern, rule] of Object.entries(dependent.bumpy.specificDependencyRules)) {
      if (matchGlob(dependencyName, pattern)) return rule;
    }
  }

  // Check per-package dependency type rules
  if (dependent?.bumpy?.dependencyBumpRules?.[depType]) {
    return dependent.bumpy.dependencyBumpRules[depType];
  }

  // Check global config
  if (config.dependencyBumpRules[depType]) {
    return config.dependencyBumpRules[depType];
  }

  // Built-in defaults
  return DEFAULT_BUMP_RULES[depType] || { trigger: "patch", bumpAs: "patch" };
}
