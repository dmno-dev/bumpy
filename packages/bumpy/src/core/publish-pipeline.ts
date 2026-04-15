import { resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { readJson, writeJson } from '../utils/fs.ts';
import { runAsync } from '../utils/shell.ts';
import { tryRun } from '../utils/shell.ts';
import { log, colorize } from '../utils/logger.ts';
import { createTag, tagExists } from './git.ts';
import { DependencyGraph } from './dep-graph.ts';
import { stripProtocol } from './semver.ts';
import { resolveCatalogDep, type CatalogMap } from '../utils/package-manager.ts';
import type { ReleasePlan, PlannedRelease, WorkspacePackage, BumpyConfig, PackageManager } from '../types.ts';

export interface PublishOptions {
  dryRun?: boolean;
  tag?: string; // npm dist-tag (e.g., "next", "beta")
}

export interface PublishResult {
  published: { name: string; version: string }[];
  skipped: { name: string; reason: string }[];
  failed: { name: string; error: string }[];
}

/**
 * Detect which CI OIDC provider is available for npm trusted publishing.
 * Returns the provider name or null if none detected.
 *
 * Supported providers:
 * - GitHub Actions: `ACTIONS_ID_TOKEN_REQUEST_URL` (set when `id-token: write` permission is granted)
 * - GitLab CI: `GITLAB_CI` + `NPM_ID_TOKEN`
 * - CircleCI: `CIRCLECI` + `NPM_ID_TOKEN`
 */
function detectOidcProvider(): 'github-actions' | 'gitlab' | 'circleci' | null {
  if (process.env.ACTIONS_ID_TOKEN_REQUEST_URL) return 'github-actions';
  if (process.env.GITLAB_CI && process.env.NPM_ID_TOKEN) return 'gitlab';
  if (process.env.CIRCLECI && process.env.NPM_ID_TOKEN) return 'circleci';
  return null;
}

const OIDC_NPM_UPGRADE_HINTS: Record<string, string> = {
  'github-actions': 'Add `actions/setup-node@v6` with `node-version: lts/*` to your workflow',
  gitlab: 'Use a Node.js image with npm >= 11.5.1 or run `npm install -g npm@latest`',
  circleci: 'Use a Node.js image with npm >= 11.5.1 or run `sudo npm install -g npm@latest`',
};

/**
 * Set up npm authentication for publishing.
 *
 * Handles three scenarios:
 * 1. **Trusted publishing (OIDC)** — GitHub Actions, GitLab CI, or CircleCI with OIDC configured.
 *    npm >= 11.5.1 authenticates automatically via OIDC token exchange.
 *    No secret needed, but we check the npm version and warn if too old.
 * 2. **Token-based auth** — `NPM_TOKEN` or `NODE_AUTH_TOKEN` env var.
 *    Writes a project-level `.npmrc` so npm can authenticate.
 * 3. **Pre-configured** — user already has `.npmrc` with auth (e.g. via `actions/setup-node`).
 */
function setupNpmAuth(rootDir: string, publishManager: string): void {
  // Only relevant when publishing via npm CLI
  if (publishManager !== 'npm') return;

  const npmrcPath = resolve(rootDir, '.npmrc');
  const existingNpmrc = existsSync(npmrcPath) ? readFileSync(npmrcPath, 'utf-8') : '';
  const hasAuthConfigured = existingNpmrc.includes(':_authToken=');

  // If auth is already configured (e.g. via actions/setup-node), nothing to do
  if (hasAuthConfigured) {
    log.dim('  Using existing .npmrc auth configuration');
    return;
  }

  // Scenario 1: OIDC trusted publishing
  const oidcProvider = detectOidcProvider();
  if (oidcProvider) {
    const npmVersion = tryRun('npm --version');
    if (npmVersion) {
      const [major, minor, patch] = npmVersion.split('.').map(Number);
      const meetsMinVersion = major! > 11 || (major === 11 && (minor! > 5 || (minor === 5 && patch! >= 1)));
      if (!meetsMinVersion) {
        log.warn(`  npm ${npmVersion} detected — trusted publishing (OIDC) requires npm >= 11.5.1`);
        log.warn(`  ${OIDC_NPM_UPGRADE_HINTS[oidcProvider]}`);
      } else {
        log.dim(`  OIDC detected (${oidcProvider}) — npm ${npmVersion} will authenticate via trusted publishing`);
      }
    }
    return;
  }

  // Scenario 2: Token-based auth via environment variable
  // Support NPM_TOKEN (common convention) by mapping to NODE_AUTH_TOKEN (what npm reads from .npmrc)
  const token = process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN;
  if (token) {
    if (process.env.NPM_TOKEN && !process.env.NODE_AUTH_TOKEN) {
      process.env.NODE_AUTH_TOKEN = token;
    }
    const authLine = '//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}';
    if (existingNpmrc) {
      appendFileSync(npmrcPath, `\n${authLine}\n`);
    } else {
      writeFileSync(npmrcPath, `${authLine}\n`);
    }
    log.dim('  Configured .npmrc with auth token');
    return;
  }

  // No auth detected — warn
  if (process.env.CI) {
    log.warn('  No npm authentication detected. Publishing will likely fail.');
    log.warn('  Options:');
    log.warn('    • Trusted publishing (OIDC): add `id-token: write` permission + npm >= 11.5.1');
    log.warn('    • Token auth: set NPM_TOKEN or NODE_AUTH_TOKEN environment variable');
    log.warn('    • Manual: add `actions/setup-node` with `registry-url` to your workflow');
  }
}

/**
 * Publish all packages in the release plan.
 * Order: topological (dependencies published before dependents).
 */
export async function publishPackages(
  releasePlan: ReleasePlan,
  packages: Map<string, WorkspacePackage>,
  depGraph: DependencyGraph,
  config: BumpyConfig,
  rootDir: string,
  opts: PublishOptions = {},
  catalogs: CatalogMap = new Map(),
  detectedPm: PackageManager = 'npm',
): Promise<PublishResult> {
  const result: PublishResult = { published: [], skipped: [], failed: [] };
  const publishConfig = config.publish;

  // Set up npm authentication before publishing
  setupNpmAuth(rootDir, publishConfig.publishManager);

  // Resolve "auto" pack manager to detected PM
  const packManager = publishConfig.packManager === 'auto' ? detectedPm : publishConfig.packManager;

  // Topological sort for correct publish order
  const topoOrder = depGraph.topologicalSort(packages);
  const releaseMap = new Map(releasePlan.releases.map((r) => [r.name, r]));

  // Filter to only packages that need publishing, in topo order
  const ordered: PlannedRelease[] = [];
  for (const name of topoOrder) {
    const release = releaseMap.get(name);
    if (release) ordered.push(release);
  }

  for (const release of ordered) {
    const pkg = packages.get(release.name)!;
    const pkgConfig = pkg.bumpy || {};

    // Skip private packages unless they have a custom publish command
    if (pkg.private && !pkgConfig.publishCommand) {
      if (config.privatePackages.tag) {
        createGitTag(release, rootDir, opts);
      }
      result.skipped.push({ name: release.name, reason: 'private' });
      continue;
    }

    log.step(`Publishing ${colorize(release.name, 'cyan')}@${release.newVersion}`);

    try {
      // 1. Build
      if (pkgConfig.buildCommand) {
        log.dim(`  Building...`);
        if (!opts.dryRun) {
          await runAsync(pkgConfig.buildCommand, { cwd: pkg.dir });
        }
      }

      // 2. Resolve workspace:/catalog: protocols if using in-place mode
      //    (for pack mode, the PM pack command handles this; for custom commands, always resolve)
      const needsInPlaceResolve = pkgConfig.publishCommand || publishConfig.protocolResolution === 'in-place';
      if (needsInPlaceResolve) {
        // Always write resolved protocols — dryRun only skips the actual publish command
        await resolveProtocolsInPlace(pkg, packages, releasePlan, catalogs);
      }

      // 3. Publish
      if (pkgConfig.publishCommand) {
        // Custom publish command(s)
        const commands = Array.isArray(pkgConfig.publishCommand)
          ? pkgConfig.publishCommand
          : [pkgConfig.publishCommand];

        for (const cmd of commands) {
          const expanded = cmd.replace(/\{\{version\}\}/g, release.newVersion).replace(/\{\{name\}\}/g, release.name);
          log.dim(`  Running: ${expanded}`);
          if (!opts.dryRun) {
            await runAsync(expanded, { cwd: pkg.dir });
          }
        }
      } else if (!pkgConfig.skipNpmPublish) {
        // Standard publish flow
        if (publishConfig.protocolResolution === 'pack') {
          await packThenPublish(pkg, pkgConfig, config, packManager, opts);
        } else {
          // "in-place" already resolved above; "none" skips resolution
          await npmPublishDirect(pkg, pkgConfig, config, opts);
        }
      } else {
        result.skipped.push({ name: release.name, reason: 'skipNpmPublish' });
        createGitTag(release, rootDir, opts);
        continue;
      }

      // 3. Git tag
      createGitTag(release, rootDir, opts);

      result.published.push({ name: release.name, version: release.newVersion });
      log.success(`  Published ${release.name}@${release.newVersion}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error(`  Failed to publish ${release.name}: ${errMsg}`);
      result.failed.push({ name: release.name, error: errMsg });
    }
  }

  return result;
}

/**
 * Pack with the PM (which resolves workspace:/catalog: protocols into the tarball),
 * then publish the tarball with npm (which supports OIDC/provenance).
 */
async function packThenPublish(
  pkg: WorkspacePackage,
  pkgConfig: WorkspacePackage['bumpy'] & {},
  config: BumpyConfig,
  packManager: PackageManager,
  opts: PublishOptions,
): Promise<void> {
  const packCmd = getPackCommand(packManager);
  log.dim(`  Packing with: ${packCmd}`);

  if (opts.dryRun) {
    const publishCmd = buildPublishCommand(pkg, pkgConfig, config, opts, '<tarball>');
    log.dim(`  Would publish with: ${publishCmd}`);
    return;
  }

  // Pack and capture the tarball filename
  const packOutput = await runAsync(packCmd, { cwd: pkg.dir });
  // Pack commands output the tarball filename on the last line
  const tarball = parseTarballPath(packOutput, pkg.dir);

  try {
    // Publish the tarball
    const publishCmd = buildPublishCommand(pkg, pkgConfig, config, opts, tarball);
    log.dim(`  Publishing: ${publishCmd}`);
    await runAsync(publishCmd, { cwd: pkg.dir });
  } finally {
    // Clean up tarball
    try {
      await unlink(tarball);
    } catch {
      /* ignore */
    }
  }
}

/** Publish directly from the package directory (no tarball) */
async function npmPublishDirect(
  pkg: WorkspacePackage,
  pkgConfig: WorkspacePackage['bumpy'] & {},
  config: BumpyConfig,
  opts: PublishOptions,
): Promise<void> {
  const cmd = buildPublishCommand(pkg, pkgConfig, config, opts);
  log.dim(`  Running: ${cmd}`);
  if (!opts.dryRun) {
    await runAsync(cmd, { cwd: pkg.dir });
  }
}

function getPackCommand(pm: PackageManager): string {
  switch (pm) {
    case 'pnpm':
      return 'pnpm pack';
    case 'bun':
      return 'bun pm pack';
    case 'yarn':
      return 'yarn pack';
    case 'npm':
    default:
      return 'npm pack';
  }
}

function buildPublishCommand(
  pkg: WorkspacePackage,
  pkgConfig: WorkspacePackage['bumpy'] & {},
  config: BumpyConfig,
  opts: PublishOptions,
  tarball?: string,
): string {
  const publishManager = config.publish.publishManager;
  const parts: string[] = [];

  // Base command
  if (publishManager === 'yarn') {
    parts.push('yarn npm publish');
  } else {
    parts.push(`${publishManager} publish`);
  }

  // Tarball path (if pack-then-publish)
  if (tarball) parts.push(tarball);

  // Access
  const access = pkgConfig?.access || config.access;
  parts.push(`--access ${access}`);

  // Registry
  if (pkgConfig?.registry) parts.push(`--registry ${pkgConfig.registry}`);

  // Dist tag
  if (opts.tag) parts.push(`--tag ${opts.tag}`);

  // Extra user-configured args (e.g., --provenance)
  if (config.publish.publishArgs.length > 0) {
    parts.push(...config.publish.publishArgs);
  }

  return parts.join(' ');
}

/**
 * Parse the tarball path from pack command output.
 * Each PM has different output formats:
 *   npm/pnpm: tarball filename on the last line
 *   bun:      tarball filename mid-output, summary lines after
 *   yarn:     'success Wrote tarball to "/path/to/foo.tgz".'
 */
function parseTarballPath(output: string, cwd: string): string {
  // Extract any .tgz path — handles both bare filenames and quoted paths (yarn)
  const tgzMatch = output.match(/(?:^|["'\s])([^\s"']*\.tgz)/m);
  if (tgzMatch) {
    const tarball = tgzMatch[1]!;
    return tarball.startsWith('/') ? tarball : resolve(cwd, tarball);
  }

  // Fallback: last non-empty line
  const lines = output.trim().split('\n').filter(Boolean);
  const lastLine = lines[lines.length - 1]?.trim() || '';
  return lastLine.startsWith('/') ? lastLine : resolve(cwd, lastLine);
}

function createGitTag(release: PlannedRelease, rootDir: string, opts: PublishOptions): void {
  const tag = `${release.name}@${release.newVersion}`;
  if (opts.dryRun) {
    log.dim(`  Would create tag: ${tag}`);
    return;
  }
  if (tagExists(tag, { cwd: rootDir })) {
    log.dim(`  Tag ${tag} already exists, skipping`);
    return;
  }
  createTag(tag, { cwd: rootDir });
  log.dim(`  Tagged: ${tag}`);
}

/**
 * Resolve workspace:/catalog: protocols by rewriting package.json in-place.
 * Used for custom publish commands and "in-place" protocolResolution mode.
 */
async function resolveProtocolsInPlace(
  pkg: WorkspacePackage,
  packages: Map<string, WorkspacePackage>,
  releasePlan: ReleasePlan,
  catalogs: CatalogMap,
): Promise<void> {
  const pkgJsonPath = resolve(pkg.dir, 'package.json');
  const pkgJson = await readJson<Record<string, unknown>>(pkgJsonPath);
  let modified = false;

  const releaseMap = new Map(releasePlan.releases.map((r) => [r.name, r]));

  for (const depField of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
    const deps = pkgJson[depField] as Record<string, string> | undefined;
    if (!deps) continue;

    for (const [depName, range] of Object.entries(deps)) {
      let resolved: string | null = null;

      if (range.startsWith('catalog:')) {
        resolved = resolveCatalogDep(depName, range, catalogs);
        if (!resolved) {
          log.warn(`  Could not resolve ${depName}: "${range}" — catalog entry not found`);
          continue;
        }
      } else if (range.startsWith('workspace:')) {
        const cleanRange = stripProtocol(range);

        if (cleanRange === '*' || cleanRange === '^' || cleanRange === '~') {
          const depPkg = packages.get(depName);
          const depRelease = releaseMap.get(depName);
          const version = depRelease?.newVersion || depPkg?.version || '0.0.0';
          const prefix = cleanRange === '*' ? '^' : cleanRange;
          resolved = `${prefix}${version}`;
        } else {
          resolved = cleanRange;
        }
      }

      if (resolved) {
        deps[depName] = resolved;
        modified = true;
      }
    }
  }

  if (modified) {
    await writeJson(pkgJsonPath, pkgJson);
  }
}
