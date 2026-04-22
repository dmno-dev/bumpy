import { log, colorize } from '../utils/logger.ts';
import { loadConfig } from '../core/config.ts';
import { findChangedPackages } from './check.ts';
import { discoverWorkspace } from '../core/workspace.ts';
import { DependencyGraph } from '../core/dep-graph.ts';
import { readBumpFiles, filterBranchBumpFiles } from '../core/bump-file.ts';
import { getChangedFiles } from '../core/git.ts';
import { assembleReleasePlan } from '../core/release-plan.ts';
import { runArgs, runArgsAsync, tryRunArgs } from '../utils/shell.ts';
import { randomName } from '../utils/names.ts';
import { detectPackageManager } from '../utils/package-manager.ts';
import { createHash } from 'node:crypto';
import { resolveCommitMessage } from '../core/commit-message.ts';
import type { BumpyConfig, BumpFile, PackageManager, ReleasePlan, PlannedRelease } from '../types.ts';

// ---- PAT-scoped gh helpers ----

/**
 * Temporarily override GH_TOKEN with BUMPY_GH_TOKEN for a gh CLI call.
 *
 * Use `--pat-pr` / `--pat-comments` flags to opt in. This is useful when
 * BUMPY_GH_TOKEN belongs to a dedicated automation/bot account. If you're
 * using a developer's personal PAT, it's better to leave these flags off so
 * that PRs and comments appear from github-actions[bot] — allowing the
 * developer to still review and approve the PR.
 */
function requirePatToken(): string {
  const token = process.env.BUMPY_GH_TOKEN;
  if (!token) {
    throw new Error('BUMPY_GH_TOKEN must be set when using --pat-pr or --pat-comments');
  }
  return token;
}

async function withPatToken<T>(usePat: boolean, fn: () => Promise<T>): Promise<T> {
  if (!usePat) return fn();
  const token = requirePatToken();
  const originalGhToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = token;
  try {
    return await fn();
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
  patComments?: boolean; // post PR comments using BUMPY_GH_TOKEN
}

/**
 * CI check: report on pending bump files.
 * Designed for PR workflows — shows what would be released and optionally comments on the PR.
 */
export async function ciCheckCommand(rootDir: string, opts: CheckOptions): Promise<void> {
  const config = await loadConfig(rootDir);
  const { packages } = await discoverWorkspace(rootDir, config);
  const depGraph = new DependencyGraph(packages);
  const { bumpFiles: allBumpFiles, errors: parseErrors } = await readBumpFiles(rootDir);

  // Skip on the version PR branch — it has no bump files by design
  const prBranchName = detectPrBranch(rootDir);
  if (prBranchName === config.versionPr.branch) {
    log.dim('  Skipping — this is the version PR branch.');
    return;
  }

  const inCI = !!process.env.CI;
  const shouldComment = opts.comment ?? inCI;
  const prNumber = detectPrNumber();
  const pm = await detectPackageManager(rootDir);

  // Filter to only bump files added/modified in this PR
  const changedFiles = getChangedFiles(rootDir, config.baseBranch);
  const { branchBumpFiles: prBumpFiles, hasEmptyBumpFile } = filterBranchBumpFiles(
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
    if (hasEmptyBumpFile && parseErrors.length === 0) {
      log.success('Empty bump file found — no releases needed.');
      if (shouldComment && prNumber) {
        await postOrUpdatePrComment(prNumber, formatEmptyBumpFileComment(), rootDir, opts.patComments);
      }
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
        opts.patComments,
      );
    }

    if (willFail) process.exit(1);
    return;
  }

  const plan = assembleReleasePlan(prBumpFiles, packages, depGraph, config);

  // Pretty output for logs
  log.bold(`${prBumpFiles.length} bump file(s) → ${plan.releases.length} package(s) to release\n`);
  for (const r of plan.releases) {
    const tag = r.isDependencyBump ? ' (dep)' : r.isCascadeBump ? ' (cascade)' : '';
    console.log(`  ${r.name}: ${r.oldVersion} → ${colorize(r.newVersion, 'cyan')}${tag}`);
  }
  if (plan.warnings.length > 0) {
    for (const w of plan.warnings) {
      log.warn(w);
    }
  }

  // Comment on PR
  if (shouldComment && prNumber) {
    const prBranch = detectPrBranch(rootDir);
    const comment = formatReleasePlanComment(plan, prBumpFiles, prNumber, prBranch, pm, plan.warnings, parseErrors);
    await postOrUpdatePrComment(prNumber, comment, rootDir, opts.patComments);
  }

  // Fail if there were parse errors (even if some files parsed successfully)
  if (parseErrors.length > 0 && !opts.noFail) {
    process.exit(1);
  }

  // Check for uncovered packages
  const coveredPackages = new Set(plan.releases.map((r) => r.name));
  const changedPackages = await findChangedPackages(changedFiles, packages, rootDir, config);
  const missing = changedPackages.filter((name) => !coveredPackages.has(name));
  if (missing.length > 0) {
    const willFail = opts.strict && !opts.noFail;
    const logFn = willFail ? log.error : log.warn;
    logFn(`${missing.length} changed package(s) not covered by bump files: ${missing.join(', ')}`);
    if (willFail) process.exit(1);
  }
}

