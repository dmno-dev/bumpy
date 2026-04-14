import { log, colorize } from '../utils/logger.ts';
import { loadConfig } from '../core/config.ts';
import { discoverWorkspace } from '../core/workspace.ts';
import { DependencyGraph } from '../core/dep-graph.ts';
import { readChangesets } from '../core/changeset.ts';
import { assembleReleasePlan } from '../core/release-plan.ts';
import { run, tryRun, runAsync } from '../utils/shell.ts';
import type { BumpyConfig, ReleasePlan, PlannedRelease } from '../types.ts';

/** Configure git identity for CI commits if not already set */
function ensureGitIdentity(rootDir: string, config: BumpyConfig): void {
  const name = tryRun('git config user.name', { cwd: rootDir });
  if (!name) {
    const { name: gitName, email: gitEmail } = config.gitUser;
    run(`git config user.name "${gitName}"`, { cwd: rootDir });
    run(`git config user.email "${gitEmail}"`, { cwd: rootDir });
    log.dim(`  Using git identity: ${gitName} <${gitEmail}>`);
  }
}

// ---- ci check ----

interface CheckOptions {
  comment?: boolean; // post a PR comment via gh (default: true in CI)
  failOnMissing?: boolean; // exit 1 if no changesets (default: false)
}

/**
 * CI check: report on pending changesets.
 * Designed for PR workflows — shows what would be released and optionally comments on the PR.
 */
export async function ciCheckCommand(rootDir: string, opts: CheckOptions): Promise<void> {
  const config = await loadConfig(rootDir);
  const { packages } = await discoverWorkspace(rootDir, config);
  const depGraph = new DependencyGraph(packages);
  const changesets = await readChangesets(rootDir);

  const inCI = !!process.env.CI;
  const shouldComment = opts.comment ?? inCI;
  const prNumber = detectPrNumber();

  if (changesets.length === 0) {
    const msg = 'No changesets found in this PR.';
    log.info(msg);

    if (shouldComment && prNumber) {
      await postOrUpdatePrComment(prNumber, formatNoChangesetsComment(), rootDir);
    }

    if (opts.failOnMissing) {
      process.exit(1);
    }
    return;
  }

  const plan = assembleReleasePlan(changesets, packages, depGraph, config);

  // Pretty output for logs
  log.bold(`${changesets.length} changeset(s) → ${plan.releases.length} package(s) to release\n`);
  for (const r of plan.releases) {
    const tag = r.isDependencyBump ? ' (dep)' : r.isCascadeBump ? ' (cascade)' : '';
    console.log(`  ${r.name}: ${r.oldVersion} → ${colorize(r.newVersion, 'cyan')}${tag}`);
  }

  // Comment on PR
  if (shouldComment && prNumber) {
    const comment = formatReleasePlanComment(plan, changesets.length);
    await postOrUpdatePrComment(prNumber, comment, rootDir);
  }
}

// ---- ci release ----

interface ReleaseOptions {
  mode: 'auto-publish' | 'version-pr';
  tag?: string; // npm dist-tag for auto-publish
  branch?: string; // branch name for version PR (default: "bumpy/version-packages")
}

/**
 * CI release: either auto-publish or create a version PR.
 * Designed for merge-to-main workflows.
 */
export async function ciReleaseCommand(rootDir: string, opts: ReleaseOptions): Promise<void> {
  const config = await loadConfig(rootDir);
  ensureGitIdentity(rootDir, config);
  const { packages } = await discoverWorkspace(rootDir, config);
  const depGraph = new DependencyGraph(packages);
  const changesets = await readChangesets(rootDir);

  if (changesets.length === 0) {
    // No changesets — check if there are unpublished packages to publish
    // (this handles the case where a version PR was just merged)
    log.info('No pending changesets — checking for unpublished packages...');
    const { publishCommand } = await import('./publish.ts');
    await publishCommand(rootDir, { tag: opts.tag });
    return;
  }

  const plan = assembleReleasePlan(changesets, packages, depGraph, config);
  if (plan.releases.length === 0) {
    log.info('Changesets found but no packages would be released.');
    return;
  }

  if (opts.mode === 'auto-publish') {
    await autoPublish(rootDir, config, opts.tag);
  } else {
    await createVersionPr(rootDir, plan, config, opts.branch);
  }
}

// ---- auto-publish mode ----

async function autoPublish(rootDir: string, config: BumpyConfig, tag?: string): Promise<void> {
  log.step('Running bumpy version...');
  const { versionCommand } = await import('./version.ts');
  await versionCommand(rootDir);

  // Commit the version changes
  log.step('Committing version changes...');
  run('git add -A', { cwd: rootDir });
  const status = tryRun('git status --porcelain', { cwd: rootDir });
  if (status) {
    run('git commit -m "Version packages"', { cwd: rootDir });
    run('git push', { cwd: rootDir });
  }

  log.step('Running bumpy publish...');
  const { publishCommand } = await import('./publish.ts');
  await publishCommand(rootDir, { tag });
}

// ---- version-pr mode ----

