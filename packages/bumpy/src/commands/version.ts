import { log, colorize } from '../utils/logger.ts';
import { loadConfig } from '../core/config.ts';
import { discoverPackages } from '../core/workspace.ts';
import { DependencyGraph } from '../core/dep-graph.ts';
import { readBumpFiles, moveBumpFilesToChannel } from '../core/bump-file.ts';
import { assembleReleasePlan } from '../core/release-plan.ts';
import { applyReleasePlan } from '../core/apply-release-plan.ts';
import { channelNames, resolveActiveChannel, type ResolvedChannel } from '../core/channels.ts';
import { runArgs, tryRunArgs } from '../utils/shell.ts';
import { detectWorkspaces } from '../utils/package-manager.ts';
import { resolveCommitMessage } from '../core/commit-message.ts';
import type { BumpyConfig, BumpFile, ReleasePlan } from '../types.ts';

interface VersionOptions {
  commit?: boolean;
  /** Channel name override (otherwise inferred from the current branch) */
  channel?: string;
}

export async function versionCommand(rootDir: string, opts: VersionOptions = {}): Promise<void> {
  const config = await loadConfig(rootDir);

  const channel = resolveActiveChannel(rootDir, config, opts.channel);
  if (channel) {
    await channelVersion(rootDir, config, channel, { commit: opts.commit });
    return;
  }

  const packages = await discoverPackages(rootDir, config);
  const depGraph = new DependencyGraph(packages);
  // Include channel subdirs — bump files that shipped as prereleases are pending
  // for the stable release (promotion consumes them).
  const { bumpFiles, errors: parseErrors } = await readBumpFiles(rootDir, { channels: channelNames(config) });

  if (parseErrors.length > 0) {
    for (const err of parseErrors) {
      log.error(err);
    }
    throw new Error('Bump file parse errors must be fixed before versioning.');
  }

  if (bumpFiles.length === 0) {
    log.info('No pending bump files.');
    return;
  }

  const plan = assembleReleasePlan(bumpFiles, packages, depGraph, config);

  if (plan.releases.length === 0) {
    log.warn('Bump files found but no packages would be released.');
    return;
  }

  // Show warnings from the release plan
  if (plan.warnings.length > 0) {
    for (const w of plan.warnings) {
      log.warn(w);
    }
    console.log();
  }

  // Show what will happen
  log.step('Applying version bumps:');
  for (const r of plan.releases) {
    const tag = r.isDependencyBump ? ' (dep)' : r.isCascadeBump ? ' (cascade)' : '';
    console.log(`  ${r.name}: ${r.oldVersion} → ${colorize(r.newVersion, 'cyan')}${tag}`);
  }

  // Apply the plan
  await applyReleasePlan(plan, packages, rootDir, config);

  log.success(`🐸 Updated ${plan.releases.length} package(s)`);
  log.dim(`  Deleted ${bumpFiles.length} bump file(s)`);

  // Update lockfile so it stays in sync with bumped versions
  await updateLockfile(rootDir);

  // Optionally commit
  if (opts.commit) {
    try {
      // Stage version changes, changelogs, deleted bump files, and lockfile
      runArgs(['git', 'add', '-A', '.bumpy/'], { cwd: rootDir });
      for (const r of plan.releases) {
        const pkg = packages.get(r.name)!;
        runArgs(['git', 'add', '--', `${pkg.relativeDir}/package.json`], { cwd: rootDir });
        runArgs(['git', 'add', '--', `${pkg.relativeDir}/CHANGELOG.md`], { cwd: rootDir });
      }
      // Stage lockfile if it changed
      for (const lockfile of ['bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json']) {
        tryRunArgs(['git', 'add', '--', lockfile], { cwd: rootDir });
      }
      const msg = await resolveCommitMessage(config.versionCommitMessage, plan, rootDir);
      runArgs(['git', 'commit', '-F', '-'], { cwd: rootDir, input: msg });
      log.success('Created git commit');
    } catch (e) {
      log.warn(`Git commit failed: ${e}`);
    }
  }
}

export interface ChannelVersionResult {
  /** The full cycle plan (pending + shipped bump files) with stable target versions */
  cyclePlan: ReleasePlan;
  /** Bump files that were moved into the channel dir by this run */
  movedFiles: BumpFile[];
}

