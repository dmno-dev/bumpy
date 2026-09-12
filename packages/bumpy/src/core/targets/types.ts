import type { BumpyConfig, PackageConfig, PackageManager, WorkspacePackage } from '../../types.ts';

/** Free-form option bag for a target instance (merged from type defaults + instance config) */
export type TargetOptions = Record<string, unknown>;

export type ReleaseKind = 'stable' | 'channel' | 'snapshot';

/**
 * When a target runs relative to the GitHub release:
 * - `release`: constitutes the release — the draft is held until it's done (npm, jsr,
 *   marketplaces, release assets)
 * - `post-release`: consumes the release — runs only once it's published, because it
 *   needs public release URLs (a Homebrew formula pointing at release assets, a
 *   Dockerfile that downloads them). Draft release assets aren't downloadable.
 */
export type TargetPhase = 'release' | 'post-release';

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
  /** Default phase for instances of this plugin (an instance can override with a `phase` option). Default: `release`. */
  phase?: TargetPhase;
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
   * Whether `version` is already live on this target. The registry is the source of
   * truth: the pipeline asks before every publish (idempotency guard) and to promote
   * `staged` targets once they go live. Return null for "unknown" (caller falls back
   * to release metadata / git-tag tracking).
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
  publish(ctx: TargetPublishContext): Promise<PublishHookResult>;
  /** Browsable URL for a published version, used in release notes. */
  publishUrl?(
    pkg: WorkspacePackage,
    version: string,
    options: TargetOptions,
    extra: { repoSlug?: string },
  ): string | undefined;
}

/**
 * What `publish()` reports back. `void` means the version is live. `staged` means the
 * registry accepted the artifact but holds it for an out-of-band step (npm staged
 * publishing's 2FA approval, a marketplace review queue, ...): the release stays a
 * draft and the target is re-checked with `checkPublished` on later runs until it is
 * live. `ref` is the registry's handle for the pending item (e.g. the npm stage id).
 */
export type PublishHookResult = void | { status: 'staged'; ref?: string };

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
  phase: TargetPhase;
}
