import { matchGlob } from './config.ts';
import { DependencyGraph } from './dep-graph.ts';
import { bumpVersion, satisfies } from './semver.ts';
import {
  type BumpyConfig,
  type BumpType,
  type BumpFile,
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
} from '../types.ts';

interface PlannedBump {
  type: BumpType;
  isolated: boolean;
  /** Explicit 'none' from bump file — suppresses propagation bumps */
  suppressed: boolean;
  isDependencyBump: boolean;
  isCascadeBump: boolean;
  bumpFiles: Set<string>;
}

/**
 * Build a release plan from pending bump files, the dependency graph, and config.
 * This is the core algorithm of bumpy.
 *
 * The propagation loop runs three phases until stable:
 *   Phase A — fix out-of-range dependencies (always runs)
 *   Phase B — enforce fixed/linked group constraints
 *   Phase C — apply cascades and proactive propagation rules
 */
export function assembleReleasePlan(
  bumpFiles: BumpFile[],
  packages: Map<string, WorkspacePackage>,
  depGraph: DependencyGraph,
  config: BumpyConfig,
): ReleasePlan {
  if (bumpFiles.length === 0) {
    return { bumpFiles: [], releases: [], warnings: [] };
  }

  const planned = new Map<string, PlannedBump>();
  const warnings: string[] = [];

  // Step 1: Collect explicit bumps from bump files
  const cascadeOverrides = new Map<string, Map<string, BumpType>>(); // pkg → (glob → bumpType)
  const suppressedPackages = new Set<string>(); // packages with explicit 'none'

  for (const bf of bumpFiles) {
    for (const release of bf.releases) {
      if (!packages.has(release.name)) continue;
      const { bump, isolated } = parseIsolatedBump(release.type);

      if (bump === 'none') {
        suppressedPackages.add(release.name);
        continue;
      }

      const existing = planned.get(release.name);
      if (existing) {
        existing.type = maxBump(existing.type, bump);
        // If ANY bump file is non-isolated, the package is non-isolated
        if (!isolated) existing.isolated = false;
        existing.bumpFiles.add(bf.id);
      } else {
        planned.set(release.name, {
          type: bump,
          isolated,
          suppressed: false,
          isDependencyBump: false,
          isCascadeBump: false,
          bumpFiles: new Set([bf.id]),
        });
      }

      // Collect per-bump-file cascade overrides
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

  // Mark suppressed packages (explicit 'none' in bump file)
  for (const name of suppressedPackages) {
    if (!planned.has(name)) {
      // Create a placeholder that will be removed later
      // This prevents propagation from adding this package
      planned.set(name, {
        type: 'patch', // placeholder, won't be used
        isolated: false,
        suppressed: true,
        isDependencyBump: false,
        isCascadeBump: false,
        bumpFiles: new Set(),
      });
    }
  }

  // Step 2: Propagation loop (iterative until stable)
  let changed = true;
  let iterations = 0;
  const MAX_ITERATIONS = 100; // safety valve

  while (changed && iterations < MAX_ITERATIONS) {
    changed = false;
    iterations++;

    // Phase A: Fix out-of-range dependencies (always runs)
    for (const [pkgName, bump] of planned) {
      if (bump.suppressed) continue;

      const pkg = packages.get(pkgName)!;
      const newVersion = bumpVersion(pkg.version, bump.type);
      const dependents = depGraph.getDependents(pkgName);

      for (const dep of dependents) {
        // Skip devDependencies in Phase A
        if (dep.depType === 'devDependencies') continue;

        // Check if new version is out of range
        const currentVersion = pkg.version;
        if (satisfies(newVersion, dep.versionRange, currentVersion)) continue;

        // Determine bump level for the dependent
        let depBump: BumpType;
        if (dep.depType === 'peerDependencies') {
          // Match the triggering bump level
          depBump = bump.type;
        } else {
          // dependencies / optionalDependencies get patch
          depBump = 'patch';
        }

        // Check if the dependent is suppressed
        const existingDep = planned.get(dep.name);
        if (existingDep?.suppressed) {
          throw new Error(
            `Cannot suppress bump for '${dep.name}' (via 'none' in bump file) — ` +
              `'${pkgName}' is bumping to ${newVersion} which breaks the declared range '${dep.versionRange}'. ` +
              `Either widen the range or remove the 'none' entry.`,
          );
        }

        // Check if isolated would break range
        if (bump.isolated) {
          throw new Error(
            `'patch-isolated' bump for '${pkgName}' would break the range '${dep.versionRange}' ` +
              `declared by '${dep.name}'. Either widen the range, drop '-isolated', ` +
              `or explicitly bump '${dep.name}' in the bump file.`,
          );
        }

        // Warn about ^0.x peer dep propagation
        if (dep.depType === 'peerDependencies' && depBump !== 'patch') {
          // Resolve workspace:^ to ^<version> for checking
          let resolvedRange = dep.versionRange.replace(/^workspace:/, '');
          if (resolvedRange === '^' || resolvedRange === '~') {
            resolvedRange = `${resolvedRange}${pkg.version}`;
          }
          if (/^\^0(\.|$)/.test(resolvedRange)) {
            warnings.push(
              `${dep.name} gets a ${depBump} bump because ${pkgName}@${newVersion} is out of range ` +
                `for its peer dep "${dep.versionRange}" (resolves to ${resolvedRange}). ` +
                `npm treats ^ on 0.x as minor-breaking. Consider using >=0.x ranges for pre-1.0 peer deps.`,
            );
          }
        }

        if (applyBump(planned, dep.name, depBump, true, false, bump.bumpFiles)) {
          changed = true;
        }
      }
    }

    // Phase B: Enforce fixed/linked group constraints
    for (const group of config.fixed) {
      let groupBump: BumpType | undefined;
      let groupIsolated = true;
      for (const nameOrGlob of group) {
        for (const [name, bump] of planned) {
          if (bump.suppressed) continue;
          if (matchGlob(name, nameOrGlob)) {
            groupBump = maxBump(groupBump, bump.type);
            if (!bump.isolated) groupIsolated = false;
          }
        }
      }
      if (!groupBump) continue;
      for (const nameOrGlob of group) {
        for (const [name] of packages) {
          if (!matchGlob(name, nameOrGlob)) continue;
          const existing = planned.get(name);
          if (existing && existing.suppressed) continue;
          if (existing) {
            const newType = maxBump(existing.type, groupBump);
            if (newType !== existing.type) {
              existing.type = newType;
              existing.isolated = groupIsolated;
              changed = true;
            }
          } else {
            planned.set(name, {
              type: groupBump,
              isolated: groupIsolated,
              suppressed: false,
              isDependencyBump: false,
              isCascadeBump: false,
              bumpFiles: new Set(),
            });
            changed = true;
          }
        }
      }
    }

    // Linked groups (same bump level, independent versions, only already-planned packages)
    for (const group of config.linked) {
      let groupBump: BumpType | undefined;
      for (const nameOrGlob of group) {
        for (const [name, bump] of planned) {
          if (bump.suppressed) continue;
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
          if (!existing || existing.suppressed) continue;
          const newType = maxBump(existing.type, groupBump);
          if (newType !== existing.type) {
            existing.type = newType;
            changed = true;
          }
        }
      }
    }

    // Phase C: Proactive propagation (only when updateInternalDependencies !== 'out-of-range')
    if (config.updateInternalDependencies !== 'out-of-range') {
      for (const [pkgName, bump] of planned) {
        if (bump.suppressed) continue;
        if (bump.isolated) continue;

        // Check minimum threshold for proactive propagation
        if (config.updateInternalDependencies === 'minor' && bumpLevel(bump.type) < bumpLevel('minor')) {
          continue;
        }

        // C1: Apply bump-file-level cascade overrides
        const bfOverrides = cascadeOverrides.get(pkgName);
        if (bfOverrides) {
          for (const [pattern, cascadeBumpType] of bfOverrides) {
            for (const [targetName] of packages) {
              if (!matchGlob(targetName, pattern)) continue;
              const existingTarget = planned.get(targetName);
              if (existingTarget?.suppressed) continue;
              if (applyBump(planned, targetName, cascadeBumpType, false, true, bump.bumpFiles)) {
                changed = true;
              }
            }
          }
        }

        // C2: Apply source-side cascadeTo config
        const pkg = packages.get(pkgName);
        const cascadeTo = pkg?.bumpy?.cascadeTo;
        if (cascadeTo) {
          for (const [pattern, rule] of Object.entries(cascadeTo)) {
            if (!shouldTrigger(bump.type, rule.trigger)) continue;
            const cascadeBump = rule.bumpAs === 'match' ? bump.type : rule.bumpAs;
            for (const [targetName] of packages) {
              if (!matchGlob(targetName, pattern)) continue;
              const existingTarget = planned.get(targetName);
              if (existingTarget?.suppressed) continue;
              if (applyBump(planned, targetName, cascadeBump, false, true, bump.bumpFiles)) {
                changed = true;
              }
            }
          }
        }

        // C3: Apply dependency graph proactive propagation
        const dependents = depGraph.getDependents(pkgName);
        for (const dep of dependents) {
          const rule = resolveRule(dep.name, dep.depType, packages, config);
          if (!rule) continue; // disabled for this dep type
          if (!shouldTrigger(bump.type, rule.trigger)) continue;

          const existingDep = planned.get(dep.name);
          if (existingDep?.suppressed) continue;

          const depBump = rule.bumpAs === 'match' ? bump.type : rule.bumpAs;
          if (applyBump(planned, dep.name, depBump, true, false, bump.bumpFiles)) {
            changed = true;
          }
        }
      }
    } else {
      // Even in out-of-range mode, still apply bump file cascades and cascadeTo
      for (const [pkgName, bump] of planned) {
        if (bump.suppressed) continue;
        if (bump.isolated) continue;

        // Bump-file-level cascade overrides always apply
        const bfOverrides = cascadeOverrides.get(pkgName);
        if (bfOverrides) {
          for (const [pattern, cascadeBumpType] of bfOverrides) {
            for (const [targetName] of packages) {
              if (!matchGlob(targetName, pattern)) continue;
              const existingTarget = planned.get(targetName);
              if (existingTarget?.suppressed) continue;
              if (applyBump(planned, targetName, cascadeBumpType, false, true, bump.bumpFiles)) {
                changed = true;
              }
            }
          }
        }

        // Source-side cascadeTo config always applies
        const pkg = packages.get(pkgName);
        const cascadeTo = pkg?.bumpy?.cascadeTo;
        if (cascadeTo) {
          for (const [pattern, rule] of Object.entries(cascadeTo)) {
            if (!shouldTrigger(bump.type, rule.trigger)) continue;
            const cascadeBump = rule.bumpAs === 'match' ? bump.type : rule.bumpAs;
            for (const [targetName] of packages) {
              if (!matchGlob(targetName, pattern)) continue;
              const existingTarget = planned.get(targetName);
              if (existingTarget?.suppressed) continue;
              if (applyBump(planned, targetName, cascadeBump, false, true, bump.bumpFiles)) {
                changed = true;
              }
            }
          }
        }
      }
    }
  }

  // Step 3: Validate suppressed packages — check that their ranges are still satisfied
  for (const [name, bump] of planned) {
    if (!bump.suppressed) continue;
    // Check all dependencies of this package to ensure none are broken
    const pkg = packages.get(name)!;
    // Check if any planned bump on a dependency would break this package's range
    for (const [depName, depBump] of planned) {
      if (depBump.suppressed) continue;
      const depPkg = packages.get(depName)!;
      const newDepVersion = bumpVersion(depPkg.version, depBump.type);

      // Check all dep types
      for (const depType of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
        const range = pkg[depType]?.[depName];
        if (!range) continue;
        if (!satisfies(newDepVersion, range, depPkg.version)) {
          throw new Error(
            `Cannot suppress bump for '${name}' (via 'none' in bump file) — ` +
              `'${depName}' is bumping to ${newDepVersion} which breaks the declared range '${range}'. ` +
              `Either widen the range or remove the 'none' entry.`,
          );
        }
      }
    }
  }

  // Step 4: Calculate new versions (exclude suppressed)
  const releases: PlannedRelease[] = [];
  for (const [name, bump] of planned) {
    if (bump.suppressed) continue;
    const pkg = packages.get(name);
    if (!pkg) continue;

    const newVersion = bumpVersion(pkg.version, bump.type);
    releases.push({
      name,
      type: bump.type,
      oldVersion: pkg.version,
      newVersion,
      bumpFiles: [...bump.bumpFiles],
      isDependencyBump: bump.isDependencyBump,
      isCascadeBump: bump.isCascadeBump,
    });
  }

  // Sort by name for stable output
  releases.sort((a, b) => a.name.localeCompare(b.name));

  // Static warning: workspace:* on peer deps
  for (const [name, pkg] of packages) {
    for (const [depName, range] of Object.entries(pkg.peerDependencies)) {
      if (range === 'workspace:*' && packages.has(depName)) {
        warnings.push(
          `${name} has peer dep "${depName}": "workspace:*" — this will be published as a fixed range ` +
            `which may not match your intent. Consider using "workspace:^" instead.`,
        );
      }
    }
  }

  return { bumpFiles, releases, warnings };
}

/** Apply a bump to a package, upgrading if already planned. Returns true if anything changed. */
function applyBump(
  planned: Map<string, PlannedBump>,
  name: string,
  type: BumpType,
  isDependencyBump: boolean,
  isCascadeBump: boolean,
  sourceBumpFiles: Set<string>,
): boolean {
  const existing = planned.get(name);
  if (existing) {
    if (existing.suppressed) return false;
    const newType = maxBump(existing.type, type);
    if (newType === existing.type) return false;
    existing.type = newType;
    if (isDependencyBump) existing.isDependencyBump = true;
    if (isCascadeBump) existing.isCascadeBump = true;
    for (const bf of sourceBumpFiles) existing.bumpFiles.add(bf);
    return true;
  }
  planned.set(name, {
    type,
    isolated: false,
    suppressed: false,
    isDependencyBump,
    isCascadeBump,
    bumpFiles: new Set(sourceBumpFiles),
  });
  return true;
}

/** Check if a bump level meets the trigger threshold */
function shouldTrigger(bumpType: BumpType, trigger: BumpType): boolean {
  return bumpLevel(bumpType) >= bumpLevel(trigger);
}

/**
 * Resolve the dependency bump rule for a specific dependent + dep type.
 * Priority: per-package depType rules > global depType rules > defaults
 * Returns false if the rule is disabled.
 */
function resolveRule(
  dependentName: string,
  depType: DepType,
  packages: Map<string, WorkspacePackage>,
  config: BumpyConfig,
): DependencyBumpRule | false {
  const dependent = packages.get(dependentName);

  // Check per-package dependency type rules
  if (dependent?.bumpy?.dependencyBumpRules && depType in dependent.bumpy.dependencyBumpRules) {
    return dependent.bumpy.dependencyBumpRules[depType]!;
  }

  // Check global config
  if (depType in config.dependencyBumpRules) {
    return config.dependencyBumpRules[depType]!;
  }

  // Built-in defaults
  const defaultRule = DEFAULT_BUMP_RULES[depType];
  return defaultRule !== undefined ? defaultRule : { trigger: 'patch', bumpAs: 'patch' };
}
