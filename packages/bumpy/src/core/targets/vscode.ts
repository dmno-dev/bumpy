import { resolve } from 'node:path';
import { runArgsAsync, runStreaming, sq } from '../../utils/shell.ts';
import { log } from '../../utils/logger.ts';
import { stringArrayOption } from './util.ts';
import type { WorkspacePackage } from '../../types.ts';
import type { PublishTargetPlugin, TargetPublishContext } from './types.ts';

/**
 * VS Code Marketplace and Open VSX targets.
 *
 * Both publish the same packaged `.vsix`, so they share the "vsix" artifact kind —
 * the pipeline builds it once (via `vsce package`) and hands the same file to both.
 * Publishing from a prebuilt vsix also keeps vsce/ovsx from re-running their own
 * version bumps or builds.
 *
 * Auth: vsce reads `VSCE_PAT`, ovsx reads `OVSX_PAT` (both native to the CLIs).
 * The CLIs are invoked through `npx --yes`, so a repo-local devDependency wins and
 * otherwise the published CLI is fetched on demand.
 *
 * The Marketplace requires plain `major.minor.patch` versions — semver prerelease
 * suffixes are rejected — so both targets opt out of prereleases and snapshots.
 */

const VSCE_BIN = ['npx', '--yes', '@vscode/vsce'];
const OVSX_BIN = ['npx', '--yes', 'ovsx'];

function extensionId(pkg: WorkspacePackage): string {
  const publisher = pkg.packageJson.publisher;
  if (typeof publisher !== 'string' || !publisher) {
    throw new Error(`${pkg.name}: VS Code extension targets require a "publisher" field in package.json`);
  }
  return `${publisher}.${pkg.name}`;
}

function looksLikeVscodeExtension(pkg: WorkspacePackage): boolean {
  const engines = pkg.packageJson.engines;
  const hasVscodeEngine = !!engines && typeof engines === 'object' && 'vscode' in (engines as Record<string, unknown>);
  return hasVscodeEngine && typeof pkg.packageJson.publisher === 'string';
}

function vsixPath(ctx: TargetPublishContext): string {
  // vsce's default filename, made explicit so both targets agree on the path
  return resolve(ctx.pkg.dir, `${ctx.pkg.name}-${ctx.version}.vsix`);
}

async function buildVsix(ctx: TargetPublishContext): Promise<string> {
  const out = vsixPath(ctx);
  const extraArgs = stringArrayOption(ctx.options, 'packageArgs');
  // --no-dependencies by default: vsce's npm-based dependency detection breaks in
  // workspace monorepos (workspace:/catalog: protocols, hoisted node_modules) and
  // silently ships a broken vsix. Bundled extensions (the norm) don't need it;
  // set `dependencies: true` on the target to restore vsce's default behavior.
  const depArgs = ctx.options.dependencies === true ? [] : ['--no-dependencies'];
  const cmd = [...VSCE_BIN, 'package', ...depArgs, '--out', sq(out), ...extraArgs.map(sq)].join(' ');
  log.dim(`  Packaging vsix: ${cmd}`);
  // Stream output — vsce runs the extension's (pre)publish build, which can be chatty/slow
  await runStreaming(cmd, { cwd: ctx.pkg.dir });
  return out;
}

/** Run a CLI and parse the published version out of its JSON output. Null = unknown. */
async function fetchPublishedVersion(args: string[], extract: (json: unknown) => unknown): Promise<string | null> {
  try {
    const output = await runArgsAsync(args);
    const version = extract(JSON.parse(output));
    return typeof version === 'string' && version ? version : null;
  } catch {
    return null;
  }
}

export const vscodeMarketplaceTarget: PublishTargetPlugin = {
  type: 'vscode-marketplace',
  capabilities: { distTags: false, prereleases: false, snapshots: false },

  detect: looksLikeVscodeExtension,

  label() {
    return 'VS Code Marketplace';
  },

  async preflight(ctx) {
    // azureCredential: auth via Azure OIDC (`azure/login` in CI) instead of a
    // long-lived VSCE_PAT — vsce mints a short-lived token per publish
    if (ctx.options.azureCredential === true) return;
    if (!ctx.dryRun && !process.env.VSCE_PAT && !process.env.AZURE_TENANT_ID) {
      log.warn('  VSCE_PAT is not set — vsce will need another credential source (e.g. azureCredential) to publish');
    }
  },

  async checkPublished(pkg, version, _options) {
    if (!looksLikeVscodeExtension(pkg)) return null; // no publisher — can't query
    const published = await fetchPublishedVersion(
      [...VSCE_BIN, 'show', extensionId(pkg), '--json'],
      (json) => (json as { versions?: Array<{ version?: unknown }> })?.versions?.[0]?.version,
    );
    return published === null ? null : published === version;
  },

  artifactKind() {
    return 'vsix';
  },

  needsProtocolResolution() {
    // vsce reads package.json from the package dir when packaging
    return true;
  },

  buildArtifact: buildVsix,

  async publish(ctx) {
    const extraArgs = stringArrayOption(ctx.options, 'publishArgs');
    const authArgs = ctx.options.azureCredential === true ? ['--azure-credential'] : [];
    const args = [...VSCE_BIN, 'publish', '--packagePath', ctx.artifactPath!, ...authArgs, ...extraArgs];
    if (ctx.dryRun) {
      log.dim(`  Would publish with: ${args.join(' ')}`);
      return;
    }
    log.dim(`  Publishing: ${args.join(' ')}`);
    await runArgsAsync(args, { cwd: ctx.pkg.dir });
  },

  publishUrl(pkg) {
    return `https://marketplace.visualstudio.com/items?itemName=${extensionId(pkg)}`;
  },
};

export const openVsxTarget: PublishTargetPlugin = {
  type: 'open-vsx',
  capabilities: { distTags: false, prereleases: false, snapshots: false },

  detect: looksLikeVscodeExtension,

  label() {
    return 'Open VSX';
  },

  async preflight(ctx) {
    if (!ctx.dryRun && !process.env.OVSX_PAT) {
      log.warn('  OVSX_PAT is not set — ovsx publish will likely fail');
    }
  },

  async checkPublished(pkg, version, _options) {
    if (!looksLikeVscodeExtension(pkg)) return null; // no publisher — can't query
    const publisher = String(pkg.packageJson.publisher ?? '');
    const published = await fetchPublishedVersion(
      [...OVSX_BIN, 'get', `${publisher}.${pkg.name}`, '--metadata'],
      (json) => (json as { version?: unknown })?.version,
    );
    return published === null ? null : published === version;
  },

  artifactKind() {
    return 'vsix';
  },

  needsProtocolResolution() {
    return true;
  },

  buildArtifact: buildVsix,

  async publish(ctx) {
    const extraArgs = stringArrayOption(ctx.options, 'publishArgs');
    const args = [...OVSX_BIN, 'publish', ctx.artifactPath!, ...extraArgs];
    if (ctx.dryRun) {
      log.dim(`  Would publish with: ${args.join(' ')}`);
      return;
    }
    log.dim(`  Publishing: ${args.join(' ')}`);
    await runArgsAsync(args, { cwd: ctx.pkg.dir });
  },

  publishUrl(pkg, version) {
    const publisher = String(pkg.packageJson.publisher ?? '');
    return `https://open-vsx.org/extension/${publisher}/${pkg.name}/${version}`;
  },
};
