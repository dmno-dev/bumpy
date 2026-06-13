import { log, colorize } from '../utils/logger.ts';
import { loadConfig } from '../core/config.ts';
import { findChangedPackages } from './check.ts';
import { discoverWorkspace } from '../core/workspace.ts';
import { DependencyGraph } from '../core/dep-graph.ts';
import { readBumpFiles, filterBranchBumpFiles, recoverDeletedBumpFiles } from '../core/bump-file.ts';
import { getChangedFiles, withGitToken } from '../core/git.ts';
import { assembleReleasePlan } from '../core/release-plan.ts';
import {
  channelNames,
  detectReleaseBranch,
  matchChannelByBranch,
  resolveChannels,
  type ResolvedChannel,
} from '../core/channels.ts';
import { buildChannelReleasePlan, channelDisplayPlan, formatChannelVersionSummary } from '../core/prerelease.ts';
import { runArgs, runArgsAsync, tryRunArgs } from '../utils/shell.ts';
import { randomName } from '../utils/names.ts';
import { detectPackageManager } from '../utils/package-manager.ts';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolveCommitMessage } from '../core/commit-message.ts';
import type { BumpyConfig, BumpFile, PackageConfig, PackageManager, ReleasePlan, PlannedRelease } from '../types.ts';

// ---- PAT-scoped gh helpers ----

/**
 * Temporarily override GH_TOKEN with BUMPY_GH_TOKEN for a gh CLI call.
 *
 * When BUMPY_GH_TOKEN is set (e.g. a dedicated bot PAT or GitHub App token),
 * it is used so that PRs created by bumpy can trigger CI workflows (the
 * default GITHUB_TOKEN cannot do this). If BUMPY_GH_TOKEN is not available
 * (e.g. fork PRs where secrets are hidden), falls back to the default token.
 */
async function withPatToken<T>(fn: () => Promise<T>): Promise<T> {
  const token = process.env.BUMPY_GH_TOKEN;
  if (!token) return fn();
  const originalGhToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = token;
  try {
    return await fn();
  } catch (err) {
    // Redact token from error messages to prevent leakage in CI logs
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(msg.replaceAll(token, '***'));
  } finally {
    if (originalGhToken !== undefined) {
      process.env.GH_TOKEN = originalGhToken;
    } else {
      delete process.env.GH_TOKEN;
    }
  }
}

// ---- Validation helpers ----

/** Validate a git branch name to prevent injection */
function validateBranchName(name: string): string {
  if (!/^[a-zA-Z0-9_./-]+$/.test(name)) {
    throw new Error(`Invalid branch name: ${name}`);
  }
  return name;
}

/** Validate a PR number is numeric */
function validatePrNumber(pr: string): string {
  if (!/^\d+$/.test(pr)) {
    throw new Error(`Invalid PR number: ${pr}`);
  }
  return pr;
}

/** Configure git identity for CI commits if not already set */
function ensureGitIdentity(rootDir: string, config: BumpyConfig): void {
  const name = tryRunArgs(['git', 'config', 'user.name'], { cwd: rootDir });
  if (!name) {
    const { name: gitName, email: gitEmail } = config.gitUser;
    runArgs(['git', 'config', 'user.name', gitName], { cwd: rootDir });
    runArgs(['git', 'config', 'user.email', gitEmail], { cwd: rootDir });
    log.dim(`  Using git identity: ${gitName} <${gitEmail}>`);
  }
}

// ---- ci check ----

interface CheckOptions {
  comment?: boolean; // post a PR comment via gh (default: true in CI)
  strict?: boolean; // exit 1 if any changed packages are uncovered
  noFail?: boolean; // never exit 1, warn only
}

/**
 * CI check: report on pending bump files.
 * Designed for PR workflows — shows what would be released and optionally comments on the PR.
 */
export async function ciCheckCommand(rootDir: string, opts: CheckOptions): Promise<void> {
  const config = await loadConfig(rootDir);
  const { packages } = await discoverWorkspace(rootDir, config);
  const depGraph = new DependencyGraph(packages);
  // Read channel dirs too: on promotion (channel → main) and graduation (channel →
  // channel) PRs, the pending bump files live in `.bumpy/<channel>/`. Feature PRs
  // never have shipped channel files in their diff vs the PR base, so this only
  // surfaces files where they're genuinely pending.
  const { bumpFiles: allBumpFiles, errors: parseErrors } = await readBumpFiles(rootDir, {
    channels: channelNames(config),
  });

  // Skip on the version PR branch (and channel release PR branches) — they move/consume
  // bump files by design
  const prBranchName = detectPrBranch(rootDir);
  const channels = resolveChannels(config);
  const releasePrBranches = new Set([
    config.versionPr.branch,
    ...[...channels.values()].map((c) => c.versionPr.branch),
  ]);
  if (prBranchName && releasePrBranches.has(prBranchName)) {
    log.dim('  Skipping — this is a release PR branch.');
    return;
  }

  const inCI = !!process.env.CI;
  const shouldComment = opts.comment ?? inCI;
  const prNumber = detectPrNumber();
  const pm = await detectPackageManager(rootDir);

  // Filter to only bump files added/modified in this PR.
  // For PRs targeting a channel branch, compare against that branch (GITHUB_BASE_REF),
  // not baseBranch — otherwise the whole cycle's changes would show up.
  const compareBranch = process.env.GITHUB_BASE_REF || config.baseBranch;
  // If this PR targets a channel branch, the comment makes that explicit (prerelease,
  // dist-tag) rather than implying a normal stable release.
  const prChannel = matchChannelByBranch(config, process.env.GITHUB_BASE_REF || null);
  const changedFiles = getChangedFiles(rootDir, compareBranch);
  const { branchBumpFiles: prBumpFiles, emptyBumpFileIds } = filterBranchBumpFiles(
    allBumpFiles,
    changedFiles,
    rootDir,
    parseErrors,
  );

  // Surface any parse errors
  if (parseErrors.length > 0) {
    for (const err of parseErrors) {
      log.error(err);
    }
  }

  if (prBumpFiles.length === 0) {
    // An empty bump file signals intentionally no releases needed
    if (emptyBumpFileIds.length > 0 && parseErrors.length === 0) {
      log.success('Empty bump file found — no releases needed.');
      if (shouldComment && prNumber) {
        const prBranch = detectPrBranch(rootDir);
        await postOrUpdatePrComment(
          prNumber,
          formatEmptyBumpFileComment(emptyBumpFileIds, prNumber, prBranch),
          rootDir,
        );
      }
      return;
    }

    // Check if any managed packages actually changed — if not, no bump file is needed
    const changedPackages = await findChangedPackages(changedFiles, packages, rootDir, config);
    if (changedPackages.length === 0 && parseErrors.length === 0) {
      log.info('No managed packages have changed — no bump files needed.');
      return;
    }

    const willFail = !opts.noFail || parseErrors.length > 0;
    const msg =
      parseErrors.length > 0
        ? 'Bump file(s) found but failed to parse — see errors above.'
        : 'No bump files found in this PR.';
    if (willFail) log.error(msg);
    else log.warn(msg);

    if (shouldComment && prNumber) {
      const prBranch = detectPrBranch(rootDir);
      await postOrUpdatePrComment(
        prNumber,
        parseErrors.length > 0
          ? formatBumpFileErrorsComment(parseErrors, prBranch, pm)
          : formatNoBumpFilesComment(prBranch, pm),
        rootDir,
      );
    }

    if (willFail) process.exit(1);
    return;
  }

  // On a channel-targeted PR, plan with the prerelease preid so the wider cascade
  // (every dependent joins the cycle) is reflected accurately in the preview.
  const plan = assembleReleasePlan(
    prBumpFiles,
    packages,
    depGraph,
    config,
    prChannel ? { prereleasePreid: prChannel.preid } : {},
  );

  // Pretty output for logs
  const releaseSuffix = prChannel ? `-${prChannel.preid}.x` : '';
  log.bold(
    `${prBumpFiles.length} bump file(s) → ${plan.releases.length} package(s) to release` +
      `${prChannel ? ` on the "${prChannel.name}" channel (@${prChannel.tag})` : ''}\n`,
  );
  for (const r of plan.releases) {
    const tag = r.isDependencyBump ? ' (dep)' : r.isCascadeBump ? ' (cascade)' : '';
    console.log(`  ${r.name}: ${r.oldVersion} → ${colorize(`${r.newVersion}${releaseSuffix}`, 'cyan')}${tag}`);
  }
  if (plan.warnings.length > 0) {
    for (const w of plan.warnings) {
      log.warn(w);
    }
  }

  // Comment on PR
  if (shouldComment && prNumber) {
    const prBranch = detectPrBranch(rootDir);
    const comment = formatReleasePlanComment(
      plan,
      prBumpFiles,
      prNumber,
      prBranch,
      pm,
      plan.warnings,
      parseErrors,
      emptyBumpFileIds,
      prChannel,
      channels,
    );
    await postOrUpdatePrComment(prNumber, comment, rootDir);
  }

  // Fail if there were parse errors (even if some files parsed successfully)
  if (parseErrors.length > 0 && !opts.noFail) {
    process.exit(1);
  }

  // Check for uncovered packages
  // Include both released packages and those explicitly listed in bump files (e.g. with 'none')
  const coveredPackages = new Set(plan.releases.map((r) => r.name));
  for (const bf of prBumpFiles) {
    for (const release of bf.releases) {
      coveredPackages.add(release.name);
    }
  }
  const changedPackages = await findChangedPackages(changedFiles, packages, rootDir, config);
  const missing = changedPackages.filter((name) => !coveredPackages.has(name));
  if (missing.length > 0) {
    const willFail = opts.strict && !opts.noFail;
    const logFn = willFail ? log.error : log.warn;
    logFn(`${missing.length} changed package(s) not covered by bump files: ${missing.join(', ')}`);
    if (willFail) process.exit(1);
  }
}

