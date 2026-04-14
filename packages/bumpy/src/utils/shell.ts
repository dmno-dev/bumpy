import { execSync, exec } from 'node:child_process';

export function run(cmd: string, opts?: { cwd?: string }): string {
  return execSync(cmd, {
    cwd: opts?.cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

export function runAsync(cmd: string, opts?: { cwd?: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd: opts?.cwd, encoding: 'utf-8' }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`Command failed: ${cmd}\n${stderr}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

export function tryRun(cmd: string, opts?: { cwd?: string }): string | null {
  try {
    return run(cmd, opts);
  } catch {
    return null;
  }
}
