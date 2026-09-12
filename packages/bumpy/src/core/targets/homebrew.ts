import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { runArgsAsync, tryRunArgs } from '../../utils/shell.ts';
import { log } from '../../utils/logger.ts';
import { isGhAvailable } from '../github-release.ts';
import type { BumpyConfig, WorkspacePackage } from '../../types.ts';
import { expandGlobs, stringArrayOption, stringOption, templateString, withEnv } from './util.ts';
import type { PublishTargetPlugin, TargetOptions } from './types.ts';

/**
 * Homebrew tap target: renders a formula from a template in the repo, commits it to
 * the tap repository, tags the tap commit `name@version`, and pushes.
 *
 * The template is the user's (formula shape is theirs); bumpy supplies the
 * placeholders and the git choreography:
 * - `{{version}}`, `{{name}}`
 * - `{{sha256 <file>}}` — SHA-256 of a release asset, looked up by basename among the
 *   `assets` globs (the same files a `github-release-assets` target uploads — put that
 *   target first so the formula's `url`s resolve)
 *
 * Options:
 * - `tap` (string, required) — the tap repo, e.g. `dmno-dev/homebrew-tap`
 * - `template` (string, required) — formula template path, relative to the package dir
 * - `formula` (string) — path inside the tap; default `Formula/<name>.rb`
 * - `assets` (string[]) — globs (relative to the package dir) that `{{sha256 …}}` searches
 * - `tapDir` (string) — an existing checkout of the tap to use instead of cloning
 *   (relative to the package dir), e.g. from `actions/checkout` with its own token
 *
 * Auth: pushing to the tap needs a token with write access to THAT repo — a workflow's
 * `GITHUB_TOKEN` can't. Set `HOMEBREW_TAP_TOKEN` (falls back to `BUMPY_GH_TOKEN`,
 * `GH_TOKEN`); it is handed to git through the environment, never argv.
 */

function tapSlug(options: TargetOptions): string {
  const tap = stringOption(options, 'tap');
  if (!tap || !/^[^/\s]+\/[^/\s]+$/.test(tap)) {
    throw new Error('homebrew target requires a "tap" option in owner/repo form (e.g. "dmno-dev/homebrew-tap")');
  }
  return tap;
}

function formulaPath(pkg: WorkspacePackage, options: TargetOptions): string {
  return stringOption(options, 'formula') ?? `Formula/${basename(pkg.name)}.rb`;
}

function tapToken(): string | undefined {
  return process.env.HOMEBREW_TAP_TOKEN || process.env.BUMPY_GH_TOKEN || process.env.GH_TOKEN || undefined;
}

/** Git env that authenticates github.com over https without putting the token in argv (what actions/checkout does) */
function gitAuthEnv(): Record<string, string | undefined> {
  const token = tapToken();
  if (!token) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

/** Parse the `version "x.y.z"` line out of a formula */
export function formulaVersion(formula: string): string | undefined {
  return formula.match(/^\s*version\s+"([^"]+)"/m)?.[1];
}

/** Render a formula template: `{{version}}`, `{{name}}`, `{{sha256 <file>}}` */
export function renderFormula(
  template: string,
  vars: { version: string; name: string },
  sha256For: (file: string) => string,
): string {
  const withHashes = template.replace(/\{\{\s*sha256\s+([^}\s]+)\s*\}\}/g, (_m, file: string) => sha256For(file));
  return templateString(withHashes, vars);
}

function assetSha256Lookup(pkg: WorkspacePackage, options: TargetOptions): (file: string) => string {
  const files = expandGlobs(pkg.dir, stringArrayOption(options, 'assets'));
  return (file) => {
    const match = files.find((f) => f === file || basename(f) === file);
    if (!match) {
      throw new Error(
        `${pkg.name}: formula template references {{sha256 ${file}}} but no such file matched the "assets" globs ` +
          `(${JSON.stringify(stringArrayOption(options, 'assets'))}) — build the release assets before publishing`,
      );
    }
    return createHash('sha256')
      .update(readFileSync(resolve(pkg.dir, match)))
      .digest('hex');
  };
}

async function git(args: string[], cwd: string, config: BumpyConfig): Promise<string> {
  const identity = ['-c', `user.name=${config.gitUser.name}`, '-c', `user.email=${config.gitUser.email}`];
  return withEnv(gitAuthEnv(), () => runArgsAsync(['git', ...identity, ...args], { cwd }));
}

