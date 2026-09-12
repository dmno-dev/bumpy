import { resolve } from 'node:path';
import { runArgsAsync, runStreaming, tryRunArgs } from '../../utils/shell.ts';
import { log } from '../../utils/logger.ts';
import { shellWord, stringArrayOption, stringMapOption, stringOption, templateString } from './util.ts';
import type { PublishTargetPlugin, TargetOptions, TargetPublishContext } from './types.ts';

/**
 * Docker image target: builds and pushes an image tagged with the version (plus
 * `latest` for stable releases and the dist-tag for channel/snapshot publishes, so
 * `image:next` / `image:pr-123` work like npm dist-tags).
 *
 * Uses `docker buildx build --push`, which handles multi-platform manifests
 * (`platforms`) in one go. Auth is left to the environment (`docker login`, or
 * `docker/login-action` in CI) — for GHCR the workflow's `GITHUB_TOKEN` with
 * `packages: write` is enough.
 *
 * Options:
 * - `image` (string, required) — e.g. `ghcr.io/dmno-dev/varlock`
 * - `context` (string, default `.`) — build context, relative to the package dir
 * - `dockerfile` (string) — Dockerfile path, relative to the package dir
 * - `platforms` (string[]) — e.g. `["linux/amd64", "linux/arm64"]`
 * - `buildArgs` (object) — `--build-arg` values; `{{version}}`/`{{name}}` substituted
 * - `tags` (string[]) — extra tags, `{{version}}` substituted
 * - `latest` (boolean, default true) — also tag stable releases as `latest`
 */

function imageName(options: TargetOptions): string {
  const image = stringOption(options, 'image');
  if (!image) throw new Error('docker target requires an "image" option (e.g. "ghcr.io/owner/name")');
  return image;
}

/** Tags this publish applies: version, latest (stable only), dist-tag, extras */
export function dockerTags(ctx: TargetPublishContext): string[] {
  const vars = { version: ctx.version, name: ctx.pkg.name };
  const tags = [ctx.version];
  if (ctx.releaseKind === 'stable' && ctx.options.latest !== false) tags.push('latest');
  if (ctx.distTag) tags.push(ctx.distTag);
  for (const extra of stringArrayOption(ctx.options, 'tags')) tags.push(templateString(extra, vars));
  return [...new Set(tags)];
}

export function dockerBuildArgs(ctx: TargetPublishContext): string[] {
  const image = imageName(ctx.options);
  const vars = { version: ctx.version, name: ctx.pkg.name };
  const args = ['docker', 'buildx', 'build', '--push'];
  for (const tag of dockerTags(ctx)) args.push('--tag', `${image}:${tag}`);
  const platforms = stringArrayOption(ctx.options, 'platforms');
  if (platforms.length > 0) args.push('--platform', platforms.join(','));
  for (const [key, value] of Object.entries(stringMapOption(ctx.options, 'buildArgs'))) {
    args.push('--build-arg', `${key}=${templateString(value, vars)}`);
  }
  const dockerfile = stringOption(ctx.options, 'dockerfile');
  if (dockerfile) args.push('--file', resolve(ctx.pkg.dir, dockerfile));
  args.push(resolve(ctx.pkg.dir, stringOption(ctx.options, 'context') ?? '.'));
  return args;
}

function registryHost(image: string): string {
  const first = image.split('/')[0]!;
  return first.includes('.') || first.includes(':') ? first : 'docker.io';
}

export const dockerTarget: PublishTargetPlugin = {
  type: 'docker',
  capabilities: { distTags: true, prereleases: true, snapshots: true },
  // Consumes the release (downloads its assets) — runs once it's published
  phase: 'post-release',

  label(options) {
    const image = stringOption(options, 'image');
    if (!image) return 'Docker';
    const host = registryHost(image);
    if (host === 'ghcr.io') return 'GHCR';
    if (host === 'docker.io') return 'Docker Hub';
    return `Docker (${host})`;
  },

  async preflight(ctx) {
    imageName(ctx.options);
    if (!tryRunArgs(['docker', '--version'])) {
      throw new Error('docker target requires the `docker` CLI (with buildx) to build and push images');
    }
  },

  async checkPublished(_pkg, version, options) {
    const ref = `${imageName(options)}:${version}`;
    try {
      // Bounded: a credential helper waiting for a prompt must not hang the release
      await runArgsAsync(['docker', 'manifest', 'inspect', ref], { timeoutMs: 60_000 });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A missing tag is a definite "not published"; auth/network errors and timeouts are unknown
      return /manifest unknown|not found|no such manifest|MANIFEST_UNKNOWN/i.test(msg) ? false : null;
    }
  },

  async publish(ctx) {
    const args = dockerBuildArgs(ctx);
    if (ctx.dryRun) {
      log.dim(`  Would build and push with: ${args.join(' ')}`);
      return;
    }
    log.dim(`  Building and pushing: ${args.join(' ')}`);
    // Stream — image builds are slow and chatty
    await runStreaming(args.map(shellWord).join(' '), { cwd: ctx.pkg.dir });
  },

  publishUrl(_pkg, _version, options, extra) {
    const image = stringOption(options, 'image');
    if (!image) return undefined;
    const host = registryHost(image);
    const path = host === 'docker.io' ? image.replace(/^docker\.io\//, '') : image.slice(host.length + 1);
    if (host === 'ghcr.io') {
      // ghcr.io/<owner>/<name> lives under the repo's packages when the owner matches
      const [owner, ...rest] = path.split('/');
      const name = rest.join('/');
      if (extra.repoSlug && owner && extra.repoSlug.toLowerCase().startsWith(`${owner.toLowerCase()}/`)) {
        return `https://github.com/${extra.repoSlug}/pkgs/container/${encodeURIComponent(name)}`;
      }
      return undefined;
    }
    if (host === 'docker.io') {
      const [ns, name] = path.includes('/') ? path.split('/') : ['library', path];
      return `https://hub.docker.com/r/${ns}/${name}`;
    }
    return undefined;
  },
};
