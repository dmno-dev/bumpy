export interface CwdParseResult {
  /** The directory passed to `--cwd`, or undefined if the flag was absent. */
  cwd?: string;
  /** The remaining argv with the `--cwd` flag (and its value) removed. */
  rest: string[];
}

/**
 * Extract a global `--cwd <dir>` / `--cwd=<dir>` flag from argv, returning the
 * directory (if any) and the remaining args with the flag stripped out.
 *
 * The CLI applies this with `process.chdir()` BEFORE any other argument handling,
 * so `findRoot()` and every git/file operation resolves against the target
 * directory. The security-critical property: the bumpy binary itself was already
 * resolved, downloaded, and started by bunx/npx from the *original* working
 * directory — the chdir happens inside the already-running process. That makes it
 * safe to point bumpy at an untrusted checkout (e.g. a fork PR under
 * `pull_request_target`): package-manager config committed into that tree
 * (`bunfig.toml`, `.npmrc`) can redirect where a package manager fetches packages
 * from, but it can no longer influence how bumpy itself was obtained.
 */
export function extractCwdFlag(argv: string[]): CwdParseResult {
  const rest: string[] = [];
  let cwd: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--cwd') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error('--cwd requires a directory argument');
      }
      cwd = next;
      i++;
      continue;
    }
    if (arg.startsWith('--cwd=')) {
      const val = arg.slice('--cwd='.length);
      if (val === '') throw new Error('--cwd requires a directory argument');
      cwd = val;
      continue;
    }
    rest.push(arg);
  }
  return { cwd, rest };
}

const DOCS_URL = 'https://github.com/dmno-dev/bumpy/blob/main/docs/github-actions.md';

/**
 * Return a migration error message if `ci check` is running in the unsafe
 * `pull_request_target` configuration (no explicit `--cwd`), or `null` if it's
 * fine. The CLI throws when this returns a string.
 *
 * This is a MIGRATION NUDGE, not a security control: a fork PR that successfully
 * redirected the registry would be running its own replacement bumpy, which has
 * no such guard. The value is in catching honest users still on a legacy
 * pull_request_target check and steering them to the recommended pull_request +
 * workflow_run setup. Passing any `--cwd` (including `--cwd .` to acknowledge an
 * already-trusted directory) satisfies the check for those staying on it.
 */
export function pullRequestTargetCwdError(opts: {
  eventName: string | undefined;
  cwdProvided: boolean;
}): string | null {
  if (opts.eventName !== 'pull_request_target' || opts.cwdProvided) return null;
  return [
    '`bumpy ci check` is running under pull_request_target without --cwd.',
    '',
    'This is the unsafe configuration. pull_request_target grants a write token and',
    'secrets even on fork PRs, and the current directory is the (untrusted) PR',
    "checkout — so a fork PR's bunfig.toml/.npmrc can redirect where bumpy itself is",
    'fetched from, at the exact version you pinned.',
    '',
    'Recommended fix: stop using pull_request_target. Run `ci check` on the plain',
    '`pull_request` event and post fork-PR comments from a separate workflow_run job:',
    `  ${DOCS_URL}#commenting-on-fork-prs`,
    '',
    'To stay on pull_request_target, check the PR head into ./pr from a trusted base',
    'checkout and run `bumpy ci check --cwd ./pr` (or `--cwd .` if the current',
    'checkout is already trusted, e.g. a same-repo PR).',
  ].join('\n');
}
