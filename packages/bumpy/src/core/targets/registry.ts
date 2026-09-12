import { log } from '../../utils/logger.ts';
import { npmTarget } from './npm.ts';
import { customTarget } from './custom.ts';
import { jsrTarget } from './jsr.ts';
import { pypiTarget } from './pypi.ts';
import { vscodeMarketplaceTarget, openVsxTarget } from './vscode.ts';
import { githubReleaseAssetsTarget } from './github-release-assets.ts';
import { dockerTarget } from './docker.ts';
import { homebrewTarget } from './homebrew.ts';
import type {
  BumpyConfig,
  PackageConfig,
  PackageTargetEntry,
  TargetDefinition,
  WorkspacePackage,
} from '../../types.ts';
import type { PublishTargetPlugin, ReleaseKind, ResolvedTarget, TargetOptions, TargetPhase } from './types.ts';

/**
 * Built-in publish targets. These register through the same interface external
 * plugins will eventually load through — being built-in is a packaging choice,
 * not an architectural one.
 */
const BUILT_IN_TARGETS: Record<string, PublishTargetPlugin> = {
  [npmTarget.type]: npmTarget,
  [customTarget.type]: customTarget,
  [jsrTarget.type]: jsrTarget,
  [pypiTarget.type]: pypiTarget,
  [vscodeMarketplaceTarget.type]: vscodeMarketplaceTarget,
  [openVsxTarget.type]: openVsxTarget,
  [githubReleaseAssetsTarget.type]: githubReleaseAssetsTarget,
  [dockerTarget.type]: dockerTarget,
  [homebrewTarget.type]: homebrewTarget,
};

export function getTargetPlugin(type: string): PublishTargetPlugin | undefined {
  return BUILT_IN_TARGETS[type];
}

export function knownTargetTypes(): string[] {
  return Object.keys(BUILT_IN_TARGETS);
}

function requirePlugin(type: string, context: string): PublishTargetPlugin {
  const plugin = BUILT_IN_TARGETS[type];
  if (!plugin) {
    throw new Error(
      `Unknown publish target type "${type}" (${context}). Known types: ${knownTargetTypes().join(', ')}`,
    );
  }
  return plugin;
}

/** The phase an instance runs in: its `phase` option, else the plugin's default */
function resolvePhase(plugin: PublishTargetPlugin, options: TargetOptions): TargetPhase {
  const override = options.phase;
  if (override === 'release' || override === 'post-release') return override;
  if (override !== undefined) {
    throw new Error(`Invalid target "phase" ${JSON.stringify(override)} — expected "release" or "post-release"`);
  }
  return plugin.phase ?? 'release';
}

function instance(name: string, type: string, plugin: PublishTargetPlugin, options: TargetOptions): ResolvedTarget {
  return { name, type, plugin, options, phase: resolvePhase(plugin, options) };
}

/** Options from a root `targets` map entry, minus the structural `type` key */
function definitionOptions(def: TargetDefinition | undefined): TargetOptions {
  if (!def) return {};
  const { type: _type, ...options } = def;
  return options;
}

function resolveStringEntry(ref: string, config: BumpyConfig | undefined, pkgName: string): ResolvedTarget {
  const def = config?.targets?.[ref];

  // A key matching a built-in type names an instance of that type (the entry, if any,
  // holds that instance's options — nothing is inherited by other instances)
  if (BUILT_IN_TARGETS[ref]) {
    if (def?.type && def.type !== ref) {
      throw new Error(
        `targets["${ref}"] sets type "${def.type}", but "${ref}" is a built-in target type — ` +
          `rename the entry to define a separate named instance`,
      );
    }
    return instance(ref, ref, BUILT_IN_TARGETS[ref], definitionOptions(def));
  }

  // Named instance from the root targets map
  if (def) {
    if (typeof def.type !== 'string' || !def.type) {
      throw new Error(`targets["${ref}"] must declare a "type" — it doesn't match any built-in target type`);
    }
    const plugin = requirePlugin(def.type, `targets["${ref}"]`);
    return instance(ref, def.type, plugin, definitionOptions(def));
  }

  if (!config) {
    throw new Error(
      `Cannot resolve publish target "${ref}" for "${pkgName}" without the root config — ` +
        `it is not a built-in target type`,
    );
  }
  throw new Error(
    `Package "${pkgName}" references unknown publish target "${ref}" — ` +
      `not a built-in type (${knownTargetTypes().join(', ')}) and not defined in the root config's "targets" map`,
  );
}

