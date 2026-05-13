import { runArgs, tryRunArgs } from '../utils/shell.ts';

/** Create a git tag */
export function createTag(tag: string, opts?: { cwd?: string }): void {
  runArgs(['git', 'tag', tag], opts);
}

/** Push tags to remote, using BUMPY_GH_TOKEN if available */
export function pushWithTags(opts?: { cwd?: string }): void {
  // Use `git push --tags` directly (no preceding `git push` for commits) because:
  // - In the publish flow there are no new commits to push
  // - `--follow-tags` only pushes annotated tags reachable from pushed commits,
  //   but we create lightweight tags, so we use `--tags` instead
  withGitToken(opts?.cwd, () => {
    runArgs(['git', 'push', '--tags'], opts);
  });
}

/**
 * Temporarily configure git credentials using BUMPY_GH_TOKEN (or GH_TOKEN),
 * execute a callback, then restore the original config.
 *
 * Uses the http.extraheader approach (same as actions/checkout) rather than
 * embedding tokens in the remote URL, because extraheader takes priority over
 * any credential manager that may be installed on the runner.
 *
 * Also clears any existing credential config set by actions/checkout (extraheader
 * or includeIf entries) so our token is used instead of the default GITHUB_TOKEN.
 */
export function withGitToken(cwd: string | undefined, fn: () => void): void {
  const token = process.env.BUMPY_GH_TOKEN || process.env.GH_TOKEN;
  const server = process.env.GITHUB_SERVER_URL || 'https://github.com';

  if (!token) {
    fn();
    return;
  }

  const extraHeaderKey = `http.${server}/.extraheader`;
  // Authorization: bearer works for both GitHub PATs and GITHUB_TOKEN
  const authHeader = `Authorization: bearer ${token}`;

  // Save and clear any existing credential config set by actions/checkout:
  //   1. Direct http.<server>/.extraheader in local config
  //   2. includeIf.gitdir entries pointing to credential config files
  const savedHeader = tryRunArgs(['git', 'config', '--local', extraHeaderKey], { cwd });

  const includeIfRaw = tryRunArgs(['git', 'config', '--local', '--get-regexp', '^includeif\\.gitdir:'], { cwd });
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
      runArgs(['git', 'config', '--local', '--unset-all', extraHeaderKey], { cwd });
    }
    for (const entry of savedIncludeIfs) {
      tryRunArgs(['git', 'config', '--local', '--unset', entry.key], { cwd });
    }
    // Set our token as the Authorization header — this takes priority over credential managers
    runArgs(['git', 'config', '--local', extraHeaderKey, authHeader], { cwd });
    try {
      fn();
    } catch (err) {
      // Redact token from error messages to prevent leakage in CI logs
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(msg.replaceAll(token, '***'));
    }
  } finally {
    // Remove our injected header
    tryRunArgs(['git', 'config', '--local', '--unset-all', extraHeaderKey], { cwd });
    // Restore previous credential config
    if (savedHeader) {
      runArgs(['git', 'config', '--local', extraHeaderKey, savedHeader], { cwd });
    }
    for (const entry of savedIncludeIfs) {
      tryRunArgs(['git', 'config', '--local', entry.key, entry.value], { cwd });
    }
  }
}

/** Check if there are uncommitted changes */
export function hasUncommittedChanges(opts?: { cwd?: string }): boolean {
  const result = tryRunArgs(['git', 'status', '--porcelain'], opts);
  return result !== null && result.length > 0;
}

/** Get the current branch name */
export function getCurrentBranch(opts?: { cwd?: string }): string | null {
  return tryRunArgs(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], opts);
}

/** Stage files and create a commit */
export function commitFiles(files: string[], message: string, opts?: { cwd?: string }): void {
  for (const file of files) {
    // Use -- to prevent filenames from being interpreted as flags
    runArgs(['git', 'add', '--', file], opts);
  }
  runArgs(['git', 'commit', '-F', '-'], { ...opts, input: message });
}

/** Check if a tag already exists */
export function tagExists(tag: string, opts?: { cwd?: string }): boolean {
  return tryRunArgs(['git', 'tag', '-l', tag], opts) === tag;
}

/** Get files changed on this branch compared to a base branch */
export function getChangedFiles(rootDir: string, baseBranch: string): string[] {
  // Ensure we have the base branch ref (may need fetching in shallow CI clones)
  if (!tryRunArgs(['git', 'rev-parse', '--verify', `origin/${baseBranch}`], { cwd: rootDir })) {
    tryRunArgs(['git', 'fetch', 'origin', baseBranch, '--depth=1'], { cwd: rootDir });
  }

  // Try merge-base for the most accurate comparison
  const mergeBase = tryRunArgs(['git', 'merge-base', 'HEAD', `origin/${baseBranch}`], { cwd: rootDir });
  const ref = mergeBase || `origin/${baseBranch}`;
  const diff = tryRunArgs(['git', 'diff', '--name-only', ref], { cwd: rootDir });
  if (!diff) return [];
  return diff.split('\n').filter(Boolean);
}

/** Get commits on the current branch since it diverged from baseBranch */
export function getBranchCommits(
  rootDir: string,
  baseBranch: string,
): { hash: string; subject: string; body: string }[] {
  // Ensure we have the base branch ref
  if (!tryRunArgs(['git', 'rev-parse', '--verify', `origin/${baseBranch}`], { cwd: rootDir })) {
    tryRunArgs(['git', 'fetch', 'origin', baseBranch, '--depth=1'], { cwd: rootDir });
  }

  const mergeBase = tryRunArgs(['git', 'merge-base', 'HEAD', `origin/${baseBranch}`], { cwd: rootDir });
  const ref = mergeBase || `origin/${baseBranch}`;

  const rawLog = tryRunArgs(['git', 'log', `${ref}..HEAD`, '--format=%H%n%s%n%b%n---END---'], { cwd: rootDir });
  if (!rawLog) return [];

  const commits: { hash: string; subject: string; body: string }[] = [];
  const entries = rawLog.split('---END---').filter((e) => e.trim());
  for (const entry of entries) {
    const lines = entry.trim().split('\n');
    if (lines.length < 2) continue;
    commits.push({
      hash: lines[0]!.trim(),
      subject: lines[1]!.trim(),
      body: lines.slice(2).join('\n').trim(),
    });
  }
  return commits;
}

/** Get files changed in a specific commit */
export function getFilesChangedInCommit(hash: string, opts?: { cwd?: string }): string[] {
  const result = tryRunArgs(['git', 'diff-tree', '--no-commit-id', '--name-only', '-r', hash], opts);
  if (!result) return [];
  return result.split('\n').filter(Boolean);
}

/** Get the git status of files in a directory (staged, unstaged, untracked) */
export function getFileStatuses(
  dir: string,
  opts?: { cwd?: string },
): Map<string, 'committed' | 'staged' | 'untracked'> {
  const statuses = new Map<string, 'committed' | 'staged' | 'untracked'>();
  const result = tryRunArgs(['git', 'status', '--porcelain', '--', dir], opts);
  if (!result) return statuses;
  for (const line of result.split('\n')) {
    if (!line.trim()) continue;
    const indexStatus = line[0]!;
    const file = line.slice(3);
    if (indexStatus === '?') {
      statuses.set(file, 'untracked');
    } else {
      statuses.set(file, 'staged');
    }
  }
  return statuses;
}

/** Get all tags matching a pattern */
export function listTags(pattern: string, opts?: { cwd?: string }): string[] {
  const result = tryRunArgs(['git', 'tag', '-l', pattern], opts);
  if (!result) return [];
  return result.split('\n').filter(Boolean);
}
