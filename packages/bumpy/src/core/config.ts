import { resolve } from 'node:path';
import { readJson, readJsonc, exists } from '../utils/fs.ts';
import { type BumpyConfig, type PackageConfig, DEFAULT_CONFIG, normalizeCascadeConfig } from '../types.ts';

const BUMPY_DIR = '.bumpy';
const CONFIG_FILE = '_config.json';

/** Find the monorepo root by walking up from cwd looking for .bumpy/ */
export async function findRoot(startDir: string = process.cwd()): Promise<string> {
  let dir = resolve(startDir);
  while (true) {
    if (await exists(resolve(dir, BUMPY_DIR))) return dir;
    // Also check for package.json with workspaces as a fallback
    if (await exists(resolve(dir, 'package.json'))) {
      try {
        const pkg = await readJson<Record<string, unknown>>(resolve(dir, 'package.json'));
        if (pkg.workspaces) return dir;
      } catch {
        // ignore
      }
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  // Default to cwd if nothing found
  return resolve(startDir);
}

/** Load the root bumpy config, merging with defaults */
export async function loadConfig(rootDir: string): Promise<BumpyConfig> {
  const configPath = resolve(rootDir, BUMPY_DIR, CONFIG_FILE);
  let userConfig: Partial<BumpyConfig> = {};
  if (await exists(configPath)) {
    userConfig = await readJsonc<Partial<BumpyConfig>>(configPath);
  }
  return mergeConfig(DEFAULT_CONFIG, userConfig);
}

/** Load per-package bumpy config from package.json["bumpy"] or .bumpy.config.json */
export async function loadPackageConfig(
  pkgDir: string,
  rootConfig: BumpyConfig,
  pkgName: string,
): Promise<PackageConfig> {
  // Start with what's in the root config's packages map
  const rootPkgConfig = findPackageConfig(rootConfig, pkgName);

  // Layer on package.json["bumpy"]
  let pkgJsonConfig: PackageConfig = {};
  try {
    const pkg = await readJson<Record<string, unknown>>(resolve(pkgDir, 'package.json'));
    if (pkg.bumpy && typeof pkg.bumpy === 'object') {
      pkgJsonConfig = pkg.bumpy as PackageConfig;
    }
  } catch {
    // ignore
  }

  // The pre-targets publish fields were removed (breaking) — fail with the migration
  // rather than silently ignoring them
  const legacy = (['publishCommand', 'skipNpmPublish', 'checkPublished'] as const).filter(
    (k) =>
      (pkgJsonConfig as Record<string, unknown>)[k] != null || (rootPkgConfig as Record<string, unknown>)[k] != null,
  );
  if (legacy.length > 0) {
    throw new Error(
      `Package "${pkgName}" uses removed config field(s) ${legacy.map((k) => `"${k}"`).join(', ')}. Migrate to "publishTargets":\n` +
        '  publishCommand + checkPublished → "publishTargets": [{ "type": "custom", "name": "custom", "command": ..., "checkPublished": ... }]\n' +
        '  skipNpmPublish: true → "publishTargets": []\n' +
        '(name the custom instance "custom" so an in-flight release keeps resuming from its existing metadata)',
    );
  }

  // Trust boundary: a package's own package.json may only *reference* publish targets
  // by name. Anything that steers the credentialed publish — a build command, or an
  // inline target definition carrying options (`registry` redirects it, `publishArgs`
  // injects CLI flags, `command` runs a shell) — requires the root config to opt the
  // package in. The root config itself (`packages` and `targets` maps) is always trusted.
  const disallowed: string[] = [];
  if (pkgJsonConfig.buildCommand != null) disallowed.push('buildCommand');
  if ((pkgJsonConfig.publishTargets ?? []).some((entry) => typeof entry === 'object')) {
    disallowed.push('publishTargets (inline target definitions)');
  }
  if (disallowed.length > 0 && !isCustomCommandAllowed(pkgName, rootConfig)) {
    throw new Error(
      `Package "${pkgName}" defines ${disallowed.map((k) => `"${k}"`).join(', ')} in its package.json "bumpy" config, ` +
        'but the root config does not allow this.\n' +
        'Build commands and inline target definitions steer publishing with CI credentials and must be explicitly enabled.\n\n' +
        'To fix this, either:\n' +
        '  1. Move it to .bumpy/_config.json (always trusted) — under "packages", or as a named ' +
        'instance in "targets" that the package references by name\n' +
        `  2. Add "allowCustomCommands": true (or ["${pkgName}"]) to .bumpy/_config.json`,
    );
  }

  // Merge: root packages map → package.json["bumpy"] (later wins)
  return mergePackageConfig(rootPkgConfig, pkgJsonConfig);
}

/** Find a package config from the root config, supporting glob patterns */
function findPackageConfig(config: BumpyConfig, pkgName: string): PackageConfig {
  // Exact match first
  if (config.packages[pkgName]) return config.packages[pkgName];
  // Try glob matches
  for (const [pattern, pkgConfig] of Object.entries(config.packages)) {
    if (matchGlob(pkgName, pattern)) return pkgConfig;
  }
  return {};
}

/** Simple glob matching for package names (supports * and **) */
export function matchGlob(name: string, pattern: string): boolean {
  // Exact match
  if (name === pattern) return true;
  // Convert glob to regex
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex special chars
    .replace(/\*\*/g, '{{DOUBLE}}') // placeholder for **
    .replace(/\*/g, '[^/]*') // * matches anything except /
    .replace(/{{DOUBLE}}/g, '.*'); // ** matches anything
  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(name);
}

function mergeConfig(defaults: BumpyConfig, user: Partial<BumpyConfig>): BumpyConfig {
  return {
    ...defaults,
    ...user,
    dependencyBumpRules: {
      ...defaults.dependencyBumpRules,
      ...user.dependencyBumpRules,
    },
    privatePackages: {
      ...defaults.privatePackages,
      ...user.privatePackages,
    },
    publish: {
      ...defaults.publish,
      ...user.publish,
    },
    targets: {
      ...defaults.targets,
      ...user.targets,
    },
    packages: {
      ...defaults.packages,
      ...user.packages,
    },
    channels: {
      ...defaults.channels,
      ...user.channels,
    },
    snapshot: {
      ...defaults.snapshot,
      ...user.snapshot,
    },
  };
}

function mergePackageConfig(...configs: PackageConfig[]): PackageConfig {
  const result: PackageConfig = {};
  for (const cfg of configs) {
    Object.assign(result, cfg);
    // Deep merge nested objects
    if (cfg.dependencyBumpRules) {
      result.dependencyBumpRules = { ...result.dependencyBumpRules, ...cfg.dependencyBumpRules };
    }
    if (cfg.cascadeTo) {
      result.cascadeTo = {
        ...(result.cascadeTo ? normalizeCascadeConfig(result.cascadeTo) : {}),
        ...normalizeCascadeConfig(cfg.cascadeTo),
      };
    }
    if (cfg.cascadeFrom) {
      result.cascadeFrom = {
        ...(result.cascadeFrom ? normalizeCascadeConfig(result.cascadeFrom) : {}),
        ...normalizeCascadeConfig(cfg.cascadeFrom),
      };
    }
  }
  return result;
}

/** Check if a package is allowed to define custom commands via package.json */
function isCustomCommandAllowed(pkgName: string, config: BumpyConfig): boolean {
  const { allowCustomCommands } = config;
  if (allowCustomCommands === true) return true;
  if (Array.isArray(allowCustomCommands)) {
    return allowCustomCommands.some((pattern) => matchGlob(pkgName, pattern));
  }
  return false;
}

export function getBumpyDir(rootDir: string): string {
  return resolve(rootDir, BUMPY_DIR);
}

/**
 * Determine if a package should be managed by bumpy.
 * Resolution order:
 * 1. Per-package `managed: false` → skip (explicit opt-out)
 * 2. `config.ignore` glob match → skip
 * 3. Per-package `managed: true` → include (explicit opt-in, overrides private)
 * 4. `config.include` glob match → include (overrides private)
 * 5. Private package that declares publish targets → include (it ships somewhere:
 *    a marketplace extension, a PyPI stub, a CLI distributed as release assets)
 * 6. Private package + `config.privatePackages.version` false → skip
 * 7. Otherwise → include
 */
export function isPackageManaged(
  pkgName: string,
  isPrivate: boolean,
  config: BumpyConfig,
  pkgBumpy?: PackageConfig,
): boolean {
  // 1. Explicit opt-out via per-package config
  if (pkgBumpy?.managed === false) return false;

  // 2. Ignored by glob
  if (config.ignore.some((pattern) => matchGlob(pkgName, pattern))) {
    // ...unless explicitly opted in
    if (pkgBumpy?.managed === true) return true;
    if (config.include.some((pattern) => matchGlob(pkgName, pattern))) return true;
    return false;
  }

  // 3. Explicit opt-in via per-package config
  if (pkgBumpy?.managed === true) return true;

  // 4. Included by glob (overrides private)
  if (config.include.some((pattern) => matchGlob(pkgName, pattern))) return true;

  // 5. "private": true only means "not npm"; explicit targets mean it publishes anyway
  if (isPrivate && (pkgBumpy?.publishTargets?.length ?? 0) > 0) return true;

  // 6. Private package check
  if (isPrivate && !config.privatePackages.version) return false;

  // 7. Default: managed
  return true;
}