/**
 * "Versioning" on a prerelease channel never writes versions or changelogs — those
 * are derived at publish time. It only moves pending bump files (root + other
 * channels' dirs) into this channel's `.bumpy/<channel>/` directory, marking them
 * as shipped on this channel.
 */
export async function channelVersion(
  rootDir: string,
  config: BumpyConfig,
  channel: ResolvedChannel,
  opts: { commit?: boolean } = {},
): Promise<ChannelVersionResult | null> {
  const packages = await discoverPackages(rootDir, config);
  const depGraph = new DependencyGraph(packages);
  const { bumpFiles, errors: parseErrors } = await readBumpFiles(rootDir, { channels: channelNames(config) });

  if (parseErrors.length > 0) {
    for (const err of parseErrors) {
      log.error(err);
    }
    throw new Error('Bump file parse errors must be fixed before versioning.');
  }

  // A bump file is pending for this channel unless it's already in this channel's dir
  const pending = bumpFiles.filter((bf) => bf.channel !== channel.name);

  if (pending.length === 0) {
    log.info(`No pending bump files for channel "${channel.name}".`);
    return null;
  }

  // The full cycle (pending + shipped) determines the targets — show them, suffixed.
  // Counters come from the registry at publish time, so they render as ".?" here.
  const cyclePlan = assembleReleasePlan(bumpFiles, packages, depGraph, config, {
    prereleasePreid: channel.preid,
  });

  if (cyclePlan.warnings.length > 0) {
    for (const w of cyclePlan.warnings) {
      log.warn(w);
    }
    console.log();
  }

  log.step(`Channel "${channel.name}" — moving ${pending.length} bump file(s) into .bumpy/${channel.name}/:`);
  for (const bf of pending) {
    const from = bf.channel ? `.bumpy/${bf.channel}/` : '.bumpy/';
    console.log(`  ${from}${bf.id}.md → .bumpy/${channel.name}/${bf.id}.md`);
  }
  console.log();
  log.step('Cycle targets (counters are derived from the registry at publish time):');
  for (const r of cyclePlan.releases) {
    const tag = r.isDependencyBump ? ' (dep)' : r.isCascadeBump ? ' (cascade)' : '';
    console.log(`  ${r.name}: ${r.oldVersion} → ${colorize(`${r.newVersion}-${channel.preid}.?`, 'cyan')}${tag}`);
  }

  await moveBumpFilesToChannel(rootDir, pending, channel.name);
  log.success(`🐸 Moved ${pending.length} bump file(s) — no versions written (prereleases are derived, not committed)`);

  if (opts.commit) {
    try {
      runArgs(['git', 'add', '-A', '.bumpy/'], { cwd: rootDir });
      const summary = pending.map((bf) => `${bf.id}.md`).join(', ');
      const msg = `Version prerelease (${channel.name})\n\nShipped: ${summary}`;
      runArgs(['git', 'commit', '-F', '-'], { cwd: rootDir, input: msg });
      log.success('Created git commit');
    } catch (e) {
      log.warn(`Git commit failed: ${e}`);
    }
  }

  return { cyclePlan, movedFiles: pending };
}

/** Run the package manager's install to update the lockfile */
async function updateLockfile(rootDir: string): Promise<void> {
  const { packageManager } = await detectWorkspaces(rootDir);
  const installArgs = getInstallArgs(packageManager);

  log.step(`Updating lockfile (${installArgs.join(' ')})...`);
  try {
    runArgs(installArgs, { cwd: rootDir });
    log.dim('  Lockfile updated');
  } catch (err) {
    log.warn(`  Lockfile update failed: ${err instanceof Error ? err.message : err}`);
  }
}

function getInstallArgs(pm: string): string[] {
  switch (pm) {
    case 'pnpm':
      return ['pnpm', 'install', '--lockfile-only'];
    case 'bun':
      return ['bun', 'install'];
    case 'yarn':
      return ['yarn', 'install', '--mode', 'update-lockfile'];
    default:
      return ['npm', 'install', '--package-lock-only'];
  }
}
