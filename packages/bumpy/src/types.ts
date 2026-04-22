// ---- Bump types ----

export type BumpType = 'major' | 'minor' | 'patch';
export type BumpTypeWithNone = BumpType | 'none';

export const BUMP_LEVELS: Record<BumpType, number> = {
  patch: 0,
  minor: 1,
  major: 2,
};

export function bumpLevel(type: BumpType): number {
  return BUMP_LEVELS[type];
}

export function maxBump(a: BumpType | undefined, b: BumpType): BumpType {
  if (!a) return b;
  return bumpLevel(a) >= bumpLevel(b) ? a : b;
}

// ---- Dependency bump rules ----

export interface DependencyBumpRule {
  /** What bump level in the dependency triggers propagation */
  trigger: BumpType;
  /** What bump to apply to the dependent */
  bumpAs: BumpType | 'match';
}

export const DEFAULT_BUMP_RULES: Record<string, DependencyBumpRule | false> = {
  dependencies: { trigger: 'patch', bumpAs: 'patch' },
  peerDependencies: { trigger: 'major', bumpAs: 'match' },
  devDependencies: false,
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
  /**
   * Customize the commit message used when versioning.
   * A string starting with "./" is treated as a path to a module that exports
   * a function receiving the release plan and returning a message string.
   * Any other string is used as a static commit message.
   * Omit to use the default: "Version packages\n\npkg@version..."
   */
  versionCommitMessage?: string;
  changelog: false | string | [string, Record<string, unknown>];
  fixed: string[][];
  linked: string[][];
  /** Glob patterns to filter which changed files count toward marking a package as changed */
  changedFilePatterns: string[];
  /** Package names/globs to exclude from version management */
  ignore: string[];
  /** Package names/globs to explicitly include (overrides private + ignore) */
  include: string[];
  updateInternalDependencies: 'patch' | 'minor' | 'out-of-range';
  dependencyBumpRules: Partial<Record<DepType, DependencyBumpRule | false>>;
  privatePackages: { version: boolean; tag: boolean };
  /**
   * Allow per-package custom commands (buildCommand, publishCommand, checkPublished)
   * defined in package.json "bumpy" fields.
   * Commands defined in the root config's `packages` map are always trusted.
   *
   * true = allow all packages to define custom commands
   * string[] = allow only matching package names/globs
   * false = only root-config commands are allowed (default)
   */
  allowCustomCommands: boolean | string[];
  packages: Record<string, PackageConfig>;
  publish: PublishConfig;
  /**
   * GitHub release creation (requires `gh` CLI).
   * false = individual release per package (default)
   * true = single aggregated release for all packages
   * { enabled: true, title: "..." } = aggregate with custom title (supports {{date}})
   */
  aggregateRelease: boolean | { enabled: boolean; title?: string };
  /** Git identity used for CI commits. Defaults to bumpy-bot. */
  gitUser: { name: string; email: string };
  /** Version PR settings */
  versionPr: {
    /** PR title. Default: "🐸 Versioned release" */
    title: string;
    /** Branch name. Default: "bumpy/version-packages" */
    branch: string;
    /** Preamble text shown at the top of the PR body */
    preamble: string;
  };
}

export interface PackageConfig {
  /** Explicitly opt in or out of version management (overrides private/ignore/include) */
  managed?: boolean;
  access?: 'public' | 'restricted';
  publishCommand?: string | string[];
  buildCommand?: string;
  registry?: string;
  skipNpmPublish?: boolean;
  /** Command to check if a version is already published. Should output the published version string. */
  checkPublished?: string;
  /** Glob patterns to filter which changed files count toward marking this package as changed */
  changedFilePatterns?: string[];
  dependencyBumpRules?: Partial<Record<DepType, DependencyBumpRule | false>>;
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
  versionCommitMessage: undefined,
  changedFilePatterns: ['**'],
  changelog: 'default',
  fixed: [],
  linked: [],
  ignore: [],
  include: [],
  updateInternalDependencies: 'out-of-range',
  dependencyBumpRules: {},
  privatePackages: { version: false, tag: false },
  allowCustomCommands: false,
  packages: {},
  publish: { ...DEFAULT_PUBLISH_CONFIG },
  aggregateRelease: false,
  gitUser: { name: 'bumpy-bot', email: '276066384+bumpy-bot@users.noreply.github.com' },
  versionPr: {
    title: '🐸 Versioned release',
    branch: 'bumpy/version-packages',
    preamble: [
      `<a href="https://bumpy.varlock.dev"><img src="https://raw.githubusercontent.com/dmno-dev/bumpy/main/images/frog-talking.png" alt="bumpy-frog" width="60" align="left" style="image-rendering: pixelated;" title="Hi! I'm bumpy!" /></a>`,
      '',
      `This PR was created and will be kept in sync by [bumpy](https://bumpy.varlock.dev) based on your bump files (in \`.bumpy/\`). Merge it when you are ready to release the packages listed below:`,
      '<br clear="left" />',
    ].join('\n'),
  },
};

// ---- Bump file ----

export interface BumpFileReleaseSimple {
  name: string;
  type: BumpTypeWithNone;
}

export interface BumpFileReleaseCascade {
  name: string;
  type: BumpTypeWithNone;
  cascade: Record<string, BumpType>; // glob pattern → bump type
}

export type BumpFileRelease = BumpFileReleaseSimple | BumpFileReleaseCascade;

export function hasCascade(r: BumpFileRelease): r is BumpFileReleaseCascade {
  return 'cascade' in r && Object.keys(r.cascade).length > 0;
}

export interface BumpFile {
  id: string; // filename without .md
  releases: BumpFileRelease[];
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
  bumpFiles: string[]; // bump file IDs that contributed
  isDependencyBump: boolean;
  isCascadeBump: boolean;
}

export interface ReleasePlan {
  bumpFiles: BumpFile[];
  releases: PlannedRelease[];
  warnings: string[];
}