// ---- ci release ----

interface ReleaseOptions {
  mode: 'auto-publish' | 'version-pr';
  tag?: string; // npm dist-tag for auto-publish
  branch?: string; // branch name for version PR (default: "bumpy/version-packages")
  patPr?: boolean; // create/edit PR using BUMPY_GH_TOKEN
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
  const { bumpFiles, errors: releaseParseErrors } = await readBumpFiles(rootDir);

  if (releaseParseErrors.length > 0) {
    for (const err of releaseParseErrors) {
      log.error(err);
    }
    throw new Error('Bump file parse errors must be fixed before releasing.');
  }

  if (bumpFiles.length === 0) {
    // No bump files — check if there are unpublished packages to publish
    // (this handles the case where a version PR was just merged)
    log.info('No pending bump files — checking for unpublished packages...');
    const { publishCommand } = await import('./publish.ts');
    await publishCommand(rootDir, { tag: opts.tag });
    return;
  }

  const plan = assembleReleasePlan(bumpFiles, packages, depGraph, config);
  if (plan.releases.length === 0) {
    log.info('Bump files found but no packages would be released.');
    return;
  }

  if (opts.mode === 'auto-publish') {
    await autoPublish(rootDir, config, plan, opts.tag);
  } else {
    const packageDirs = new Map([...packages.values()].map((p) => [p.name, p.relativeDir]));
    await createVersionPr(rootDir, plan, config, packageDirs, opts.branch, opts.patPr);
  }
}

// ---- auto-publish mode ----

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

  const token = process.env.BUMPY_GH_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY; // e.g. "owner/repo"
  const server = process.env.GITHUB_SERVER_URL || 'https://github.com';

  if (token && repo) {
    const authedUrl = `${server.replace('://', `://x-access-token:${token}@`)}/${repo}.git`;
    const originalUrl = tryRunArgs(['git', 'remote', 'get-url', 'origin'], { cwd: rootDir });

    // `actions/checkout@v6` persists the default GITHUB_TOKEN in two ways:
    //   1. Direct http.<server>/.extraheader config
    //   2. includeIf.gitdir entries pointing to credential config files
    //      that also sets http.<server>/.extraheader
    // Both must be cleared for our custom token to be used.
    const extraHeaderKey = `http.${server}/.extraheader`;
    const savedHeader = tryRunArgs(['git', 'config', '--local', extraHeaderKey], { cwd: rootDir });

    // Collect includeIf entries that point to credential config files
    // git config --get-regexp outputs keys in lowercase
    const includeIfRaw = tryRunArgs(['git', 'config', '--local', '--get-regexp', '^includeif\\.gitdir:'], {
      cwd: rootDir,
    });
    const savedIncludeIfs: Array<{ key: string; value: string }> = [];
    if (includeIfRaw) {
      for (const line of includeIfRaw.split('\n').filter(Boolean)) {
        const spaceIdx = line.indexOf(' ');
        if (spaceIdx > 0) {
          savedIncludeIfs.push({ key: line.slice(0, spaceIdx), value: line.slice(spaceIdx + 1) });
        }
      }
    }

    try {
      if (savedHeader) {
        runArgs(['git', 'config', '--local', '--unset-all', extraHeaderKey], { cwd: rootDir });
      }
      for (const entry of savedIncludeIfs) {
        tryRunArgs(['git', 'config', '--local', '--unset', entry.key], { cwd: rootDir });
      }
      runArgs(['git', 'remote', 'set-url', 'origin', authedUrl], { cwd: rootDir });
      try {
        // --no-verify skips pre-push hooks (e.g. bumpy check) which would fail
        // on the version branch since bump files are consumed during versioning
        runArgs(['git', 'push', '-u', 'origin', branch, '--force', '--no-verify'], { cwd: rootDir });
      } catch (err) {
        // Redact token from error messages to prevent leakage in CI logs
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(msg.replaceAll(token, '***'));
      }
    } finally {
      // Restore original URL, extraheader, and includeIf entries
      if (originalUrl) {
        runArgs(['git', 'remote', 'set-url', 'origin', originalUrl], { cwd: rootDir });
      }
      if (savedHeader) {
        runArgs(['git', 'config', '--local', extraHeaderKey, savedHeader], { cwd: rootDir });
      }
      for (const entry of savedIncludeIfs) {
        tryRunArgs(['git', 'config', '--local', entry.key, entry.value], { cwd: rootDir });
      }
    }
    log.dim('  Pushed with custom token — PR workflows will be triggered');
  } else {
    runArgs(['git', 'push', '-u', 'origin', branch, '--force', '--no-verify'], { cwd: rootDir });
    if (!token && repo) {
      // Only warn on GitHub Actions — other CI providers don't have this limitation
      log.warn(
        'BUMPY_GH_TOKEN is not set — PR checks will not trigger automatically.\n' + '  Run `bumpy ci setup` for help.',
      );
    }
  }
}