// ---- ci plan ----

/** Path (relative to rootDir) where ci plan caches its output for ci release to reuse */
export const CI_PLAN_CACHE_PATH = 'node_modules/.cache/bumpy/ci-plan.json';

export type CiPlanMode = 'version-pr' | 'publish' | 'nothing';

interface PlanRelease {
  name: string;
  type: string;
  oldVersion: string;
  newVersion: string;
  dir?: string;
  bumpFiles: string[];
  isDependencyBump: boolean;
  isCascadeBump: boolean;
  publishTargets: Array<{ type: string }>;
}

interface PlanOutput {
  mode: CiPlanMode;
  bumpFiles: Array<{
    id: string;
    summary: string;
    releases: Array<{ name: string; type: string }>;
  }>;
  releases: PlanRelease[];
  packageNames: string[];
}

/**
 * CI plan: report what `ci release` would do, without acting.
 * Outputs JSON to stdout and sets GitHub Actions outputs when detected.
 */
export async function ciPlanCommand(rootDir: string): Promise<void> {
  const config = await loadConfig(rootDir);
  const { packages } = await discoverWorkspace(rootDir, config);
  const depGraph = new DependencyGraph(packages);
  // Channel-dir bump files count as pending on the base branch (promotion consumes them)
  const { bumpFiles, errors: parseErrors } = await readBumpFiles(rootDir, { channels: channelNames(config) });

  if (parseErrors.length > 0) {
    for (const err of parseErrors) {
      log.error(err);
    }
    throw new Error('Bump file parse errors must be fixed before planning.');
  }

  // On a channel branch, report the channel plan instead
  const channel = matchChannelByBranch(config, detectReleaseBranch(rootDir));
  if (channel) {
    await ciChannelPlan(rootDir, config, channel, packages, depGraph, bumpFiles);
    return;
  }

  let output: PlanOutput;

  // Assemble plan from bump files (if any)
  const plan = bumpFiles.length > 0 ? assembleReleasePlan(bumpFiles, packages, depGraph, config) : null;

  if (plan && plan.releases.length > 0) {
    // Bump files produce actual releases → version-pr mode
    output = {
      mode: 'version-pr',
      bumpFiles: plan.bumpFiles.map((bf) => ({
        id: bf.id,
        summary: bf.summary,
        releases: bf.releases.map((r) => ({ name: r.name, type: r.type })),
      })),
      releases: plan.releases.map((r) => formatPlanRelease(r, packages, config)),
      packageNames: plan.releases.map((r) => r.name),
    };
  } else {
    // No releases from bump files (none-only or no bump files) → check for unpublished packages
    const { findUnpublishedPackages } = await import('./publish.ts');
    const unpublished = await findUnpublishedPackages(packages, config);

    if (unpublished.length > 0) {
      output = {
        mode: 'publish',
        bumpFiles: [],
        releases: unpublished.map((r) => formatPlanRelease(r, packages, config)),
        packageNames: unpublished.map((r) => r.name),
      };
    } else {
      output = {
        mode: 'nothing',
        bumpFiles: [],
        releases: [],
        packageNames: [],
      };
    }
  }

  // JSON to stdout
  const json = JSON.stringify(output, null, 2);
  console.log(json);

  // Cache for ci release to reuse (avoids duplicate registry lookups)
  const cachePath = `${rootDir}/${CI_PLAN_CACHE_PATH}`;
  const cacheDir = cachePath.slice(0, cachePath.lastIndexOf('/'));
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cachePath, json, 'utf-8');

  // Set GitHub Actions outputs
  writeGitHubOutput('mode', output.mode);
  writeGitHubOutput('packages', JSON.stringify(output.packageNames));
  writeGitHubOutput('json', JSON.stringify(output));
}

function formatPlanRelease(
  r: {
    name: string;
    type: string;
    oldVersion: string;
    newVersion: string;
    bumpFiles: string[];
    isDependencyBump: boolean;
    isCascadeBump: boolean;
  },
  packages: Map<string, { relativeDir: string; private: boolean; bumpy?: PackageConfig }>,
  config: BumpyConfig,
): PlanRelease {
  const pkg = packages.get(r.name);
  return {
    name: r.name,
    type: r.type,
    oldVersion: r.oldVersion,
    newVersion: r.newVersion,
    dir: pkg?.relativeDir,
    bumpFiles: r.bumpFiles,
    isDependencyBump: r.isDependencyBump,
    isCascadeBump: r.isCascadeBump,
    publishTargets: getPublishTargets(pkg, config),
  };
}

function getPublishTargets(
  pkg: { private: boolean; bumpy?: PackageConfig } | undefined,
  _config: BumpyConfig,
): Array<{ type: string }> {
  if (!pkg) return [];
  const pkgConfig = pkg.bumpy || {};
  if (pkg.private && !pkgConfig.publishCommand) return [];
  const targets: Array<{ type: string }> = [];
  if (pkgConfig.publishCommand) {
    targets.push({ type: 'custom' });
  }
  if (!pkgConfig.publishCommand && !pkgConfig.skipNpmPublish) {
    targets.push({ type: 'npm' });
  }
  return targets;
}

