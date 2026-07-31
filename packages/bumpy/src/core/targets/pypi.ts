import { resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { runArgsAsync, tryRunArgs } from '../../utils/shell.ts';
import { log } from '../../utils/logger.ts';
import type { WorkspacePackage } from '../../types.ts';
import { stringArrayOption, stringOption } from './util.ts';
import type { PublishTargetPlugin, TargetPublishContext } from './types.ts';

/**
 * PyPI target — publishes a Python package living inside the (package.json-driven)
 * workspace. bumpy's versioning spine stays package.json: give the Python package a
 * stub `package.json` (`"private": true` + `bumpy.publishTargets: ["pypi"]`) and this
 * target syncs the version into `pyproject.toml` at publish time — the same
 * publish-time-sync model as the jsr target, so nothing extra is committed in the
 * release PR.
 *
 * Build/upload run through `uv` (`uv build` / `uv publish`):
 * - builds into an isolated per-version out-dir, so stale artifacts in `dist/` from
 *   earlier builds can never be uploaded alongside the new release
 * - `uv publish` supports PyPI **trusted publishing** (OIDC) natively on GitHub
 *   Actions (`id-token: write`), or a token via `UV_PUBLISH_TOKEN`
 *
 * The PyPI project name comes from `pyproject.toml` `[project].name` (the source of
 * truth — npm names, especially scoped ones, are not valid PyPI names).
 *
 * Capabilities: PyPI has no dist-tags, and PEP 440 versions don't cover bumpy's
 * semver prerelease/snapshot suffixes (`-next.0`, `-preview-abc123` are invalid
 * there), so channel prereleases and snapshots are skipped, not attempted.
 *
 * Options:
 * - `index` (string) — alternative index URL passed to `uv publish --publish-url`
 * - `buildArgs` / `publishArgs` (string[]) — extra args for the respective step
 */

const OUT_DIR_PREFIX = '.bumpy-pypi-dist';

interface PyprojectInfo {
  raw: string;
  /** [project].name */
  name?: string;
  /** [project].version (undefined when absent or listed in `dynamic`) */
  version?: string;
  dynamicVersion: boolean;
}

/**
 * Minimal pyproject.toml inspection: extracts `name`/`version` from the `[project]`
 * table via line matching (full TOML parsing is overkill for two flat keys).
 */
export function parsePyproject(raw: string): PyprojectInfo {
  const projectSection = extractTomlSection(raw, 'project');
  const name = matchTomlString(projectSection, 'name');
  const version = matchTomlString(projectSection, 'version');
  const dynamic = projectSection.match(/^\s*dynamic\s*=\s*\[([^\]]*)\]/m)?.[1] ?? '';
  return {
    raw,
    name,
    version,
    dynamicVersion: /["']version["']/.test(dynamic),
  };
}

/** The lines of one `[section]` table (up to the next top-level `[table]` header) */
function extractTomlSection(raw: string, section: string): string {
  const match = raw.match(new RegExp(`^\\[${section}\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, 'm'));
  return match?.[1] ?? '';
}

function matchTomlString(sectionBody: string, key: string): string | undefined {
  return sectionBody.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']*)["']`, 'm'))?.[1];
}

/**
 * Rewrite `[project].version` in-place, preserving all other formatting.
 * Returns the updated content, or null if the version key couldn't be located.
 */
export function updatePyprojectVersion(raw: string, newVersion: string): string | null {
  const sectionStart = raw.match(/^\[project\]\s*$/m);
  if (sectionStart?.index === undefined) return null;
  const bodyStart = sectionStart.index + sectionStart[0].length;
  const rest = raw.slice(bodyStart);
  const nextSection = rest.search(/^\[/m);
  const body = nextSection === -1 ? rest : rest.slice(0, nextSection);

  const versionLine = body.match(/^(\s*version\s*=\s*)(["'])[^"']*\2/m);
  if (versionLine?.index === undefined) return null;

  const absolute = bodyStart + versionLine.index;
  return (
    raw.slice(0, absolute) +
    `${versionLine[1]}${versionLine[2]}${newVersion}${versionLine[2]}` +
    raw.slice(absolute + versionLine[0].length)
  );
}

function loadPyproject(pkg: WorkspacePackage): PyprojectInfo | null {
  const path = resolve(pkg.dir, 'pyproject.toml');
  if (!existsSync(path)) return null;
  return parsePyproject(readFileSync(path, 'utf-8'));
}

/** PEP 503 normalization for URL/API paths: lowercase, runs of -_. collapse to - */
function normalizePypiName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/** Sync pyproject.toml's [project].version from the version being published */
function syncPyprojectVersion(ctx: TargetPublishContext): void {
  const path = resolve(ctx.pkg.dir, 'pyproject.toml');
  const info = parsePyproject(readFileSync(path, 'utf-8'));
  if (info.dynamicVersion) {
    throw new Error(
      `${ctx.pkg.name}: pyproject.toml declares a dynamic version — bumpy can't sync it. ` +
        `Use a static [project] version (commit any placeholder; bumpy rewrites it at publish time).`,
    );
  }
  if (info.version === ctx.version) return;
  // Validate even on dry runs — only the write is skipped
  const updated = updatePyprojectVersion(info.raw, ctx.version);
  if (updated === null) {
    throw new Error(`${ctx.pkg.name}: could not find a static [project] version in pyproject.toml to sync`);
  }
  if (!ctx.dryRun) writeFileSync(path, updated);
}

export const pypiTarget: PublishTargetPlugin = {
  type: 'pypi',
  capabilities: { distTags: false, prereleases: false, snapshots: false },

  detect(pkg) {
    return existsSync(resolve(pkg.dir, 'pyproject.toml'));
  },

  label() {
    return 'PyPI';
  },

  async preflight(ctx) {
    const uvVersion = tryRunArgs(['uv', '--version']);
    if (!uvVersion) {
      throw new Error(
        'pypi target requires the `uv` CLI for building and publishing — ' +
          'install it (https://docs.astral.sh/uv/) or use a custom target with your own commands',
      );
    }
    // Auth: trusted publishing (OIDC) needs no secret on GitHub Actions; otherwise a token
    if (
      !ctx.dryRun &&
      !process.env.UV_PUBLISH_TOKEN &&
      !process.env.ACTIONS_ID_TOKEN_REQUEST_URL &&
      !ctx.options.index
    ) {
      log.warn('  No PyPI auth detected — set UV_PUBLISH_TOKEN or configure trusted publishing (OIDC)');
    }
  },

  async checkPublished(pkg, version, options) {
    // Only pypi.org is queryable generically; custom indexes fall back to git tags
    if (options.index) return null;
    const info = loadPyproject(pkg);
    if (!info?.name) return null;
    try {
      const res = await fetch(`https://pypi.org/pypi/${normalizePypiName(info.name)}/${version}/json`);
      if (res.status === 200) return true;
      if (res.status === 404) return false;
      return null;
    } catch {
      return null; // network hiccup — unknown
    }
  },

  artifactKind() {
    return 'python-dist';
  },

  async prepare(ctx) {
    if (!existsSync(resolve(ctx.pkg.dir, 'pyproject.toml'))) {
      throw new Error(`${ctx.pkg.name}: pypi target requires a pyproject.toml`);
    }
    syncPyprojectVersion(ctx);
  },

  async buildArtifact(ctx) {
    // Isolated out-dir: `dist/` may hold stale builds of other versions, and
    // uploading a directory wholesale is how old artifacts leak into a release
    const outDir = resolve(ctx.pkg.dir, `${OUT_DIR_PREFIX}-${ctx.version}`);
    const buildArgs = stringArrayOption(ctx.options, 'buildArgs');
    const args = ['uv', 'build', '--out-dir', outDir, ...buildArgs];
    log.dim(`  Building: ${args.join(' ')}`);
    await runArgsAsync(args, { cwd: ctx.pkg.dir });
    return outDir;
  },

  async publish(ctx) {
    const args = ['uv', 'publish'];
    const index = stringOption(ctx.options, 'index');
    if (index) args.push('--publish-url', index);
    args.push(...stringArrayOption(ctx.options, 'publishArgs'));

    if (ctx.dryRun) {
      log.dim(`  Would publish with: ${args.join(' ')} <dist files>`);
      return;
    }

    // Explicit file list (no shell globbing) from the isolated build dir
    const distFiles = (await readdir(ctx.artifactPath!)).map((f) => resolve(ctx.artifactPath!, f));
    if (distFiles.length === 0) {
      throw new Error(`${ctx.pkg.name}: uv build produced no distributions in ${ctx.artifactPath}`);
    }
    args.push(...distFiles);

    log.dim(`  Publishing: ${args.join(' ')}`);
    await runArgsAsync(args, { cwd: ctx.pkg.dir });
  },

  publishUrl(pkg, version) {
    const info = loadPyproject(pkg);
    if (!info?.name) return undefined;
    return `https://pypi.org/project/${normalizePypiName(info.name)}/${version}/`;
  },
};
