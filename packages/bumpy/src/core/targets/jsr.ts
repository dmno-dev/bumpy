import { resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { runArgsAsync } from '../../utils/shell.ts';
import { log } from '../../utils/logger.ts';
import { buildPublishUrl } from '../github-release.ts';
import type { WorkspacePackage } from '../../types.ts';
import type { PublishTargetPlugin } from './types.ts';

/**
 * JSR (jsr.io) target.
 *
 * JSR publishes TypeScript source described by `jsr.json` (name, version, exports).
 * Two version-sync facts shape this target:
 * - `jsr.json` has its own `version` field, but it does NOT need to be committed in
 *   the release PR — the target syncs it from package.json into the working tree at
 *   publish time (commit it as `0.0.0` and forget it). That's also why publishes run
 *   with `--allow-dirty`: the tree is intentionally modified (version sync here,
 *   workspace:/catalog: resolution by the pipeline — JSR reads npm dependency ranges
 *   from package.json, and deno silently drops deps with protocol specifiers).
 * - JSR has no create-on-first-publish: packages must be claimed in the scope on
 *   jsr.io first. The publish step detects an unclaimed package and says so, rather
 *   than surfacing deno's less helpful error.
 *
 * Auth: token-less OIDC trusted publishing from GitHub Actions (`id-token: write`)
 * once the package's GitHub repo is linked on jsr.io; `JSR_TOKEN` otherwise.
 *
 * Options:
 * - `allowSlowTypes` (boolean, default false) — pass `--allow-slow-types`
 * - `publishArgs` (string[]) — extra args for `jsr publish`
 *
 * Credit: the publish-time version sync, catalog-resolution requirement, and
 * claim-first bootstrap behavior are all lessons from Drake Costa's (@Saeris —
 * https://github.com/Saeris) JSR publishing setup in mirrordown, an early bumpy
 * adopter. Thanks Drake!
 */

const JSR_BIN = ['npx', '--yes', 'jsr'];
const JSR_API = 'https://api.jsr.io';

function scopeAndName(pkg: WorkspacePackage): { scope: string; name: string } | null {
  const match = pkg.name.match(/^@([^/]+)\/(.+)$/);
  return match ? { scope: match[1]!, name: match[2]! } : null;
}

/** GET a JSR API path; returns the response status or null on network failure */
async function jsrApiStatus(path: string): Promise<number | null> {
  try {
    const res = await fetch(`${JSR_API}${path}`);
    return res.status;
  } catch {
    return null;
  }
}

/** Sync jsr.json's version field from the version being published */
function syncJsrJsonVersion(pkgDir: string, version: string): void {
  const jsrJsonPath = resolve(pkgDir, 'jsr.json');
  const jsr = JSON.parse(readFileSync(jsrJsonPath, 'utf-8'));
  if (jsr.version !== version) {
    jsr.version = version;
    writeFileSync(jsrJsonPath, `${JSON.stringify(jsr, null, 2)}\n`);
  }
}

export const jsrTarget: PublishTargetPlugin = {
  type: 'jsr',
  // JSR versions are semver (prereleases fine), but there are no dist-tags — so
  // snapshots, which are only reachable via a throwaway tag, don't make sense.
  capabilities: { distTags: false, prereleases: true, snapshots: false },

  detect(pkg) {
    return existsSync(resolve(pkg.dir, 'jsr.json'));
  },

  label() {
    return 'JSR';
  },

  needsProtocolResolution() {
    // JSR resolves npm deps from package.json — protocol specifiers must be concrete
    return true;
  },

  async checkPublished(pkg, version, _options) {
    const id = scopeAndName(pkg);
    if (!id) return null; // JSR packages are always scoped
    const status = await jsrApiStatus(`/scopes/${id.scope}/packages/${id.name}/versions/${version}`);
    if (status === null) return null; // network hiccup — unknown
    return status === 200;
  },

  async publish(ctx) {
    const id = scopeAndName(ctx.pkg);
    if (!id) {
      throw new Error(`${ctx.pkg.name}: JSR packages must be scoped (@scope/name)`);
    }
    const jsrJsonPath = resolve(ctx.pkg.dir, 'jsr.json');
    if (!existsSync(jsrJsonPath)) {
      throw new Error(
        `${ctx.pkg.name}: jsr target requires a jsr.json (name + exports; version can stay "0.0.0" — ` +
          `bumpy syncs it at publish time)`,
      );
    }

    const args = [...JSR_BIN, 'publish', '--allow-dirty'];
    if (ctx.options.allowSlowTypes === true) args.push('--allow-slow-types');
    if (Array.isArray(ctx.options.publishArgs)) args.push(...ctx.options.publishArgs.map(String));

    if (ctx.dryRun) {
      log.dim(`  Would publish with: ${args.join(' ')}`);
      return;
    }

    // JSR has no create-on-first-publish — fail with actionable guidance instead of
    // deno's opaque error when the package hasn't been claimed in the scope yet.
    const pkgStatus = await jsrApiStatus(`/scopes/${id.scope}/packages/${id.name}`);
    if (pkgStatus === 404) {
      throw new Error(
        `${ctx.pkg.name} is not claimed on JSR — create it in the @${id.scope} scope first ` +
          `(jsr.io → scope → Create package), and link the GitHub repo for token-less OIDC publishing`,
      );
    }

    syncJsrJsonVersion(ctx.pkg.dir, ctx.version);
    log.dim(`  Publishing: ${args.join(' ')}`);
    await runArgsAsync(args, { cwd: ctx.pkg.dir });
  },

  publishUrl(pkg, version) {
    return buildPublishUrl(pkg.name, version, 'jsr');
  },
};