/** Write a key=value pair to $GITHUB_OUTPUT if available */
function writeGitHubOutput(key: string, value: string): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;
  // Use delimiter protocol for multiline values
  const delimiter = `ghadelimiter_${Date.now()}`;
  appendFileSync(outputFile, `${key}<<${delimiter}\n${value}\n${delimiter}\n`);
}

// ---- ci release ----

interface ReleaseOptions {
  autoPublish?: boolean; // skip the version-PR step and version+publish in one shot
  assertMode?: 'version-pr' | 'publish'; // refuse to run if detected mode doesn't match — see CiPlanMode
  tag?: string; // npm dist-tag for auto-publish
  branch?: string; // branch name for version PR (default: "bumpy/version-packages")
}

/**
 * CI release: either create a version PR (bump files present) or publish unpublished
 * packages (no bump files — i.e. a version PR was just merged). Pass `autoPublish` to
 * collapse both steps into a single push-to-main, or `assertMode` to refuse running
 * when the detected state doesn't match expectations (used by split-job workflows).
 */
export async function ciReleaseCommand(rootDir: string, opts: ReleaseOptions): Promise<void> {
  const config = await loadConfig(rootDir);
  ensureGitIdentity(rootDir, config);

  // Channel branches get the channel flow; unknown branches are refused (when channels
  // are configured) so a misconfigured workflow can't publish from a feature branch.
  const releaseBranch = detectReleaseBranch(rootDir);
  const channel = matchChannelByBranch(config, releaseBranch);
  if (channel) {
    await ciChannelRelease(rootDir, config, channel, opts);
    return;
  }
  if (Object.keys(config.channels || {}).length > 0 && releaseBranch && releaseBranch !== config.baseBranch) {
    throw new Error(
      `"bumpy ci release" ran on branch "${releaseBranch}", which is neither the base branch ` +
        `("${config.baseBranch}") nor a configured channel branch. Refusing to release — ` +
        'add the branch to "channels" in .bumpy/_config.json or fix the workflow trigger.',
    );
  }

  const { packages } = await discoverWorkspace(rootDir, config);
  const depGraph = new DependencyGraph(packages);
  // Channel-dir bump files count as pending on the base branch — merging a channel
  // into main brings its shipped files along, and the stable release consumes them
  // (promotion). No special mode needed.
  const { bumpFiles, errors: releaseParseErrors } = await readBumpFiles(rootDir, { channels: channelNames(config) });

  if (releaseParseErrors.length > 0) {
    for (const err of releaseParseErrors) {
      log.error(err);
    }
    throw new Error('Bump file parse errors must be fixed before releasing.');
  }

  // Determine detected mode. "version-pr" = bump files exist with real releases.
  // "publish" = no bump files, or only none-only files (version PR just merged).
  const plan = bumpFiles.length > 0 ? assembleReleasePlan(bumpFiles, packages, depGraph, config) : null;
  const detectedMode: 'version-pr' | 'publish' = plan && plan.releases.length > 0 ? 'version-pr' : 'publish';

  if (opts.assertMode && opts.assertMode !== detectedMode) {
    throw new Error(
      `Expected mode "${opts.assertMode}" but detected "${detectedMode}". ` +
        `Either remove --expect-mode, or gate this step on the output of "bumpy ci plan".`,
    );
  }

  if (detectedMode === 'publish') {
    // No bump files (or only none-only) — check for unpublished packages.
    // Recover bump files deleted in the version commit so the formatter
    // can generate proper GitHub release bodies.
    const msg =
      bumpFiles.length === 0
        ? 'No pending bump files — checking for unpublished packages...'
        : 'Bump files found but no packages would be released — checking for unpublished packages...';
    log.info(msg);
    const recoveredBumpFiles = recoverDeletedBumpFiles(rootDir);
    const { publishCommand } = await import('./publish.ts');
    await publishCommand(rootDir, { tag: opts.tag, recoveredBumpFiles });
    return;
  }

  // detectedMode === 'version-pr' — plan is non-null with releases
  if (opts.autoPublish) {
    await autoPublish(rootDir, config, plan!, opts.tag);
  } else {
    const packageDirs = new Map([...packages.values()].map((p) => [p.name, p.relativeDir]));
    await createVersionPr(rootDir, plan!, config, packageDirs, opts.branch);
  }
}

// ---- auto-publish mode ----

/**
 * "Auto-publish" mode: skip the Version Packages PR and ship version+publish in one run.
 *
 * The only thing forfeited vs. the default flow is the preview/review gate on version
 * bumps. Credentials are NOT a differentiator — a single-job non-auto-publish workflow
 * also carries both PR-write and publish creds, just split across two runs. The real
 * credential separation comes from the split-job pattern, which is orthogonal to (and
 * incompatible with) this flag, since this collapses both paths into one execution.
 *
 * That incompatibility is also why --auto-publish and --expect-mode are mutually exclusive:
 * --expect-mode is for split-job workflows where each job runs exactly one path.
 */
async function autoPublish(rootDir: string, config: BumpyConfig, plan: ReleasePlan, tag?: string): Promise<void> {
  log.step('Running bumpy version...');
  const { versionCommand } = await import('./version.ts');
  await versionCommand(rootDir);

  // Commit the version changes
  log.step('Committing version changes...');
  runArgs(['git', 'add', '-A'], { cwd: rootDir });
  const status = tryRunArgs(['git', 'status', '--porcelain'], { cwd: rootDir });
  if (status) {
    const commitMsg = await resolveCommitMessage(config.versionCommitMessage, plan, rootDir);
    runArgs(['git', 'commit', '-F', '-'], { cwd: rootDir, input: commitMsg });
    runArgs(['git', 'push', '--no-verify'], { cwd: rootDir });
  }

  log.step('Running bumpy publish...');
  const { publishCommand } = await import('./publish.ts');
  await publishCommand(rootDir, { tag });
}

// ---- Token-aware push ----

/**
 * Push a branch to origin, optionally using a custom GitHub token.
 *
 * When `BUMPY_GH_TOKEN` is set, the remote URL is temporarily rewritten to
 * include the token.  Pushes made with a PAT or GitHub App token bypass
 * GitHub's anti-recursion guard, allowing `pull_request` workflows to fire
 * on the version PR — no extra CI configuration required.
 *
 * When only the default `GITHUB_TOKEN` is available the push still succeeds,
 * but PR workflows won't be triggered automatically.
 */
function pushWithToken(rootDir: string, branch: string, config: BumpyConfig): void {
  // Guard against misconfigured versionPr.branch pointing at the base branch
  if (branch === config.baseBranch || branch === 'main' || branch === 'master') {
    throw new Error(`Refusing to force-push to "${branch}" — this looks like a base branch, not a version PR branch`);
  }

  withGitToken(rootDir, () => {
    // --no-verify skips pre-push hooks (e.g. bumpy check) which would fail
    // on the version branch since bump files are consumed during versioning
    runArgs(['git', 'push', '-u', 'origin', branch, '--force', '--no-verify'], { cwd: rootDir });
  });

  if (process.env.BUMPY_GH_TOKEN && process.env.GITHUB_REPOSITORY) {
    log.dim('  Pushed with custom token — PR workflows will be triggered');
  } else if (!process.env.BUMPY_GH_TOKEN && process.env.GITHUB_REPOSITORY) {
    // Only warn on GitHub Actions — other CI providers don't have this limitation
    log.warn(
      'BUMPY_GH_TOKEN is not set — PR checks will not trigger automatically.\n' + '  Run `bumpy ci setup` for help.',
    );
  }
}

