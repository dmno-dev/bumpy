import { log } from '../../utils/logger.ts';
import { npmTarget } from './npm.ts';
import { customTarget } from './custom.ts';
import { jsrTarget } from './jsr.ts';
import { pypiTarget } from './pypi.ts';
import { vscodeMarketplaceTarget, openVsxTarget } from './vscode.ts';
import type {
  BumpyConfig,
  PackageConfig,
  PackageTargetEntry,
  TargetDefinition,
  WorkspacePackage,
} from '../../types.ts';
import type { PublishTargetPlugin, ResolvedTarget, TargetOptions } from './types.ts';

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

/** Options from a root `targets` map entry, minus the structural `type` key */
function definitionOptions(def: TargetDefinition | undefined): TargetOptions {
  if (!def) return {};
  const { type: _type, ...options } = def;
  return options;
}

/**
 * Type-level default options for `type`: the root `targets` map entry whose key IS the
 * type name. (Named instances layer their own options on top of these.)
 */
function typeDefaults(type: string, config?: BumpyConfig): TargetOptions {
  return definitionOptions(config?.targets?.[type]);
}

function resolveStringEntry(ref: string, config: BumpyConfig | undefined, pkgName: string): ResolvedTarget {
  const def = config?.targets?.[ref];

  // A key matching a built-in type is type-level defaults, not a redirection
  if (BUILT_IN_TARGETS[ref]) {
    if (def?.type && def.type !== ref) {
      throw new Error(
        `targets["${ref}"] sets type "${def.type}", but "${ref}" is a built-in target type — ` +
          `rename the entry to define a separate named instance`,
      );
    }
    return { name: ref, type: ref, plugin: BUILT_IN_TARGETS[ref], options: definitionOptions(def) };
  }

  // Named instance from the root targets map
  if (def) {
    if (typeof def.type !== 'string' || !def.type) {
      throw new Error(`targets["${ref}"] must declare a "type" — it doesn't match any built-in target type`);
    }
    const plugin = requirePlugin(def.type, `targets["${ref}"]`);
    return {
      name: ref,
      type: def.type,
      plugin,
      options: { ...typeDefaults(def.type, config), ...definitionOptions(def) },
    };
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
  return {
    name: typeof name === 'string' && name ? name : type,
    type,
    plugin,
    options: { ...typeDefaults(type, config), ...options },
  };
}

/**
 * Map the legacy per-package fields (`publishCommand`, `skipNpmPublish`, `private`)
 * onto target instances. Instance names intentionally match the metadata keys the
 * previous pipeline wrote ("npm", "custom") so in-flight releases resume cleanly.
 */
function resolveLegacyTargets(
  pkg: Pick<WorkspacePackage, 'private'>,
  pkgConfig: PackageConfig,
  config?: BumpyConfig,
): ResolvedTarget[] {
  if (pkgConfig.publishCommand) {
    return [
      {
        name: 'custom',
        type: 'custom',
        plugin: customTarget,
        options: {
          ...typeDefaults('custom', config),
          command: pkgConfig.publishCommand,
          ...(pkgConfig.checkPublished ? { checkPublished: pkgConfig.checkPublished } : {}),
        },
      },
    ];
  }
  if (pkg.private || pkgConfig.skipNpmPublish) return [];
  return [{ name: 'npm', type: 'npm', plugin: npmTarget, options: typeDefaults('npm', config) }];
}

/**
 * Resolve the publish targets for a package: explicit `publishTargets` config if
 * present, otherwise derived from the legacy fields / implicit npm default.
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
  const entries = pkgConfig.publishTargets;
  if (entries === undefined) {
    return resolveLegacyTargets(pkg as WorkspacePackage, pkgConfig, config);
  }

  if (pkgConfig.publishCommand || pkgConfig.skipNpmPublish) {
    log.warn(`  ${pkg.name}: "publishTargets" is set — ignoring legacy "publishCommand"/"skipNpmPublish" fields`);
  }

  const resolved: ResolvedTarget[] = [];
  for (const entry of entries) {
    const target =
      typeof entry === 'string'
        ? resolveStringEntry(entry, config, pkg.name)
        : resolveInlineEntry(entry, config, pkg.name);

    if (pkg.private && target.type === 'npm') {
      log.warn(
        `  ${pkg.name}: dropping npm publish target "${target.name}" — package is "private": true (npm refuses to publish it)`,
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

/** First npm-type target instance for a package, if any (registry queries use its options) */
export function getNpmTarget(pkg: WorkspacePackage, config?: BumpyConfig): ResolvedTarget | undefined {
  return getPackageTargets(pkg, config).find((t) => t.type === 'npm');
}

/** Display label for a resolved target (plugin label, falling back to the instance name) */
export function targetLabel(target: ResolvedTarget, pkg?: WorkspacePackage): string {
  return target.plugin.label?.(target.options, pkg) ?? target.name;
}
