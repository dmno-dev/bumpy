import { run, tryRun } from '../utils/shell.ts';

/** Create a git tag */
export function createTag(tag: string, opts?: { cwd?: string }): void {
  run(`git tag ${tag}`, opts);
}

/** Push commits and tags to remote */
export function pushWithTags(opts?: { cwd?: string }): void {
  run('git push --follow-tags', opts);
}

/** Check if there are uncommitted changes */
export function hasUncommittedChanges(opts?: { cwd?: string }): boolean {
  const result = tryRun('git status --porcelain', opts);
  return result !== null && result.length > 0;
}

/** Get the current branch name */
export function getCurrentBranch(opts?: { cwd?: string }): string | null {
  return tryRun('git rev-parse --abbrev-ref HEAD', opts);
}

/** Stage files and create a commit */
export function commitFiles(files: string[], message: string, opts?: { cwd?: string }): void {
  for (const file of files) {
    // Use -- to prevent filenames from being interpreted as flags
    run(`git add -- "${file}"`, opts);
  }
  // Use a temp file approach to avoid shell escaping issues with commit messages
  run(`git commit -m "${message.replace(/"/g, '\\"')}"`, opts);
}

/** Check if a tag already exists */
export function tagExists(tag: string, opts?: { cwd?: string }): boolean {
  return tryRun(`git tag -l "${tag}"`, opts) === tag;
}

/** Get all tags matching a pattern */
export function listTags(pattern: string, opts?: { cwd?: string }): string[] {
  const result = tryRun(`git tag -l "${pattern}"`, opts);
  if (!result) return [];
  return result.split('\n').filter(Boolean);
}