// ---- version-pr mode ----

async function createVersionPr(
  rootDir: string,
  plan: ReleasePlan,
  config: BumpyConfig,
  packageDirs: Map<string, string>,
  branchName?: string,
): Promise<void> {
  const branch = validateBranchName(branchName || config.versionPr.branch);
  const baseBranch = validateBranchName(
    tryRunArgs(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: rootDir }) || 'main',
  );

  // Check if a version PR already exists
  const existingPr = tryRunArgs(['gh', 'pr', 'list', '--head', branch, '--json', 'number', '--jq', '.[0].number'], {
    cwd: rootDir,
  });

  // Create or update the branch
  log.step(`Creating branch ${branch}...`);
  const branchExists = tryRunArgs(['git', 'rev-parse', '--verify', branch], { cwd: rootDir }) !== null;

  if (branchExists) {
    runArgs(['git', 'checkout', branch], { cwd: rootDir });
    runArgs(['git', 'reset', '--hard', baseBranch], { cwd: rootDir });
  } else {
    runArgs(['git', 'checkout', '-b', branch], { cwd: rootDir });
  }

  // Run bumpy version
  log.step('Running bumpy version...');
  const { versionCommand } = await import('./version.ts');
  await versionCommand(rootDir);

  // Commit and push
  runArgs(['git', 'add', '-A'], { cwd: rootDir });
  const status = tryRunArgs(['git', 'status', '--porcelain'], { cwd: rootDir });
  if (!status) {
    log.info('No version changes to commit.');
    runArgs(['git', 'checkout', baseBranch], { cwd: rootDir });
    return;
  }

  const commitMsg = await resolveCommitMessage(config.versionCommitMessage, plan, rootDir);
  runArgs(['git', 'commit', '-F', '-'], { cwd: rootDir, input: commitMsg });

  pushWithToken(rootDir, branch, config);

  // Create or update PR
  const repo = process.env.GITHUB_REPOSITORY;
  const noPatWarning = !process.env.BUMPY_GH_TOKEN && !!repo;

  if (existingPr) {
    const validPr = validatePrNumber(existingPr);
    const prBody = formatVersionPrBody(plan, config.versionPr.preamble, packageDirs, repo, validPr, noPatWarning);
    log.step(`Updating existing PR #${validPr}...`);
    await withPatToken(() =>
      runArgsAsync(['gh', 'pr', 'edit', validPr, '--title', config.versionPr.title, '--body-file', '-'], {
        cwd: rootDir,
        input: prBody,
      }),
    );
    log.success(`🐸 Updated PR #${validPr}`);
  } else {
    log.step('Creating version PR...');
    const prTitle = config.versionPr.title;
    // Create PR first without diff links, then update body with correct PR number
    const prBody = formatVersionPrBody(plan, config.versionPr.preamble, packageDirs, repo, null, noPatWarning);
    const result = await withPatToken(() =>
      runArgsAsync(
        ['gh', 'pr', 'create', '--title', prTitle, '--body-file', '-', '--base', baseBranch, '--head', branch],
        { cwd: rootDir, input: prBody },
      ),
    );
    log.success(`🐸 Created PR: ${result}`);

    // Update body now that we know the PR number
    if (repo) {
      const newPrNumber = result?.match(/\/pull\/(\d+)/)?.[1];
      if (newPrNumber) {
        const updatedBody = formatVersionPrBody(
          plan,
          config.versionPr.preamble,
          packageDirs,
          repo,
          newPrNumber,
          noPatWarning,
        );
        await withPatToken(() =>
          runArgsAsync(['gh', 'pr', 'edit', newPrNumber, '--body-file', '-'], {
            cwd: rootDir,
            input: updatedBody,
          }),
        );
      }
    }

    if (!process.env.BUMPY_GH_TOKEN) {
      // Push again with the custom token now that the PR exists, so that a
      // `pull_request: synchronize` event is generated and CI workflows trigger.
      // (The initial push happened before the PR existed, and the PR creation
      // event from GITHUB_TOKEN doesn't trigger workflows.)
      pushWithToken(rootDir, branch, config);
    }
  }

  // A promotion merge makes any open release PR on the source channel obsolete
  await closePromotedChannelReleasePrs(rootDir, config, plan.bumpFiles);

  // Switch back to the base branch
  runArgs(['git', 'checkout', baseBranch], { cwd: rootDir });
}

/**
 * Close lingering channel release PRs whose cycles were promoted: once a channel's
 * bump files are pending on this branch (via a promotion or graduation merge), the
 * source channel's own release PR is obsolete — merging it would re-publish a cycle
 * that's already moving to its next stage. A fresh release PR is created automatically
 * if new work lands on the channel branch.
 */
async function closePromotedChannelReleasePrs(
  rootDir: string,
  config: BumpyConfig,
  bumpFiles: BumpFile[],
  /** The channel whose release PR is being maintained right now (never close our own) */
  currentChannel?: ResolvedChannel,
): Promise<void> {
  const promoted = [...new Set(bumpFiles.map((bf) => bf.channel))].filter(
    (name): name is string => name != null && name !== currentChannel?.name,
  );
  if (promoted.length === 0) return;

  const channels = resolveChannels(config);
  for (const name of promoted) {
    const channel = channels.get(name);
    if (!channel) continue;
    const pr = tryRunArgs(
      ['gh', 'pr', 'list', '--head', channel.versionPr.branch, '--json', 'number', '--jq', '.[0].number'],
      { cwd: rootDir },
    );
    if (!pr) continue;
    const validPr = validatePrNumber(pr);
    log.step(`Closing release PR #${validPr} — the "${name}" cycle's changes are pending here now...`);
    try {
      await withPatToken(() =>
        runArgsAsync(
          [
            'gh',
            'pr',
            'close',
            validPr,
            '--comment',
            `Closing — the \`${name}\` cycle's bump files were promoted and are now pending a release here. ` +
              `A new release PR will be created automatically if more changes land on \`${channel.branch}\`.`,
          ],
          { cwd: rootDir },
        ),
      );
      log.success(`🐸 Closed obsolete release PR #${validPr}`);
    } catch (e) {
      log.warn(`  Failed to close release PR #${validPr}: ${e}`);
    }
  }
}

// ---- channel (prerelease) release flow ----

