import type { BumpyConfig, PackageConfig, PackageManager, WorkspacePackage } from '../../types.ts';

/** Free-form option bag for a target instance (merged from type defaults + instance config) */
export type TargetOptions = Record<string, unknown>;

export type ReleaseKind = 'stable' | 'channel' | 'snapshot';

export interface TargetCapabilities {
  /** Supports npm-style dist-tags (`--tag next`) */
  distTags: boolean;
  /** Can publish semver prerelease versions (e.g. `1.2.0-rc.0`) */
  prereleases: boolean;
  /** Participates in transient snapshot releases (`bumpy publish --snapshot`) */
  snapshots: boolean;
  /**
   * The registry refuses `"private": true` packages (npm's marker). Instances of
   * such targets are dropped from private packages at resolve time — which is what
   * lets a private VS Code extension publish to marketplaces while never touching npm.
   */
  refusesPrivatePackages?: boolean;
}

/** Context for the once-per-target-instance preflight hook, run before any publish */
export interface TargetPreflightContext {
  rootDir: string;
  config: BumpyConfig;
  options: TargetOptions;
  dryRun: boolean;
}

/** Context for per-package target operations (publish, buildArtifact) */
export interface TargetPublishContext {
  pkg: WorkspacePackage;
  /** Merged per-package bumpy config (legacy fields like `registry`/`access` live here) */
  pkgConfig: PackageConfig;
  /** The version being published (already written to the package manifest) */
  version: string;
  rootDir: string;
  config: BumpyConfig;
  /** Merged options for this target instance */
  options: TargetOptions;
  /** npm-style dist-tag for this publish, when the release flow provides one */
  distTag?: string;
  dryRun: boolean;
  releaseKind: ReleaseKind;
  /** Path to the shared artifact, when the plugin declares an artifactKind */
  artifactPath?: string;
  /** Detected workspace package manager (pack strategies may use it) */
  packManager: PackageManager;
}

/**
 * A publish target plugin. Built-in targets (npm, custom, vscode-marketplace, open-vsx)
 * implement this interface; it is also the seam future external plugins load through.
 *
 * Lifecycle within one `bumpy publish` run:
 * 1. `preflight` — once per resolved target instance, before anything publishes
 *    (auth/tooling validation; throw to abort the whole run)
 * 2. per package, in topo order:
 *    a. `artifactKind`/`buildArtifact` — artifacts are cached per package by kind, so
 *       multiple targets sharing a kind (e.g. one .vsix → marketplace + Open VSX) get
 *       the same file
 *    b. `publish` — one target failing does not block sibling targets; state is
 *       recorded per target in the GitHub release metadata and retried on the next run
 */
export interface PublishTargetPlugin {
  type: string;
  capabilities: TargetCapabilities;
  /** Heuristic: does this package look like it should use this target? (used for suggestions, never auto-applied) */
  detect?(pkg: WorkspacePackage): boolean;
  /** Human-readable label for release notes / status output. Falls back to the instance name. */
  label?(options: TargetOptions, pkg?: WorkspacePackage): string;
  preflight?(ctx: TargetPreflightContext): void | Promise<void>;
  /**
   * Per-package pre-publish step, run after the skip gates (capabilities, resume,
   * registry guard) and before artifact building. The home for publish-time version
   * syncing into ecosystem manifests (jsr.json, pyproject.toml). Also called on dry
   * runs so config validation surfaces there — check `ctx.dryRun` and skip file
   * mutations only.
   */
  prepare?(ctx: TargetPublishContext): void | Promise<void>;
  /**
   * Whether `version` is already live on this target.
   * Return null for "unknown" (caller falls back to git-tag tracking).
   */
  checkPublished?(pkg: WorkspacePackage, version: string, options: TargetOptions): Promise<boolean | null>;
  /**
   * Artifact kind this target publishes from (e.g. "vsix", "npm-tarball").
   * Targets on the same package sharing a kind share one built artifact.
   * Return undefined to publish directly from the package directory.
   */
  artifactKind?(options: TargetOptions, config: BumpyConfig): string | undefined;
  /** Build the artifact and return its absolute path. Required when artifactKind returns a kind. */
  buildArtifact?(ctx: TargetPublishContext): Promise<string>;
  /**
   * Whether workspace:/catalog: protocols must be resolved in the package.json on disk
   * before this target runs (targets that read the manifest directly, e.g. custom
   * commands and vsce, need this; npm's pack flow handles it in the tarball).
   */
  needsProtocolResolution?(options: TargetOptions, config: BumpyConfig): boolean;
  publish(ctx: TargetPublishContext): Promise<void>;
  /** Browsable URL for a published version, used in release notes. */
  publishUrl?(
    pkg: WorkspacePackage,
    version: string,
    options: TargetOptions,
    extra: { repoSlug?: string },
  ): string | undefined;
}

/** A target instance resolved for a specific package: plugin + merged options + stable name */
export interface ResolvedTarget {
  /**
   * Instance name — the stable key for this target in release metadata. Renaming it
   * mid-release breaks partial-failure resume, so names should be stable.
   */
  name: string;
  type: string;
  plugin: PublishTargetPlugin;
  options: TargetOptions;
}
