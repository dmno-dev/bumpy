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
