import { resolve } from 'node:path';
import { getBumpyDir } from './config.ts';
import { getCurrentBranch } from './git.ts';
import type { BumpyConfig } from '../types.ts';

/** A channel config with all defaults applied */
export interface ResolvedChannel {
  name: string;
  branch: string;
  preid: string;
  tag: string;
  versionPr: {
    title: string;
    branch: string;
    automerge: boolean;
  };
}

/** Channel names that would collide with reserved `.bumpy/` entries */
const RESERVED_CHANNEL_NAMES = new Set(['README', 'README.md']);

/**
 * Resolve all configured channels, applying defaults and validating names.
 * Defaults: preid/tag = channel name; versionPr.title = "<base-title> (<name>)";
 * versionPr.branch = "<base-branch>-<name>".
 */
export function resolveChannels(config: BumpyConfig): Map<string, ResolvedChannel> {
  const channels = new Map<string, ResolvedChannel>();
  const seenBranches = new Map<string, string>();

  for (const [name, raw] of Object.entries(config.channels || {})) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name.startsWith('_') || RESERVED_CHANNEL_NAMES.has(name)) {
      throw new Error(
        `Invalid channel name "${name}" — channel names become .bumpy/ subdirectories and must be ` +
          'alphanumeric (plus ".", "-", "_"), not start with "_", and not collide with reserved entries.',
      );
    }
    if (!raw.branch || typeof raw.branch !== 'string') {
      throw new Error(`Channel "${name}" is missing required "branch" field`);
    }
    if (raw.branch === config.baseBranch) {
      throw new Error(`Channel "${name}" cannot use the base branch ("${config.baseBranch}") as its channel branch`);
    }
    const existing = seenBranches.get(raw.branch);
    if (existing) {
      throw new Error(`Channels "${existing}" and "${name}" both use branch "${raw.branch}"`);
    }
    seenBranches.set(raw.branch, name);

    channels.set(name, {
      name,
      branch: raw.branch,
      preid: raw.preid ?? name,
      tag: raw.tag ?? name,
      versionPr: {
        title: raw.versionPr?.title ?? `${config.versionPr.title} (${name})`,
        branch: raw.versionPr?.branch ?? `${config.versionPr.branch}-${name}`,
        automerge: raw.versionPr?.automerge ?? false,
      },
    });
  }

  return channels;
}

/** Names of all configured channels (used as `.bumpy/` subdirectory names) */
export function channelNames(config: BumpyConfig): string[] {
  return Object.keys(config.channels || {});
}

/** Absolute path of a channel's shipped-bump-files directory */
export function getChannelDir(rootDir: string, channelName: string): string {
  return resolve(getBumpyDir(rootDir), channelName);
}

/**
 * Detect the branch the release flow is running for.
 * In GitHub Actions push events, HEAD is often detached — prefer GITHUB_REF_NAME.
 */
export function detectReleaseBranch(rootDir: string): string | null {
  const refName = process.env.GITHUB_REF_NAME;
  const refType = process.env.GITHUB_REF_TYPE;
  if (refName && refType !== 'tag') return refName;
  const branch = getCurrentBranch({ cwd: rootDir });
  if (!branch || branch === 'HEAD') return null; // detached HEAD with no env hint
  return branch;
}

/** Find the channel matching a branch name, if any */
export function matchChannelByBranch(config: BumpyConfig, branch: string | null): ResolvedChannel | null {
  if (!branch) return null;
  for (const channel of resolveChannels(config).values()) {
    if (channel.branch === branch) return channel;
  }
  return null;
}

/**
 * Resolve the active channel for a command:
 * an explicit `--channel <name>` override wins, otherwise the current branch is matched.
 * Throws if an explicit override names an unknown channel.
 */
export function resolveActiveChannel(rootDir: string, config: BumpyConfig, override?: string): ResolvedChannel | null {
  if (override) {
    const channel = resolveChannels(config).get(override);
    if (!channel) {
      const known = channelNames(config);
      throw new Error(
        `Unknown channel "${override}"${known.length ? ` — configured channels: ${known.join(', ')}` : ' — no channels are configured in .bumpy/_config.json'}`,
      );
    }
    return channel;
  }
  return matchChannelByBranch(config, detectReleaseBranch(rootDir));
}
