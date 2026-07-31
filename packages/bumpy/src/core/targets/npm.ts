import { resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { runArgsAsync, tryRunArgs } from '../../utils/shell.ts';
import { log } from '../../utils/logger.ts';
import { buildPublishUrl, publishTargetLabel, resolvePackageRegistry } from '../github-release.ts';
import type { BumpyConfig, PackageConfig, PackageManager, PublishConfig, WorkspacePackage } from '../../types.ts';
import type { PublishTargetPlugin, TargetOptions, TargetPublishContext } from './types.ts';

/**
 * Detect which CI OIDC provider is available for npm trusted publishing.
 * Returns the provider name or null if none detected.
 *
 * Supported providers:
 * - GitHub Actions: `ACTIONS_ID_TOKEN_REQUEST_URL` (set when `id-token: write` permission is granted)
 * - GitLab CI: `GITLAB_CI` + `NPM_ID_TOKEN`
 * - CircleCI: `CIRCLECI` + `NPM_ID_TOKEN`
 */
export function detectOidcProvider(): 'github-actions' | 'gitlab' | 'circleci' | null {
  if (process.env.ACTIONS_ID_TOKEN_REQUEST_URL) return 'github-actions';
  if (process.env.GITLAB_CI && process.env.NPM_ID_TOKEN) return 'gitlab';
  if (process.env.CIRCLECI && process.env.NPM_ID_TOKEN) return 'circleci';
  return null;
}

/**
 * Returns true when OIDC trusted publishing is the only available npm auth path:
 * an OIDC provider is detected AND no token env vars or .npmrc auth are present.
 *
 * Used to gate checks that only matter when OIDC will definitely be used — e.g.
 * erroring when a brand-new package can't be bootstrapped via trusted publishing.
 * Detection alone is leaky (id-token: write is also set for provenance), so this
 * helper avoids false positives when a token fallback exists.
 */
export function willUseOidcExclusively(rootDir: string): boolean {
  if (!detectOidcProvider()) return false;
  if (process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN) return false;
  const npmrcPath = resolve(rootDir, '.npmrc');
  const existingNpmrc = existsSync(npmrcPath) ? readFileSync(npmrcPath, 'utf-8') : '';
  return !existingNpmrc.includes(':_authToken=');
}

const OIDC_NPM_UPGRADE_HINTS: Record<string, string> = {
  'github-actions': 'Add `actions/setup-node@v6` with `node-version: lts/*` to your workflow',
  gitlab: 'Use a Node.js image with npm >= 11.5.1 or run `npm install -g npm@latest`',
  circleci: 'Use a Node.js image with npm >= 11.5.1 or run `sudo npm install -g npm@latest`',
};

/** Compare semver triples: returns true if version >= minimum */
export function npmVersionAtLeast(version: string, minimum: [number, number, number]): boolean {
  const [major, minor, patch] = version.split('.').map(Number);
  const [minMajor, minMinor, minPatch] = minimum;
  if (major! > minMajor) return true;
  if (major! < minMajor) return false;
  if (minor! > minMinor) return true;
  if (minor! < minMinor) return false;
  return patch! >= minPatch;
}

const MIN_NPM_OIDC: [number, number, number] = [11, 5, 1];
const MIN_NPM_STAGED: [number, number, number] = [11, 15, 0];

/**
 * The npm target's effective options: the legacy root `publish` block provides
 * defaults, overridden by `targets.npm` / instance options (merged by the resolver).
 */
function npmOptions(config: BumpyConfig, options: TargetOptions): PublishConfig & TargetOptions {
  return { ...config.publish, ...options } as PublishConfig & TargetOptions;
}

function effectiveRegistry(
  pkg: WorkspacePackage,
  pkgConfig: PackageConfig,
  options: TargetOptions,
): string | undefined {
  if (typeof options.registry === 'string' && options.registry) return options.registry;
  return resolvePackageRegistry(pkg, pkgConfig);
}

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
    const npmVersion = tryRunArgs(['npm', '--version']);
    if (npmVersion) {
      if (!npmVersionAtLeast(npmVersion, MIN_NPM_OIDC)) {
        log.warn(`  npm ${npmVersion} detected — trusted publishing (OIDC) requires npm >= ${MIN_NPM_OIDC.join('.')}`);
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

function getPackArgs(pm: PackageManager): string[] {
  switch (pm) {
    case 'pnpm':
      return ['pnpm', 'pack', '--json'];
    case 'bun':
      return ['bun', 'pm', 'pack'];
    case 'yarn':
      return ['yarn', 'pack'];
    case 'npm':
    default:
      return ['npm', 'pack', '--json'];
  }
}

function buildPublishArgs(ctx: TargetPublishContext, tarball?: string): string[] {
  const o = npmOptions(ctx.config, ctx.options);
  const publishManager = o.publishManager;
  const args: string[] = [];

  // Base command
  if (o.npmStaged && publishManager === 'npm') {
    args.push('npm', 'stage', 'publish');
  } else if (publishManager === 'yarn') {
    args.push('yarn', 'npm', 'publish');
  } else {
    args.push(publishManager, 'publish');
  }

  // Tarball path (if pack-then-publish)
  if (tarball) args.push(tarball);

  // Access
  const access = (ctx.options.access as string | undefined) || ctx.pkgConfig.access || ctx.config.access;
  args.push('--access', access);

  // Registry
  const registry = effectiveRegistry(ctx.pkg, ctx.pkgConfig, ctx.options);
  if (registry) args.push('--registry', registry);

  // Dist tag
  if (ctx.distTag) args.push('--tag', ctx.distTag);

  // Provenance attestation
  if (o.provenance && publishManager === 'npm') {
    args.push('--provenance');
  }

  // Extra user-configured args
  if (Array.isArray(o.publishArgs) && o.publishArgs.length > 0) {
    args.push(...o.publishArgs);
  }

  return args;
}

/**
 * Parse the tarball path from pack command output.
 * npm/pnpm use --json for structured output; bun/yarn fall back to regex parsing.
 */
export function parseTarballPath(output: string, cwd: string, pm: PackageManager): string {
  // npm and pnpm support --json which gives us a deterministic filename
  if (pm === 'npm' || pm === 'pnpm') {
    try {
      const parsed = JSON.parse(output);
      // npm returns an array, pnpm returns an object or array
      const entry = Array.isArray(parsed) ? parsed[0] : parsed;
      if (entry?.filename) {
        return resolve(cwd, entry.filename);
      }
    } catch {
      // JSON parse failed — fall through to regex
    }
  }

  // Fallback for bun/yarn or if JSON parsing failed:
  // extract any .tgz path — handles both bare filenames and quoted paths (yarn)
  const tgzMatch = output.match(/(?:^|["'\s])([^\s"']*\.tgz)/m);
  if (tgzMatch) {
    const tarball = tgzMatch[1]!;
    return tarball.startsWith('/') ? tarball : resolve(cwd, tarball);
  }

  // Last resort: last non-empty line
  const lines = output.trim().split('\n').filter(Boolean);
  const lastLine = lines[lines.length - 1]?.trim() || '';
  return lastLine.startsWith('/') ? lastLine : resolve(cwd, lastLine);
}

export const npmTarget: PublishTargetPlugin = {
  type: 'npm',
  capabilities: { distTags: true, prereleases: true, snapshots: true },

  detect(pkg) {
    return !pkg.private;
  },

  label(options, pkg) {
    // Refines the common cases (e.g. "GitHub Packages"); named instances otherwise
    // label themselves via the metadata key.
    const registry = pkg
      ? effectiveRegistry(pkg, pkg.bumpy || {}, options)
      : typeof options.registry === 'string'
        ? options.registry
        : undefined;
    return publishTargetLabel('npm', registry);
  },

  async preflight(ctx) {
    const o = npmOptions(ctx.config, ctx.options);

    if (o.provenance && o.publishManager !== 'npm') {
      throw new Error('provenance requires publishManager "npm" — provenance attestation is an npm-specific feature');
    }

    if (o.npmStaged) {
      if (o.publishManager !== 'npm') {
        throw new Error('npmStaged requires publishManager "npm" — staged publishing is an npm-specific feature');
      }
      const npmVersion = tryRunArgs(['npm', '--version']);
      if (!npmVersion) {
        throw new Error(`npmStaged is enabled but npm was not found — install npm >= ${MIN_NPM_STAGED.join('.')}`);
      }
      if (!npmVersionAtLeast(npmVersion, MIN_NPM_STAGED)) {
        throw new Error(
          `npmStaged requires npm >= ${MIN_NPM_STAGED.join('.')} (found ${npmVersion})\n` +
            `  Upgrade npm: npm install -g npm@latest`,
        );
      }
      log.dim(`Staged publishing enabled — packages will require 2FA approval on npmjs.com`);
    }

    setupNpmAuth(ctx.rootDir, o.publishManager);
  },

  async checkPublished(pkg, version, options) {
    try {
      const args = ['npm', 'info', `${pkg.name}@${version}`, 'version'];
      const registry = effectiveRegistry(pkg, pkg.bumpy || {}, options);
      if (registry) args.push('--registry', registry);
      const result = await runArgsAsync(args);
      return result.trim() === version;
    } catch {
      return false;
    }
  },

  artifactKind(options, config) {
    const o = { ...config.publish, ...options } as PublishConfig;
    return o.protocolResolution === 'pack' ? 'npm-tarball' : undefined;
  },

  needsProtocolResolution(options, config) {
    const o = { ...config.publish, ...options } as PublishConfig;
    return o.protocolResolution === 'in-place';
  },

  async buildArtifact(ctx) {
    const o = npmOptions(ctx.config, ctx.options);
    const packManager = o.packManager === 'auto' ? ctx.packManager : o.packManager;
    const packArgs = getPackArgs(packManager);
    log.dim(`  Packing with: ${packArgs.join(' ')}`);
    const packOutput = await runArgsAsync(packArgs, { cwd: ctx.pkg.dir });
    return parseTarballPath(packOutput, ctx.pkg.dir, packManager);
  },

  async publish(ctx) {
    const args = buildPublishArgs(ctx, ctx.artifactPath);
    if (ctx.dryRun) {
      log.dim(`  Would publish with: ${args.join(' ')}`);
      return;
    }
    log.dim(`  Publishing: ${args.join(' ')}`);
    await runArgsAsync(args, { cwd: ctx.pkg.dir });
  },

  publishUrl(pkg, version, options, extra) {
    return buildPublishUrl(pkg.name, version, 'npm', {
      registry: effectiveRegistry(pkg, pkg.bumpy || {}, options),
      repoSlug: extra.repoSlug,
    });
  },
};