/** Read the push event's before/after range, if running on a GitHub Actions push event */
function getPushEventRange(): { before: string; after: string } | null {
  if (process.env.GITHUB_EVENT_NAME !== 'push') return null;
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) return null;
  try {
    const payload = JSON.parse(readFileSync(path, 'utf-8')) as { before?: string; after?: string };
    // "before" is all zeros for branch-creation pushes — no usable range
    if (payload.before && payload.after && !/^0+$/.test(payload.before)) {
      return { before: payload.before, after: payload.after };
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Bump file IDs added to `.bumpy/<channel>/` by the push that triggered this run.
 *
 * This is the channel publish trigger: merging the release PR moves files into the
 * channel dir; ordinary feature merges don't touch it. Re-running on the same push is
 * idempotent — packages already published from this commit are skipped via the
 * gitHead recorded on the registry.
 */
function detectChannelMoves(rootDir: string, channel: ResolvedChannel): string[] {
  const range = getPushEventRange();
  let diffRange: string;
  if (range) {
    diffRange = `${range.before}..${range.after}`;
  } else {
    if (!tryRunArgs(['git', 'rev-parse', '--verify', 'HEAD^'], { cwd: rootDir })) {
      log.warn(
        'Cannot diff against the previous commit (shallow clone?) — channel publish trigger unavailable.\n' +
          '  Use `fetch-depth: 0` in your checkout step, or run `bumpy publish` manually on the channel branch.',
      );
      return [];
    }
    diffRange = 'HEAD^..HEAD';
  }

  // --no-renames so file moves into the channel dir show up as additions
  const out = tryRunArgs(
    ['git', 'diff', '--name-only', '--diff-filter=A', '--no-renames', diffRange, '--', `.bumpy/${channel.name}/`],
    { cwd: rootDir },
  );
  if (!out) return [];
  return out
    .split('\n')
    .filter((f) => f.endsWith('.md') && !f.endsWith('README.md'))
    .map((f) => f.split('/').pop()!.replace(/\.md$/, ''));
}

/**
 * CI release on a channel branch. Two independent steps, both of which can run
 * in the same invocation:
 *
 * 1. **Publish** — if this push moved bump files into `.bumpy/<channel>/` (a release
 *    PR merge), publish the cycle as prereleases. Versions are derived (targets from
 *    bump files, counters from the registry) and never committed.
 * 2. **Release PR** — if pending bump files exist (root or other channels' dirs),
 *    create/update the file-move release PR.
 */
async function ciChannelRelease(
  rootDir: string,
  config: BumpyConfig,
  channel: ResolvedChannel,
  opts: ReleaseOptions,
): Promise<void> {
  log.bold(`Channel "${channel.name}" (branch "${channel.branch}")\n`);
  const { packages } = await discoverWorkspace(rootDir, config);
  const { bumpFiles, errors: parseErrors } = await readBumpFiles(rootDir, { channels: channelNames(config) });
  if (parseErrors.length > 0) {
    for (const err of parseErrors) log.error(err);
    throw new Error('Bump file parse errors must be fixed before releasing.');
  }

  const pending = bumpFiles.filter((bf) => bf.channel !== channel.name);

  if (opts.autoPublish) {
    // Skip the release PR: move pending files, commit and push directly to the
    // channel branch, then publish. (The push re-triggers CI; the re-run is a no-op
    // thanks to the published-from-HEAD skip.)
    if (pending.length > 0) {
      const { channelVersion } = await import('./version.ts');
      const result = await channelVersion(rootDir, config, channel, { commit: true });
      if (result) {
        runArgs(['git', 'push', '--no-verify'], { cwd: rootDir });
      }
    }
    const { publishCommand } = await import('./publish.ts');
    await publishCommand(rootDir, { channel: channel.name, tag: opts.tag });
    return;
  }

  // Step 1: publish if this push merged a release PR (moved files into the channel dir)
  const movedIds = detectChannelMoves(rootDir, channel);
  const shouldPublish = movedIds.length > 0 && opts.assertMode !== 'version-pr';
  if (shouldPublish) {
    log.step(`Release PR merge detected (${movedIds.map((id) => `${id}.md`).join(', ')}) — publishing prereleases...`);
    const { publishCommand } = await import('./publish.ts');
    await publishCommand(rootDir, { channel: channel.name, tag: opts.tag });
  }

  if (opts.assertMode === 'publish') {
    if (!shouldPublish) {
      throw new Error(
        'Expected mode "publish" but this push did not move bump files into the channel dir. ' +
          'Either remove --expect-mode, or gate this step on the output of "bumpy ci plan".',
      );
    }
    return;
  }

  // Step 2: create/update the release PR for pending bump files
  if (pending.length > 0) {
    await createChannelReleasePr(rootDir, config, channel, packages, opts.branch);
  } else if (!shouldPublish) {
    log.info(`Nothing to do on channel "${channel.name}" — no pending bump files, no release PR merge in this push.`);
  }
}

/**
 * Create or update the channel's release PR. Unlike the stable version PR, its diff
 * is pure file moves (pending bump files → `.bumpy/<channel>/`) — no versions, no
 * changelogs. The PR title/body show targets with a wildcard counter (`1.2.0-rc.x`),
 * derived purely from committed state; the exact counter is assigned at publish time.
 */
async function createChannelReleasePr(
  rootDir: string,
  config: BumpyConfig,
  channel: ResolvedChannel,
  packages: Map<string, import('../types.ts').WorkspacePackage>,
  branchOverride?: string,
): Promise<void> {
  const branch = validateBranchName(branchOverride || channel.versionPr.branch);
  const baseBranch = validateBranchName(channel.branch);

  // Check if a release PR already exists
  const existingPr = tryRunArgs(['gh', 'pr', 'list', '--head', branch, '--json', 'number', '--jq', '.[0].number'], {
    cwd: rootDir,
  });

  log.step(`Creating branch ${branch}...`);
  const branchExists = tryRunArgs(['git', 'rev-parse', '--verify', branch], { cwd: rootDir }) !== null;
  if (branchExists) {
    runArgs(['git', 'checkout', branch], { cwd: rootDir });
    runArgs(['git', 'reset', '--hard', baseBranch], { cwd: rootDir });
  } else {
    runArgs(['git', 'checkout', '-b', branch], { cwd: rootDir });
  }

  // Move pending bump files into the channel dir (the entire "version" step for a channel)
  const { channelVersion } = await import('./version.ts');
  const result = await channelVersion(rootDir, config, channel);
  if (!result) {
    log.info('No pending bump files to move.');
    runArgs(['git', 'checkout', baseBranch], { cwd: rootDir });
    return;
  }

  // Versions shown in the PR title/body/commit message are deterministic: targets
  // come from committed bump files; the counter is a wildcard (`-rc.x`) because the
  // real one is derived from the registry at publish time and could drift by merge.
  const displayPlan = channelDisplayPlan(result.cyclePlan, channel, packages);

  const versionSummary = formatChannelVersionSummary(displayPlan.releases);
  const prTitle = versionSummary ? `${channel.versionPr.title}: ${versionSummary}` : channel.versionPr.title;

  // Commit the moves — the version summary lives in the commit message, so
  // `git log` on the channel branch reads as a release history
  runArgs(['git', 'add', '-A', '.bumpy/'], { cwd: rootDir });
  const status = tryRunArgs(['git', 'status', '--porcelain'], { cwd: rootDir });
  if (!status) {
    log.info('No changes to commit.');
    runArgs(['git', 'checkout', baseBranch], { cwd: rootDir });
    return;
  }
  const commitMsg = `${prTitle}\n\nShipped: ${result.movedFiles.map((bf) => `${bf.id}.md`).join(', ')}`;
  runArgs(['git', 'commit', '-F', '-'], { cwd: rootDir, input: commitMsg });

  pushWithToken(rootDir, branch, config);

  const repo = process.env.GITHUB_REPOSITORY;
  const noPatWarning = !process.env.BUMPY_GH_TOKEN && !!repo;
  const packageDirs = new Map([...packages.values()].map((p) => [p.name, p.relativeDir]));
  const preamble = buildChannelPrPreamble(config, channel);

  let prNumber: string | null = null;
  if (existingPr) {
    prNumber = validatePrNumber(existingPr);
    const prBody = formatVersionPrBody(displayPlan, preamble, packageDirs, repo, prNumber, noPatWarning);
    log.step(`Updating existing PR #${prNumber}...`);
    await withPatToken(() =>
      runArgsAsync(['gh', 'pr', 'edit', prNumber!, '--title', prTitle, '--body-file', '-'], {
        cwd: rootDir,
        input: prBody,
      }),
    );
    log.success(`🐸 Updated PR #${prNumber}`);
  } else {
    log.step('Creating release PR...');
    const prBody = formatVersionPrBody(displayPlan, preamble, packageDirs, repo, null, noPatWarning);
    const createResult = await withPatToken(() =>
      runArgsAsync(
        ['gh', 'pr', 'create', '--title', prTitle, '--body-file', '-', '--base', baseBranch, '--head', branch],
        { cwd: rootDir, input: prBody },
      ),
    );
    log.success(`🐸 Created PR: ${createResult}`);

    prNumber = createResult?.match(/\/pull\/(\d+)/)?.[1] ?? null;
    if (repo && prNumber) {
      const updatedBody = formatVersionPrBody(displayPlan, preamble, packageDirs, repo, prNumber, noPatWarning);
      await withPatToken(() =>
        runArgsAsync(['gh', 'pr', 'edit', prNumber!, '--body-file', '-'], {
          cwd: rootDir,
          input: updatedBody,
        }),
      );
    }

    if (!process.env.BUMPY_GH_TOKEN) {
      // Push again with the custom token now that the PR exists (see createVersionPr)
      pushWithToken(rootDir, branch, config);
    }
  }

  if (channel.versionPr.automerge && prNumber) {
    await enableAutoMerge(rootDir, prNumber);
  }

  // A graduation merge (e.g. alpha → beta) makes any open release PR on the
  // source channel obsolete
  await closePromotedChannelReleasePrs(rootDir, config, result.movedFiles, channel);

  // Switch back to the channel branch
  runArgs(['git', 'checkout', baseBranch], { cwd: rootDir });
}

function buildChannelPrPreamble(config: BumpyConfig, channel: ResolvedChannel): string {
  return [
    config.versionPr.preamble,
    '',
    `> 🔀 **Prerelease channel \`${channel.name}\`** — merging this PR publishes the versions below to the \`@${channel.tag}\` dist-tag.`,
    `> The diff only moves bump files into \`.bumpy/${channel.name}/\` — prerelease versions are derived at publish time and never committed. The \`.x\` counter is assigned from the registry at publish time.`,
  ].join('\n');
}

/** Enable GitHub auto-merge on a PR, trying the available merge methods in order */
async function enableAutoMerge(rootDir: string, prNumber: string): Promise<void> {
  const validPr = validatePrNumber(prNumber);
  for (const method of ['--squash', '--merge', '--rebase']) {
    try {
      await withPatToken(() => runArgsAsync(['gh', 'pr', 'merge', validPr, '--auto', method], { cwd: rootDir }));
      log.dim(`  Auto-merge enabled (${method.slice(2)})`);
      return;
    } catch {
      // method not allowed on this repo — try the next one
    }
  }
  log.warn('  Failed to enable auto-merge — check repository merge settings and token permissions.');
}

/** Channel-aware `ci plan`: reports what `ci release` would do on this channel branch */
async function ciChannelPlan(
  rootDir: string,
  config: BumpyConfig,
  channel: ResolvedChannel,
  packages: Map<string, import('../types.ts').WorkspacePackage>,
  depGraph: DependencyGraph,
  bumpFiles: BumpFile[],
): Promise<void> {
  const pending = bumpFiles.filter((bf) => bf.channel !== channel.name);
  const movedIds = detectChannelMoves(rootDir, channel);

  let mode: CiPlanMode = 'nothing';
  let releases: PlannedRelease[] = [];
  if (pending.length > 0 || movedIds.length > 0) {
    mode = pending.length > 0 ? 'version-pr' : 'publish';
    const stablePlan = assembleReleasePlan(bumpFiles, packages, depGraph, config, {
      prereleasePreid: channel.preid,
    });
    try {
      const built = await buildChannelReleasePlan(stablePlan, channel, packages, rootDir, { forDisplay: true });
      releases = built.plan.releases;
    } catch {
      releases = stablePlan.releases.map((r) => ({ ...r, newVersion: `${r.newVersion}-${channel.preid}.?` }));
    }
  }

  const output = {
    mode,
    channel: channel.name,
    bumpFiles: bumpFiles.map((bf) => ({
      id: bf.id,
      summary: bf.summary,
      releases: bf.releases.map((r) => ({ name: r.name, type: r.type })),
      shipped: bf.channel === channel.name,
    })),
    releases: releases.map((r) => formatPlanRelease(r, packages, config)),
    packageNames: releases.map((r) => r.name),
  };

  const json = JSON.stringify(output, null, 2);
  console.log(json);
  writeGitHubOutput('mode', output.mode);
  writeGitHubOutput('channel', channel.name);
  writeGitHubOutput('packages', JSON.stringify(output.packageNames));
  writeGitHubOutput('json', JSON.stringify(output));
}

// ---- PR comment helpers ----

const FROG_IMG_BASE = 'https://raw.githubusercontent.com/dmno-dev/bumpy/main/images';

function buildAddBumpFileLink(prBranch: string | null): string | null {
  if (!prBranch) return null;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) return null;

  const template = ['---', '"package-name": patch', '---', '', 'Description of the change', ''].join('\n');
  const filename = `.bumpy/${randomName()}.md`;
  return `https://github.com/${repo}/new/${prBranch}?filename=${encodeURIComponent(filename)}&value=${encodeURIComponent(template)}`;
}

function pmRunCommand(pm: PackageManager): string {
  if (pm === 'bun') return 'bunx bumpy';
  if (pm === 'pnpm') return 'pnpm exec bumpy';
  if (pm === 'yarn') return 'yarn bumpy';
  return 'npx bumpy';
}

export function formatReleasePlanComment(
  plan: ReleasePlan,
  bumpFiles: BumpFile[],
  prNumber: string,
  prBranch: string | null,
  pm: PackageManager,
  warnings: string[] = [],
  parseErrors: string[] = [],
  emptyBumpFileIds: string[] = [],
  channel: ResolvedChannel | null = null,
  allChannels: Map<string, ResolvedChannel> | null = null,
): string {
  const repo = process.env.GITHUB_REPOSITORY;
  const lines: string[] = [];

  // When targeting a prerelease channel, the version display carries a wildcard
  // `-<preid>.x` suffix (the exact counter is derived from the registry at publish time).
  const versionSuffix = channel ? `-${channel.preid}.x` : '';

  // Promotion PR: stable-targeted, carrying bump files that already shipped on a
  // channel (e.g. `next` → `main`). Merging it ends the cycle and ships stable.
  const promotedChannels = channel ? [] : [...new Set(bumpFiles.map((bf) => bf.channel))].filter((c) => c != null);
  const channelTag = (name: string) => `\`@${allChannels?.get(name)?.tag ?? name}\``;

  const headline = channel
    ? `**This PR targets the \`${channel.name}\` prerelease channel** — merging it ships these packages as a **prerelease** to the \`@${channel.tag}\` dist-tag, not a stable release.`
    : promotedChannels.length > 0
      ? `**This PR promotes the ${promotedChannels.map((c) => `\`${c}\``).join(', ')} prerelease cycle${promotedChannels.length > 1 ? 's' : ''} to a stable release.** ` +
        `The changes below that already shipped to the ${promotedChannels.map(channelTag).join(', ')} dist-tag${promotedChannels.length > 1 ? 's' : ''} will be consolidated into the next stable version bump.`
      : '**The changes in this PR will be included in the next version bump.**';
  const preamble = [
    `<a href="https://bumpy.varlock.dev"><img src="${FROG_IMG_BASE}/frog-clipboard.png" alt="bumpy-frog" width="60" align="left" style="image-rendering: pixelated;" title="Hi! I'm bumpy!" /></a>`,
    '',
    headline,
    '<br clear="left" />',
  ].join('\n');
  lines.push(preamble);
  lines.push('');

  // Package list grouped by bump type
  const groups: Record<string, PlannedRelease[]> = { major: [], minor: [], patch: [] };
  for (const r of plan.releases) {
    groups[r.type]?.push(r);
  }

  for (const type of ['major', 'minor', 'patch'] as const) {
    const releases = groups[type];
    if (!releases || releases.length === 0) continue;

    lines.push(bumpSectionHeader(type));
    lines.push('');
    for (const r of releases) {
      const suffix = r.isDependencyBump ? ' _(dep)_' : r.isCascadeBump ? ' _(cascade)_' : '';
      lines.push(`- \`${r.name}\` ${r.oldVersion} → **${r.newVersion}${versionSuffix}**${suffix}`);
    }
    lines.push('');
  }

  if (channel) {
    const examplePkg =
      plan.releases.find((r) => !r.isDependencyBump && !r.isCascadeBump)?.name ?? plan.releases[0]?.name;
    const installHint = examplePkg ? ` (e.g. \`npm i ${examplePkg}@${channel.tag}\`)` : '';
    lines.push(
      `> 🔀 Published to the \`@${channel.tag}\` dist-tag${installHint}. ` +
        `Prerelease versions are derived at publish time — the \`.x\` counter is filled in from the registry. ` +
        `Promote to a stable release by merging \`${channel.branch}\` into your base branch.`,
    );
    lines.push('');
  }

  // Bump file list with links
  lines.push(`#### Bump files in this PR`);
  lines.push('');
  for (const bf of bumpFiles) {
    // Channel-dir files (pending on promotion/graduation PRs) live at `.bumpy/<channel>/`
    const filename = bf.channel ? `${bf.channel}/${bf.id}.md` : `${bf.id}.md`;
    const parts: string[] = [`\`${filename}\``];
    if (bf.channel) parts.push(`_(shipped on ${channelTag(bf.channel)})_`);
    if (repo) {
      parts.push(
        `([view diff](https://github.com/${repo}/pull/${prNumber}/changes#diff-${sha256Hex(`.bumpy/${filename}`)}))`,
      );
      if (prBranch) {
        parts.push(`([edit](https://github.com/${repo}/edit/${prBranch}/.bumpy/${filename}))`);
      }
    }
    lines.push(`- ${parts.join(' ')}`);
  }
  for (const id of emptyBumpFileIds) {
    const filename = `${id}.md`;
    const parts: string[] = [`\`${filename}\` _(empty — no release)_`];
    if (repo) {
      parts.push(
        `([view diff](https://github.com/${repo}/pull/${prNumber}/changes#diff-${sha256Hex(`.bumpy/${filename}`)}))`,
      );
      if (prBranch) {
        parts.push(`([edit](https://github.com/${repo}/edit/${prBranch}/.bumpy/${filename}))`);
      }
    }
    lines.push(`- ${parts.join(' ')}`);
  }
  lines.push('');

  if (parseErrors.length > 0) {
    lines.push('#### Errors');
    lines.push('');
    for (const e of parseErrors) {
      lines.push(`> :x: ${e}`);
    }
    lines.push('');
  }

  if (warnings.length > 0) {
    lines.push('#### Warnings');
    lines.push('');
    for (const w of warnings) {
      lines.push(`> ⚠️ ${w}`);
    }
    lines.push('');
  }

  const addLink = buildAddBumpFileLink(prBranch);
  if (addLink) {
    lines.push(`[Click here if you want to add another bump file to this PR](${addLink})\n`);
  } else {
    lines.push(`To add another bump file, run \`${pmRunCommand(pm)} add\`\n`);
  }

  lines.push('---');
  lines.push(`_This comment is maintained by [bumpy](https://bumpy.varlock.dev)._`);
  return lines.join('\n');
}