// ---- version-pr mode ----

async function createVersionPr(
  rootDir: string,
  plan: ReleasePlan,
  config: BumpyConfig,
  packageDirs: Map<string, string>,
  branchName?: string,
  patPr?: boolean,
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
  const prBody = formatVersionPrBody(plan, config.versionPr.preamble, packageDirs);

  if (existingPr) {
    const validPr = validatePrNumber(existingPr);
    log.step(`Updating existing PR #${validPr}...`);
    await withPatToken(!!patPr, () =>
      runArgsAsync(['gh', 'pr', 'edit', validPr, '--title', config.versionPr.title, '--body-file', '-'], {
        cwd: rootDir,
        input: prBody,
      }),
    );
    log.success(`🐸 Updated PR #${validPr}`);
  } else {
    log.step('Creating version PR...');
    const prTitle = config.versionPr.title;
    const result = await withPatToken(!!patPr, () =>
      runArgsAsync(
        ['gh', 'pr', 'create', '--title', prTitle, '--body-file', '-', '--base', baseBranch, '--head', branch],
        { cwd: rootDir, input: prBody },
      ),
    );
    log.success(`🐸 Created PR: ${result}`);
    if (!patPr) {
      // Push again with the custom token now that the PR exists, so that a
      // `pull_request: synchronize` event is generated and CI workflows trigger.
      // (The initial push happened before the PR existed, and the PR creation
      // event from GITHUB_TOKEN doesn't trigger workflows.)
      pushWithToken(rootDir, branch, config);
    }
  }

  // Switch back to the base branch
  runArgs(['git', 'checkout', baseBranch], { cwd: rootDir });
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

function formatReleasePlanComment(
  plan: ReleasePlan,
  bumpFiles: BumpFile[],
  prNumber: string,
  prBranch: string | null,
  pm: PackageManager,
  warnings: string[] = [],
  parseErrors: string[] = [],
): string {
  const repo = process.env.GITHUB_REPOSITORY;
  const lines: string[] = [];

  const preamble = [
    `<a href="https://bumpy.varlock.dev"><img src="${FROG_IMG_BASE}/frog-talking.png" alt="bumpy-frog" width="60" align="left" style="image-rendering: pixelated;" title="Hi! I'm bumpy!" /></a>`,
    '',
    '**The changes in this PR will be included in the next version bump.**',
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
      lines.push(`- \`${r.name}\` ${r.oldVersion} → **${r.newVersion}**${suffix}`);
    }
    lines.push('');
  }

  // Bump file list with links
  lines.push(`#### Bump files in this PR`);
  lines.push('');
  for (const bf of bumpFiles) {
    const filename = `${bf.id}.md`;
    const parts: string[] = [`\`${filename}\``];
    if (repo) {
      parts.push(`([view diff](https://github.com/${repo}/pull/${prNumber}/files#diff-.bumpy/${filename}))`);
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
    `<a href="https://bumpy.varlock.dev"><img src="${FROG_IMG_BASE}/frog-neutral.png" alt="bumpy-frog" width="60" align="left" style="image-rendering: pixelated;" title="Hi! I'm bumpy!" /></a>`,
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

function formatEmptyBumpFileComment(): string {
  const lines = [
    `<a href="https://bumpy.varlock.dev"><img src="${FROG_IMG_BASE}/frog-neutral.png" alt="bumpy-frog" width="60" align="left" style="image-rendering: pixelated;" title="Hi! I'm bumpy!" /></a>`,
    '',
    '**This PR includes an empty bump file — no version bump is needed.** :white_check_mark:',
    '<br clear="left" />',
    '\n---',
    `_This comment is maintained by [bumpy](https://bumpy.varlock.dev)._`,
  ];
  return lines.join('\n');
}

function formatNoBumpFilesComment(prBranch: string | null, pm: PackageManager): string {
  const runCmd = pmRunCommand(pm);
  const lines = [
    `<a href="https://bumpy.varlock.dev"><img src="${FROG_IMG_BASE}/frog-neutral.png" alt="bumpy-frog" width="60" align="left" style="image-rendering: pixelated;" title="Hi! I'm bumpy!" /></a>`,
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
function buildDiffLinks(pkgDir: string): string {
  const pkgJsonPath = `${pkgDir}/package.json`;
  const changelogPath = `${pkgDir}/CHANGELOG.md`;
  // GitHub anchors diff sections with #diff-<sha256 of file path>
  const links = [
    `[package.json](#diff-${sha256Hex(pkgJsonPath)})`,
    `[CHANGELOG.md](#diff-${sha256Hex(changelogPath)})`,
  ];
  return ` <sub>${links.join(' · ')}</sub>`;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function formatVersionPrBody(plan: ReleasePlan, preamble: string, packageDirs: Map<string, string>): string {
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
      const diffLinks = pkgDir ? buildDiffLinks(pkgDir) : '';
      lines.push(`#### \`${r.name}\` ${r.oldVersion} → **${r.newVersion}**${suffix}${diffLinks}`);
      lines.push('');

      const relevantBumpFiles = plan.bumpFiles.filter((bf) => r.bumpFiles.includes(bf.id));

      if (relevantBumpFiles.length > 0) {
        for (const bf of relevantBumpFiles) {
          if (bf.summary) {
            const bfLink = ` ([bump file](#diff-${sha256Hex(`.bumpy/${bf.id}.md`)}))`;
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

  return lines.join('\n');
}

const COMMENT_MARKER = '<!-- bumpy-release-plan -->';

async function postOrUpdatePrComment(prNumber: string, body: string, rootDir: string, usePat = false): Promise<void> {
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
      await withPatToken(usePat, () =>
        runArgsAsync(
          ['gh', 'api', `repos/{owner}/{repo}/issues/comments/${commentId}`, '-X', 'PATCH', '-F', 'body=@-'],
          { cwd: rootDir, input: markedBody },
        ),
      );
      log.dim('  Updated PR comment');
    } else {
      await withPatToken(usePat, () =>
        runArgsAsync(['gh', 'pr', 'comment', validPr, '--body-file', '-'], { cwd: rootDir, input: markedBody }),
      );
      log.dim('  Posted PR comment');
    }
  } catch (err) {
    log.warn(`  Failed to comment on PR: ${err instanceof Error ? err.message : err}`);
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
  // GitHub Actions
  if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
    // PR number is in GITHUB_REF: refs/pull/123/merge
    const match = process.env.GITHUB_REF?.match(/refs\/pull\/(\d+)\//);
    if (match) return match[1]!;
  }
  // Also check for explicit env var — validate it's numeric
  const envPr = process.env.BUMPY_PR_NUMBER || process.env.PR_NUMBER || null;
  if (envPr && !/^\d+$/.test(envPr)) {
    log.warn(`Ignoring invalid PR number from environment: ${envPr}`);
    return null;
  }
  return envPr;
}