export const homebrewTarget: PublishTargetPlugin = {
  type: 'homebrew',
  // Formulas track stable versions only
  capabilities: { distTags: false, prereleases: false, snapshots: false },
  // Consumes the release (downloads its assets) — runs once it's published
  phase: 'post-release',

  label() {
    return 'Homebrew';
  },

  async preflight(ctx) {
    tapSlug(ctx.options);
    if (!stringOption(ctx.options, 'template')) {
      throw new Error(
        'homebrew target requires a "template" option (formula template path, relative to the package dir)',
      );
    }
    if (!tryRunArgs(['git', '--version'])) throw new Error('homebrew target requires git');
    if (!ctx.dryRun && !ctx.options.tapDir && !tapToken()) {
      log.warn('  No HOMEBREW_TAP_TOKEN set — pushing to the tap will need git credentials from the environment');
    }
  },

  async checkPublished(pkg, version, options) {
    if (!isGhAvailable()) return null;
    try {
      const output = await runArgsAsync(
        ['gh', 'api', `repos/${tapSlug(options)}/contents/${formulaPath(pkg, options)}`, '--jq', '.content'],
        { timeoutMs: 60_000 },
      );
      const formula = Buffer.from(output.replace(/\s/g, ''), 'base64').toString('utf-8');
      return formulaVersion(formula) === version;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return /404|Not Found/i.test(msg) ? false : null;
    }
  },

  async prepare(ctx) {
    const template = resolve(ctx.pkg.dir, stringOption(ctx.options, 'template')!);
    if (!existsSync(template)) {
      throw new Error(`${ctx.pkg.name}: homebrew formula template not found at ${template}`);
    }
  },

  async publish(ctx) {
    const tap = tapSlug(ctx.options);
    const formulaRel = formulaPath(ctx.pkg, ctx.options);
    const template = readFileSync(resolve(ctx.pkg.dir, stringOption(ctx.options, 'template')!), 'utf-8');
    const tag = `${ctx.pkg.name}@${ctx.version}`;

    if (ctx.dryRun) {
      // Dry runs skip the build, so assets (and their checksums) usually don't exist yet —
      // render with placeholder hashes to validate the template
      renderFormula(template, { version: ctx.version, name: ctx.pkg.name }, (file) => `<sha256 of ${file}>`);
      log.dim(`  Would update ${tap}/${formulaRel} to ${ctx.version} and tag ${tag}`);
      return;
    }

    const rendered = renderFormula(
      template,
      { version: ctx.version, name: ctx.pkg.name },
      assetSha256Lookup(ctx.pkg, ctx.options),
    );

    let tapDir = stringOption(ctx.options, 'tapDir');
    if (tapDir) {
      tapDir = resolve(ctx.pkg.dir, tapDir);
    } else {
      tapDir = mkdtempSync(resolve(tmpdir(), 'bumpy-homebrew-'));
      log.dim(`  Cloning ${tap}...`);
      await git(['clone', '--depth', '1', `https://github.com/${tap}.git`, tapDir], ctx.rootDir, ctx.config);
    }

    const formulaAbs = resolve(tapDir, formulaRel);
    mkdirSync(dirname(formulaAbs), { recursive: true });
    writeFileSync(formulaAbs, rendered);
    await git(['add', formulaRel], tapDir, ctx.config);
    const staged = await git(['status', '--porcelain', '--', formulaRel], tapDir, ctx.config);
    if (staged.trim()) {
      await git(['commit', '-m', tag], tapDir, ctx.config);
    } else {
      log.dim(`  ${formulaRel} already at ${ctx.version} — nothing to commit`);
    }
    if (!(await git(['tag', '-l', tag], tapDir, ctx.config)).trim()) {
      await git(['tag', tag], tapDir, ctx.config);
    }
    log.dim(`  Pushing ${tap} (${formulaRel} → ${ctx.version}, tag ${tag})`);
    await git(['push', 'origin', 'HEAD', '--tags'], tapDir, ctx.config);
  },

  publishUrl(pkg, _version, options) {
    return `https://github.com/${tapSlug(options)}/blob/HEAD/${formulaPath(pkg, options)}`;
  },
};
