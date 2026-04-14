import { log, colorize } from '../utils/logger.ts';
import { loadConfig } from '../core/config.ts';
import { discoverPackages } from '../core/workspace.ts';
import { DependencyGraph } from '../core/dep-graph.ts';
import { readChangesets } from '../core/changeset.ts';
import { assembleReleasePlan } from '../core/release-plan.ts';
import { applyReleasePlan } from '../core/apply-release-plan.ts';
import { run, tryRun } from '../utils/shell.ts';
import { detectWorkspaces } from '../utils/package-manager.ts';

export async function versionCommand(rootDir: string): Promise<void> {
  const config = await loadConfig(rootDir);
  const packages = await discoverPackages(rootDir, config);
  const depGraph = new DependencyGraph(packages);
  const changesets = await readChangesets(rootDir);

  if (changesets.length === 0) {
    log.info('No pending changesets.');
    return;
  }

  const plan = assembleReleasePlan(changesets, packages, depGraph, config);

  if (plan.releases.length === 0) {
    log.warn('Changesets found but no packages would be released.');
    return;
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
  log.dim(`  Deleted ${changesets.length} changeset file(s)`);

  // Update lockfile so it stays in sync with bumped versions
  await updateLockfile(rootDir);

  // Optionally commit
  if (config.commit) {
    try {
      // Stage version changes, changelogs, deleted changesets, and lockfile
      run('git add -A .bumpy/', { cwd: rootDir });
      for (const r of plan.releases) {
        const pkg = packages.get(r.name)!;
        run(`git add "${pkg.relativeDir}/package.json"`, { cwd: rootDir });
        run(`git add "${pkg.relativeDir}/CHANGELOG.md"`, { cwd: rootDir });
      }
      // Stage lockfile if it changed
      for (const lockfile of ['bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json']) {
        tryRun(`git add "${lockfile}"`, { cwd: rootDir });
      }
      const msg = `Version packages\n\n${plan.releases.map((r) => `${r.name}@${r.newVersion}`).join('\n')}`;
      run(`git commit -m "${msg.replace(/"/g, '\\"')}"`, { cwd: rootDir });
      log.success('Created git commit');
    } catch (e) {
      log.warn(`Git commit failed: ${e}`);
    }
  }
}

/** Run the package manager's install to update the lockfile */
async function updateLockfile(rootDir: string): Promise<void> {
  const { packageManager } = await detectWorkspaces(rootDir);
  const installCmd = getInstallCommand(packageManager);

  log.step(`Updating lockfile (${installCmd})...`);
  try {
    run(installCmd, { cwd: rootDir });
    log.dim('  Lockfile updated');
  } catch (err) {
    log.warn(`  Lockfile update failed: ${err instanceof Error ? err.message : err}`);
  }
}

function getInstallCommand(pm: string): string {
  switch (pm) {
    case 'pnpm':
      return 'pnpm install --lockfile-only';
    case 'bun':
      return 'bun install';
    case 'yarn':
      return 'yarn install --mode update-lockfile';
    default:
      return 'npm install --package-lock-only';
  }
}
