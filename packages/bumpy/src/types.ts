// ---- Bump types ----

export type BumpType = 'major' | 'minor' | 'patch';
export type BumpTypeWithIsolated = BumpType | 'minor-isolated' | 'patch-isolated';

export const BUMP_LEVELS: Record<BumpType, number> = {
  patch: 0,
  minor: 1,
  major: 2,
};

export function bumpLevel(type: BumpType): number {
  return BUMP_LEVELS[type];
}

export function parseIsolatedBump(type: BumpTypeWithIsolated): { bump: BumpType; isolated: boolean } {
  if (type.endsWith('-isolated')) {
    return { bump: type.replace('-isolated', '') as BumpType, isolated: true };
  }
  return { bump: type as BumpType, isolated: false };
}

export function maxBump(a: BumpType | undefined, b: BumpType): BumpType {
  if (!a) return b;
  return bumpLevel(a) >= bumpLevel(b) ? a : b;
}

// ---- Dependency bump rules ----

export interface DependencyBumpRule {
  /** What bump level in the dependency triggers propagation */
  trigger: BumpType | 'none';
  /** What bump to apply to the dependent */
  bumpAs: BumpType | 'match';
}

export const DEFAULT_BUMP_RULES: Record<string, DependencyBumpRule> = {
  dependencies: { trigger: 'patch', bumpAs: 'patch' },
  peerDependencies: { trigger: 'major', bumpAs: 'major' },
  devDependencies: { trigger: 'none', bumpAs: 'patch' },
  optionalDependencies: { trigger: 'minor', bumpAs: 'patch' },
};

export type DepType = 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies';
export const DEP_TYPES: DepType[] = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

// ---- Config ----

export interface PublishConfig {
  /** Package manager to use for packing. "auto" detects from lockfile. Default: "auto" */
  packManager: 'auto' | 'npm' | 'pnpm' | 'bun' | 'yarn';
  /** Command to use for publishing. "npm" uses npm publish (supports OIDC). Default: "npm" */
  publishManager: 'npm' | 'pnpm' | 'bun' | 'yarn';
  /** Extra args appended to the publish command (e.g., "--provenance") */
  publishArgs: string[];
  /**
   * How to handle workspace:/catalog: protocol resolution.
   * "pack" = use PM's pack to build a clean tarball, then publish the tarball (recommended)
   * "in-place" = resolve protocols by rewriting package.json before publish
   * "none" = don't resolve (only if PM's publish handles it natively)
   * Default: "pack"
   */
  protocolResolution: 'pack' | 'in-place' | 'none';
}

export interface BumpyConfig {
  baseBranch: string;
  access: 'public' | 'restricted';
  commit: boolean;
  changelog: string | [string, Record<string, unknown>];
  fixed: string[][];
  linked: string[][];
  /** Package names/globs to exclude from version management */
  ignore: string[];
  /** Package names/globs to explicitly include (overrides private + ignore) */
  include: string[];
  updateInternalDependencies: 'patch' | 'minor' | 'out-of-range' | 'none';
  dependencyBumpRules: Partial<Record<DepType, DependencyBumpRule>>;
  privatePackages: { version: boolean; tag: boolean };
  packages: Record<string, PackageConfig>;
  publish: PublishConfig;
  /**
   * GitHub release creation (requires `gh` CLI).
   * false = individual release per package (default)
   * true = single aggregated release for all packages
   * { enabled: true, title: "..." } = aggregate with custom title (supports {{date}})
   */
  aggregateRelease: boolean | { enabled: boolean; title?: string };
}

export interface PackageConfig {
  /** Explicitly opt in or out of version management (overrides private/ignore/include) */
  managed?: boolean;
  access?: 'public' | 'restricted';
  publishCommand?: string | string[];
  buildCommand?: string;
  registry?: string;
  skipNpmPublish?: boolean;
  dependencyBumpRules?: Partial<Record<DepType, DependencyBumpRule>>;
  specificDependencyRules?: Record<string, DependencyBumpRule>;
  cascadeTo?: Record<string, DependencyBumpRule>;
}

export const DEFAULT_PUBLISH_CONFIG: PublishConfig = {
  packManager: 'auto',
  publishManager: 'npm',
  publishArgs: [],
  protocolResolution: 'pack',
};

export const DEFAULT_CONFIG: BumpyConfig = {
  baseBranch: 'main',
  access: 'public',
  commit: false,
  changelog: 'default',
  fixed: [],
  linked: [],
  ignore: [],
  include: [],
  updateInternalDependencies: 'out-of-range',
  dependencyBumpRules: {},
  privatePackages: { version: false, tag: false },
  packages: {},
  publish: { ...DEFAULT_PUBLISH_CONFIG },
  aggregateRelease: false,
};

// ---- Changeset ----

export interface ChangesetReleaseSimple {
  name: string;
  type: BumpTypeWithIsolated;
}

export interface ChangesetReleaseCascade {
  name: string;
  type: BumpTypeWithIsolated;
  cascade: Record<string, BumpType>; // glob pattern → bump type
}

export type ChangesetRelease = ChangesetReleaseSimple | ChangesetReleaseCascade;

export function hasCascade(r: ChangesetRelease): r is ChangesetReleaseCascade {
  return 'cascade' in r && Object.keys(r.cascade).length > 0;
}

export interface Changeset {
  id: string; // filename without .md
  releases: ChangesetRelease[];
  summary: string; // markdown body
}

// ---- Workspace ----

export interface WorkspacePackage {
  name: string;
  version: string;
  dir: string; // absolute path
  relativeDir: string;
  packageJson: Record<string, unknown>;
  private: boolean;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  bumpy?: PackageConfig; // per-package config from package.json or .bumpy.config.json
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

// ---- Dependency graph ----

export interface DependentInfo {
  /** The package that depends on the source */
  name: string;
  depType: DepType;
  versionRange: string;
}

// ---- Release plan ----

export interface PlannedRelease {
  name: string;
  type: BumpType;
  oldVersion: string;
  newVersion: string;
  changesets: string[]; // changeset IDs that contributed
  isDependencyBump: boolean;
  isCascadeBump: boolean;
}

export interface ReleasePlan {
  changesets: Changeset[];
  releases: PlannedRelease[];
}