async function createVersionPr(
  rootDir: string,
  plan: ReleasePlan,
  config: BumpyConfig,
  branchName?: string,
): Promise<void> {
  const branch = branchName || config.versionPr.branch;
  const baseBranch = tryRun('git rev-parse --abbrev-ref HEAD', { cwd: rootDir }) || 'main';

  // Check if a version PR already exists
  const existingPr = tryRun(`gh pr list --head "${branch}" --json number --jq ".[0].number"`, { cwd: rootDir });

  // Create or update the branch
  log.step(`Creating branch ${branch}...`);
  const branchExists = tryRun(`git rev-parse --verify ${branch}`, { cwd: rootDir }) !== null;

  if (branchExists) {
    run(`git checkout ${branch}`, { cwd: rootDir });
    run(`git reset --hard ${baseBranch}`, { cwd: rootDir });
  } else {
    run(`git checkout -b ${branch}`, { cwd: rootDir });
  }

  // Run bumpy version
  log.step('Running bumpy version...');
  const { versionCommand } = await import('./version.ts');
  await versionCommand(rootDir);

  // Commit and push
  run('git add -A', { cwd: rootDir });
  const status = tryRun('git status --porcelain', { cwd: rootDir });
  if (!status) {
    log.info('No version changes to commit.');
    run(`git checkout ${baseBranch}`, { cwd: rootDir });
    return;
  }

  const commitMsg = ['Version packages', '', ...plan.releases.map((r) => `${r.name}@${r.newVersion}`)].join('\n');
  run('git commit -F -', { cwd: rootDir, input: commitMsg });
  run(`git push -u origin ${branch} --force`, { cwd: rootDir });

  // Create or update PR
  const prBody = formatVersionPrBody(plan, config.versionPr.preamble);

  if (existingPr) {
    log.step(`Updating existing PR #${existingPr}...`);
    await runAsync(`gh pr edit ${existingPr} --title "${config.versionPr.title}" --body-file -`, {
      cwd: rootDir,
      input: prBody,
    });
    log.success(`Updated PR #${existingPr}`);
  } else {
    log.step('Creating version PR...');
    const prTitle = config.versionPr.title;
    const result = await runAsync(
      `gh pr create --title "${prTitle}" --body-file - --base "${baseBranch}" --head "${branch}"`,
      { cwd: rootDir, input: prBody },
    );
    log.success(`Created PR: ${result}`);
  }

  // Switch back to the base branch
  run(`git checkout ${baseBranch}`, { cwd: rootDir });
}

// ---- PR comment helpers ----

function formatReleasePlanComment(plan: ReleasePlan, changesetCount: number): string {
  const lines: string[] = [];
  lines.push('## 🐸 Bumpy Release Plan\n');
  lines.push(`**${changesetCount}** changeset(s) → **${plan.releases.length}** package(s) to release\n`);

  const groups: [string, PlannedRelease[]][] = [
    ['🔴 Major', plan.releases.filter((r) => r.type === 'major')],
    ['🟡 Minor', plan.releases.filter((r) => r.type === 'minor')],
    ['🟢 Patch', plan.releases.filter((r) => r.type === 'patch')],
  ];

  for (const [label, group] of groups) {
    if (group.length === 0) continue;
    lines.push(`### ${label}\n`);
    lines.push('| Package | Change |');
    lines.push('|---------|--------|');
    for (const r of group) {
      const suffix = r.isDependencyBump ? ' _(dep)_' : r.isCascadeBump ? ' _(cascade)_' : '';
      lines.push(`| \`${r.name}\` | ${r.oldVersion} → **${r.newVersion}**${suffix} |`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('_This comment is maintained by [bumpy](https://github.com/dmno-dev/bumpy)._');
  return lines.join('\n');
}

function formatNoChangesetsComment(): string {
  return [
    '## 🐸 Bumpy Release Plan\n',
    'No changesets found in this PR. If this PR should trigger a release, run:\n',
    '```bash',
    'bumpy add',
    '```\n',
    '---',
    '_This comment is maintained by [bumpy](https://github.com/dmno-dev/bumpy)._',
  ].join('\n');
}

function formatVersionPrBody(plan: ReleasePlan, preamble: string): string {
  const lines: string[] = [];
  lines.push(preamble);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const r of plan.releases) {
    const suffix = r.isDependencyBump ? ' (dep)' : r.isCascadeBump ? ' (cascade)' : '';
    lines.push(`- \`${r.name}\` ${r.oldVersion} → **${r.newVersion}**${suffix}`);
  }

  return lines.join('\n');
}

const COMMENT_MARKER = '<!-- bumpy-release-plan -->';

async function postOrUpdatePrComment(prNumber: string, body: string, rootDir: string): Promise<void> {
  const markedBody = `${COMMENT_MARKER}\n${body}`;

  try {
    // Find existing bumpy comment
    const existingComment = tryRun(
      `gh pr view ${prNumber} --json comments --jq '.comments[] | select(.body | startswith("${COMMENT_MARKER}")) | .id' | head -1`,
      { cwd: rootDir },
    );

    if (existingComment) {
      await runAsync(`gh api repos/{owner}/{repo}/issues/comments/${existingComment} -X PATCH -f body=@-`, {
        cwd: rootDir,
        input: markedBody,
      });
      log.dim('  Updated PR comment');
    } else {
      await runAsync(`gh pr comment ${prNumber} --body-file -`, { cwd: rootDir, input: markedBody });
      log.dim('  Posted PR comment');
    }
  } catch (err) {
    log.warn(`  Failed to comment on PR: ${err instanceof Error ? err.message : err}`);
  }
}

function detectPrNumber(): string | null {
  // GitHub Actions
  if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
    // PR number is in GITHUB_REF: refs/pull/123/merge
    const match = process.env.GITHUB_REF?.match(/refs\/pull\/(\d+)\//);
    if (match) return match[1]!;
  }
  // Also check for explicit env var
  return process.env.BUMPY_PR_NUMBER || process.env.PR_NUMBER || null;
}
