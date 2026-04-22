import { log, colorize } from '../utils/logger.ts';
import { loadConfig } from '../core/config.ts';
import { discoverPackages } from '../core/workspace.ts';
import { DependencyGraph } from '../core/dep-graph.ts';
import { readBumpFiles } from '../core/bump-file.ts';
import { assembleReleasePlan } from '../core/release-plan.ts';
import { applyReleasePlan } from '../core/apply-release-plan.ts';
import { runArgs, tryRunArgs } from '../utils/shell.ts';
import { detectWorkspaces } from '../utils/package-manager.ts';
import { resolveCommitMessage } from '../core/commit-message.ts';

interface VersionOptions {
  commit?: boolean;
}

export async function versionCommand(rootDir: string, opts: VersionOptions = {}): Promise<void> {
  const config = await loadConfig(rootDir);
  const packages = await discoverPackages(rootDir, config);
  const depGraph = new DependencyGraph(packages);
  const bumpFiles = await readBumpFiles(rootDir);

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

  log.success(`Updated ${plan.releases.length} package(s)`);
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
