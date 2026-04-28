import { runArgs, tryRunArgs } from '../utils/shell.ts';

/** Create a git tag */
export function createTag(tag: string, opts?: { cwd?: string }): void {
  runArgs(['git', 'tag', tag], opts);
}

/** Push commits and tags to remote */
export function pushWithTags(opts?: { cwd?: string }): void {
  // Use `--tags` instead of `--follow-tags` because:
  // - `--follow-tags` only pushes *annotated* tags reachable from pushed commits
  // - We create lightweight tags and may have no new commits to push
  runArgs(['git', 'push'], opts);
  runArgs(['git', 'push', '--tags'], opts);
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
