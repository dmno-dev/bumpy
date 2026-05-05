import { matchGlob } from './config.ts';
import { DependencyGraph } from './dep-graph.ts';
import { bumpVersion, satisfies } from './semver.ts';
import {
  type BumpyConfig,
  type BumpType,
  type BumpFile,
  type DependencyBumpRule,
  normalizeCascadeConfig,
  type DepType,
  type PlannedRelease,
  type ReleasePlan,
  type WorkspacePackage,
  DEFAULT_BUMP_RULES,
  bumpLevel,
  maxBump,
  hasCascade,
} from '../types.ts';

interface PlannedBump {
  type: BumpType;
  isDependencyBump: boolean;
  isCascadeBump: boolean;
  isGroupBump: boolean;
  bumpFiles: Set<string>;
  /** Package names that caused this bump via dependency/cascade/group propagation, with the bump type they contributed */
  bumpSources: Map<string, BumpType>;
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

  for (const bf of bumpFiles) {
    for (const release of bf.releases) {
      if (!packages.has(release.name)) continue;
      const bump = release.type;

      // 'none' means "no direct bump needed" — just skip it.
      // Cascading bumps from other packages can still add this package later.
      if (bump === 'none') continue;

      const existing = planned.get(release.name);
      if (existing) {
        existing.type = maxBump(existing.type, bump);
        existing.bumpFiles.add(bf.id);
      } else {
        planned.set(release.name, {
          type: bump,
          isDependencyBump: false,
          isCascadeBump: false,
          isGroupBump: false,
          bumpFiles: new Set([bf.id]),
          bumpSources: new Map(),
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

  // Step 2: Propagation loop (iterative until stable)
  let changed = true;
  let iterations = 0;
  const MAX_ITERATIONS = 100; // safety valve

  while (changed && iterations < MAX_ITERATIONS) {
    changed = false;
    iterations++;

    // Phase A: Fix out-of-range dependencies (always runs)
    for (const [pkgName, bump] of planned) {
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

        // Warn about ^0.x peer dep propagation (only when it's surprising, not for major→major)
        if (dep.depType === 'peerDependencies' && depBump !== 'patch' && bump.type !== 'major') {
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

        if (applyBump(planned, dep.name, depBump, true, false, pkgName)) {
          changed = true;
        }
      }
    }

    // Phase B: Enforce fixed/linked group constraints
    for (const group of config.fixed) {
      let groupBump: BumpType | undefined;
      const groupSources: string[] = [];
      for (const nameOrGlob of group) {
        for (const [name, bump] of planned) {
          if (matchGlob(name, nameOrGlob)) {
            if (!groupBump || bumpLevel(bump.type) > bumpLevel(groupBump)) {
              groupBump = bump.type;
              groupSources.length = 0;
              groupSources.push(name);
            } else if (bump.type === groupBump) {
              groupSources.push(name);
            }
          }
        }
      }
      if (!groupBump) continue;
      for (const nameOrGlob of group) {
        for (const [name] of packages) {
          if (!matchGlob(name, nameOrGlob)) continue;
          const existing = planned.get(name);
          if (existing) {
            const newType = maxBump(existing.type, groupBump);
            if (newType !== existing.type) {
              existing.type = newType;
              existing.isGroupBump = true;
              for (const src of groupSources) {
                if (src !== name) existing.bumpSources.set(src, groupBump);
              }
              changed = true;
            }
          } else {
            planned.set(name, {
              type: groupBump,
              isDependencyBump: false,
              isCascadeBump: false,
              isGroupBump: true,
              bumpFiles: new Set(),
              bumpSources: new Map(groupSources.filter((s) => s !== name).map((s) => [s, groupBump])),
            });
            changed = true;
          }
        }
      }
    }

    // Linked groups (same bump level, independent versions, only already-planned packages)
    for (const group of config.linked) {
      let groupBump: BumpType | undefined;
      const groupSources: string[] = [];
      for (const nameOrGlob of group) {
        for (const [name, bump] of planned) {
          if (matchGlob(name, nameOrGlob)) {
            if (!groupBump || bumpLevel(bump.type) > bumpLevel(groupBump)) {
              groupBump = bump.type;
              groupSources.length = 0;
              groupSources.push(name);
            } else if (bump.type === groupBump) {
              groupSources.push(name);
            }
          }
        }
      }
      if (!groupBump) continue;
      for (const nameOrGlob of group) {
        for (const [name] of packages) {
          if (!matchGlob(name, nameOrGlob)) continue;
          const existing = planned.get(name);
          if (!existing) continue;
          const newType = maxBump(existing.type, groupBump);
          if (newType !== existing.type) {
            existing.type = newType;
            existing.isGroupBump = true;
            for (const src of groupSources) {
              if (src !== name) existing.bumpSources.set(src, groupBump);
            }
            changed = true;
          }
        }
      }
    }

    // Phase C: Proactive propagation (only when updateInternalDependencies !== 'out-of-range')
    if (config.updateInternalDependencies !== 'out-of-range') {
      for (const [pkgName, bump] of planned) {
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
              if (applyBump(planned, targetName, cascadeBumpType, false, true, pkgName)) {
                changed = true;
              }
            }
          }
        }

        // C2: Apply source-side cascadeTo config
        const pkg = packages.get(pkgName);
        if (pkg?.bumpy?.cascadeTo) {
          if (applyCascadeRules(normalizeCascadeConfig(pkg.bumpy.cascadeTo), pkgName, bump.type, packages, planned)) {
            changed = true;
          }
        }

        // C2b: Apply consumer-side cascadeFrom config
        if (applyCascadeFrom(pkgName, bump.type, packages, planned)) {
          changed = true;
        }

        // C3: Apply dependency graph proactive propagation
        const dependents = depGraph.getDependents(pkgName);
        for (const dep of dependents) {
          const rule = resolveRule(dep.name, dep.depType, packages, config);
          if (!rule) continue; // disabled for this dep type
          if (!shouldTrigger(bump.type, rule.trigger)) continue;

          const depBump = rule.bumpAs === 'match' ? bump.type : rule.bumpAs;
          if (applyBump(planned, dep.name, depBump, true, false, pkgName)) {
            changed = true;
          }
        }
      }
    } else {
      // Even in out-of-range mode, still apply bump file cascades, cascadeTo, and cascadeFrom
      for (const [pkgName, bump] of planned) {
        // Bump-file-level cascade overrides always apply
        const bfOverrides = cascadeOverrides.get(pkgName);
        if (bfOverrides) {
          for (const [pattern, cascadeBumpType] of bfOverrides) {
            for (const [targetName] of packages) {
              if (!matchGlob(targetName, pattern)) continue;
              if (applyBump(planned, targetName, cascadeBumpType, false, true, pkgName)) {
                changed = true;
              }
            }
          }
        }

        // Source-side cascadeTo config always applies
        const pkg = packages.get(pkgName);
        if (pkg?.bumpy?.cascadeTo) {
          if (applyCascadeRules(normalizeCascadeConfig(pkg.bumpy.cascadeTo), pkgName, bump.type, packages, planned)) {
            changed = true;
          }
        }

        // Consumer-side cascadeFrom config always applies
        if (applyCascadeFrom(pkgName, bump.type, packages, planned)) {
          changed = true;
        }
      }
    }
  }

  // Step 3: Calculate new versions
  const releases: PlannedRelease[] = [];
  for (const [name, bump] of planned) {
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
      isGroupBump: bump.isGroupBump,
      bumpSources: [...bump.bumpSources].map(([srcName, contributedType]) => {
        const srcBump = planned.get(srcName);
        const srcPkg = packages.get(srcName);
        return {
          name: srcName,
          newVersion: srcPkg && srcBump ? bumpVersion(srcPkg.version, srcBump.type) : 'unknown',
          bumpType: contributedType,
        };
      }),
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
  sourcePackageName: string,
): boolean {
  const existing = planned.get(name);
  if (existing) {
    const newType = maxBump(existing.type, type);
    if (newType === existing.type) return false;
    existing.type = newType;
    if (isDependencyBump) existing.isDependencyBump = true;
    if (isCascadeBump) existing.isCascadeBump = true;
    existing.bumpSources.set(sourcePackageName, type);
    return true;
  }
  planned.set(name, {
    type,
    isDependencyBump,
    isCascadeBump,
    isGroupBump: false,
    bumpFiles: new Set(),
    bumpSources: new Map([[sourcePackageName, type]]),
  });
  return true;
}

/**
 * Apply normalized cascade rules (used for both cascadeTo and cascadeFrom).
 * Keys in `rules` are target package name/glob patterns.
 * Returns true if any bump was applied.
 */
function applyCascadeRules(
  rules: Record<string, Required<{ trigger: BumpType; bumpAs: BumpType | 'match' }>>,
  sourceName: string,
  sourceType: BumpType,
  packages: Map<string, WorkspacePackage>,
  planned: Map<string, PlannedBump>,
): boolean {
  let changed = false;
  for (const [pattern, rule] of Object.entries(rules)) {
    if (!shouldTrigger(sourceType, rule.trigger)) continue;
    const cascadeBump = rule.bumpAs === 'match' ? sourceType : rule.bumpAs;
    for (const [targetName] of packages) {
      if (!matchGlob(targetName, pattern)) continue;
      if (applyBump(planned, targetName, cascadeBump, false, true, sourceName)) {
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * Apply consumer-side cascadeFrom rules.
 * Scans all packages for cascadeFrom entries where the pattern matches the bumped source.
 * Returns true if any bump was applied.
 */
function applyCascadeFrom(
  sourceName: string,
  sourceType: BumpType,
  packages: Map<string, WorkspacePackage>,
  planned: Map<string, PlannedBump>,
): boolean {
  let changed = false;
  for (const [targetName, targetPkg] of packages) {
    if (!targetPkg.bumpy?.cascadeFrom) continue;
    const rules = normalizeCascadeConfig(targetPkg.bumpy.cascadeFrom);
    for (const [pattern, rule] of Object.entries(rules)) {
      if (!matchGlob(sourceName, pattern)) continue;
      if (!shouldTrigger(sourceType, rule.trigger)) continue;
      const cascadeBump: BumpType = rule.bumpAs === 'match' ? sourceType : rule.bumpAs;
      if (applyBump(planned, targetName, cascadeBump, false, true, sourceName)) {
        changed = true;
      }
    }
  }
  return changed;
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
