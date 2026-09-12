import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import picomatch from 'picomatch';
import type { TargetOptions } from './types.ts';

/** Coerce a target option to a string array (options are untyped user config) */
export function stringArrayOption(options: TargetOptions, key: string): string[] {
  const value = options[key];
  return Array.isArray(value) ? value.map(String) : [];
}

/** Coerce a target option to a non-empty string, or undefined */
export function stringOption(options: TargetOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value ? value : undefined;
}

/** Coerce a target option to a string→string map (e.g. build args), or an empty map */
export function stringMapOption(options: TargetOptions, key: string): Record<string, string> {
  const value = options[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
}

/** Substitute `{{name}}`-style placeholders. Unknown placeholders are left as-is. */
export function templateString(input: string, vars: Record<string, string>): string {
  return input.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, key: string) => vars[key] ?? match);
}

/**
 * Expand glob patterns (picomatch syntax) relative to `dir`, returning matched file
 * paths relative to `dir` in a stable order. Walks the tree once; ignores node_modules.
 */
export function expandGlobs(dir: string, patterns: string[]): string[] {
  if (patterns.length === 0) return [];
  const isMatch = picomatch(patterns, { dot: true });
  const files: string[] = [];
  const walk = (current: string) => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git') continue;
      const full = join(current, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        walk(full);
      } else {
        const rel = relative(dir, full).split(sep).join('/');
        if (isMatch(rel)) files.push(rel);
      }
    }
  };
  walk(dir);
  return files.sort();
}

/** Quote a shell word only when it needs it (keeps logged/mocked commands readable) */
export function shellWord(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * Run `fn` with extra environment variables set on the process, restoring the previous
 * values afterwards. Used to hand credentials to child processes without putting them
 * in argv (where they would show up in logs and process listings).
 */
export async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
