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

/** Get all tags matching a pattern */
export function listTags(pattern: string, opts?: { cwd?: string }): string[] {
  const result = tryRunArgs(['git', 'tag', '-l', pattern], opts);
  if (!result) return [];
  return result.split('\n').filter(Boolean);
}