function resolveInlineEntry(
  entry: PackageTargetEntry,
  config: BumpyConfig | undefined,
  pkgName: string,
): ResolvedTarget {
  if (typeof entry.type !== 'string' || !entry.type) {
    throw new Error(`Package "${pkgName}" has a publishTargets entry without a "type"`);
  }
  const plugin = requirePlugin(entry.type, `package "${pkgName}" publishTargets`);
  const { type, name, ...options } = entry;
  return instance(typeof name === 'string' && name ? name : type, type, plugin, options);
}

/**
 * Resolve the publish targets for a package: explicit `publishTargets` config if
 * present, otherwise the implicit default — npm for public packages, nothing for
 * private ones.
 *
 * npm-type targets are dropped for `"private": true` packages (npm refuses to publish
 * them) — this is what lets a private VS Code extension publish to the marketplace
 * while never touching npm.
 */
export function resolvePackageTargets(
  pkg: Pick<WorkspacePackage, 'name' | 'private'>,
  pkgConfig: PackageConfig,
  config?: BumpyConfig,
): ResolvedTarget[] {
  const entries = pkgConfig.publishTargets ?? (pkg.private ? [] : ['npm']);

  const resolved: ResolvedTarget[] = [];
  for (const entry of entries) {
    const target =
      typeof entry === 'string'
        ? resolveStringEntry(entry, config, pkg.name)
        : resolveInlineEntry(entry, config, pkg.name);

    if (pkg.private && target.plugin.capabilities.refusesPrivatePackages) {
      log.warn(
        `  ${pkg.name}: dropping publish target "${target.name}" — package is "private": true (${target.type} refuses to publish it)`,
      );
      continue;
    }
    if (resolved.some((t) => t.name === target.name)) {
      throw new Error(
        `Package "${pkg.name}" has duplicate publish target name "${target.name}" — ` +
          `give one instance an explicit unique "name" (it keys the release metadata)`,
      );
    }
    resolved.push(target);
  }
  return resolved;
}

/**
 * Publish targets for a package: the instances attached at workspace discovery, or a
 * lazy resolution for hand-constructed packages (tests, partial contexts). Without a
 * root config, named-instance references can't resolve — pass `config` when you have it.
 */
export function getPackageTargets(pkg: WorkspacePackage, config?: BumpyConfig): ResolvedTarget[] {
  if (pkg.targets) return pkg.targets;
  return resolvePackageTargets(pkg, pkg.bumpy || {}, config);
}

/** Whether this package publishes anywhere at all */
export function packagePublishes(pkg: WorkspacePackage, config?: BumpyConfig): boolean {
  return getPackageTargets(pkg, config).length > 0;
}

/**
 * Whether a target participates in this kind of release — the capability gates.
 * Shared by the pipeline (which records a `capability` skip) and the planners (which
 * drop packages nothing can publish, so no draft release is ever opened for them).
 */
export function targetSupportsRelease(
  target: ResolvedTarget,
  releaseKind: ReleaseKind,
  isPrerelease: boolean,
): boolean {
  const caps = target.plugin.capabilities;
  if (releaseKind === 'snapshot' && !caps.snapshots) return false;
  if (isPrerelease && !caps.prereleases) return false;
  return true;
}

/** Whether any of the package's targets can publish this kind of release (channel/snapshot versions are always prereleases) */
export function packagePublishesFor(pkg: WorkspacePackage, releaseKind: ReleaseKind, config?: BumpyConfig): boolean {
  const isPrerelease = releaseKind !== 'stable';
  return getPackageTargets(pkg, config).some((t) => targetSupportsRelease(t, releaseKind, isPrerelease));
}

/** First npm-type target instance for a package, if any (registry queries use its options) */
export function getNpmTarget(pkg: WorkspacePackage, config?: BumpyConfig): ResolvedTarget | undefined {
  return getPackageTargets(pkg, config).find((t) => t.type === 'npm');
}

/** Display label for a resolved target (plugin label, falling back to the instance name) */
export function targetLabel(target: ResolvedTarget, pkg?: WorkspacePackage): string {
  return target.plugin.label?.(target.options, pkg) ?? target.name;
}
