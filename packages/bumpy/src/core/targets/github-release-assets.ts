import { resolve } from 'node:path';
import { basename } from 'node:path';
import { runArgsAsync } from '../../utils/shell.ts';
import { log } from '../../utils/logger.ts';
import { isGhAvailable, withReleaseToken } from '../github-release.ts';
import type { WorkspacePackage } from '../../types.ts';
import { expandGlobs, stringArrayOption, templateString } from './util.ts';
import type { PublishTargetPlugin, TargetOptions } from './types.ts';

/**
 * GitHub Release assets target: uploads files (CLI binaries, checksums, signatures, …)
 * to the package's GitHub release — the `name@version` release bumpy already manages.
 *
 * The upload goes to the draft, so the release is only published (firing
 * `release: published`) once the assets are attached, alongside every other target.
 * Files must exist when bumpy publishes: produce them with the package's
 * `buildCommand` (or an earlier CI step). Uploads use `--clobber`, so re-running after
 * a partial failure replaces what's there.
 *
 * Options:
 * - `files` (string[], required) — globs relative to the package dir; `{{version}}` and
 *   `{{name}}` are substituted
 *
 * Auth: the `gh` CLI (`GH_TOKEN` / `BUMPY_GH_TOKEN`, `contents: write`).
 */

function releaseTag(pkg: WorkspacePackage, version: string): string {
  return `${pkg.name}@${version}`;
}

function assetFiles(pkg: WorkspacePackage, version: string, options: TargetOptions): string[] {
  const patterns = stringArrayOption(options, 'files').map((p) => templateString(p, { version, name: pkg.name }));
  return expandGlobs(pkg.dir, patterns);
}

export const githubReleaseAssetsTarget: PublishTargetPlugin = {
  type: 'github-release-assets',
  // A GitHub release exists for stable and channel versions; snapshots never get one
  capabilities: { distTags: false, prereleases: true, snapshots: false },

  label() {
    return 'GitHub Release';
  },

  async preflight(ctx) {
    if (stringArrayOption(ctx.options, 'files').length === 0) {
      throw new Error('github-release-assets target requires a "files" option (globs relative to the package dir)');
    }
    if (!isGhAvailable()) {
      throw new Error('github-release-assets target requires the `gh` CLI (authenticated) to upload assets');
    }
  },

  async checkPublished(pkg, version, options) {
    const expected = assetFiles(pkg, version, options).map((f) => basename(f));
    if (expected.length === 0) return null; // not built yet — can't tell
    try {
      const output = await withReleaseToken(() =>
        runArgsAsync(
          ['gh', 'release', 'view', releaseTag(pkg, version), '--json', 'assets', '--jq', '.assets[].name'],
          {
            timeoutMs: 60_000,
          },
        ),
      );
      const present = new Set(
        output
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      );
      return expected.every((name) => present.has(name));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return /release not found|not found/i.test(msg) ? false : null;
    }
  },

  async publish(ctx) {
    const files = assetFiles(ctx.pkg, ctx.version, ctx.options);
    if (files.length === 0 && ctx.dryRun) {
      // Dry runs skip the build, so the assets usually don't exist yet
      log.dim(
        `  Would upload assets matching ${JSON.stringify(stringArrayOption(ctx.options, 'files'))} to release ${releaseTag(ctx.pkg, ctx.version)}`,
      );
      return;
    }
    if (files.length === 0) {
      throw new Error(
        `${ctx.pkg.name}: no files matched ${JSON.stringify(stringArrayOption(ctx.options, 'files'))} — ` +
          `build them first (e.g. via "buildCommand")`,
      );
    }
    const tag = releaseTag(ctx.pkg, ctx.version);
    const args = ['gh', 'release', 'upload', tag, ...files.map((f) => resolve(ctx.pkg.dir, f)), '--clobber'];
    if (ctx.dryRun) {
      log.dim(`  Would upload ${files.length} asset(s) to release ${tag}: ${files.join(', ')}`);
      return;
    }
    log.dim(`  Uploading ${files.length} asset(s) to release ${tag}: ${files.join(', ')}`);
    await withReleaseToken(() => runArgsAsync(args, { cwd: ctx.rootDir }));
  },

  publishUrl(pkg, version, _options, extra) {
    if (!extra.repoSlug) return undefined;
    return `https://github.com/${extra.repoSlug}/releases/tag/${encodeURIComponent(releaseTag(pkg, version))}`;
  },
};
