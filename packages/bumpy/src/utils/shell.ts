import { execSync, execFileSync, exec, execFile } from 'node:child_process';

/**
 * Escape a value for safe interpolation inside a single-quoted shell string.
 * Works by ending the current single-quote, inserting an escaped single-quote,
 * and re-opening the single-quote: "it's" → 'it'\''s'
 */
export function sq(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

// ---- Test interception ----

type CommandInterceptor = (
  args: string[],
  opts?: { cwd?: string; input?: string },
) => { intercepted: true; result: string } | { intercepted: true; error: string } | { intercepted: false };

let _interceptor: CommandInterceptor | null = null;

/** @internal Install a command interceptor for testing. Returns a cleanup function. */
export function _setInterceptor(fn: CommandInterceptor | null): void {
  _interceptor = fn;
}

function checkIntercept(args: string[], opts?: { cwd?: string; input?: string }) {
  if (!_interceptor) return null;
  return _interceptor(args, opts);
}

// ---- String-based commands (for static/trusted command strings only) ----

export function run(cmd: string, opts?: { cwd?: string; input?: string }): string {
  const result = checkIntercept(cmd.split(/\s+/), opts);
  if (result?.intercepted) {
    if ('error' in result) throw new Error(result.error);
    return result.result;
  }
  return execSync(cmd, {
    cwd: opts?.cwd,
    input: opts?.input,
    encoding: 'utf-8',
    stdio: [opts?.input ? 'pipe' : 'pipe', 'pipe', 'pipe'],
  }).trim();
}

export function runAsync(cmd: string, opts?: { cwd?: string; input?: string }): Promise<string> {
  const result = checkIntercept(cmd.split(/\s+/), opts);
  if (result?.intercepted) {
    if ('error' in result) return Promise.reject(new Error(result.error));
    return Promise.resolve(result.result);
  }
  return new Promise((resolve, reject) => {
    const child = exec(cmd, { cwd: opts?.cwd, encoding: 'utf-8' }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`Command failed: ${cmd}\n${stderr}`));
      } else {
        resolve(stdout.trim());
      }
    });
    if (opts?.input) {
      child.stdin?.write(opts.input);
      child.stdin?.end();
    }
  });
}

export function tryRun(cmd: string, opts?: { cwd?: string }): string | null {
  try {
    return run(cmd, opts);
  } catch {
    return null;
  }
}

// ---- Array-based commands (shell-injection safe) ----

/** Run a command with an argument array — bypasses the shell entirely */
export function runArgs(args: string[], opts?: { cwd?: string; input?: string }): string {
  const result = checkIntercept(args, opts);
  if (result?.intercepted) {
    if ('error' in result) throw new Error(result.error);
    return result.result;
  }
  const [cmd, ...rest] = args;
  return execFileSync(cmd!, rest, {
    cwd: opts?.cwd,
    input: opts?.input,
    encoding: 'utf-8',
    stdio: [opts?.input ? 'pipe' : 'pipe', 'pipe', 'pipe'],
  }).trim();
}

/** Async version of runArgs */
export function runArgsAsync(args: string[], opts?: { cwd?: string; input?: string }): Promise<string> {
  const result = checkIntercept(args, opts);
  if (result?.intercepted) {
    if ('error' in result) return Promise.reject(new Error(result.error));
    return Promise.resolve(result.result);
  }
  const [cmd, ...rest] = args;
  return new Promise((resolve, reject) => {
    const child = execFile(cmd!, rest, { cwd: opts?.cwd, encoding: 'utf-8' }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`Command failed: ${args.join(' ')}\n${stderr}`));
      } else {
        resolve(stdout.trim());
      }
    });
    if (opts?.input) {
      child.stdin?.write(opts.input);
      child.stdin?.end();
    }
  });
}

/** tryRun equivalent for argument arrays */
export function tryRunArgs(args: string[], opts?: { cwd?: string }): string | null {
  try {
    return runArgs(args, opts);
  } catch {
    return null;
  }
}