function formatBumpFileErrorsComment(errors: string[], prBranch: string | null, pm: PackageManager): string {
  const runCmd = pmRunCommand(pm);
  const lines = [
    `<a href="https://bumpy.varlock.dev"><img src="${FROG_IMG_BASE}/frog-error.png" alt="bumpy-frog" width="60" align="left" style="image-rendering: pixelated;" title="Hi! I'm bumpy!" /></a>`,
    '',
    '**This PR has bump file(s) with errors that need to be fixed.**',
    '<br clear="left" />\n',
    '#### Errors',
    '',
    ...errors.map((e) => `> :x: ${e}`),
    '',
    'Please fix the errors above or recreate the bump file:\n',
    '```bash',
    `${runCmd} add`,
    '```',
  ];

  const addLink = buildAddBumpFileLink(prBranch);
  if (addLink) {
    lines.push('');
    lines.push(`Or [click here to add a bump file](${addLink}) directly on GitHub.`);
  }

  lines.push('\n---');
  lines.push(`_This comment is maintained by [bumpy](https://bumpy.varlock.dev)._`);
  return lines.join('\n');
}

function formatEmptyBumpFileComment(emptyBumpFileIds: string[], prNumber: string, prBranch: string | null): string {
  const repo = process.env.GITHUB_REPOSITORY;
  const lines = [
    `<a href="https://bumpy.varlock.dev"><img src="${FROG_IMG_BASE}/frog-neutral.png" alt="bumpy-frog" width="60" align="left" style="image-rendering: pixelated;" title="Hi! I'm bumpy!" /></a>`,
    '',
    '**This PR includes an empty bump file — no version bump is needed.** :white_check_mark:',
    '<br clear="left" />',
    '',
  ];

  for (const id of emptyBumpFileIds) {
    const filename = `${id}.md`;
    const parts: string[] = [`\`${filename}\``];
    if (repo) {
      parts.push(
        `([view diff](https://github.com/${repo}/pull/${prNumber}/changes#diff-${sha256Hex(`.bumpy/${filename}`)}))`,
      );
      if (prBranch) {
        parts.push(`([edit](https://github.com/${repo}/edit/${prBranch}/.bumpy/${filename}))`);
      }
    }
    lines.push(`- ${parts.join(' ')}`);
  }

  lines.push('\n---');
  lines.push(`_This comment is maintained by [bumpy](https://bumpy.varlock.dev)._`);
  return lines.join('\n');
}

