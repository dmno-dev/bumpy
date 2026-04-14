import { execSync, exec } from 'node:child_process';

export function run(cmd: string, opts?: { cwd?: string; input?: string }): string {
  return execSync(cmd, {
    cwd: opts?.cwd,
    input: opts?.input,
    encoding: 'utf-8',
    stdio: [opts?.input ? 'pipe' : 'pipe', 'pipe', 'pipe'],
  }).trim();
}

export function runAsync(cmd: string, opts?: { cwd?: string; input?: string }): Promise<string> {
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