function formatNoBumpFilesComment(prBranch: string | null, pm: PackageManager): string {
  const runCmd = pmRunCommand(pm);
  const lines = [
    `<a href="https://bumpy.varlock.dev"><img src="${FROG_IMG_BASE}/frog-warning.png" alt="bumpy-frog" width="60" align="left" style="image-rendering: pixelated;" title="Hi! I'm bumpy!" /></a>`,
    '',
    "Merging this PR will not cause a version bump for any packages. If these changes should not result in a new version, you're good to go. **If these changes should result in a version bump, you need to add a bump file.**",
    '<br clear="left" />\n',
    'You can add a bump file by running:\n',
    '```bash',
    `${runCmd} add`,
    '```',
  ];

  const addLink = buildAddBumpFileLink(prBranch);
  if (addLink) {
    lines.push('');
    lines.push(`Or [click here to add a bump file](${addLink}) directly on GitHub.`);
  }

  lines.push('\n---');
  lines.push(`_This comment is maintained by [bumpy](https://bumpy.varlock.dev)._`);
  return lines.join('\n');
}

function bumpSectionHeader(type: string): string {
  // I think pixelated css gets stripped but may as well leave it
  // wrapping in <a> prevents Gmail dark mode from inverting the image
  const label = `${type.charAt(0).toUpperCase() + type.slice(1)} releases`;
  const frog = `<a href="https://bumpy.varlock.dev" title="${label}"><img src="${FROG_IMG_BASE}/frog-${type}.png" alt="${type}" width="52" style="image-rendering: pixelated;" align="right" /></a>`;
  return `### ${frog} ${label}`;
}

/** Build inline diff links for a package's changed files in the PR */
function buildDiffLinks(pkgDir: string, changesBaseUrl: string | null): string {
  if (!changesBaseUrl) return '';
  const changelogPath = `${pkgDir}/CHANGELOG.md`;
  // GitHub anchors diff sections with #diff-<sha256 of file path>
  return ` <sub>[CHANGELOG.md](${changesBaseUrl}#diff-${sha256Hex(changelogPath)})</sub>`;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function formatVersionPrBody(
  plan: ReleasePlan,
  preamble: string,
  packageDirs: Map<string, string>,
  repo: string | undefined,
  prNumber: string | null,
  showNoPatWarning = false,
): string {
  const changesBaseUrl = repo && prNumber ? `https://github.com/${repo}/pull/${prNumber}/changes` : null;
  const lines: string[] = [];
  lines.push(preamble);
  lines.push('');

  const groups: Record<string, PlannedRelease[]> = { major: [], minor: [], patch: [] };
  for (const r of plan.releases) {
    groups[r.type]?.push(r);
  }

  for (const type of ['major', 'minor', 'patch'] as const) {
    const releases = groups[type];
    if (!releases || releases.length === 0) continue;

    lines.push(bumpSectionHeader(type));
    lines.push('');
    for (const r of releases) {
      const suffix = r.isDependencyBump ? ' _(dep)_' : r.isCascadeBump ? ' _(cascade)_' : '';
      const pkgDir = packageDirs.get(r.name);
      const diffLinks = pkgDir ? buildDiffLinks(pkgDir, changesBaseUrl) : '';
      lines.push(`#### \`${r.name}\` ${r.oldVersion} → **${r.newVersion}**${suffix}${diffLinks}`);
      lines.push('');

      const relevantBumpFiles = plan.bumpFiles.filter((bf) => r.bumpFiles.includes(bf.id));

      if (relevantBumpFiles.length > 0) {
        for (const bf of relevantBumpFiles) {
          if (bf.summary) {
            const bfLink = changesBaseUrl
              ? ` ([bump file](${changesBaseUrl}#diff-${sha256Hex(`.bumpy/${bf.id}.md`)}))`
              : '';
            const summaryLines = bf.summary.split('\n');
            lines.push(`- ${summaryLines[0]}${bfLink}`);
            for (let i = 1; i < summaryLines.length; i++) {
              if (summaryLines[i]!.trim()) {
                lines.push(`  ${summaryLines[i]}`);
              }
            }
          }
        }
      } else if (r.isDependencyBump) {
        lines.push('- Updated dependencies');
      } else if (r.isCascadeBump) {
        lines.push('- Version bump via cascade rule');
      }

      lines.push('');
    }
  }

  if (showNoPatWarning) {
    lines.push(
      '> ⚠️ `BUMPY_GH_TOKEN` is not set — CI checks will not run automatically on this PR. Run `bumpy ci setup` for help.',
    );
    lines.push('');
  }

  return lines.join('\n');
}

const COMMENT_MARKER = '<!-- bumpy-release-plan -->';

async function postOrUpdatePrComment(prNumber: string, body: string, rootDir: string): Promise<void> {
  const validPr = validatePrNumber(prNumber);
  const markedBody = `${COMMENT_MARKER}\n${body}`;

  try {
    // Find existing bumpy comment using gh with jq
    const jqFilter = `.comments[] | select(.body | startswith("${COMMENT_MARKER}")) | .url | capture("issuecomment-(?<id>[0-9]+)$") | .id`;
    const existingComment = tryRunArgs(['gh', 'pr', 'view', validPr, '--json', 'comments', '--jq', jqFilter], {
      cwd: rootDir,
    });

    // Take the first result if multiple
    const commentId = existingComment?.split('\n')[0]?.trim();

    if (commentId) {
      await runArgsAsync(
        ['gh', 'api', `repos/{owner}/{repo}/issues/comments/${commentId}`, '-X', 'PATCH', '-F', 'body=@-'],
        { cwd: rootDir, input: markedBody },
      );
      log.dim('  Updated PR comment');
    } else {
      await runArgsAsync(['gh', 'pr', 'comment', validPr, '--body-file', '-'], {
        cwd: rootDir,
        input: markedBody,
      });
      log.dim('  Posted PR comment');
    }
  } catch (err) {
    log.warn(`  Failed to comment on PR: ${err instanceof Error ? err.message : err}`);
    // Most common cause: the workflow is on `pull_request` and this is a fork PR,
    // so GITHUB_TOKEN is read-only. Surface that explicitly — otherwise contributors
    // see a red check with no comment and no clue why.
    if (process.env.GITHUB_EVENT_NAME === 'pull_request' && isForkPr()) {
      log.warn(
        '  This PR is from a fork. Fork PRs running on `pull_request` get a read-only token\n' +
          '  and cannot post comments. Switch the workflow to `pull_request_target` —\n' +
          '  see https://bumpy.varlock.dev/docs/github-actions',
      );
    }
  }
}

function detectPrBranch(rootDir: string): string | null {
  // GitHub Actions sets GITHUB_HEAD_REF for pull_request events
  if (process.env.GITHUB_HEAD_REF) return process.env.GITHUB_HEAD_REF;
  // Fallback: ask gh for the PR head branch
  const branch = tryRunArgs(['gh', 'pr', 'view', '--json', 'headRefName', '--jq', '.headRefName'], { cwd: rootDir });
  return branch?.trim() || null;
}

function detectPrNumber(): string | null {
  // GitHub Actions: read PR number from the event payload — same shape for
  // both `pull_request` and `pull_request_target` (under `pull_request_target`,
  // GITHUB_REF points at the base branch, not refs/pull/N/merge).
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    const event = readGitHubEventPayload();
    const num = event?.pull_request?.number;
    if (typeof num === 'number') return String(num);
    // Fallback for `pull_request`: parse GITHUB_REF if payload wasn't readable.
    if (eventName === 'pull_request') {
      const match = process.env.GITHUB_REF?.match(/refs\/pull\/(\d+)\//);
      if (match) return match[1]!;
    }
  }
  // Also check for explicit env var — validate it's numeric
  const envPr = process.env.BUMPY_PR_NUMBER || process.env.PR_NUMBER || null;
  if (envPr && !/^\d+$/.test(envPr)) {
    log.warn(`Ignoring invalid PR number from environment: ${envPr}`);
    return null;
  }
  return envPr;
}

interface GitHubEventPayload {
  pull_request?: {
    number?: number;
    head?: { repo?: { id?: number } };
    base?: { repo?: { id?: number } };
  };
}

function readGitHubEventPayload(): GitHubEventPayload | null {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as GitHubEventPayload;
  } catch {
    return null;
  }
}

/** True when running on a PR whose head repo differs from the base repo (i.e. a fork). */
function isForkPr(): boolean {
  const event = readGitHubEventPayload();
  const headId = event?.pull_request?.head?.repo?.id;
  const baseId = event?.pull_request?.base?.repo?.id;
  return typeof headId === 'number' && typeof baseId === 'number' && headId !== baseId;
}
